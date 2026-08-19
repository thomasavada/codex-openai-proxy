import { createServer as createHttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessToken, resolveAuthPath } from "./auth.js";
import {
  chatCompletionsToResponsesRequest,
  imageGenerationsToResponsesRequest,
  parseSSEEvents,
  responsesEventToChatChunk,
  collectImageFromEvent,
  buildChatCompletionResponse,
  buildImageGenerationResponse,
} from "./convert.js";
import { listModels } from "./models.js";

const BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const AGENT_GUIDE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "agent.md");
const AGENT_GUIDE_ROUTES = new Set(["/agent.md", "/llms.txt", "/AGENTS.md"]);

function requestPath(req) {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return req.url ?? "/";
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonError(res, status, message) {
  sendJson(res, status, { error: { message, type: "proxy_error" } });
}

// Logs full detail server-side but only ever sends a generic, client-safe
// message over the wire — the raw text may include upstream account/session
// details or internal exception messages that shouldn't leak to callers.
function jsonErrorSafe(res, status, publicMessage, detail) {
  if (detail !== undefined) console.error(publicMessage, detail);
  jsonError(res, status, publicMessage);
}

function isAuthorized(req, apiKey) {
  if (!apiKey) return true;
  const header = req.headers["authorization"] || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(apiKey);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function callBackend(responsesReq, { accessToken, accountId }) {
  return fetch(BACKEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      "originator": "codex_cli_rs",
      "session_id": randomUUID(),
    },
    body: JSON.stringify(responsesReq),
  });
}

async function handleChatCompletions(req, res, ctx) {
  let chatReq;
  try {
    chatReq = await readJsonBody(req);
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  if (!chatReq.model || !Array.isArray(chatReq.messages)) {
    return jsonError(res, 400, "`model` and `messages` are required");
  }

  const responsesReq = chatCompletionsToResponsesRequest(chatReq);
  const wantsStream = Boolean(chatReq.stream);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let auth = await getAccessToken(ctx.authPath);
  let backendRes = await callBackend(responsesReq, auth);

  if (backendRes.status === 401) {
    auth = await getAccessToken(ctx.authPath, { forceRefresh: true });
    backendRes = await callBackend(responsesReq, auth);
  }

  if (!backendRes.ok) {
    const text = await backendRes.text().catch(() => "");
    return jsonErrorSafe(res, backendRes.status, "Codex backend request failed", text.slice(0, 2000));
  }

  if (wantsStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
  }

  let buffer = "";
  let content = "";
  const reader = backendRes.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, remainder } = parseSSEEvents(decoder.decode(value, { stream: true }), buffer);
    buffer = remainder;
    for (const event of events) {
      if (event.type === "response.output_text.delta") content += event.delta;
      if (wantsStream) {
        const chunk = responsesEventToChatChunk(event, { id, model: chatReq.model, created });
        if (chunk) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  }

  if (wantsStream) {
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    sendJson(res, 200, buildChatCompletionResponse({ id, model: chatReq.model, created, content }));
  }
}

async function handleImageGenerations(req, res, ctx) {
  let imageReq;
  try {
    imageReq = await readJsonBody(req);
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  if (!imageReq.prompt || !String(imageReq.prompt).trim()) {
    return jsonError(res, 400, "`prompt` is required");
  }

  const responsesReq = imageGenerationsToResponsesRequest(imageReq);
  let auth = await getAccessToken(ctx.authPath);
  let backendRes = await callBackend(responsesReq, auth);

  if (backendRes.status === 401) {
    auth = await getAccessToken(ctx.authPath, { forceRefresh: true });
    backendRes = await callBackend(responsesReq, auth);
  }

  if (!backendRes.ok) {
    const text = await backendRes.text().catch(() => "");
    return jsonErrorSafe(res, backendRes.status, "Codex backend request failed", text.slice(0, 2000));
  }

  let buffer = "";
  let image = {};
  const reader = backendRes.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, remainder } = parseSSEEvents(decoder.decode(value, { stream: true }), buffer);
    buffer = remainder;
    for (const event of events) image = collectImageFromEvent(event, image);
  }

  if (!image.b64) {
    return jsonError(res, 502, "Image generation produced no image");
  }

  sendJson(
    res,
    200,
    buildImageGenerationResponse({
      created: Math.floor(Date.now() / 1000),
      b64: image.b64,
      revisedPrompt: image.revised_prompt,
    }),
  );
}

async function handleAgentGuide(res) {
  const markdown = await readFile(AGENT_GUIDE_PATH, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(markdown);
}

export function createServer({ authPath: explicitAuthPath, apiKey } = {}) {
  const authPath = resolveAuthPath(explicitAuthPath);
  const ctx = { authPath };

  return createHttpServer(async (req, res) => {
    try {
      const path = requestPath(req);

      if (req.method === "GET" && path === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (req.method === "GET" && AGENT_GUIDE_ROUTES.has(path)) {
        return await handleAgentGuide(res);
      }

      if (!isAuthorized(req, apiKey)) {
        return jsonError(res, 401, "Missing or invalid API key");
      }

      if (req.method === "GET" && path === "/v1/models") {
        const models = await listModels(ctx.authPath);
        return sendJson(res, 200, { object: "list", data: models });
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        return await handleChatCompletions(req, res, ctx);
      }
      if (req.method === "POST" && path === "/v1/images/generations") {
        return await handleImageGenerations(req, res, ctx);
      }
      jsonError(res, 404, "Not found");
    } catch (err) {
      jsonErrorSafe(res, 500, "Internal server error", err);
    }
  });
}

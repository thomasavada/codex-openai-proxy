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
  collectToolCallFromEvent,
  collectImageFromEvent,
  buildChatCompletionResponse,
  buildImageGenerationResponse,
} from "./convert.js";
import { listModels, resolveImageOrchestrator } from "./models.js";
import { parseMultipart } from "./multipart.js";
import {
  SIZE_PRESETS,
  OUTPUT_FORMATS,
  parseSize,
  parseOutputFormat,
  parseFit,
  parseBackground,
  transformImage,
  availableBackends,
} from "./imageops.js";

const BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const AGENT_GUIDE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "agent.md");
const AGENT_GUIDE_ROUTES = new Set(["/agent.md", "/llms.txt", "/AGENTS.md"]);
// Reference images arrive inline (base64 or multipart), so bodies are far
// bigger than a chat request — but still bounded, or a single caller can pin
// the process's memory.
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

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

class BodyTooLargeError extends Error {}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes) {
  const raw = (await readBody(req, maxBytes)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// Accepts both the OpenAI SDK's multipart upload and a plain JSON body, so the
// same endpoint works from `openai.images.edit()` and from a curl one-liner.
async function readImageRequest(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return await readJsonBody(req, maxBytes);
  }
  const { fields, files } = parseMultipart(await readBody(req, maxBytes), contentType);
  const images = (files.image ?? []).map((file) => file.data);
  return { ...fields, ...(images.length ? { image: images } : {}) };
}

function callBackend(responsesReq, { accessToken, accountId }, fetcher = fetch) {
  return fetcher(BACKEND_URL, {
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

async function callBackendWithRefresh(responsesReq, ctx) {
  let auth = await ctx.tokenProvider(ctx.authPath);
  let backendRes = await callBackend(responsesReq, auth, ctx.backendFetch);
  if (backendRes.status === 401) {
    auth = await ctx.tokenProvider(ctx.authPath, { forceRefresh: true });
    backendRes = await callBackend(responsesReq, auth, ctx.backendFetch);
  }
  return backendRes;
}

async function handleResponses(req, res, ctx) {
  let responsesReq;
  try {
    responsesReq = await readJsonBody(req, ctx.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError(res, 413, `Request body exceeds ${ctx.maxBodyBytes} bytes`);
    }
    return jsonError(res, 400, "Invalid JSON body");
  }
  if (!responsesReq.model || responsesReq.input === undefined) {
    return jsonError(res, 400, "`model` and `input` are required");
  }

  const wantsStream = responsesReq.stream === true;
  const input =
    typeof responsesReq.input === "string"
      ? [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: responsesReq.input }],
          },
        ]
      : responsesReq.input;
  const backendRes = await callBackendWithRefresh(
    { ...responsesReq, input, store: false, stream: true },
    ctx,
  );
  if (!backendRes.ok) {
    const text = await backendRes.text().catch(() => "");
    return jsonErrorSafe(res, backendRes.status, "Codex backend request failed", text.slice(0, 2000));
  }

  if (wantsStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = backendRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    return res.end();
  }

  let buffer = "";
  let terminalResponse;
  const outputItems = new Map();
  const reader = backendRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, remainder } = parseSSEEvents(decoder.decode(value, { stream: true }), buffer);
    buffer = remainder;
    for (const event of events) {
      if (event.type === "response.output_item.done" && event.item) {
        outputItems.set(event.output_index ?? outputItems.size, event.item);
      }
      if (
        ["response.completed", "response.failed", "response.incomplete"].includes(event.type) &&
        event.response
      ) {
        terminalResponse = event.response;
      }
    }
  }
  if (!terminalResponse) return jsonError(res, 502, "Codex backend returned no terminal response");
  if (
    (!Array.isArray(terminalResponse.output) || terminalResponse.output.length === 0) &&
    outputItems.size > 0
  ) {
    terminalResponse.output = [...outputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  }
  return sendJson(res, 200, terminalResponse);
}

async function handleChatCompletions(req, res, ctx) {
  let chatReq;
  try {
    chatReq = await readJsonBody(req, ctx.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError(res, 413, `Request body exceeds ${ctx.maxBodyBytes} bytes`);
    }
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
  const toolCalls = [];
  const reader = backendRes.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, remainder } = parseSSEEvents(decoder.decode(value, { stream: true }), buffer);
    buffer = remainder;
    for (const event of events) {
      if (event.type === "response.output_text.delta") content += event.delta;
      const toolCall = collectToolCallFromEvent(event);
      if (toolCall) toolCalls.push(toolCall);
      if (wantsStream) {
        const chunk = responsesEventToChatChunk(event, {
          id,
          model: chatReq.model,
          created,
          toolCallsSeen: toolCalls.length > 0,
        });
        if (chunk) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  }

  if (wantsStream) {
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    sendJson(
      res,
      200,
      buildChatCompletionResponse({ id, model: chatReq.model, created, content, toolCalls }),
    );
  }
}

// Shared by /v1/images/generations and /v1/images/edits — the only difference
// between them is whether reference images came along.
async function handleImages(req, res, ctx, { requireImage = false } = {}) {
  let imageReq;
  try {
    imageReq = await readImageRequest(req, ctx.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError(res, 413, `Request body exceeds ${ctx.maxBodyBytes} bytes`);
    }
    return jsonError(res, 400, "Invalid request body");
  }

  if (!imageReq.prompt || !String(imageReq.prompt).trim()) {
    return jsonError(res, 400, "`prompt` is required");
  }
  if (requireImage && !imageReq.image && !imageReq.images) {
    return jsonError(res, 400, "`image` is required for edits");
  }
  if (imageReq.mask) {
    return jsonError(res, 400, "`mask` (inpainting) is not supported by this backend");
  }
  if (imageReq.response_format && imageReq.response_format !== "b64_json") {
    return jsonError(res, 400, "Only `response_format: \"b64_json\"` is supported");
  }

  let dimensions;
  let outputFormat;
  let fit;
  let background;
  let responsesReq;
  try {
    dimensions = parseSize(imageReq.size);
    outputFormat = parseOutputFormat(imageReq.output_format);
    fit = parseFit(imageReq.fit);
    background = parseBackground(imageReq.background);
    responsesReq = imageGenerationsToResponsesRequest(imageReq, {
      fallbackModel: await resolveImageOrchestrator(ctx.authPath),
      dimensions,
      outputFormat,
      allowRemote: ctx.allowRemoteImages,
    });
  } catch (err) {
    return jsonError(res, 400, err.message);
  }

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

  // The upstream tool ignores `size` and returns whatever canvas it picked, so
  // the requested frame is applied here.
  let b64 = image.b64;
  let warning;
  if (dimensions) {
    const result = await transformImage(Buffer.from(image.b64, "base64"), {
      ...dimensions,
      format: outputFormat,
      fit,
      background,
    });
    b64 = result.buffer.toString("base64");
    if (!result.transformed && fit !== "none") {
      warning = `Returned at the model's own canvas size: ${result.reason}`;
    }
  }

  sendJson(
    res,
    200,
    buildImageGenerationResponse({
      created: Math.floor(Date.now() / 1000),
      b64,
      revisedPrompt: image.revised_prompt,
      outputFormat,
      size: dimensions ? `${dimensions.width}x${dimensions.height}` : "auto",
      quality: responsesReq.tools[0].quality,
      background: imageReq.background,
      warning,
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

export function createServer({
  authPath: explicitAuthPath,
  apiKey,
  allowRemoteImages = false,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  tokenProvider = getAccessToken,
  backendFetch = fetch,
} = {}) {
  const authPath = resolveAuthPath(explicitAuthPath);
  const ctx = {
    authPath,
    allowRemoteImages,
    maxBodyBytes,
    tokenProvider,
    backendFetch,
  };

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
      if (req.method === "POST" && path === "/v1/responses") {
        return await handleResponses(req, res, ctx);
      }
      if (req.method === "GET" && path === "/v1/images/sizes") {
        return sendJson(res, 200, {
          object: "list",
          formats: OUTPUT_FORMATS,
          fits: ["cover", "contain", "fill", "none"],
          local_backends: await availableBackends(),
          data: Object.entries(SIZE_PRESETS).map(([name, size]) => ({ name, size })),
        });
      }
      if (req.method === "POST" && path === "/v1/images/generations") {
        return await handleImages(req, res, ctx);
      }
      if (req.method === "POST" && path === "/v1/images/edits") {
        return await handleImages(req, res, ctx, { requireImage: true });
      }
      jsonError(res, 404, "Not found");
    } catch (err) {
      jsonErrorSafe(res, 500, "Internal server error", err);
    }
  });
}

import { canvasHint, detectImageMime } from "./imageops.js";

export const DEFAULT_IMAGE_ORCHESTRATOR = "gpt-5.4-mini";

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join(" ");
  }
  return content == null ? "" : String(content);
}

export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

// The Codex backend refuses a `system` role outright ("System messages are not
// allowed"), and `instructions` is where the Responses API expects that prompt,
// so hoist it instead of forwarding it. Previously `instructions` was hardcoded,
// which silently discarded whatever system prompt the caller sent.
function splitSystem(messages) {
  const instructions = [];
  const rest = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) instructions.push(text);
      continue;
    }
    rest.push(msg);
  }
  return { instructions, rest };
}

// Assistant turns must carry `output_text` — `input_text` is rejected with
// "Invalid value: 'input_text'". Tool traffic changes item type entirely:
// a requested call becomes `function_call`, its result `function_call_output`.
function toInputItems(msg) {
  if (msg.role === "assistant") {
    const items = [];
    const text = extractText(msg.content);
    if (text) {
      items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    }
    for (const call of msg.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments ?? "{}",
      });
    }
    return items;
  }

  if (msg.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: extractText(msg.content),
      },
    ];
  }

  return [
    { type: "message", role: msg.role, content: [{ type: "input_text", text: extractText(msg.content) }] },
  ];
}

// Chat Completions nests the schema under `function`; the Responses API wants it
// flat and rejects the nested shape with "Missing required parameter:
// 'tools[0].name'". Non-function tools (image_generation) already match.
function toResponsesTool(tool) {
  if (tool?.type !== "function" || !tool.function) return tool;
  const { name, description, parameters, strict } = tool.function;
  return {
    type: "function",
    name,
    description: description ?? "",
    parameters: parameters ?? { type: "object", properties: {} },
    strict: strict ?? false,
  };
}

function toResponsesToolChoice(choice) {
  if (choice?.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return choice ?? "auto";
}

export function chatCompletionsToResponsesRequest(chatReq) {
  const { instructions, rest } = splitSystem(chatReq.messages ?? []);
  return {
    model: chatReq.model,
    instructions: instructions.length ? instructions.join("\n\n") : DEFAULT_INSTRUCTIONS,
    input: rest.flatMap(toInputItems),
    tools: (chatReq.tools ?? []).map(toResponsesTool),
    tool_choice: toResponsesToolChoice(chatReq.tool_choice),
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}

// The backend emits a finished function call as a single `output_item.done`
// event; arguments arrive complete, so there is nothing to accumulate.
export function collectToolCallFromEvent(event) {
  if (event?.type !== "response.output_item.done") return null;
  const item = event.item;
  if (item?.type !== "function_call") return null;
  return {
    id: item.call_id,
    type: "function",
    function: { name: item.name, arguments: item.arguments ?? "{}" },
  };
}

// Splits raw SSE bytes on blank-line event boundaries, parses each `data: ` line
// as JSON, and returns any leftover partial event text to prepend to the next chunk.
export function parseSSEEvents(rawChunkText, buffer) {
  const combined = (buffer + rawChunkText).replace(/\r\n/g, "\n");
  const parts = combined.split("\n\n");
  const remainder = parts.pop() ?? "";
  const events = [];

  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Ignore malformed SSE payloads rather than failing the whole stream.
      }
    }
  }

  return { events, remainder };
}

export function responsesEventToChatChunk(event, { id, model, created, toolCallsSeen = false }) {
  if (event.type === "response.output_text.delta") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: event.delta }, finish_reason: null }],
    };
  }
  const toolCall = collectToolCallFromEvent(event);
  if (toolCall) {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: [{ index: event.output_index ?? 0, ...toolCall }] },
          finish_reason: null,
        },
      ],
    };
  }
  if (event.type === "response.completed") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCallsSeen ? "tool_calls" : "stop" }],
    };
  }
  return null;
}

export function buildChatCompletionResponse({ id, model, created, content, toolCalls = [] }) {
  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const IMAGE_MODEL_SLUGS = new Set([
  "dall-e-2",
  "dall-e-3",
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "gpt-image-2",
]);

// Callers routinely pass an OpenAI image-model slug the Codex backend has never
// heard of; those get swapped for a chat model that drives the image tool. Any
// other slug is a deliberate orchestrator choice and is left alone.
export function orchestratorModel(model, fallback) {
  if (!model || IMAGE_MODEL_SLUGS.has(model)) return fallback;
  return model;
}

function mapImageQuality(quality) {
  if (quality === "hd") return "high";
  if (quality === "standard") return "medium";
  return quality || "medium";
}

const MAX_REFERENCE_IMAGES = 8;

/**
 * Normalise one reference image into a Responses `input_image` content part.
 * Accepts a data URL, bare base64, a Buffer (multipart upload) or — only when
 * `allowRemote` is set — an http(s) URL. Remote URLs are opt-in because this
 * proxy is reachable from outside the host it runs on, and fetching arbitrary
 * URLs on a caller's behalf turns it into an SSRF pivot.
 */
export function toInputImage(value, { allowRemote = false } = {}) {
  if (Buffer.isBuffer(value)) {
    const mime = detectImageMime(value);
    if (!mime) throw new Error("Reference image is not a PNG, JPEG, WebP or GIF");
    return { type: "input_image", image_url: `data:${mime};base64,${value.toString("base64")}` };
  }

  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Reference image is empty");

  if (raw.startsWith("data:")) {
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) {
      throw new Error("Reference image data URL must be base64-encoded image/* data");
    }
    return { type: "input_image", image_url: raw };
  }

  if (/^https?:\/\//i.test(raw)) {
    if (!allowRemote) {
      throw new Error(
        "Reference images by URL are disabled. Send base64 or a data: URL, or start the proxy with --allow-remote-images.",
      );
    }
    return { type: "input_image", image_url: raw };
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 32) {
    return toInputImage(Buffer.from(raw.replace(/\s+/g, ""), "base64"), { allowRemote });
  }

  throw new Error("Reference image must be base64, a data: URL or an http(s) URL");
}

export function toInputImages(images, options) {
  if (images === undefined || images === null || images === "") return [];
  const list = Array.isArray(images) ? images : [images];
  if (list.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are supported`);
  }
  return list.map((image) => toInputImage(image, options));
}

/**
 * Build the Responses request for an image generation or edit.
 *
 * `size` never reaches the backend as a hard constraint — the upstream tool
 * picks its own canvas and ignores it — so the target frame is also described
 * in the prompt, and the server crops the result to the exact pixels afterwards.
 */
export function imageGenerationsToResponsesRequest(imageReq, options = {}) {
  const {
    fallbackModel = DEFAULT_IMAGE_ORCHESTRATOR,
    dimensions = null,
    outputFormat = "png",
    allowRemote = false,
  } = options;

  const prompt = String(imageReq.prompt ?? "").trim();
  const references = toInputImages(imageReq.image ?? imageReq.images, { allowRemote });

  const tool = {
    type: "image_generation",
    quality: mapImageQuality(imageReq.quality),
    output_format: outputFormat,
  };
  if (dimensions) tool.size = `${dimensions.width}x${dimensions.height}`;
  if (imageReq.background === "opaque" || imageReq.background === "transparent") {
    tool.background = imageReq.background;
  }

  const verb = references.length
    ? "Edit the attached reference image(s) as follows."
    : "Draw the following image.";
  const text = `${verb} ${prompt}${dimensions ? canvasHint(dimensions) : ""}`;

  return {
    model: orchestratorModel(imageReq.model, fallbackModel),
    instructions: "You are a helpful assistant that generates images.",
    input: [
      {
        type: "message",
        role: "user",
        content: [...references, { type: "input_text", text }],
      },
    ],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}

// Pull the latest image payload out of a Responses SSE event. Prefers a
// completed tool result over a streaming partial preview.
export function collectImageFromEvent(event, acc = {}) {
  const next = { ...acc };
  if (event.type === "response.image_generation_call.partial_image" && event.partial_image_b64) {
    if (!next.b64 || next.partial !== false) {
      next.b64 = event.partial_image_b64;
      next.partial = true;
    }
    if (event.revised_prompt) next.revised_prompt = event.revised_prompt;
  }
  const item =
    event.type === "response.output_item.done" && event.item?.type === "image_generation_call"
      ? event.item
      : event.type === "response.image_generation_call.completed"
        ? event
        : null;
  if (item?.result) {
    next.b64 = item.result;
    next.partial = false;
    if (item.revised_prompt) next.revised_prompt = item.revised_prompt;
  }
  if (event.type === "response.completed") {
    for (const output of event.response?.output ?? []) {
      if (output?.type === "image_generation_call" && output.result) {
        next.b64 = output.result;
        next.partial = false;
        if (output.revised_prompt) next.revised_prompt = output.revised_prompt;
      }
    }
  }
  return next;
}

export function buildImageGenerationResponse({
  created,
  b64,
  revisedPrompt,
  outputFormat,
  size,
  quality,
  background,
  warning,
}) {
  const entry = { b64_json: b64 };
  if (revisedPrompt) entry.revised_prompt = revisedPrompt;
  const response = { created, data: [entry] };
  if (outputFormat) response.output_format = outputFormat;
  if (size) response.size = size;
  if (quality) response.quality = quality;
  if (background) response.background = background;
  // Surfaced instead of failing: the image is real, only the requested frame
  // could not be applied locally.
  if (warning) response.warning = warning;
  return response;
}

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

export function chatCompletionsToResponsesRequest(chatReq) {
  return {
    model: chatReq.model,
    instructions: "You are a helpful assistant.",
    input: chatReq.messages.map((msg) => ({
      type: "message",
      role: msg.role,
      content: [{ type: "input_text", text: extractText(msg.content) }],
    })),
    tools: chatReq.tools ?? [],
    tool_choice: chatReq.tool_choice ?? "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}

// Splits raw SSE bytes on blank-line event boundaries, parses each `data: ` line
// as JSON, and returns any leftover partial event text to prepend to the next chunk.
export function parseSSEEvents(rawChunkText, buffer) {
  const combined = buffer + rawChunkText;
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

export function responsesEventToChatChunk(event, { id, model, created }) {
  if (event.type === "response.output_text.delta") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
    };
  }
  if (event.type === "response.completed") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
  return null;
}

export function buildChatCompletionResponse({ id, model, created, content }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
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

const DEFAULT_IMAGE_ORCHESTRATOR = "gpt-5.4";

function orchestratorModel(model) {
  if (!model || IMAGE_MODEL_SLUGS.has(model)) return DEFAULT_IMAGE_ORCHESTRATOR;
  return model;
}

function mapImageQuality(quality) {
  if (quality === "hd") return "high";
  if (quality === "standard") return "medium";
  return quality || "medium";
}

export function imageGenerationsToResponsesRequest(imageReq) {
  const prompt = String(imageReq.prompt ?? "").trim();
  const tool = { type: "image_generation", quality: mapImageQuality(imageReq.quality) };
  if (imageReq.size && imageReq.size !== "auto") tool.size = imageReq.size;
  return {
    model: orchestratorModel(imageReq.model),
    instructions: "You are a helpful assistant that generates images.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Draw the following image. ${prompt}` }],
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

export function buildImageGenerationResponse({ created, b64, revisedPrompt }) {
  const entry = { b64_json: b64 };
  if (revisedPrompt) entry.revised_prompt = revisedPrompt;
  return { created, data: [entry] };
}

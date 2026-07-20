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

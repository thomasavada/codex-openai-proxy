import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionsToResponsesRequest,
  imageGenerationsToResponsesRequest,
  parseSSEEvents,
  responsesEventToChatChunk,
  collectImageFromEvent,
  buildChatCompletionResponse,
  collectToolCallFromEvent,
  DEFAULT_INSTRUCTIONS,
  buildImageGenerationResponse,
  toInputImage,
  toInputImages,
  DEFAULT_IMAGE_ORCHESTRATOR,
} from "../src/convert.js";

test("chatCompletionsToResponsesRequest maps messages to input items", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(req.model, "gpt-5.6-sol");
  assert.equal(req.stream, true);
  assert.deepEqual(req.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
  ]);
});

test("chatCompletionsToResponsesRequest extracts text from array content", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-5.6-sol",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hi" }, { type: "text", text: "there" }] },
    ],
  });
  assert.equal(req.input[0].content[0].text, "Hi there");
});

test("parseSSEEvents parses complete events and holds back a partial trailing event", () => {
  const chunk = 'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"incompl';
  const { events, remainder } = parseSSEEvents(chunk, "");
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
  assert.equal(remainder, 'data: {"incompl');
});

test("parseSSEEvents ignores the [DONE] sentinel", () => {
  const { events } = parseSSEEvents("data: [DONE]\n\n", "");
  assert.deepEqual(events, []);
});

test("parseSSEEvents reassembles an event split across two chunks", () => {
  const first = parseSSEEvents('data: {"type":"a"}\n\ndata: {"ty', "");
  const second = parseSSEEvents('pe":"b"}\n\n', first.remainder);
  assert.deepEqual(first.events, [{ type: "a" }]);
  assert.deepEqual(second.events, [{ type: "b" }]);
});

test("responsesEventToChatChunk maps a text delta", () => {
  const chunk = responsesEventToChatChunk(
    { type: "response.output_text.delta", delta: "Hi" },
    { id: "id1", model: "m", created: 1 },
  );
  assert.equal(chunk.choices[0].delta.content, "Hi");
});

test("responsesEventToChatChunk maps completion to finish_reason stop", () => {
  const chunk = responsesEventToChatChunk(
    { type: "response.completed" },
    { id: "id1", model: "m", created: 1 },
  );
  assert.equal(chunk.choices[0].finish_reason, "stop");
});

test("responsesEventToChatChunk ignores unrelated event types", () => {
  const chunk = responsesEventToChatChunk(
    { type: "response.output_item.added" },
    { id: "id1", model: "m", created: 1 },
  );
  assert.equal(chunk, null);
});

test("buildChatCompletionResponse shapes a non-streaming response", () => {
  const res = buildChatCompletionResponse({ id: "id1", model: "m", created: 1, content: "hi" });
  assert.equal(res.object, "chat.completion");
  assert.equal(res.choices[0].message.content, "hi");
});

// Each of the next three covers a shape the Codex backend rejected outright;
// the quoted text is the upstream error they used to produce.
test("chatCompletionsToResponsesRequest hoists system messages into instructions", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [
      { role: "system", content: "You are Joy." },
      { role: "user", content: "Hello" },
    ],
  });
  // Upstream: {"detail":"System messages are not allowed"}
  assert.equal(req.instructions, "You are Joy.");
  assert.equal(req.input.length, 1);
  assert.equal(req.input[0].role, "user");
});

test("chatCompletionsToResponsesRequest falls back to default instructions", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(req.instructions, DEFAULT_INSTRUCTIONS);
});

test("chatCompletionsToResponsesRequest joins multiple system messages", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [
      { role: "system", content: "One." },
      { role: "system", content: "Two." },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(req.instructions, "One.\n\nTwo.");
});

test("chatCompletionsToResponsesRequest emits output_text for assistant turns", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ],
  });
  // Upstream: "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'."
  assert.equal(req.input[1].content[0].type, "output_text");
  assert.equal(req.input[0].content[0].type, "input_text");
});

test("chatCompletionsToResponsesRequest flattens function tools", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ],
  });
  // Upstream: "Missing required parameter: 'tools[0].name'."
  assert.equal(req.tools[0].name, "get_weather");
  assert.equal(req.tools[0].type, "function");
  assert.equal(req.tools[0].parameters.properties.city.type, "string");
  assert.equal(req.tools[0].function, undefined);
});

test("chatCompletionsToResponsesRequest maps a tool round-trip", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "31C" },
    ],
  });
  assert.deepEqual(req.input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"Hanoi"}',
  });
  assert.deepEqual(req.input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "31C",
  });
});

test("chatCompletionsToResponsesRequest flattens a named tool_choice", () => {
  const req = chatCompletionsToResponsesRequest({
    model: "gpt-reserve",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  });
  assert.deepEqual(req.tool_choice, { type: "function", name: "get_weather" });
});

test("collectToolCallFromEvent picks up a finished function call", () => {
  const call = collectToolCallFromEvent({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Hanoi"}' },
  });
  assert.equal(call.id, "call_1");
  assert.equal(call.function.name, "get_weather");
  assert.equal(collectToolCallFromEvent({ type: "response.completed" }), null);
});

test("buildChatCompletionResponse reports tool_calls as the finish reason", () => {
  const res = buildChatCompletionResponse({
    id: "id1",
    model: "m",
    created: 1,
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
  });
  assert.equal(res.choices[0].finish_reason, "tool_calls");
  assert.equal(res.choices[0].message.tool_calls[0].id, "call_1");
});

test("responsesEventToChatChunk finishes as tool_calls when one was seen", () => {
  const chunk = responsesEventToChatChunk(
    { type: "response.completed" },
    { id: "id1", model: "m", created: 1, toolCallsSeen: true },
  );
  assert.equal(chunk.choices[0].finish_reason, "tool_calls");
});

test("responsesEventToChatChunk labels deltas as assistant", () => {
  // Without a role, LangChain builds a generic ChatMessageChunk and later fails
  // with "Unable to coerce message from array" when the history is replayed.
  const text = responsesEventToChatChunk(
    { type: "response.output_text.delta", delta: "Hi" },
    { id: "id1", model: "m", created: 1 },
  );
  assert.equal(text.choices[0].delta.role, "assistant");

  const call = responsesEventToChatChunk(
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
    },
    { id: "id1", model: "m", created: 1 },
  );
  assert.equal(call.choices[0].delta.role, "assistant");
});

test("imageGenerationsToResponsesRequest forces the image_generation tool", () => {
  const req = imageGenerationsToResponsesRequest(
    { prompt: "a red apple" },
    { dimensions: { width: 1024, height: 1024 } },
  );
  assert.equal(req.model, DEFAULT_IMAGE_ORCHESTRATOR);
  assert.equal(req.tool_choice.type, "image_generation");
  assert.equal(req.tools[0].type, "image_generation");
  assert.equal(req.tools[0].size, "1024x1024");
  assert.equal(req.tools[0].quality, "medium");
  assert.equal(req.tools[0].output_format, "png");
  assert.match(req.input[0].content[0].text, /a red apple/);
});

test("imageGenerationsToResponsesRequest remaps dall-e / gpt-image models", () => {
  const req = imageGenerationsToResponsesRequest({ model: "dall-e-3", prompt: "cat" });
  assert.equal(req.model, DEFAULT_IMAGE_ORCHESTRATOR);
});

test("imageGenerationsToResponsesRequest honours an explicit fallback model", () => {
  const req = imageGenerationsToResponsesRequest({ prompt: "cat" }, { fallbackModel: "gpt-5.6-luna" });
  assert.equal(req.model, "gpt-5.6-luna");
});

test("imageGenerationsToResponsesRequest keeps a mainline chat model", () => {
  const req = imageGenerationsToResponsesRequest({ model: "gpt-5.5", prompt: "cat" });
  assert.equal(req.model, "gpt-5.5");
});

test("imageGenerationsToResponsesRequest passes the requested output format through", () => {
  const req = imageGenerationsToResponsesRequest({ prompt: "cat" }, { outputFormat: "webp" });
  assert.equal(req.tools[0].output_format, "webp");
});

test("imageGenerationsToResponsesRequest describes the target frame in the prompt", () => {
  const req = imageGenerationsToResponsesRequest(
    { prompt: "a sale banner" },
    { dimensions: { width: 728, height: 90 } },
  );
  const text = req.input[0].content[0].text;
  assert.match(text, /728x90/);
  assert.match(text, /aspect ratio 36:5|aspect ratio 8\.09:1/);
  assert.match(text, /extremely wide, short banner strip/);
});

test("imageGenerationsToResponsesRequest attaches reference images before the prompt", () => {
  const png = "data:image/png;base64,aGVsbG8=";
  const req = imageGenerationsToResponsesRequest({ prompt: "make it mint", image: png });
  assert.deepEqual(req.input[0].content[0], { type: "input_image", image_url: png });
  assert.equal(req.input[0].content[1].type, "input_text");
  assert.match(req.input[0].content[1].text, /Edit the attached reference image/);
});

test("imageGenerationsToResponsesRequest sets the generate verb without references", () => {
  const req = imageGenerationsToResponsesRequest({ prompt: "a duck" });
  assert.match(req.input[0].content[0].text, /^Draw the following image\./);
});

test("toInputImage sniffs bare base64 and builds a data URL", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  const part = toInputImage(png.toString("base64"));
  assert.match(part.image_url, /^data:image\/png;base64,/);
});

test("toInputImage accepts a raw Buffer from a multipart upload", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
  assert.match(toInputImage(jpeg).image_url, /^data:image\/jpeg;base64,/);
});

test("toInputImage rejects bytes that are not a known image container", () => {
  assert.throws(() => toInputImage(Buffer.from("not an image at all")), /not a PNG/);
});

test("toInputImage rejects a non-image data URL", () => {
  assert.throws(() => toInputImage("data:text/plain;base64,aGk="), /image\/\* data/);
});

test("toInputImage refuses remote URLs unless explicitly allowed", () => {
  assert.throws(() => toInputImage("https://example.com/a.png"), /disabled/);
  assert.equal(
    toInputImage("https://example.com/a.png", { allowRemote: true }).image_url,
    "https://example.com/a.png",
  );
});

test("toInputImages caps the number of references", () => {
  const png = "data:image/png;base64,aGVsbG8=";
  assert.equal(toInputImages(Array(8).fill(png)).length, 8);
  assert.throws(() => toInputImages(Array(9).fill(png)), /At most 8/);
});

test("toInputImages treats an absent value as no references", () => {
  assert.deepEqual(toInputImages(undefined), []);
});

test("collectImageFromEvent prefers a completed result over a partial preview", () => {
  let acc = collectImageFromEvent({
    type: "response.image_generation_call.partial_image",
    partial_image_b64: "partial",
    revised_prompt: "draft",
  });
  acc = collectImageFromEvent(
    {
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: "final", revised_prompt: "final prompt" },
    },
    acc,
  );
  assert.equal(acc.b64, "final");
  assert.equal(acc.partial, false);
  assert.equal(acc.revised_prompt, "final prompt");
});

test("buildImageGenerationResponse shapes an OpenAI images payload", () => {
  const res = buildImageGenerationResponse({
    created: 1,
    b64: "abc",
    revisedPrompt: "apple",
    outputFormat: "webp",
    size: "1200x628",
  });
  assert.deepEqual(res, {
    created: 1,
    data: [{ b64_json: "abc", revised_prompt: "apple" }],
    output_format: "webp",
    size: "1200x628",
  });
});

test("buildImageGenerationResponse surfaces a transform warning", () => {
  const res = buildImageGenerationResponse({ created: 1, b64: "abc", warning: "nope" });
  assert.equal(res.warning, "nope");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletionsToResponsesRequest,
  parseSSEEvents,
  responsesEventToChatChunk,
  buildChatCompletionResponse,
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

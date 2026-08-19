import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("GET /agent.md returns markdown without auth", async () => {
  const server = createServer({ apiKey: "test-key" });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agent.md`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/markdown/);
    assert.match(body, /# Codex OpenAI Proxy/);
    assert.match(body, /\/v1\/images\/generations/);
    assert.match(body, /<PROXY_API_KEY>/);
    assert.doesNotMatch(body, /Authorization: Bearer [A-Za-z0-9_-]{20,}/);
  } finally {
    server.close();
  }
});

test("GET /llms.txt is an alias for the agent guide", async () => {
  const server = createServer({ apiKey: "test-key" });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Agent Guide/);
  } finally {
    server.close();
  }
});

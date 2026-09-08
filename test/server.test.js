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

async function withServer(options, fn) {
  const server = createServer({ apiKey: "test-key", ...options });
  const port = await listen(server);
  try {
    return await fn((path, init) => fetch(`http://127.0.0.1:${port}${path}`, init));
  } finally {
    server.close();
  }
}

const AUTH = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

test("GET /v1/images/sizes lists the banner presets and capabilities", async () => {
  await withServer({}, async (call) => {
    const res = await call("/v1/images/sizes", { headers: AUTH });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.formats, ["png", "jpeg", "webp"]);
    assert.ok(body.data.some((p) => p.name === "leaderboard" && p.size === "728x90"));
    assert.equal(typeof body.local_backends.pillow, "boolean");
  });
});

test("GET /v1/images/sizes still requires the API key", async () => {
  await withServer({}, async (call) => {
    assert.equal((await call("/v1/images/sizes")).status, 401);
  });
});

// These stop at request validation, so they never reach the Codex backend.
test("POST /v1/images/generations rejects an unsupported output format", async () => {
  await withServer({}, async (call) => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ prompt: "a duck", output_format: "gif" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Unsupported `output_format`/);
  });
});

test("POST /v1/images/generations rejects an unknown size preset", async () => {
  await withServer({}, async (call) => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ prompt: "a duck", size: "banner-ish" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Unsupported `size`/);
  });
});

test("POST /v1/images/generations refuses a remote reference image by default", async () => {
  await withServer({}, async (call) => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ prompt: "recolour it", image: "https://example.com/a.png" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /--allow-remote-images/);
  });
});

test("POST /v1/images/edits requires a reference image", async () => {
  await withServer({}, async (call) => {
    const res = await call("/v1/images/edits", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ prompt: "recolour it" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /`image` is required/);
  });
});

test("POST /v1/images/edits reads a multipart upload", async () => {
  await withServer({}, async (call) => {
    const form = new FormData();
    form.set("prompt", "recolour it");
    // Not a real image: it must fail on the reference bytes, proving the
    // multipart parts were read and handed to the image pipeline.
    form.set("image", new Blob([Buffer.from("nonsense")], { type: "image/png" }), "ref.png");
    const res = await call("/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      body: form,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /not a PNG/);
  });
});

test("POST /v1/images/generations rejects mask and url response formats", async () => {
  await withServer({}, async (call) => {
    for (const [payload, pattern] of [
      [{ prompt: "x", mask: "abc" }, /not supported/],
      [{ prompt: "x", response_format: "url" }, /b64_json/],
    ]) {
      const res = await call("/v1/images/generations", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, pattern);
    }
  });
});

test("oversized bodies are refused with 413 instead of buffered", async () => {
  await withServer({ maxBodyBytes: 1024 }, async (call) => {
    const res = await call("/v1/images/generations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ prompt: "x".repeat(4096) }),
    });
    assert.equal(res.status, 413);
  });
});

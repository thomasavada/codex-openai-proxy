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

function sseResponse(events, status = 200) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("POST /v1/responses preserves web-search evidence and real usage", async () => {
  let upstream;
  const output = [
    {
      id: "ws_test",
      type: "web_search_call",
      status: "completed",
      action: {
        sources: [{ url: "https://apps.shopify.com/loyaltylion", title: "LoyaltyLion" }],
      },
    },
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "1. LoyaltyLion" }],
    },
  ];
  const completed = {
    id: "resp_test",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    output: [],
    usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 },
  };

  await withServer(
    {
      tokenProvider: async () => ({ accessToken: "codex-token", accountId: "account-1" }),
      backendFetch: async (url, init) => {
        upstream = { url, init, body: JSON.parse(init.body) };
        return sseResponse([
          { type: "response.created", response: { id: "resp_test" } },
          ...output.map((item, output_index) => ({
            type: "response.output_item.done",
            output_index,
            item,
          })),
          { type: "response.completed", response: completed },
        ]);
      },
    },
    async (call) => {
      const request = {
        model: "gpt-5.6-sol",
        input: "Rank Shopify loyalty apps",
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
        stream: false,
      };
      const res = await call("/v1/responses", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(request),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ...completed, output });
      assert.equal(upstream.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(upstream.init.headers.Authorization, "Bearer codex-token");
      assert.equal(upstream.init.headers["chatgpt-account-id"], "account-1");
      assert.deepEqual(upstream.body.tools, request.tools);
      assert.deepEqual(upstream.body.include, request.include);
      assert.deepEqual(upstream.body.input, [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request.input }],
        },
      ]);
      assert.equal(upstream.body.stream, true);
      assert.equal(upstream.body.store, false);
    },
  );
});

test("POST /v1/responses streams upstream Responses events unchanged", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "Loyalty" },
    { type: "response.output_text.delta", delta: "Lion" },
    { type: "response.completed", response: { id: "resp_stream", status: "completed" } },
  ];
  const expected = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;

  await withServer(
    {
      tokenProvider: async () => ({ accessToken: "codex-token", accountId: "account-1" }),
      backendFetch: async () => sseResponse(events),
    },
    async (call) => {
      const res = await call("/v1/responses", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "Rank apps", stream: true }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      assert.equal(await res.text(), expected);
    },
  );
});

test("POST /v1/responses refreshes Codex OAuth once after an upstream 401", async () => {
  const tokenCalls = [];
  let backendCalls = 0;
  await withServer(
    {
      tokenProvider: async (_path, options = {}) => {
        tokenCalls.push(options);
        return {
          accessToken: options.forceRefresh ? "fresh-token" : "stale-token",
          accountId: "account-1",
        };
      },
      backendFetch: async (_url, init) => {
        backendCalls += 1;
        if (init.headers.Authorization === "Bearer stale-token") {
          return new Response("expired", { status: 401 });
        }
        return sseResponse([
          {
            type: "response.completed",
            response: { id: "resp_refreshed", object: "response", status: "completed", output: [] },
          },
        ]);
      },
    },
    async (call) => {
      const res = await call("/v1/responses", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "Hello" }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).id, "resp_refreshed");
      assert.equal(backendCalls, 2);
      assert.deepEqual(tokenCalls, [{}, { forceRefresh: true }]);
    },
  );
});

test("POST /v1/responses returns native failed and incomplete terminal responses", async () => {
  for (const status of ["failed", "incomplete"]) {
    const terminal = {
      id: `resp_${status}`,
      object: "response",
      status,
      output: [],
      ...(status === "failed" ? { error: { message: "upstream failed" } } : {}),
    };
    await withServer(
      {
        tokenProvider: async () => ({ accessToken: "codex-token", accountId: "account-1" }),
        backendFetch: async () =>
          sseResponse([{ type: `response.${status}`, response: terminal }]),
      },
      async (call) => {
        const res = await call("/v1/responses", {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "Hello" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), terminal);
      },
    );
  }
});

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

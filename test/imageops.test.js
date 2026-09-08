import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  parseSize,
  parseOutputFormat,
  parseFit,
  parseBackground,
  detectImageMime,
  canvasHint,
  transformImage,
  availableBackends,
  resetBackendCache,
} from "../src/imageops.js";

test("parseSize accepts explicit pixel dimensions", () => {
  assert.deepEqual(parseSize("1200x628"), { width: 1200, height: 628 });
  assert.deepEqual(parseSize("1200 X 628"), { width: 1200, height: 628 });
});

test("parseSize resolves named banner presets", () => {
  assert.deepEqual(parseSize("leaderboard"), { width: 728, height: 90 });
  assert.deepEqual(parseSize("og"), { width: 1200, height: 630 });
  assert.deepEqual(parseSize("story"), { width: 1080, height: 1920 });
});

test("parseSize treats auto and absent as no constraint", () => {
  assert.equal(parseSize("auto"), null);
  assert.equal(parseSize(undefined), null);
  assert.equal(parseSize(""), null);
});

test("parseSize rejects nonsense and oversized frames", () => {
  assert.throws(() => parseSize("huge"), /Unsupported `size`/);
  assert.throws(() => parseSize("99999x10"), /between 1x1/);
  assert.throws(() => parseSize("0x10"), /between 1x1/);
});

test("parseOutputFormat normalises aliases and defaults to png", () => {
  assert.equal(parseOutputFormat(undefined), "png");
  assert.equal(parseOutputFormat("JPG"), "jpeg");
  assert.equal(parseOutputFormat("webp"), "webp");
  assert.throws(() => parseOutputFormat("gif"), /Unsupported `output_format`/);
});

test("parseFit defaults to cover and rejects unknown modes", () => {
  assert.equal(parseFit(undefined), "cover");
  assert.equal(parseFit("contain"), "contain");
  assert.throws(() => parseFit("squish"), /Unsupported `fit`/);
});

test("parseBackground maps keywords and hex colours", () => {
  assert.equal(parseBackground(undefined), "transparent");
  assert.equal(parseBackground("opaque"), "#ffffff");
  assert.equal(parseBackground("#00A8A8"), "#00a8a8");
  assert.throws(() => parseBackground("teal"), /#rrggbb/);
});

test("detectImageMime sniffs the common containers", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectImageMime(png), "image/png");
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(detectImageMime(webp), "image/webp");
  assert.equal(detectImageMime(Buffer.from("hello world!!")), null);
});

test("canvasHint describes the frame shape and exact pixels", () => {
  assert.match(canvasHint({ width: 728, height: 90 }), /extremely wide, short banner strip/);
  assert.match(canvasHint({ width: 160, height: 600 }), /extremely tall, narrow vertical strip/);
  assert.match(canvasHint({ width: 1080, height: 1920 }), /tall vertical frame/);
  assert.match(canvasHint({ width: 1080, height: 1080 }), /square frame/);
  assert.match(canvasHint({ width: 1200, height: 628 }), /exactly 1200x628 pixels/);
});

function makeSourcePng(width, height) {
  return execFileSync("python3", [
    "-c",
    "import sys;from PIL import Image;Image.new('RGB',(int(sys.argv[1]),int(sys.argv[2])),(0,168,168)).save(sys.stdout.buffer,'PNG')",
    String(width),
    String(height),
  ]);
}

function dimensionsOf(buffer) {
  const out = execFileSync(
    "python3",
    ["-c", "import sys;from PIL import Image;im=Image.open(sys.stdin.buffer);print(im.width,im.height,im.format)"],
    { input: buffer, encoding: "utf8" },
  );
  const [width, height, format] = out.trim().split(" ");
  return { width: Number(width), height: Number(height), format };
}

const backends = await availableBackends();

test(
  "transformImage crops to the exact requested frame",
  { skip: backends.pillow ? false : "needs Pillow" },
  async () => {
    const result = await transformImage(makeSourcePng(1672, 941), {
      width: 728,
      height: 90,
      format: "png",
      fit: "cover",
      background: "transparent",
    });
    assert.equal(result.transformed, true);
    assert.deepEqual(dimensionsOf(result.buffer), { width: 728, height: 90, format: "PNG" });
  },
);

test(
  "transformImage encodes webp and jpeg at the requested size",
  { skip: backends.pillow ? false : "needs Pillow" },
  async () => {
    const source = makeSourcePng(1254, 1254);
    for (const [format, expected] of [
      ["webp", "WEBP"],
      ["jpeg", "JPEG"],
    ]) {
      const result = await transformImage(source, {
        width: 300,
        height: 250,
        format,
        fit: "cover",
        background: "transparent",
      });
      assert.deepEqual(dimensionsOf(result.buffer), { width: 300, height: 250, format: expected });
    }
  },
);

test(
  "transformImage contain pads instead of cropping",
  { skip: backends.pillow ? false : "needs Pillow" },
  async () => {
    const result = await transformImage(makeSourcePng(1000, 1000), {
      width: 970,
      height: 250,
      format: "png",
      fit: "contain",
      background: "#ffffff",
    });
    assert.deepEqual(dimensionsOf(result.buffer), { width: 970, height: 250, format: "PNG" });
  },
);

test("transformImage leaves the bytes untouched when fit is none", async () => {
  const source = makeSourcePng(64, 64);
  const result = await transformImage(source, {
    width: 10,
    height: 10,
    format: "png",
    fit: "none",
    background: "transparent",
  });
  assert.equal(result.transformed, false);
  assert.equal(result.buffer, source);
});

test("transformImage returns the original bytes rather than throwing on a bad input", async () => {
  const result = await transformImage(Buffer.from("definitely not an image"), {
    width: 10,
    height: 10,
    format: "png",
    fit: "cover",
    background: "transparent",
  });
  assert.equal(result.transformed, false);
  assert.match(result.reason, /transform failed|no local image backend/);
});

// The sips path is unreachable on a host that has Pillow, so force it. sips can
// only *write* png and jpeg, which is why webp falls back to "untransformed".
test(
  "the sips fallback hits the exact frame for png and jpeg",
  { skip: backends.sips ? false : "needs sips (macOS)" },
  async () => {
    process.env.CODEX_PROXY_IMAGE_BACKEND = "sips";
    resetBackendCache();
    try {
      const source = makeSourcePng(1672, 941);
      for (const [format, expected, fit] of [
        ["png", "PNG", "cover"],
        ["jpeg", "JPEG", "cover"],
        ["png", "PNG", "contain"],
        ["png", "PNG", "fill"],
      ]) {
        const result = await transformImage(source, {
          width: 728,
          height: 90,
          format,
          fit,
          background: "#ffffff",
        });
        assert.equal(result.backend, "sips", `${format}/${fit} should use sips`);
        assert.deepEqual(dimensionsOf(result.buffer), { width: 728, height: 90, format: expected });
      }
    } finally {
      delete process.env.CODEX_PROXY_IMAGE_BACKEND;
      resetBackendCache();
    }
  },
);

test(
  "webp degrades gracefully when only sips is available",
  { skip: backends.sips ? false : "needs sips (macOS)" },
  async () => {
    process.env.CODEX_PROXY_IMAGE_BACKEND = "sips";
    resetBackendCache();
    try {
      const source = makeSourcePng(400, 400);
      const result = await transformImage(source, {
        width: 300,
        height: 250,
        format: "webp",
        fit: "cover",
        background: "transparent",
      });
      assert.equal(result.transformed, false);
      assert.match(result.reason, /webp/);
      assert.equal(result.buffer, source);
    } finally {
      delete process.env.CODEX_PROXY_IMAGE_BACKEND;
      resetBackendCache();
    }
  },
);

test("with no local backend the original image is returned with a reason", async () => {
  process.env.CODEX_PROXY_IMAGE_BACKEND = "none";
  resetBackendCache();
  try {
    const source = makeSourcePng(400, 400);
    const result = await transformImage(source, {
      width: 300,
      height: 250,
      format: "png",
      fit: "cover",
      background: "transparent",
    });
    assert.equal(result.transformed, false);
    assert.match(result.reason, /no local image backend/);
    assert.equal(result.buffer, source);
  } finally {
    delete process.env.CODEX_PROXY_IMAGE_BACKEND;
    resetBackendCache();
  }
});

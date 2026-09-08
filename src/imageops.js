import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Named frames agents can ask for instead of memorising pixel pairs. Social
// sizes are the platforms' published upload specs; the ad units are the IAB
// standard slots.
export const SIZE_PRESETS = {
  // Social
  square: "1080x1080",
  instagram: "1080x1080",
  "instagram-portrait": "1080x1350",
  story: "1080x1920",
  reel: "1080x1920",
  tiktok: "1080x1920",
  og: "1200x630",
  facebook: "1200x630",
  linkedin: "1200x627",
  twitter: "1600x900",
  x: "1600x900",
  pinterest: "1000x1500",
  "youtube-thumbnail": "1280x720",
  // IAB display ad units
  leaderboard: "728x90",
  "large-leaderboard": "970x90",
  billboard: "970x250",
  "medium-rectangle": "300x250",
  mrec: "300x250",
  "large-rectangle": "336x280",
  "half-page": "300x600",
  "wide-skyscraper": "160x600",
  "mobile-leaderboard": "320x50",
  "mobile-banner": "300x50",
  // Web / email / product
  hero: "1920x1080",
  "hero-wide": "1920x600",
  "email-header": "600x200",
  "app-icon": "1024x1024",
};

const MAX_DIMENSION = 8192;

// Accepts "1200x628", "1200X628", "1200 x 628" or a SIZE_PRESETS name.
// Returns null for auto/unset (let the model choose its own canvas).
export function parseSize(size) {
  if (size === undefined || size === null) return null;
  const raw = String(size).trim().toLowerCase();
  if (!raw || raw === "auto") return null;

  const resolved = SIZE_PRESETS[raw] ?? raw;
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(resolved);
  if (!match) throw new Error(`Unsupported \`size\`: ${size}`);

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`\`size\` must be between 1x1 and ${MAX_DIMENSION}x${MAX_DIMENSION}`);
  }
  return { width, height };
}

const FORMAT_ALIASES = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
};

export const OUTPUT_FORMATS = Object.freeze(["png", "jpeg", "webp"]);

export function parseOutputFormat(format) {
  if (format === undefined || format === null || format === "") return "png";
  const key = String(format).trim().toLowerCase();
  const resolved = FORMAT_ALIASES[key];
  if (!resolved) {
    throw new Error(`Unsupported \`output_format\`: ${format}. Use png, jpeg or webp.`);
  }
  return resolved;
}

const FITS = new Set(["cover", "contain", "fill", "none"]);

export function parseFit(fit) {
  if (fit === undefined || fit === null || fit === "") return "cover";
  const key = String(fit).trim().toLowerCase();
  if (!FITS.has(key)) {
    throw new Error(`Unsupported \`fit\`: ${fit}. Use cover, contain, fill or none.`);
  }
  return key;
}

// "transparent" only survives into PNG/WebP; JPEG flattens it to white.
export function parseBackground(background) {
  if (background === undefined || background === null || background === "") return "transparent";
  const raw = String(background).trim().toLowerCase();
  if (raw === "transparent" || raw === "auto") return "transparent";
  if (raw === "opaque" || raw === "white") return "#ffffff";
  const match = /^#?([0-9a-f]{6})$/.exec(raw);
  if (!match) throw new Error("`background` must be transparent, opaque or a #rrggbb hex colour");
  return `#${match[1]}`;
}

export const MIME_BY_FORMAT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

// Sniff the container from magic bytes; callers may not send a content type
// (bare base64) and we never want to trust a client-declared one blindly.
export function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  return null;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function ratioLabel(width, height) {
  const divisor = gcd(width, height) || 1;
  const w = width / divisor;
  const h = height / divisor;
  if (w <= 40 && h <= 40) return `${w}:${h}`;
  return `${(width / height).toFixed(2)}:1`;
}

// The upstream image tool picks its own canvas and ignores the `size` field, so
// the only lever on composition is the prompt. Describing the frame gets the
// model close; `transformImage` lands the exact pixels afterwards.
export function canvasHint({ width, height }) {
  const ratio = width / height;
  const shape =
    ratio >= 2.2
      ? "an extremely wide, short banner strip"
      : ratio >= 1.15
        ? "a wide horizontal frame"
        : ratio <= 1 / 2.2
          ? "an extremely tall, narrow vertical strip"
          : ratio <= 1 / 1.15
            ? "a tall vertical frame"
            : "a square frame";
  return (
    `\n\nCanvas: compose this as ${shape} of exactly ${width}x${height} pixels ` +
    `(aspect ratio ${ratioLabel(width, height)}). Fill the frame edge to edge — no borders, ` +
    `letterboxing or padding. Keep subjects and any text well inside the frame, because the ` +
    `edges may be cropped to hit the exact dimensions.`
  );
}

const PY_TRANSFORM = `
import sys
from PIL import Image

src, dst, w, h, fit, fmt, bg, quality = sys.argv[1:9]
w, h, quality = int(w), int(h), int(quality)
im = Image.open(src)
im = im.convert("RGBA" if im.mode not in ("RGB", "RGBA") else im.mode)

def pad_colour():
    if bg == "transparent":
        return (0, 0, 0, 0)
    return tuple(int(bg[i:i + 2], 16) for i in (1, 3, 5)) + (255,)

if fit == "fill":
    out = im.resize((w, h), Image.LANCZOS)
else:
    ratios = (w / im.width, h / im.height)
    scale = max(ratios) if fit == "cover" else min(ratios)
    nw, nh = max(1, round(im.width * scale)), max(1, round(im.height * scale))
    resized = im.resize((nw, nh), Image.LANCZOS)
    if fit == "cover":
        left, top = (nw - w) // 2, (nh - h) // 2
        out = resized.crop((left, top, left + w, top + h))
    else:
        out = Image.new("RGBA", (w, h), pad_colour())
        out.paste(resized, ((w - nw) // 2, (h - nh) // 2), resized if resized.mode == "RGBA" else None)

if fmt == "JPEG":
    flat = Image.new("RGB", out.size, pad_colour()[:3] if bg != "transparent" else (255, 255, 255))
    flat.paste(out, mask=out.split()[-1] if out.mode == "RGBA" else None)
    flat.save(dst, "JPEG", quality=quality, optimize=True)
elif fmt == "WEBP":
    out.save(dst, "WEBP", quality=quality, method=5)
else:
    out.save(dst, "PNG", optimize=True)
`;

let backendsPromise;

async function probeBackends() {
  const backends = { pillow: false, sips: false };
  // Escape hatch for exercising a specific path (the fallback is otherwise
  // unreachable on any host that has Pillow).
  const forced = process.env.CODEX_PROXY_IMAGE_BACKEND;
  try {
    await run("python3", ["-c", "from PIL import Image, features; assert features.check('webp')"]);
    backends.pillow = true;
  } catch {
    // No Pillow (or no WebP support in it) — fall back to sips where possible.
  }
  try {
    await run("sips", ["--formats"]);
    backends.sips = true;
  } catch {
    // Not macOS, or sips unavailable.
  }
  if (forced === "sips") backends.pillow = false;
  if (forced === "pillow") backends.sips = false;
  if (forced === "none") return { pillow: false, sips: false };
  return backends;
}

export function availableBackends() {
  backendsPromise ??= probeBackends();
  return backendsPromise;
}

// Only used for testing / re-probing after a environment change.
export function resetBackendCache() {
  backendsPromise = undefined;
}

async function sipsDimensions(path) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!width || !height) throw new Error("sips could not read the image dimensions");
  return { width, height };
}

// sips can only *write* png and jpeg, so WebP output always needs Pillow.
async function transformWithSips(dir, src, dst, { width, height, format, fit, background, quality }) {
  const source = await sipsDimensions(src);
  const scaled = join(dir, "scaled");
  const framed = fit === "fill" ? scaled : join(dir, "framed");

  if (fit === "fill") {
    await run("sips", ["-z", String(height), String(width), src, "--out", scaled]);
  } else {
    const ratios = [width / source.width, height / source.height];
    const scale = fit === "cover" ? Math.max(...ratios) : Math.min(...ratios);
    const nw = Math.max(1, Math.round(source.width * scale));
    const nh = Math.max(1, Math.round(source.height * scale));
    await run("sips", ["-z", String(nh), String(nw), src, "--out", scaled]);
  }

  if (fit !== "fill") {
    // `-c` crops centred when the image is larger than the frame and pads it
    // centred when it is smaller, which covers both cover and contain.
    const cropArgs = ["-c", String(height), String(width), scaled, "--out", framed];
    if (background !== "transparent") cropArgs.push("--padColor", background.slice(1));
    await run("sips", cropArgs);
  }

  const formatArgs = ["-s", "format", format, framed, "--out", dst];
  if (format === "jpeg") formatArgs.push("-s", "formatOptions", String(quality));
  await run("sips", formatArgs);
}

/**
 * Resize/crop `buffer` to exactly width x height in `format`.
 *
 * Never throws for an unusable environment: if no local image backend can
 * produce the requested format the original bytes come back with
 * `transformed: false` and a reason, so a 30s generation is not wasted just
 * because the frame could not be trimmed.
 */
export async function transformImage(buffer, { width, height, format, fit, background, quality = 90 }) {
  if (fit === "none") return { buffer, transformed: false, reason: "fit=none" };

  const backends = await availableBackends();
  const backend = backends.pillow ? "pillow" : backends.sips && format !== "webp" ? "sips" : null;
  if (!backend) {
    return {
      buffer,
      transformed: false,
      reason:
        format === "webp"
          ? "no local image backend can resize webp (install Pillow: pip3 install pillow)"
          : "no local image backend available (install Pillow: pip3 install pillow)",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "codex-proxy-img-"));
  const src = join(dir, "src");
  const dst = join(dir, `out.${format}`);
  try {
    await writeFile(src, buffer);
    if (backend === "pillow") {
      await run("python3", [
        "-c",
        PY_TRANSFORM,
        src,
        dst,
        String(width),
        String(height),
        fit,
        format.toUpperCase(),
        background,
        String(quality),
      ]);
    } else {
      await transformWithSips(dir, src, dst, { width, height, format, fit, background, quality });
    }
    return { buffer: await readFile(dst), transformed: true, backend };
  } catch (err) {
    console.error("Local image transform failed", err);
    return { buffer, transformed: false, reason: "local image transform failed" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

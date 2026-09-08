import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMultipart, boundaryOf } from "../src/multipart.js";

const BOUNDARY = "----codextest";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

function body(parts) {
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const headers = part.filename
      ? `Content-Disposition: ${disposition}\r\nContent-Type: ${part.contentType}\r\n`
      : `Content-Disposition: ${disposition}\r\n`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

test("boundaryOf reads plain and quoted boundaries", () => {
  assert.equal(boundaryOf("multipart/form-data; boundary=abc"), "abc");
  assert.equal(boundaryOf('multipart/form-data; boundary="a b c"'), "a b c");
  assert.equal(boundaryOf("application/json"), null);
});

test("parseMultipart separates text fields from file parts", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d]);
  const { fields, files } = parseMultipart(
    body([
      { name: "prompt", data: "make it mint green" },
      { name: "size", data: "1200x628" },
      { name: "image", filename: "ref.png", contentType: "image/png", data: png },
    ]),
    CONTENT_TYPE,
  );
  assert.equal(fields.prompt, "make it mint green");
  assert.equal(fields.size, "1200x628");
  assert.equal(files.image.length, 1);
  assert.ok(files.image[0].data.equals(png));
});

test("parseMultipart keeps binary parts byte-exact", () => {
  const blob = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  const { files } = parseMultipart(
    body([{ name: "image", filename: "b.bin", contentType: "application/octet-stream", data: blob }]),
    CONTENT_TYPE,
  );
  assert.ok(files.image[0].data.equals(blob));
});

test("parseMultipart collapses image[] into the image bucket", () => {
  const { files } = parseMultipart(
    body([
      { name: "image[]", filename: "a.png", contentType: "image/png", data: "a" },
      { name: "image[]", filename: "b.png", contentType: "image/png", data: "b" },
    ]),
    CONTENT_TYPE,
  );
  assert.equal(files.image.length, 2);
  assert.deepEqual(files.image.map((f) => f.data.toString()), ["a", "b"]);
});

test("parseMultipart rejects a body with no boundary", () => {
  assert.throws(() => parseMultipart(Buffer.from(""), "multipart/form-data"), /boundary/);
});

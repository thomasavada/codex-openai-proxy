// Minimal multipart/form-data reader — just enough for the OpenAI images
// edits/variations shape (a handful of text fields plus image file parts).
// Dependency-free on purpose; it is not a general-purpose RFC 7578 parser.

const DASH_DASH = Buffer.from("--");
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export function boundaryOf(contentType) {
  if (!contentType) return null;
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2]) : null;
}

function parseDisposition(headerBlock) {
  const line = headerBlock
    .split("\r\n")
    .find((h) => /^content-disposition:/i.test(h));
  if (!line) return null;
  const name = /;\s*name="([^"]*)"/i.exec(line)?.[1];
  const filename = /;\s*filename="([^"]*)"/i.exec(line)?.[1];
  const contentType = headerBlock
    .split("\r\n")
    .find((h) => /^content-type:/i.test(h))
    ?.split(":")[1]
    ?.trim();
  return name === undefined ? null : { name, filename, contentType };
}

/**
 * Returns `{ fields, files }` where `fields` maps a field name to its last text
 * value and `files` maps a field name to an array of `{ filename, contentType,
 * data }`. Field names keep any `[]` suffix stripped, so `image` and `image[]`
 * land in the same bucket.
 */
export function parseMultipart(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("multipart/form-data body is missing a boundary");

  const delimiter = Buffer.concat([DASH_DASH, Buffer.from(boundary)]);
  const fields = {};
  const files = {};

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw new Error("multipart/form-data body has no parts");

  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // Closing delimiter is `--boundary--`.
    if (body.subarray(start, start + 2).equals(DASH_DASH)) break;
    if (body.subarray(start, start + 2).equals(CRLF)) start += 2;

    const next = body.indexOf(delimiter, start);
    const rawEnd = next === -1 ? body.length : next;
    // Trim the CRLF that precedes the next delimiter.
    const partEnd = body.subarray(rawEnd - 2, rawEnd).equals(CRLF) ? rawEnd - 2 : rawEnd;

    const headerEnd = body.indexOf(HEADER_END, start);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const disposition = parseDisposition(body.subarray(start, headerEnd).toString("utf8"));
      const data = body.subarray(headerEnd + HEADER_END.length, partEnd);
      if (disposition) {
        const name = disposition.name.replace(/\[\]$/, "");
        if (disposition.filename !== undefined) {
          (files[name] ??= []).push({
            filename: disposition.filename,
            contentType: disposition.contentType,
            data: Buffer.from(data),
          });
        } else {
          fields[name] = data.toString("utf8");
        }
      }
    }

    cursor = next;
  }

  return { fields, files };
}

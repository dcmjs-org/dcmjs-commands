// src/access/DicomWebFetch.js
//
// A DICOMweb client on the global fetch: no XHR, no jsdom, no
// dicomweb-client. Exported as @dcmjs/commands/dicomweb-fetch.

import { findToken, stringToUint8Array } from "../utils/message.js";

/** Frames: any image media type first, raw pixel data second. */
export const FRAME_ACCEPT =
  'multipart/related; type="image/*", multipart/related; type="application/octet-stream"';
/** Part 10: the instance in whatever transfer syntax the server holds. */
export const PART10_ACCEPT =
  'multipart/related; type="application/dicom"; transfer-syntax=*';
/** Bulkdata default; without transfer-syntax this is Explicit VR Little Endian. */
export const OCTET_STREAM_ACCEPT =
  'multipart/related; type="application/octet-stream"';
const JSON_ACCEPT = "application/dicom+json, application/json";

/**
 * An HTTP error from the DICOMweb server.
 * `status` is the HTTP status, `retryAfter` the raw Retry-After header
 * (or null), and `url` the request URL.
 */
export class DicomWebFetchError extends Error {
  constructor(response, url) {
    super(`DICOMweb request ${url} failed: ${response.status}`);
    this.name = "DicomWebFetchError";
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after");
    this.url = url;
  }
}

/**
 * A DICOMweb client on the global `fetch`.
 *
 * Every method takes an optional `{ signal }` (an AbortSignal). The
 * frame, bulkdata, and Part 10 methods also take `{ accept }`, and resolve
 * to an async iterable of parts `{ headers, body }`: `headers` is a
 * `Headers`, and `body` is a web `ReadableStream` of that part only. Read
 * (or cancel) each body before you ask for the next part. A response that
 * is not multipart is one part with the response headers and body.
 * An HTTP error rejects with a {@link DicomWebFetchError}.
 */
export class DicomWebFetch {
  /**
   * @param {Object} options
   * @param {string} options.url - the DICOMweb root, e.g. https://host/dicomweb
   * @param {Object|Function} [options.headers] - headers for every request
   *   to the origin of `url` (not to other hosts), or an (async) function
   *   that returns them, e.g. for a fresh token
   */
  constructor({ url, headers = {} }) {
    this.url = url.replace(/\/+$/, "");
    this.headers = headers;
  }

  async request(path, accept, signal) {
    const url = new URL(path, `${this.url}/`).href;
    // Credentials go only to the DICOMweb origin, never to another host
    // named by an absolute BulkDataURI in server metadata.
    const sameOrigin = new URL(url).origin === new URL(this.url).origin;
    const headers = !sameOrigin
      ? {}
      : typeof this.headers === "function"
        ? await this.headers()
        : this.headers;
    const response = await fetch(url, {
      headers: { ...headers, Accept: accept },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DicomWebFetchError(response, url);
    }
    return response;
  }

  async json(path, signal) {
    const response = await this.request(path, JSON_ACCEPT, signal);
    return response.status === 204 ? [] : response.json();
  }

  async parts(path, accept, signal) {
    return responseParts(await this.request(path, accept, signal));
  }

  /**
   * QIDO-RS. `level` is "studies", "series", "instances", or a scoped
   * path such as `studies/<uid>/series`; `query` holds the query keys.
   */
  search(level, query = {}, { signal } = {}) {
    const search = new URLSearchParams(query).toString();
    return this.json(search ? `${level}?${search}` : level, signal);
  }

  retrieveMetadata(study, series, instance, { signal } = {}) {
    return this.json(`${uidPath(study, series, instance)}/metadata`, signal);
  }

  /** `frames` is a frame number or an array of frame numbers (1-based). */
  retrieveFrames(
    study,
    series,
    instance,
    frames,
    { accept = FRAME_ACCEPT, signal } = {}
  ) {
    const list = [frames].flat().join(",");
    return this.parts(
      `${uidPath(study, series, instance)}/frames/${list}`,
      accept,
      signal
    );
  }

  retrieveInstance(
    study,
    series,
    instance,
    { accept = PART10_ACCEPT, signal } = {}
  ) {
    return this.parts(uidPath(study, series, instance), accept, signal);
  }

  /** `uri` is absolute, or relative to the DICOMweb root. */
  retrieveBulkData(uri, { accept = OCTET_STREAM_ACCEPT, signal } = {}) {
    return this.parts(uri, accept, signal);
  }
}

function uidPath(study, series, instance) {
  let path = `studies/${study}`;
  if (series) path += `/series/${series}`;
  if (instance) path += `/instances/${instance}`;
  return path;
}

/** The boundary parameter of a multipart Content-Type, or null. */
function boundaryOf(contentType) {
  if (!/^multipart\//i.test(contentType)) return null;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? match[1] || match[2] : null;
}

/**
 * Splits a fetch Response into parts as it streams. Only one part (plus
 * one boundary length) is in memory at a time.
 */
export async function* responseParts(response) {
  const boundary = boundaryOf(response.headers.get("content-type") || "");
  if (!boundary) {
    yield { headers: response.headers, body: response.body };
    return;
  }
  const reader = response.body.getReader();
  const delimiter = stringToUint8Array(`\r\n--${boundary}`);
  const crlf2 = stringToUint8Array("\r\n\r\n");
  // A leading CRLF lets the first boundary match the same delimiter.
  let buf = stringToUint8Array("\r\n");
  let done = false;

  const more = async () => {
    if (done) return false;
    const r = await reader.read();
    if (r.done) {
      done = true;
      return false;
    }
    const next = new Uint8Array(buf.length + r.value.length);
    next.set(buf);
    next.set(r.value, buf.length);
    buf = next;
    return true;
  };
  const find = async (token) => {
    let index;
    while ((index = findToken(buf, token)) === -1) {
      if (!(await more())) throw new Error("Truncated multipart response");
    }
    return index;
  };
  // Discards up to and past `token`, keeping only a token-length tail while
  // it searches, so a skipped part is neither buffered nor re-scanned.
  const skipPast = async (token) => {
    let index;
    while ((index = findToken(buf, token)) === -1) {
      buf = buf.subarray(Math.max(0, buf.length - token.length + 1));
      if (!(await more())) throw new Error("Truncated multipart response");
    }
    buf = buf.subarray(index + token.length);
  };

  try {
    // Skip the preamble and the first delimiter.
    await skipPast(delimiter);
    for (;;) {
      while (buf.length < 2 && (await more()));
      if (buf[0] === 0x2d && buf[1] === 0x2d) return; // closing "--"
      const headerEnd = await find(crlf2);
      const headers = new Headers();
      // The first line is the rest of the boundary line (CRLF or padding).
      const lines = new TextDecoder("latin1")
        .decode(buf.subarray(0, headerEnd))
        .split("\r\n")
        .slice(1);
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers.append(line.slice(0, colon).trim(), line.slice(colon + 1));
        }
      }
      buf = buf.subarray(headerEnd + crlf2.length);

      let ended = false;
      let stale = false;
      let bodyController;
      // highWaterMark 0: read only on demand, so an unread body never
      // consumes bytes that belong to the next part.
      const body = new ReadableStream(
        {
          start(controller) {
            bodyController = controller;
          },
          async pull(controller) {
            for (;;) {
              const index = findToken(buf, delimiter);
              if (index !== -1) {
                if (index) controller.enqueue(buf.slice(0, index));
                buf = buf.subarray(index + delimiter.length);
                ended = true;
                controller.close();
                return;
              }
              // Keep a tail that can hold the start of a delimiter.
              const safe = buf.length - delimiter.length + 1;
              if (safe > 0) {
                controller.enqueue(buf.slice(0, safe));
                buf = buf.subarray(safe);
              }
              if (!(await more())) {
                throw new Error("Truncated multipart response");
              }
              if (stale) return;
              if (safe > 0) return;
            }
          },
        },
        { highWaterMark: 0 }
      );
      yield { headers, body };
      if (!ended) {
        // The caller skipped (or cancelled) this body: fail any later read
        // of it rather than hand back bytes of the next part, then discard.
        stale = true;
        bodyController.error(
          new Error("Part body read after the next part was requested")
        );
        await skipPast(delimiter);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export default DicomWebFetch;

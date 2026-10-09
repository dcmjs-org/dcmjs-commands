import https from "https";
import http from "http";
import zlib from "zlib";

const DEFAULT_TIMEOUT_MS = 30000;

export function httprequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const httpType = isHttps ? https : http;

    const req = httpType.request(urlObj, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(
          new Error(`Request to ${url} failed: statusCode=${res.statusCode}`)
        );
      }
      const body = [];
      res.on("data", function (chunk) {
        body.push(chunk);
      });
      res.on("end", function () {
        const contentEncoding = res.headers["content-encoding"];
        const contentType = res.headers["content-type"] || "";
        const isMultipart = contentType.startsWith("multipart/related");

        try {
          const buf = Buffer.concat(body);
          const uncompressed =
            contentEncoding === "gzip" ? zlib.gunzipSync(buf) : buf;

          if (isMultipart) {
            resolve({ multipart: true, buffer: uncompressed, contentType });
          } else {
            if (contentType.includes("application/json")) {
              const json = JSON.parse(uncompressed.toString());
              resolve(json);
            } else {
              resolve(uncompressed);
            }
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(options.timeout ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request to ${url} timed out`));
    });
    req.on("error", (e) => {
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    // send the request
    req.end();
  });
}

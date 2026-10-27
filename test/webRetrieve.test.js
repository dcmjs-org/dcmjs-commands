// test/webRetrieve.test.js

import http from "http";
import zlib from "zlib";
import net from "net";
import { httprequest } from "../src/webRetrieve.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

test("parses application/json responses", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ hello: "world" }));
  });
  const port = await listen(server);
  try {
    expect(await httprequest(`http://127.0.0.1:${port}/`)).toEqual({
      hello: "world",
    });
  } finally {
    server.close();
  }
});

test("gunzips gzip content-encoding", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("content-encoding", "gzip");
    res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
  });
  const port = await listen(server);
  try {
    expect(await httprequest(`http://127.0.0.1:${port}/`)).toEqual({
      zipped: true,
    });
  } finally {
    server.close();
  }
});

test("flags multipart/related responses", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "multipart/related; boundary=X");
    res.end("--X\r\n\r\npayload\r\n--X--");
  });
  const port = await listen(server);
  try {
    const result = await httprequest(`http://127.0.0.1:${port}/`);
    expect(result.multipart).toBe(true);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.contentType).toMatch(/^multipart\/related/);
  } finally {
    server.close();
  }
});

test("rejects error statuses with an Error", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end("nope");
  });
  const port = await listen(server);
  try {
    await expect(httprequest(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /404/
    );
  } finally {
    server.close();
  }
});

test("rejects connection errors with an Error instance", async () => {
  // Grab a port that is then closed again — nothing listens there.
  const probe = net.createServer();
  const port = await new Promise((resolve) => {
    probe.listen(0, () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  await expect(httprequest(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
    Error
  );
});

test("times out unresponsive servers", async () => {
  const server = http.createServer(() => {
    // never respond
  });
  const port = await listen(server);
  try {
    await expect(
      httprequest(`http://127.0.0.1:${port}/`, { timeout: 150 })
    ).rejects.toThrow(/timed out/i);
  } finally {
    server.close();
  }
}, 2000);

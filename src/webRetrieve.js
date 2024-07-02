import https from 'https';
import http from 'http';
import URL from 'url';
import zlib from 'zlib';

export function httprequest(url, _options) {
  return new Promise((resolve, reject) => {
    const urlObj = URL.parse(url, true);
    const isHttps = urlObj.protocol === 'https:';
    const httpType = isHttps ? https : http;

    const req = httpType.request(urlObj, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('statusCode=' + res.statusCode));
      }
      const body = [];
      res.on('data', function (chunk) {
        body.push(chunk);
      });
      res.on('end', function () {
        const contentEncoding = res.headers['content-encoding'];
        try {
          const buf = Buffer.concat(body);
          const uncompressed = contentEncoding === 'gzip' ? zlib.gunzipSync(buf) : buf;
          if (!uncompressed) {
            return uncompressed;
          }
          const json = JSON.parse(uncompressed?.toString());
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', (e) => {
      reject(e.message);
    });
    // send the request
    req.end();
  });
}
import fs from "fs";
import zlib from "zlib";

export function saveJson(filePath, data, zip = false) {
  // Uncomment the next line to save the raw json
  // fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const zipped = zlib.gzipSync(JSON.stringify(data));
  fs.writeFileSync(`${filePath}.gz`, zipped);
}

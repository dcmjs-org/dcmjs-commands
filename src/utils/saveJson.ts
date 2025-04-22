import { writeFile } from "fs/promises";
import { promisify } from "util";
import { gzip } from "zlib";

const gzipAsync = promisify(gzip);

export async function saveJson(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const zipped = await gzipAsync(json);
  await writeFile(`${filePath}.gz`, zipped);

  // Uncomment the next line to save the raw json
  // await writeFile(filePath, json);
}

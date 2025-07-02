import { writeStream } from "./writeStream";
import { Readable } from "stream";
import { finished } from "stream/promises";

export async function saveJson(dir, name, data, options = { mkdir: true }) {
  const json = JSON.stringify(data, null, 2);
  const out = await writeStream(dir, name, options);
  if (!json) {
    throw new Error("json not defined", json);
  }
  Readable.from([json]).pipe(out);
  await finished(out);
  await out.closePromise;
}

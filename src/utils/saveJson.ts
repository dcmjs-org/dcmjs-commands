import { writeStream } from "./writeStream";
import { Readable } from "stream";

export async function saveJson(dir, name, data, options = { mkdir: true }) {
  const json = JSON.stringify(data, null, 2);
  const out = writeStream(dir, name, options);
  Readable.from([json]).pipe(out);
  await out.closePromise;
}

import { writeStream } from "./writeStream";

export async function saveJson(dir, name, data, options = { mkdir: true }) {
  const json = JSON.stringify(data, null, 2);
  const out = writeStream(dir, name, options);
  await out.write(json);
  await out.close();
}

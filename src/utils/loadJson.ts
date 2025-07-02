import { promises as fs } from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { handleHomeRelative } from "./handleHomeRelative";

const gunzip = promisify(zlib.gunzip);

export async function loadJson(dirSrc, name, defaultReturn?) {
  let finalData;
  const dir = handleHomeRelative(dirSrc);
  try {
    const rawdata = await fs.readFile(path.join(dir, name));
    if (name.indexOf(".gz") != -1) {
      finalData = (await gunzip(rawdata, {})).toString("utf-8");
    } else {
      finalData = rawdata;
    }
  } catch (err) {
    if (defaultReturn === undefined) {
      console.log("Couldn't read", dir, name, err);
    }
  }
  return (finalData && JSON.parse(finalData)) || defaultReturn;
}

/** Calls the JSON reader on the path appropriate for the given hash data */
export function readHashData(
  studyDir,
  hashValue,
  extension = ".json.gz"
): Promise<object> {
  const hashPath = path.join(
    studyDir,
    "bulkdata",
    hashValue.substring(0, 3),
    hashValue.substring(3, 5)
  );
  return loadJson(hashPath, hashValue.substring(5) + extension);
}

export default loadJson;

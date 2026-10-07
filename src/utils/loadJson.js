import { promises as fs } from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { handleHomeRelative } from "./handleHomeRelative.js";
import { commandsLog } from "./logger.js";

const gunzip = promisify(zlib.gunzip);
const log = commandsLog.getLogger("loadJson");

export async function loadJson(dirSrc, name, defaultReturn) {
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
    // Callers that expect a possible miss pass a defaultReturn (null works);
    // only an unexpected miss is worth a log line, and it goes through the
    // logger, not raw console.
    if (defaultReturn === undefined) {
      log.warn("Couldn't read", path.join(dir, name), err.message);
    }
  }
  return (finalData && JSON.parse(finalData)) || defaultReturn;
}

/** Calls the JSON reader on the path appropriate for the given hash data */
export function readHashData(studyDir, hashValue, extension = ".json.gz") {
  const hashPath = path.join(
    studyDir,
    "bulkdata",
    hashValue.substring(0, 3),
    hashValue.substring(3, 5)
  );
  return loadJson(hashPath, hashValue.substring(5) + extension);
}

export default loadJson;

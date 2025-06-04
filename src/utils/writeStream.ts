import fs from "fs";
import zlib from "zlib";
import path from "path";
import { commandsLog } from "./logger";

const log = commandsLog.getLogger("writeStream");

/** Create an optionally gzipped stream,
 * where the write operations are performed in order executed,
 * and don't require synchronization, only the 'close' operation
 * requires syncing.
 */
export const writeStream = (dir, nameSrc, options?) => {
  const isGzip =
    !options?.compressed && (nameSrc.indexOf(".gz") != -1 || options?.gzip);
  const name =
    (isGzip && nameSrc.indexOf(".gz") === -1 && `${nameSrc}.gz`) || nameSrc;
  if (options?.mkdir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempName = path.join(
    dir,
    `tempFile-${Math.round(Math.random() * 1000000000)}`
  );
  const finalName = path.join(dir, name);
  const rawStream = fs.createWriteStream(tempName);
  const closePromise = new Promise((resolve) => {
    rawStream.on("close", async () => {
      log.debug("Renaming", tempName, finalName);
      await fs.rename(tempName, finalName, () => true);
      log.trace("Renamed", tempName, finalName);
      resolve(finalName);
    });
  });

  const outStream = isGzip ? zlib.createGzip() : rawStream;
  if (isGzip) {
    outStream.pipe(rawStream);
    outStream.on("close", async () => {
      log.trace("write stream being closed", tempName, finalName);
      rawStream.close();
    });
  }

  outStream.oldClose = outStream.close;
  outStream.closePromise = closePromise;
  outStream.close = async () => {
    await outStream.oldClose();
    return closePromise;
  };
  return outStream;
};

export default writeStream;

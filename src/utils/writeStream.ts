import fs from "fs";
import zlib from "zlib";
import path from "path";

/** Create an optionally gzipped stream,
 * where the write operations are performed in order executed,
 * and don't require synchronization, only the 'close' operation
 * requires syncing.
 */
export const writeStream = (dir, nameSrc, options?) => {
  const isGzip = nameSrc.indexOf(".gz") != -1 || options.gzip;
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
    rawStream.on("close", () => {
      resolve("closed");
    });
  });

  const writeStream = isGzip ? zlib.createGzip() : rawStream;
  if (isGzip) {
    writeStream.pipe(rawStream);
    writeStream.on("close", () => {
      rawStream.close();
    });
  }

  async function close() {
    await this.writeStream.end();
    await this.closePromise;
    console.warn("Renaming", tempName, finalName);
    await fs.rename(tempName, finalName, () => true); // console.log('Renamed', tempName,finalName));
  }

  return {
    writeStream,
    closePromise,

    write(data) {
      return this.writeStream.write(data);
    },

    close,
  };
};

export default writeStream;

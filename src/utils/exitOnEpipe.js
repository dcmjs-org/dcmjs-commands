// src/utils/exitOnEpipe.js
//
// Downstream consumers like `dcmjs dump file | head` close the pipe as soon
// as they have read what they need. Node surfaces the next write as an EPIPE
// error on stdout, and with no error listener the process dies with a stack
// trace. Treat it the way cat and grep do: the consumer got everything it
// asked for, so stop writing and exit quietly.

/**
 * Exit the process quietly when a stream write fails with EPIPE.
 * Any other stream error is re-thrown so it still crashes loudly.
 * @param {NodeJS.WriteStream} [stream] - defaults to process.stdout
 * @param {Function} [exit] - injectable for tests; defaults to process.exit
 */
export function exitOnEpipe(stream = process.stdout, exit = process.exit) {
  stream.on("error", (err) => {
    if (err?.code === "EPIPE") {
      exit(0);
      return;
    }
    throw err;
  });
}

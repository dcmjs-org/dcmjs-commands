// test/utils/exitOnEpipe.test.js

import { EventEmitter } from "node:events";
import { exitOnEpipe } from "../../src/utils/exitOnEpipe.js";

function epipeError() {
  const err = new Error("write EPIPE");
  err.code = "EPIPE";
  return err;
}

test("EPIPE on the stream exits quietly with code 0", () => {
  const stream = new EventEmitter();
  const exitCalls = [];
  exitOnEpipe(stream, (code) => exitCalls.push(code));

  stream.emit("error", epipeError());

  expect(exitCalls).toEqual([0]);
});

test("non-EPIPE stream errors still throw", () => {
  const stream = new EventEmitter();
  const exitCalls = [];
  exitOnEpipe(stream, (code) => exitCalls.push(code));

  const err = new Error("boom");
  err.code = "EACCES";

  expect(() => stream.emit("error", err)).toThrow("boom");
  expect(exitCalls).toEqual([]);
});

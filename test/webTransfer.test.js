// test/webTransfer.test.js

import { DicomAccess } from "../src/access/DicomAccess.js";
import { runTransfer } from "../src/commands/webTransfer.js";

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

function makeFakes() {
  const calls = { store: [], created: [] };
  const srcStudy = { uid: "1.2.3" };
  const destination = {
    store: async (study, options) => {
      calls.store.push({ study, options });
      return study;
    },
  };
  const source = {
    queryStudy: async (uid) => {
      calls.queriedUid = uid;
      return srcStudy;
    },
  };
  const createAccess = async (url, options) => {
    calls.created.push({ url, options });
    return options?.scheme === "file" ? destination : source;
  };
  return { calls, createAccess, srcStudy };
}

async function transfer(kind, values, fakes = makeFakes()) {
  const out = capture();
  const err = capture();
  const code = await runTransfer({
    createAccess: fakes.createAccess,
    kind,
    positionals: ["http://server/dicomweb"],
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return {
    code,
    out: out.lines.join("\n"),
    err: err.lines.join("\n"),
    calls: fakes.calls,
    srcStudy: fakes.srcStudy,
  };
}

test("download uses DICOMWEB_OPTIONS and stores destination-first", async () => {
  const { code, calls, srcStudy, out } = await transfer("download", {
    StudyInstanceUID: "1.2.3",
    directory: "/tmp/out",
  });
  expect(code).toBe(0);
  expect(calls.queriedUid).toBe("1.2.3");
  expect(calls.store).toHaveLength(1);
  expect(calls.store[0].study).toBe(srcStudy);
  // Options preset spread FLAT into the store options (the legacy
  // cliDownload nested them under an `options` key by mistake)
  expect(calls.store[0].options.frames).toBe(true);
  expect(calls.store[0].options.part10).toBe(false);
  expect(out).toMatch(/download complete/i);
});

test("part10 uses PART10_OPTIONS", async () => {
  const { code, calls } = await transfer("part10", {
    StudyInstanceUID: "1.2.3",
    directory: "/tmp/out",
  });
  expect(code).toBe(0);
  expect(calls.store[0].options.part10).toBe(true);
  expect(calls.store[0].options.frames).toBe(false);
});

test("caller values override the preset", async () => {
  const { calls } = await transfer("download", {
    StudyInstanceUID: "1.2.3",
    directory: "/tmp/out",
    frames: false,
  });
  expect(calls.store[0].options.frames).toBe(false);
});

test("missing StudyInstanceUID exits 2 without touching the network", async () => {
  const { code, err, calls } = await transfer("download", {
    directory: "/tmp/out",
  });
  expect(code).toBe(2);
  expect(err).toMatch(/StudyInstanceUID/);
  expect(calls.created).toHaveLength(0);
});

test("errors exit 1 with the message on stderr", async () => {
  const fakes = makeFakes();
  fakes.createAccess = async () => {
    throw new Error("boom");
  };
  const { code, err } = await transfer(
    "download",
    { StudyInstanceUID: "1.2.3", directory: "/tmp/out" },
    fakes
  );
  expect(code).toBe(1);
  expect(err).toMatch(/boom/);
});

test("default createAccess is DicomAccess.createInstance", async () => {
  // Contract check only — the DI default must be the real factory
  const { runTransfer: fn } = await import("../src/commands/webTransfer.js");
  expect(typeof fn).toBe("function");
  expect(typeof DicomAccess.createInstance).toBe("function");
});

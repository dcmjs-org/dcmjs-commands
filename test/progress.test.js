// test/progress.test.js
//
// Progress lines for transcode and wsiresize.

import { Progress } from "../src/pixel/progress.js";

/** A Progress with a fake clock that `tick(ms)` moves forward. */
function make(options = {}) {
  const lines = [];
  let t = 0;
  const progress = new Progress({
    command: "transcode",
    totalFiles: 4,
    write: (line) => lines.push(line),
    largeFrames: 100,
    batchFiles: 2,
    now: () => t,
    ...options,
  });
  return { progress, lines, tick: (ms) => (t += ms) };
}

// User experience: small files in batches, a large file on its own lines.
test("batches small files and gives a large file its own progress lines", () => {
  const { progress, lines, tick } = make();
  for (const [file, frames] of [
    ["a.dcm", 4],
    ["b.dcm", 6],
    ["big.dcm", 1000],
    ["c.dcm", 1],
  ]) {
    progress.startFile(file, frames);
    for (let i = 0; i < frames; i++) {
      tick(10);
      progress.frame();
    }
    progress.endFile();
  }
  progress.flushBatch();

  expect(lines[0]).toBe("transcode: [1-2/4] 2 files, 10 frames");
  expect(lines[1]).toBe("transcode: [3/4] big.dcm: 1,000 frames");
  expect(lines.slice(2, 11)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (k) => `  ${k}00/1,000 frames (${k}0%), ${k}s, about ${10 - k}s left`
    )
  );
  expect(lines[11]).toBe("  1,000/1,000 frames done in 10s");
  expect(lines[12]).toBe("transcode: [4/4] 1 file, 1 frames");
  expect(lines).toHaveLength(13);
});

// User experience: slow encoding between frames never looks stuck.
test("prints a line every 10 seconds, with the output tiles", () => {
  const { progress, lines, tick } = make({ command: "wsiresize" });
  progress.startFile("slide.dcm", 1000, { tiles: 40 });
  for (let i = 0; i < 50; i++) {
    progress.frame();
  }
  for (let i = 0; i < 4; i++) {
    tick(5000);
    progress.tile();
  }
  expect(lines).toEqual([
    "wsiresize: [1/4] slide.dcm: 1,000 frames → 40 tiles",
    "  50/1,000 frames (5%), 2/40 tiles, 10s, about 3m10s left",
    "  50/1,000 frames (5%), 4/40 tiles, 20s, about 3m00s left",
  ]);
});

test("prints nothing when quiet", () => {
  const { progress, lines } = make({ quiet: true });
  progress.startFile("big.dcm", 1000);
  progress.frame();
  progress.endFile();
  progress.flushBatch();
  expect(lines).toEqual([]);
});

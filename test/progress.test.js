// test/progress.test.js
//
// Progress lines for transcode and wsiresize.

import { Progress } from "../src/pixel/progress.js";

function run(files, options = {}) {
  const lines = [];
  const progress = new Progress({
    command: "transcode",
    totalFiles: files.length,
    write: (line) => lines.push(line),
    largeFrames: 100,
    batchFiles: 2,
    ...options,
  });
  files.forEach(([file, frames]) => {
    progress.startFile(file, frames);
    for (let i = 0; i < frames; i++) {
      progress.frame();
    }
    progress.endFile();
  });
  progress.flushBatch();
  return lines;
}

// User experience: small files in batches, a large file on its own lines.
test("batches small files and gives a large file its own progress lines", () => {
  const lines = run([
    ["a.dcm", 4],
    ["b.dcm", 6],
    ["big.dcm", 1000],
    ["c.dcm", 1],
  ]);
  expect(lines[0]).toBe("transcode: [1-2/4] 2 files, 10 frames");
  expect(lines[1]).toBe("transcode: [3/4] big.dcm: 1,000 frames");
  expect(lines.slice(2, 11)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `  ${k}00/1,000 frames (${k}0%)`)
  );
  expect(lines[11]).toBe("  1,000/1,000 frames done");
  expect(lines[12]).toBe("transcode: [4/4] 1 file, 1 frames");
  expect(lines).toHaveLength(13);
});

test("prints nothing when quiet", () => {
  expect(run([["big.dcm", 1000]], { quiet: true })).toEqual([]);
});

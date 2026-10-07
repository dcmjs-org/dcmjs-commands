// test/wsiresize.test.js
//
// dcmjs wsiresize — rebuild a whole-slide pyramid from its base level.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { runWsiResize } from "../src/commands/wsiresize.js";
import {
  readPart10Frames,
  readPart10Header,
} from "../src/pixel/frameReader.js";
import { decodeFrame, imageInfoFromDict } from "../src/pixel/codec.js";
import { downsampleBox } from "../src/pixel/resample.js";
import { planLevels } from "../src/wsi/pyramid.js";
import { writeSyntheticWsi } from "./helpers/syntheticWsi.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-wsiresize-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function wsiresize(positionals, values) {
  const out = [];
  const err = [];
  const code = await runWsiResize({
    dcmjs,
    positionals,
    values,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

/** The decoded total pixel matrix of a level, as one RGB image. */
async function decodeLevel(file) {
  const { meta, dict } = await readPart10Header({ dcmjs, inputPath: file });
  const info = imageInfoFromDict(dict);
  const width = dict["00480006"].Value[0];
  const height = dict["00480007"].Value[0];
  const perFrame = dict["52009230"]?.Value;
  const tilesX = Math.ceil(width / info.columns);
  const image = new Uint8Array(width * height * 3);
  await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async (frame, i) => {
      const position = perFrame?.[i]["0048021A"].Value[0];
      const x0 = position
        ? position["0048021E"].Value[0] - 1
        : (i % tilesX) * info.columns;
      const y0 = position
        ? position["0048021F"].Value[0] - 1
        : Math.floor(i / tilesX) * info.rows;
      const pixels = await decodeFrame(frame, info, meta["00020010"].Value[0]);
      for (let y = 0; y < info.rows && y0 + y < height; y++) {
        for (let x = 0; x < info.columns && x0 + x < width; x++) {
          for (let c = 0; c < 3; c++) {
            image[((y0 + y) * width + x0 + x) * 3 + c] =
              pixels[(y * info.columns + x) * 3 + c];
          }
        }
      }
    },
  });
  return { data: image, width, height, spp: 3, dict };
}

// API: geometry, header, and pixels of every level.
test("builds TILED_FULL levels whose pixels match the base, from frames out of raster order", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "geometry"));
  const outDir = path.join(tmpDir, "geometry-out");
  const { code, text } = await wsiresize([path.dirname(wsi.base.path)], {
    directory: outDir,
    preset: "jxl-lossless",
    tile: "128",
    factor: "2",
    json: true,
  });
  expect(code).toBe(0);
  const [series] = JSON.parse(text).series;
  expect(series.levelsAfter.map((l) => [l.width, l.height])).toEqual([
    [600, 400],
    [300, 200],
    [150, 100],
    [75, 50],
  ]);
  expect(series.before.instances).toBe(2);
  expect(series.after.frames).toBe(20 + 6 + 2 + 1);

  const source = await decodeLevel(wsi.base.path);
  let expected = { data: source.data, width: 600, height: 400, spp: 3 };
  for (const written of series.written) {
    const level = await decodeLevel(written.path);
    // jxl-lossless keeps the resampled pixels exactly.
    expect(Buffer.from(level.data).equals(Buffer.from(expected.data))).toBe(
      true
    );
    expect(level.dict["00209311"].Value[0]).toBe("TILED_FULL");
    expect(level.dict["52009230"]).toBeUndefined();
    const spacing =
      level.dict["52009229"].Value[0]["00289110"].Value[0]["00280030"].Value;
    expect(Number(spacing[0])).toBeCloseTo(0.0005 * 2 ** written.level, 10);
    expected = downsampleBox(expected, 2);
  }
});

// User experience: --in-place keeps references to the base level valid.
test("--in-place keeps the base SOPInstanceUID and series, replaces the old levels, keeps the label", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "inplace"));
  const dir = path.dirname(wsi.base.path);
  const { code } = await wsiresize([dir], {
    "in-place": true,
    preset: "jxl-medium",
    tile: "256",
    factor: "4",
  });
  expect(code).toBe(0);

  const base = await readPart10Header({ dcmjs, inputPath: wsi.base.path });
  expect(base.dict["00080018"].Value[0]).toBe(wsi.base.sop);
  expect(base.dict["0020000E"].Value[0]).toBe(wsi.series.uid);
  expect(base.meta["00020010"].Value[0]).toBe("1.2.840.10008.1.2.4.112");
  expect(fs.existsSync(wsi.half.path)).toBe(false);
  expect(fs.existsSync(wsi.label.path)).toBe(true);
  // 600x400 at 256px, factor 4: the base and one 150x100 level.
  expect(fs.readdirSync(dir).filter((f) => f.endsWith(".dcm"))).toHaveLength(3);
});

test("needs -d or --in-place", async () => {
  const { code, err } = await wsiresize([tmpDir], {});
  expect(code).toBe(1);
  expect(err).toMatch(/-d <dir> for a new series, or --in-place/);
});

test("plans levels down to one tile", () => {
  expect(
    planLevels({ width: 24000, height: 16896, tile: 1024, factor: 4 }).map(
      (l) => [l.width, l.height, l.frames]
    )
  ).toEqual([
    [24000, 16896, 408],
    [6000, 4224, 30],
    [1500, 1056, 4],
    [375, 264, 1],
  ]);
});

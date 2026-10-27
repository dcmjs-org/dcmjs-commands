// test/wsiresize.test.js
//
// dcmjs wsiresize — rebuild a whole-slide pyramid from its base level.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import dcmjs from "../src/dcmjsBundle.js";
import { runWsiResize } from "../src/commands/wsiresize.js";
import {
  readPart10Frames,
  readPart10Header,
} from "../src/pixel/frameReader.js";
import { decodeFrame, imageInfoFromDict } from "../src/pixel/codec.js";
import { downsampleBox } from "../src/pixel/resample.js";
import { planLevels } from "../src/wsi/pyramid.js";
import { writeSyntheticWsi } from "./helpers/syntheticWsi.js";

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

// API: each tile is written from its own pixels, also when the encoder
// returns the reused tile buffer (explicit-le) and the tile is small.
test("explicit-le with 64 px tiles gives levels whose pixels match the base", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "small-tiles"));
  const { code, text } = await wsiresize([wsi.base.path], {
    directory: path.join(tmpDir, "small-tiles-out"),
    preset: "jxl-lossless",
    to: "explicit-le",
    tile: "64",
    factor: "2",
    json: true,
    quiet: true,
  });
  expect(code).toBe(0);
  const source = await decodeLevel(wsi.base.path);
  let expected = { data: source.data, width: 600, height: 400, spp: 3 };
  for (const written of JSON.parse(text).series[0].written) {
    const level = await decodeLevel(written.path);
    expect(Buffer.from(level.data).equals(Buffer.from(expected.data))).toBe(
      true
    );
    expected = downsampleBox(expected, 2);
  }
});

// User experience: --in-place keeps references to the base level valid.
test("--in-place keeps the base SOPInstanceUID and series, replaces the old levels, keeps the label", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "inplace"));
  const dir = path.dirname(wsi.base.path);
  const { code, err } = await wsiresize([dir], {
    "in-place": true,
    preset: "jxl-medium",
    tile: "256",
    factor: "4",
    quiet: true,
  });
  expect(code).toBe(0);
  expect(err).toMatch(
    /warning: JPEG XL is lossy.*keeps the base SOPInstanceUID/
  );

  const base = await readPart10Header({ dcmjs, inputPath: wsi.base.path });
  expect(base.dict["00080018"].Value[0]).toBe(wsi.base.sop);
  expect(base.dict["0020000E"].Value[0]).toBe(wsi.series.uid);
  expect(base.meta["00020010"].Value[0]).toBe("1.2.840.10008.1.2.4.112");
  expect(fs.existsSync(wsi.half.path)).toBe(false);
  expect(fs.existsSync(wsi.label.path)).toBe(true);
  // 600x400 at 256px, factor 4: the base and one 150x100 level.
  expect(fs.readdirSync(dir).filter((f) => f.endsWith(".dcm"))).toHaveLength(3);
});

// User experience: --in-place never deletes another channel of the slide.
test("--in-place rebuilds each optical path of a series, and deletes only that path's old levels", async () => {
  const dir = path.join(tmpDir, "channels");
  const a = await writeSyntheticWsi(dcmjs, dir, {
    opticalPath: "1",
    prefix: "a-",
  });
  const b = await writeSyntheticWsi(dcmjs, dir, {
    series: a.series,
    opticalPath: "2",
    prefix: "b-",
  });

  // -d: both channels stay one series and one pyramid, numbered as one series.
  const copy = path.join(tmpDir, "channels-copy");
  expect(
    (
      await wsiresize([dir], {
        directory: copy,
        preset: "jxl-lossless",
        tile: "256",
        factor: "4",
        quiet: true,
      })
    ).code
  ).toBe(0);
  const [seriesDir] = fs.readdirSync(copy);
  const copies = await Promise.all(
    fs.readdirSync(path.join(copy, seriesDir)).map(async (f) => {
      const { dict } = await readPart10Header({
        dcmjs,
        inputPath: path.join(copy, seriesDir, f),
      });
      return ["00080019", "00200013"].map((t) => dict[t].Value[0]);
    })
  );
  expect(copies).toHaveLength(4);
  expect(new Set(copies.map(([pyramid]) => pyramid)).size).toBe(1);
  expect(copies[0][0]).not.toBe(a.series.pyramid);
  expect(new Set(copies.map(([, n]) => n)).size).toBe(4);

  const { code } = await wsiresize([dir], {
    "in-place": true,
    preset: "jxl-lossless",
    tile: "256",
    factor: "4",
    quiet: true,
  });
  expect(code).toBe(0);

  const paths = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".dcm"))) {
    const { dict } = await readPart10Header({
      dcmjs,
      inputPath: path.join(dir, file),
    });
    const id = dict["00480105"].Value[0]["00480106"].Value[0];
    const type = dict["00080008"].Value[2];
    paths[id] ??= [];
    paths[id].push(`${type} ${dict["00480006"].Value[0]}`);
  }
  // Each path: its base, one new 150x100 level, and its label.
  for (const id of ["1", "2"]) {
    expect(paths[id].sort()).toEqual(["LABEL 128", "VOLUME 150", "VOLUME 600"]);
  }
  for (const wsi of [a, b]) {
    const base = await readPart10Header({ dcmjs, inputPath: wsi.base.path });
    expect(base.dict["00080018"].Value[0]).toBe(wsi.base.sop);
  }
});

// User experience: focal planes are separate pyramids; levels without a
// plane position belong to the one plane of their optical path.
test("--in-place keeps focal planes apart, and places levels that have no plane position", async () => {
  const single = path.join(tmpDir, "one-plane");
  const one = await writeSyntheticWsi(dcmjs, single, { zOffset: 0 });
  const opts = {
    "in-place": true,
    preset: "jxl-lossless",
    tile: "256",
    factor: "4",
    quiet: true,
  };
  expect((await wsiresize([single], opts)).code).toBe(0);
  // The half level joined the plane at Z 0 and was replaced.
  expect(fs.existsSync(one.half.path)).toBe(false);
  expect(fs.readdirSync(single).filter((f) => f.endsWith(".dcm"))).toHaveLength(
    3
  );

  const planes = path.join(tmpDir, "two-planes");
  const a = await writeSyntheticWsi(dcmjs, planes, {
    zOffset: 0,
    prefix: "a-",
  });
  const b = await writeSyntheticWsi(dcmjs, planes, {
    series: a.series,
    zOffset: 5,
    prefix: "b-",
  });
  expect((await wsiresize([planes], opts)).code).toBe(0);
  for (const wsi of [a, b]) {
    const base = await readPart10Header({ dcmjs, inputPath: wsi.base.path });
    expect(base.dict["00080018"].Value[0]).toBe(wsi.base.sop);
    expect(base.meta["00020010"].Value[0]).toBe("1.2.840.10008.1.2.4.110");
    // With two planes, a level without a plane position cannot be placed,
    // so it stays as it is.
    expect(fs.existsSync(wsi.half.path)).toBe(true);
  }
});

// API: a TILED_FULL level keeps the per-frame macros that are the same for all frames.
test("PixelMeasures in the per-frame groups move to the shared groups of each level", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "per-frame"), {
    perFrameMeasures: true,
  });
  const { code, text } = await wsiresize([wsi.base.path], {
    directory: path.join(tmpDir, "per-frame-out"),
    preset: "jxl-lossless",
    tile: "256",
    factor: "2",
    json: true,
    quiet: true,
  });
  expect(code).toBe(0);
  for (const written of JSON.parse(text).series[0].written) {
    const { dict } = await readPart10Header({ dcmjs, inputPath: written.path });
    const spacing =
      dict["52009229"].Value[0]["00289110"].Value[0]["00280030"].Value;
    expect(Number(spacing[0])).toBeCloseTo(0.0005 * 2 ** written.level, 10);
  }
});

// User experience: a failed rebuild leaves no partial or temporary file (WR-U7).
test("a truncated base fails, and leaves the directory as it was", async () => {
  const wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "truncated"));
  const dir = path.dirname(wsi.base.path);
  const bytes = fs.readFileSync(wsi.base.path);
  fs.writeFileSync(wsi.base.path, bytes.subarray(0, bytes.length - 2000));
  const before = fs.readdirSync(dir).sort();

  const { code } = await wsiresize([dir], {
    "in-place": true,
    preset: "jxl-lossless",
    quiet: true,
  });
  expect(code).toBe(1);
  expect(fs.readdirSync(dir).sort()).toEqual(before);
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

// src/commands/wsiresize.js
//
// dcmjs wsiresize — rebuild the pyramid of a VL Whole Slide Microscopy
// series from its base level: new tile size, new level factor, new codec.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { discoverDicomFiles } from "../io.js";
import {
  checkFrameCount,
  readPart10Frames,
  readPart10Header,
} from "../pixel/frameReader.js";
import { FrameSpool, writePart10WithFrames } from "../pixel/frameWriter.js";
import { decodeFrame, encodeFrame, imageInfoFromDict } from "../pixel/codec.js";
import { photometricAfter, updatePixelHeader } from "../pixel/pixelHeader.js";
import {
  distanceFromQuality,
  resolveOutputSyntax,
} from "../pixel/transferSyntaxes.js";
import {
  addTotals,
  emptyTotals,
  formatSizeReport,
} from "../pixel/sizeReport.js";
import { Progress } from "../pixel/progress.js";
import {
  TileRowAssembler,
  createPyramidBuilder,
  planLevels,
} from "../wsi/pyramid.js";

const VL_WHOLE_SLIDE = "1.2.840.10008.5.1.4.1.1.77.1.6";
const PYRAMID_TYPES = new Set(["VOLUME", "THUMBNAIL"]);

/** Output tile size, level factor and codec for each preset. */
export const PRESETS = {
  "jxl-lossless": {
    to: "jxl-lossless",
    tile: 1024,
    factor: 4,
    progressive: true,
  },
  "jxl-high": {
    to: "jxl",
    distance: 1.0,
    tile: 1024,
    factor: 4,
    progressive: true,
  },
  "jxl-medium": {
    to: "jxl",
    distance: 2.0,
    tile: 1024,
    factor: 4,
    progressive: true,
  },
  "jxl-low": {
    to: "jxl",
    distance: 4.0,
    tile: 1024,
    factor: 4,
    progressive: true,
  },
  "jpeg-512": {
    to: "jpeg",
    quality: 90,
    tile: 512,
    factor: 2,
    progressive: false,
  },
};
const DEFAULT_PRESET = "jxl-high";

export const wsiResizeUsage = `usage: dcmjs wsiresize <file-or-directory>... (-d <dir> | --in-place) [options]

Rebuilds each whole-slide pyramid (VL Whole Slide Microscopy, 1.2.840.10008.
5.1.4.1.1.77.1.6) from its largest VOLUME level: the base is decoded one
tile at a time, and every level is written with the new tile size, level
factor and transfer syntax. LABEL and OVERVIEW images are not changed.
Prints the number of images and frames, the header bytes and the image
bytes, before and after.

Output (one is required):
  -d, --directory <dir>   write a new series to <dir>/<SeriesInstanceUID>/;
                          the input stays
  --in-place              replace the pyramid in its directory. The base
                          level keeps its SOPInstanceUID and the series keeps
                          its SeriesInstanceUID, so references to the base
                          level (for example bulk annotations) stay valid,
                          also with a lossy preset (a warning is printed).
                          The other old levels of the same optical path and
                          focal plane are deleted.

Options:
  -p, --preset <name>     ${Object.keys(PRESETS).join(", ")}
                          (default ${DEFAULT_PRESET})
                            jxl-lossless  JPEG XL lossless, 1024px, factor 4
                            jxl-high      JPEG XL distance 1 (visually lossless)
                            jxl-medium    JPEG XL distance 2
                            jxl-low       JPEG XL distance 4
                            jpeg-512      JPEG quality 90, 512px, factor 2
                          jxl presets are progressive.
  -t, --to <syntax>       override the preset transfer syntax
                          (jxl, jxl-lossless, jpeg, explicit-le, rle,
                          deflate)
  --tile <px>             override the tile size (a multiple of the factor)
  --factor <n>            override the factor between levels (2..8)
  --quality <q>           jpeg: quality 1..100; jxl: quality 0..100 (as cjxl)
  --distance <d>          jxl: Butteraugli distance 0..25
  --effort <e>            JPEG XL effort 1..9 (default 7)
  --no-progressive        write JPEG XL that is not progressive
  --dry-run               print the planned levels; write nothing
  -q, --quiet             print no progress (the report is still printed)
  --json                  print the report as JSON
  -h, --help              show this help
`;

const first = (dict, tag) => dict[tag]?.Value?.[0];
const set = (dict, tag, vr, ...Value) => {
  dict[tag] = { vr, Value };
};

function parseInteger(values, name, min, max, fallback) {
  if (values[name] === undefined) {
    return fallback;
  }
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function parseFloatOption(values, name, min, max) {
  if (values[name] === undefined) {
    return undefined;
  }
  const value = Number(values[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** The preset with the command-line overrides applied; throws on misuse. */
export function parseWsiResizeOptions(values) {
  const presetName = values.preset ?? DEFAULT_PRESET;
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `unknown preset '${presetName}' — use one of ${Object.keys(PRESETS).join(", ")}`
    );
  }
  if (values["in-place"] && values.directory) {
    throw new Error("give -d <dir> or --in-place, not both");
  }
  if (!values["in-place"] && !values.directory && !values["dry-run"]) {
    throw new Error("give -d <dir> for a new series, or --in-place");
  }
  const target = resolveOutputSyntax(values.to ?? preset.to);
  if (target.uid === "1.2.840.10008.1.2.4.111") {
    throw new Error(
      "jxl-jpeg keeps JPEG tiles as they are — use transcode for it"
    );
  }
  const factor = parseInteger(values, "factor", 2, 8, preset.factor);
  const tile = parseInteger(values, "tile", 64, 8192, preset.tile);
  if (tile % factor) {
    throw new Error(
      `--tile ${tile} must be a multiple of the factor ${factor}`
    );
  }
  const quality = parseFloatOption(values, "quality", 0, 100);
  let distance = parseFloatOption(values, "distance", 0, 25) ?? undefined;
  if (
    distance === undefined &&
    quality !== undefined &&
    target.uid.endsWith(".112")
  ) {
    distance = distanceFromQuality(quality);
  }
  return {
    presetName,
    target,
    tile,
    factor,
    encode: {
      quality: quality ?? preset.quality,
      distance: distance ?? preset.distance ?? 1.0,
      effort: parseInteger(values, "effort", 1, 9, undefined),
      progressive: preset.progressive && !values["no-progressive"],
    },
  };
}

/**
 * The optical path and focal plane of an image. Each channel or plane of a
 * series is its own pyramid, so `--in-place` never deletes another one.
 */
function planeKey(dict) {
  const paths = (dict["00480105"]?.Value ?? [])
    .map((item) => first(item, "00480106"))
    .join("\\");
  const groups = dict["52009229"]?.Value?.[0] ?? dict["52009230"]?.Value?.[0];
  const position = groups?.["0048021A"]?.Value?.[0];
  const z = position ? first(position, "0040074A") : undefined;
  return `${paths}|${z ?? ""}`;
}

/**
 * Pyramids by SeriesInstanceUID, optical path and focal plane:
 * `{ uid, key, base, levels, others }`.
 */
async function findPyramids(dcmjs, positionals) {
  const pyramids = new Map();
  for (const input of positionals) {
    for (const file of discoverDicomFiles(input)) {
      const { meta, dict } = await readPart10Header({ dcmjs, inputPath: file });
      if (first(dict, "00080016") !== VL_WHOLE_SLIDE) {
        continue;
      }
      const uid = first(dict, "0020000E");
      const key = planeKey(dict);
      const id = `${uid}|${key}`;
      if (!pyramids.has(id)) {
        pyramids.set(id, { uid, key, levels: [], others: [] });
      }
      const entry = { path: file, meta, dict };
      const imageType = dict["00080008"]?.Value ?? [];
      const group = pyramids.get(id);
      (PYRAMID_TYPES.has(imageType[2]) ? group.levels : group.others).push(
        entry
      );
    }
  }
  const area = ({ dict }) =>
    Number(first(dict, "00480006") ?? 0) * Number(first(dict, "00480007") ?? 0);
  const groups = [...pyramids.values()];
  for (const group of groups) {
    group.levels.sort((a, b) => area(b) - area(a));
    group.base = group.levels.find(
      (l) => (l.dict["00080008"]?.Value ?? [])[2] === "VOLUME"
    );
    group.shared = groups.filter((g) => g.uid === group.uid).length > 1;
  }
  return groups.filter((g) => g.base);
}

function checkPlanes({ dict, path: file }) {
  if (
    Number(first(dict, "00480303") ?? 1) > 1 ||
    Number(first(dict, "00480302") ?? 1) > 1
  ) {
    throw new Error(
      `${file}: more than one focal plane or optical path in one image is ` +
        "not supported"
    );
  }
}

/** Refuses a pyramid that the rebuild would not reproduce in full. */
function checkPyramid(group) {
  for (const level of group.levels) {
    checkPlanes(level);
  }
  const { base } = group;
  const twin = group.levels.find(
    (l) =>
      l !== base &&
      first(l.dict, "00480006") === first(base.dict, "00480006") &&
      first(l.dict, "00480007") === first(base.dict, "00480007")
  );
  if (twin) {
    throw new Error(
      `${base.path} and ${twin.path} are both full-size levels of one ` +
        "optical path and focal plane, so the pyramid of each level is unclear"
    );
  }
}

function checkBase({ dict, path: file }) {
  const fail = (why) => {
    throw new Error(`${file}: ${why}`);
  };
  if (first(dict, "00280100") !== 8) {
    fail("only 8-bit samples are supported");
  }
  if (![1, 3].includes(first(dict, "00280002"))) {
    fail("SamplesPerPixel must be 1 or 3");
  }
  // A concatenation of one part holds every frame and is accepted.
  if (
    Number(first(dict, "00209163") ?? 1) > 1 ||
    Number(first(dict, "00209228") ?? 0) > 0
  ) {
    fail("a concatenation of more than one part is not supported");
  }
}

const CONCATENATION_TAGS = [
  "00200242",
  "00209161",
  "00209162",
  "00209163",
  "00209228",
];

/** 0-based (x, y) of frame `i` in the total pixel matrix. */
function tilePosition(dict) {
  const cols = first(dict, "00280011");
  const rows = first(dict, "00280010");
  const perFrame = dict["52009230"]?.Value;
  if (first(dict, "00209311") === "TILED_FULL" || !perFrame) {
    const tilesX = Math.ceil(Number(first(dict, "00480006")) / cols);
    return (i) => ({
      x: (i % tilesX) * cols,
      y: Math.floor(i / tilesX) * rows,
    });
  }
  return (i) => {
    const position = perFrame[i]?.["0048021A"]?.Value?.[0];
    if (!position) {
      throw new Error(`frame ${i + 1} has no PlanePositionSlideSequence`);
    }
    return {
      x: Number(first(position, "0048021E")) - 1,
      y: Number(first(position, "0048021F")) - 1,
    };
  };
}

/**
 * Frame indices sorted top to bottom, then left to right; undefined when the
 * frames are already in that order.
 */
function rasterOrder(position, frameCount) {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    i,
    ...position(i),
  }));
  const sorted = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  return sorted.every((f, k) => f.i === k) ? undefined : sorted.map((f) => f.i);
}

const formatDs = (value) => {
  const text = String(Number(value.toPrecision(12)));
  return text.length <= 16 ? text : value.toExponential(9);
};

/** Per-frame macros that TILED_FULL makes implicit, so they are dropped. */
const IMPLIED_PER_FRAME = new Set(["0048021A", "00209111"]);

/**
 * The shared functional groups item of the new levels: the base's shared
 * groups, plus each per-frame macro (for example PixelMeasures) that is the
 * same in every frame. Throws when such a macro differs between frames,
 * because one TILED_FULL level cannot hold it.
 */
function sharedGroups({ dict, path: file }) {
  const shared = structuredClone(dict["52009229"]?.Value?.[0] ?? {});
  const perFrame = dict["52009230"]?.Value ?? [];
  for (const tag of Object.keys(perFrame[0] ?? {})) {
    if (IMPLIED_PER_FRAME.has(tag) || shared[tag]) {
      continue;
    }
    const value = JSON.stringify(perFrame[0][tag]);
    if (perFrame.some((item) => JSON.stringify(item[tag]) !== value)) {
      throw new Error(
        `${file}: the per-frame functional group (${tag}) differs between ` +
          "frames, so it cannot move to a TILED_FULL level"
      );
    }
    shared[tag] = structuredClone(perFrame[0][tag]);
  }
  return shared;
}

/** White in YBR_FULL; 0 for MONOCHROME2 and 255 otherwise (WR-I5). */
function backgroundFor(photometric) {
  if (photometric === "YBR_FULL") {
    return [255, 128, 128];
  }
  return photometric === "MONOCHROME2" ? 0 : 255;
}

/** The dataset of one output level, derived from the base level. */
function levelDataset({
  base,
  shared,
  plan,
  options,
  photometric,
  uids,
  lossyRatio,
}) {
  const meta = structuredClone(base.meta);
  const dict = structuredClone(base.dict);
  const { tile, factor, target } = options;

  delete dict["52009230"];
  dict["52009229"] = { vr: "SQ", Value: [structuredClone(shared)] };
  for (const tag of CONCATENATION_TAGS) {
    delete dict[tag];
  }
  set(
    dict,
    "00080008",
    "CS",
    "DERIVED",
    "PRIMARY",
    "VOLUME",
    plan.level ? "RESAMPLED" : "NONE"
  );
  set(dict, "00080018", "UI", uids.sop);
  set(meta, "00020003", "UI", uids.sop);
  set(dict, "0020000E", "UI", uids.series);
  if (dict["00080019"]) {
    set(dict, "00080019", "UI", uids.pyramid);
  }
  set(dict, "00200013", "IS", plan.level + 1);
  set(dict, "00209311", "CS", "TILED_FULL");
  set(dict, "00280008", "IS", plan.frames);
  set(dict, "00280010", "US", tile);
  set(dict, "00280011", "US", tile);
  set(dict, "00480006", "UL", plan.width);
  set(dict, "00480007", "UL", plan.height);
  set(
    dict,
    "00082111",
    "ST",
    `Resampled by dcmjs wsiresize: ${tile}px tiles, level factor ${factor}, ` +
      `level ${plan.level}, ${target.name}`
  );

  const measures = dict["52009229"]?.Value?.[0]?.["00289110"]?.Value?.[0];
  if (measures?.["00280030"] && plan.scale !== 1) {
    measures["00280030"].Value = measures["00280030"].Value.map((v) =>
      formatDs(Number(v) * plan.scale)
    );
  }

  updatePixelHeader({
    meta,
    dict,
    sourceUid: first(base.meta, "00020010"),
    target,
    photometric,
    lossyRatio,
  });
  return { meta, dict };
}

async function measure(dcmjs, file) {
  const read = await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async () => {},
  });
  return {
    frames: read.frames,
    pixelBytes: read.pixelBytes,
    fileBytes: read.fileBytes,
  };
}

const describeLevels = (levels, tile) =>
  `${levels.length} level${levels.length === 1 ? "" : "s"}, ${tile}px tiles: ` +
  levels.map((l) => `${l.width}x${l.height}`).join(", ");

/** Rebuilds one pyramid. Returns the report entry for the series. */
async function resizeSeries({
  dcmjs,
  group,
  options,
  outDir,
  inPlace,
  dryRun,
  progress,
  newSeriesUid,
}) {
  const { base } = group;
  checkBase(base);
  checkPyramid(group);
  const shared = sharedGroups(base);
  const { tile, factor, target, encode } = options;
  const width = Number(first(base.dict, "00480006"));
  const height = Number(first(base.dict, "00480007"));
  const spp = first(base.dict, "00280002");
  const sourceUid = first(base.meta, "00020010");
  const levels = planLevels({ width, height, tile, factor });
  const photometric = photometricAfter({
    photometric: first(base.dict, "00280004"),
    sourceUid,
    target,
  });
  const background = backgroundFor(photometric);

  const report = {
    series: group.uid,
    pyramid: group.shared ? group.key : undefined,
    base: base.path,
    totalPixelMatrix: { width, height, samplesPerPixel: spp },
    levelsBefore: group.levels.map((l) => ({
      path: l.path,
      width: Number(first(l.dict, "00480006")),
      height: Number(first(l.dict, "00480007")),
      tile: first(l.dict, "00280011"),
    })),
    levelsAfter: levels.map(({ level, width: w, height: h, frames }) => ({
      level,
      width: w,
      height: h,
      frames,
    })),
  };
  if (dryRun) {
    return report;
  }
  const frameCount = Number(first(base.dict, "00280008") ?? 1);
  progress?.startFile(base.path, frameCount, {
    tiles: levels.reduce((sum, l) => sum + l.frames, 0),
  });

  const seriesUid = inPlace ? group.uid : newSeriesUid(group.uid);
  const pyramidUid = inPlace
    ? first(base.dict, "00080019")
    : dcmjs.data.DicomMetaDictionary.uid();
  const seriesDir = inPlace
    ? path.dirname(base.path)
    : path.join(outDir, seriesUid);
  fs.mkdirSync(seriesDir, { recursive: true });

  const outputs = levels.map((plan) => {
    const sop =
      inPlace && plan.level === 0
        ? first(base.dict, "00080018")
        : dcmjs.data.DicomMetaDictionary.uid();
    const finalPath =
      inPlace && plan.level === 0
        ? base.path
        : path.join(
            seriesDir,
            inPlace || group.shared ? `${sop}.dcm` : `level-${plan.level}.dcm`
          );
    const tempPath = path.join(
      seriesDir,
      `.${path.basename(finalPath)}.${crypto.randomBytes(4).toString("hex")}.tmp`
    );
    return {
      plan,
      sop,
      finalPath,
      tempPath,
      spool: new FrameSpool(tempPath),
      raw: 0,
    };
  });

  const tileInfo = {
    rows: tile,
    columns: tile,
    bitsAllocated: 8,
    samplesPerPixel: spp,
    pixelRepresentation: 0,
    signed: false,
    planarConfiguration: 0,
  };
  const builder = createPyramidBuilder({
    levels,
    tile,
    factor,
    spp,
    background,
    onTile: async (image, plan) => {
      const output = outputs[plan.level];
      output.raw += image.data.byteLength;
      await output.spool.append(
        await encodeFrame(image.data, tileInfo, target.uid, encode)
      );
      progress?.tile();
    },
  });
  const sourceInfo = imageInfoFromDict(base.dict);
  const assembler = new TileRowAssembler({
    width,
    height,
    tileWidth: sourceInfo.columns,
    tileHeight: sourceInfo.rows,
    spp,
    background,
    onStrip: (strip) => builder.addRows(strip),
  });
  const position = tilePosition(base.dict);
  const order = rasterOrder(position, frameCount);
  const addFrame = async (frame, i) => {
    const pixels = await decodeFrame(frame, sourceInfo, sourceUid);
    const { x, y } = position(i);
    await assembler.addTile(
      { data: pixels, width: sourceInfo.columns, height: sourceInfo.rows, spp },
      x,
      y
    );
    progress?.frame();
  };
  // Frames out of raster order are spooled as they arrive, then read back
  // in raster order.
  const sourceSpool = order
    ? new FrameSpool(path.join(seriesDir, "source"))
    : null;

  const before = emptyTotals();
  const after = emptyTotals();
  try {
    const read = await readPart10Frames({
      dcmjs,
      inputPath: base.path,
      onFrame: sourceSpool
        ? async (frame) => {
            await sourceSpool.append(frame);
            progress?.spooled();
          }
        : addFrame,
    });
    checkFrameCount(read);
    if (sourceSpool) {
      const reader = await sourceSpool.openReader();
      try {
        for (const i of order) {
          await addFrame(await reader.read(i), i);
        }
      } finally {
        await reader.close();
      }
    }
    await assembler.finish();
    await builder.finish();
    addTotals(before, read);
    for (const level of group.levels.slice(1)) {
      addTotals(before, await measure(dcmjs, level.path));
    }

    for (const output of outputs) {
      const { meta, dict } = levelDataset({
        base,
        shared,
        plan: output.plan,
        options,
        photometric,
        uids: { sop: output.sop, series: seriesUid, pyramid: pyramidUid },
        lossyRatio: target.lossy
          ? output.raw / Math.max(1, output.spool.bytes)
          : undefined,
      });
      const written = await writePart10WithFrames({
        dcmjs,
        outputPath: output.tempPath,
        meta,
        dict,
        spool: output.spool,
        encapsulated: target.encapsulated,
      });
      addTotals(after, { frames: output.plan.frames, ...written });
      output.written = written;
    }

    // Every level is written; only now replace or delete anything.
    for (const output of outputs) {
      fs.renameSync(output.tempPath, output.finalPath);
    }
    if (inPlace) {
      report.deleted = [];
      for (const level of group.levels.slice(1)) {
        fs.rmSync(level.path);
        report.deleted.push(level.path);
      }
    }
  } finally {
    await sourceSpool?.remove();
    for (const output of outputs) {
      await output.spool.remove();
      fs.rmSync(output.tempPath, { force: true });
    }
  }

  report.before = before;
  report.after = after;
  report.written = outputs.map((o) => ({
    level: o.plan.level,
    path: o.finalPath,
    sopInstanceUID: o.sop,
    frames: o.plan.frames,
    pixelBytes: o.written.pixelBytes,
  }));
  return report;
}

export async function runWsiResize({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  let options;
  try {
    if (!positionals.length) {
      throw new Error("give at least one file or directory");
    }
    options = parseWsiResizeOptions(values);
  } catch (err) {
    stderr(`dcmjs wsiresize: ${err.message}`);
    stderr(wsiResizeUsage);
    return 1;
  }
  const inPlace = Boolean(values["in-place"]);
  const dryRun = Boolean(values["dry-run"]);

  let groups;
  try {
    groups = await findPyramids(dcmjs, positionals);
  } catch (err) {
    stderr(`dcmjs wsiresize: ${err.message}`);
    return 1;
  }
  if (!groups.length) {
    stderr("dcmjs wsiresize: no VL Whole Slide Microscopy pyramid found");
    return 1;
  }

  if (inPlace && options.target.lossy && !dryRun) {
    stderr(
      `dcmjs wsiresize: warning: ${options.target.name} is lossy, and ` +
        "--in-place keeps the base SOPInstanceUID. A system that already " +
        "holds that instance can keep the old pixels."
    );
  }

  // Pyramids of one source series (channels, focal planes) share a series.
  const newSeries = new Map();
  const newSeriesUid = (uid) => {
    if (!newSeries.has(uid)) {
      newSeries.set(uid, dcmjs.data.DicomMetaDictionary.uid());
    }
    return newSeries.get(uid);
  };

  const reports = [];
  let failed = 0;
  const progress = new Progress({
    command: "wsiresize",
    totalFiles: groups.length,
    write: stderr,
    quiet: values.quiet || dryRun,
  });
  for (const group of groups) {
    try {
      reports.push(
        await resizeSeries({
          dcmjs,
          group,
          options,
          outDir: values.directory,
          inPlace,
          dryRun,
          progress,
          newSeriesUid,
        })
      );
    } catch (err) {
      failed++;
      reports.push({ series: group.uid, error: err.message });
      stderr(`dcmjs wsiresize: series ${group.uid}: ${err.message}`);
    } finally {
      progress.endFile();
    }
  }
  progress.flushBatch();

  if (values.json) {
    stdout(
      JSON.stringify(
        {
          preset: options.presetName,
          target: options.target.uid,
          tile: options.tile,
          factor: options.factor,
          progressive: options.encode.progressive,
          inPlace,
          dryRun,
          series: reports,
        },
        null,
        2
      )
    );
    return failed ? 1 : 0;
  }

  const { target, tile, factor, encode } = options;
  const codec = target.uid.endsWith(".112")
    ? `${target.name} distance ${encode.distance}`
    : target.uid.endsWith(".50")
      ? `${target.name} quality ${encode.quality ?? 90}`
      : target.name;
  for (const report of reports) {
    if (report.error) {
      continue;
    }
    const { width, height, samplesPerPixel } = report.totalPixelMatrix;
    stdout(
      `wsiresize: series ${report.series}` +
        `${report.pyramid ? ` (optical path|focal plane ${report.pyramid})` : ""}` +
        `${dryRun ? " (dry run)" : ""}`
    );
    stdout(
      `  ${options.presetName}: ${codec}, ${tile}px tiles, factor ${factor}` +
        `${encode.progressive ? ", progressive" : ""}`
    );
    stdout(
      `  total pixel matrix ${width} x ${height}, ${samplesPerPixel} samples per pixel`
    );
    const beforeTile = report.levelsBefore[0]?.tile;
    stdout(`  before: ${describeLevels(report.levelsBefore, beforeTile)}`);
    stdout(`  after:  ${describeLevels(report.levelsAfter, tile)}`);
    if (report.before) {
      stdout(formatSizeReport(report.before, report.after));
      for (const w of report.written) {
        stdout(`  wrote level ${w.level}: ${w.path} (${w.frames} frames)`);
      }
      for (const file of report.deleted ?? []) {
        stdout(`  deleted ${file}`);
      }
    }
  }
  return failed ? 1 : 0;
}

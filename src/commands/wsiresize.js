// src/commands/wsiresize.js
//
// dcmjs wsiresize — rebuild the pyramid of a VL Whole Slide Microscopy
// series from its base level: new tile size, new level factor, new codec.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { discoverDicomFiles, pathKey } from "../io.js";
import {
  checkFrameCount,
  readPart10Frames,
  readPart10Header,
} from "../pixel/frameReader.js";
import { FrameSpool, writePart10WithFrames } from "../pixel/frameWriter.js";
import { decodeFrame, encodeFrame, imageInfoFromDict } from "../pixel/codec.js";
import {
  dropEncapsulatedIcon,
  photometricAfter,
  updatePixelHeader,
} from "../pixel/pixelHeader.js";
import {
  distanceFromQuality,
  pixelLayoutSyntax,
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
                          focal plane are deleted. An optical path with
                          several focal planes, or with a level on an
                          unclear plane, is refused; use -d for it.

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
  let distance = parseFloatOption(values, "distance", 0, 25);
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
  // The shared item usually holds only PixelMeasures, so the plane position
  // comes from the frames. A Z offset that varies from tile to tile is the
  // focus map of one plane, not a focal plane, so it gives no key.
  const shared = dict["52009229"]?.Value?.[0]?.["0048021A"]?.Value?.[0];
  const zs = shared
    ? [first(shared, "0040074A")]
    : (dict["52009230"]?.Value ?? []).map((item) =>
        first(item["0048021A"]?.Value?.[0] ?? {}, "0040074A")
      );
  const z = new Set(zs.map(String)).size === 1 ? zs[0] : undefined;
  return { paths, z: z === undefined ? "" : String(z) };
}

/**
 * Pyramids by SeriesInstanceUID, optical path and focal plane:
 * `{ uid, paths, z, key, opticalKey, base, levels, shared, multiPlane }`.
 * LABEL and OVERVIEW images are left out. A file is read once, also when
 * two inputs hold it; a file whose header cannot be read goes to
 * `unreadable` and is skipped. A level that cannot be placed on one focal
 * plane goes to `unplaced` (its path), and is left as it is. An optical
 * path with more than one plane or an unplaced level goes to `ambiguous`
 * (key `opticalKey`, value `{ uid, paths }`); `--in-place` refuses the
 * groups of that key (WR-U4b).
 */
async function findPyramids(
  dcmjs,
  positionals,
  unreadable,
  unplaced = [],
  ambiguous = new Map()
) {
  const pyramids = new Map();
  const seen = new Set();
  for (const input of positionals) {
    for (const file of discoverDicomFiles(input)) {
      const resolved = pathKey(file);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      let header;
      try {
        header = await readPart10Header({ dcmjs, inputPath: file });
      } catch (err) {
        unreadable.push({ file, error: err.message });
        continue;
      }
      const { meta, dict } = header;
      const imageType = dict["00080008"]?.Value ?? [];
      if (
        first(dict, "00080016") !== VL_WHOLE_SLIDE ||
        !PYRAMID_TYPES.has(imageType[2])
      ) {
        continue;
      }
      const uid = first(dict, "0020000E");
      const { paths, z } = planeKey(dict);
      const id = `${uid}|${paths}|${z}`;
      if (!pyramids.has(id)) {
        pyramids.set(id, {
          uid,
          paths,
          z,
          key: `${paths}|${z}`,
          opticalKey: `${uid}|${paths}`,
          levels: [],
        });
      }
      pyramids.get(id).levels.push({ path: file, meta, dict });
    }
  }
  let groups = [...pyramids.values()];
  const area = ({ dict }) =>
    Number(first(dict, "00480006") ?? 0) * Number(first(dict, "00480007") ?? 0);
  const siblingsOf = (group) =>
    groups.filter(
      (g) =>
        g !== group &&
        g.uid === group.uid &&
        g.paths === group.paths &&
        g.levels.length
    );
  const markAmbiguous = ({ uid, paths, opticalKey }) =>
    ambiguous.set(opticalKey, { uid, paths });
  const oneTile = (l) => Number(first(l.dict, "00280008") ?? 1) === 1;
  // A constant Z is a plane, with one exception: a level of one tile has a
  // constant Z even in a focus-map slide. A Z group of only one-tile levels
  // joins the group without a Z key that holds the full-size level, when
  // exactly one group holds it. No other Z group is ever merged.
  for (const group of groups.filter((g) => g.z !== "" && g.levels.length)) {
    if (!group.levels.every(oneTile)) {
      continue;
    }
    const others = siblingsOf(group);
    const largest = Math.max(0, ...others.flatMap((g) => g.levels.map(area)));
    const holders = others.filter((g) =>
      g.levels.some((l) => area(l) === largest)
    );
    if (
      holders.length === 1 &&
      holders[0].z === "" &&
      largest > Math.max(...group.levels.map(area))
    ) {
      holders[0].levels.push(...group.levels);
      group.levels = [];
    }
  }
  // Levels without a Z key (TILED_FULL levels, focus maps): a group that
  // holds a level as large as any Z group's is a plane of its own. Else it
  // joins the one Z group of its optical path; with several, its levels
  // cannot be placed, and are reported and left as they are.
  for (const loose of groups.filter((g) => g.z === "" && g.levels.length)) {
    const planes = siblingsOf(loose).filter((g) => g.z !== "");
    if (!planes.length) {
      continue;
    }
    const largest = Math.max(...planes.flatMap((g) => g.levels.map(area)));
    if (loose.levels.some((l) => area(l) >= largest)) {
      continue;
    }
    if (planes.length === 1) {
      planes[0].levels.push(...loose.levels);
    } else {
      unplaced.push(...loose.levels.map((l) => l.path));
      markAmbiguous(loose);
    }
    loose.levels = [];
  }
  for (const group of groups) {
    group.levels.sort((a, b) => area(b) - area(a));
    group.base = group.levels.find(
      (l) => (l.dict["00080008"]?.Value ?? [])[2] === "VOLUME"
    );
    // A plane whose base did not come with it (an unplaced focus-map base)
    // is not rebuilt; its levels are reported too, never dropped silently.
    // With no other group of its optical path, nothing was guessed.
    if (!group.base && group.levels.length) {
      unplaced.push(...group.levels.map((l) => l.path));
      if (siblingsOf(group).length) {
        markAmbiguous(group);
      }
    }
  }
  groups = groups.filter((g) => g.base);
  for (const group of groups) {
    const series = groups.filter((g) => g.uid === group.uid);
    group.shared = series.length > 1;
    // Several planes of one optical path: the Z groups keep their Z in a
    // sparse layout (WR-I3).
    group.multiPlane = series.filter((g) => g.paths === group.paths).length > 1;
    if (group.multiPlane) {
      markAmbiguous(group);
    }
  }
  return groups;
}

/**
 * Refuses an image with more than one focal plane or optical path by its
 * count attributes. The counts are optional for TILED_SPARSE, so an image
 * is also refused when two frames share a tile position
 * (checkOneTilePerPosition); a varying Z offset alone is a focus map.
 */
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

/**
 * Refuses a sparse image with two frames at one tile position: that is a
 * second focal plane or optical path inside the image (the counts are
 * optional for TILED_SPARSE).
 */
function checkOneTilePerPosition({ dict, path: file }) {
  const seen = new Set();
  for (const item of dict["52009230"]?.Value ?? []) {
    const position = item["0048021A"]?.Value?.[0];
    if (!position) {
      continue;
    }
    const key = `${first(position, "0048021E")},${first(position, "0048021F")}`;
    if (seen.has(key)) {
      throw new Error(
        `${file}: two frames at tile (${key}); more than one focal plane or ` +
          "optical path in one image is not supported"
      );
    }
    seen.add(key);
  }
}

/** Refuses a pyramid that the rebuild would not reproduce in full. */
function checkPyramid(group, inPlace) {
  // The base is rebuilt; the other levels matter only to --in-place,
  // which deletes them.
  for (const level of inPlace ? group.levels : [group.base]) {
    checkPlanes(level);
    checkOneTilePerPosition(level);
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

const RESAMPLED_PHOTOMETRICS = /^(MONOCHROME[12]|RGB|YBR_[A-Z0-9_]+)$/;

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
  // Resampling averages samples, which is wrong for palette indices.
  const photometric = first(dict, "00280004");
  if (!RESAMPLED_PHOTOMETRICS.test(photometric ?? "")) {
    fail(`PhotometricInterpretation ${photometric} cannot be resampled`);
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
    const x = Number(first(position, "0048021E")) - 1;
    const y = Number(first(position, "0048021F")) - 1;
    // Strips hold whole source tiles; a tile off the grid would lose rows.
    if (!(x >= 0 && y >= 0 && x % cols === 0 && y % rows === 0)) {
      throw new Error(
        `frame ${i + 1} is at (${x + 1}, ${y + 1}), which is not on the ` +
          `${cols} x ${rows} tile grid; only tiles on the grid are supported`
      );
    }
    return {
      x,
      y,
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
  const twice = sorted.find(
    (f, k) => k && f.x === sorted[k - 1].x && f.y === sorted[k - 1].y
  );
  if (twice) {
    throw new Error(
      `frames ${sorted[sorted.indexOf(twice) - 1].i + 1} and ${twice.i + 1} ` +
        `are both at (${twice.x + 1}, ${twice.y + 1}); more than one focal ` +
        "plane or optical path in one image is not supported"
    );
  }
  return sorted.every((f, k) => f.i === k) ? undefined : sorted.map((f) => f.i);
}

const formatDs = (value) => {
  const text = String(Number(value.toPrecision(12)));
  return text.length <= 16 ? text : value.toExponential(9);
};

/**
 * Per-frame macros that each level gets new: TILED_FULL implies them, and
 * a TILED_SPARSE level gets new plane positions (planePositions).
 */
const IMPLIED_PER_FRAME = new Set(["0048021A", "00209111"]);

/**
 * What a TILED_SPARSE level needs from the base (WR-I3): the slide origin,
 * the orientation and the PixelSpacing, because the X/Y offsets of each
 * plane position are Type 1. Throws when one is missing.
 */
function slideGeometry({ dict, path: file }, shared) {
  const origin = dict["00480008"]?.Value?.[0];
  const orientation = dict["00480102"]?.Value?.map(Number);
  const spacing =
    shared["00289110"]?.Value?.[0]?.["00280030"]?.Value?.map(Number);
  if (!origin || orientation?.length !== 6 || spacing?.length !== 2) {
    throw new Error(
      `${file}: a series with several focal planes needs ` +
        "TotalPixelMatrixOriginSequence, ImageOrientationSlide and " +
        "PixelSpacing, to give each new tile its slide position"
    );
  }
  return {
    x: Number(first(origin, "0040072A")),
    y: Number(first(origin, "0040073A")),
    orientation,
    spacing,
  };
}

/** An AT value as an 8-digit tag ("0048021E"). */
const tagOf = (value) =>
  typeof value === "string" && /^[0-9A-F]{8}$/i.test(value)
    ? value.toUpperCase()
    : Number(value).toString(16).padStart(8, "0").toUpperCase();

/**
 * DimensionIndexValues for each frame, from the base's DimensionIndexSequence:
 * the 1-based index of the frame's value among the sorted distinct values of
 * that dimension. A value found in neither the frame nor the shared groups
 * has index 1.
 */
function dimensionIndexValues(dict, shared, items) {
  const pointers = (dict["00209222"]?.Value ?? []).map((item) =>
    tagOf(first(item, "00209165"))
  );
  if (!pointers.length) {
    return undefined;
  }
  const lookup = (item, tag) => {
    for (const macro of [item, shared]) {
      for (const sq of Object.values(macro)) {
        const value = sq?.Value?.[0]?.[tag]?.Value?.[0];
        if (value !== undefined) {
          return value;
        }
      }
    }
    return undefined;
  };
  const values = items.map((item) => pointers.map((tag) => lookup(item, tag)));
  const ranks = pointers.map((_, d) => {
    const distinct = [...new Set(values.map((v) => v[d]))].sort(
      (a, b) => Number(a) - Number(b)
    );
    return new Map(distinct.map((v, i) => [v, i + 1]));
  });
  return values.map((v) => v.map((value, d) => ranks[d].get(value)));
}

/**
 * The per-frame groups of a TILED_SPARSE level, for a slide with several
 * focal planes (WR-I3): one plane position per tile in row-major order,
 * with the Z offset of the base and slide X/Y offsets, and a FrameContent
 * item with DimensionIndexValues when the base has a DimensionIndexSequence.
 */
function planePositions({ base, shared, geometry, plan, tile }) {
  const source = [base.dict["52009229"], base.dict["52009230"]]
    .map((sq) => sq?.Value?.[0]?.["0048021A"]?.Value?.[0])
    .find(Boolean);
  const { orientation } = geometry;
  const spacing = geometry.spacing.map((v) => v * plan.scale);
  const items = [];
  for (let ty = 0; ty < plan.tilesY; ty++) {
    for (let tx = 0; tx < plan.tilesX; tx++) {
      const col = tx * tile;
      const row = ty * tile;
      // PixelSpacing is (row spacing, column spacing), in mm.
      const along = (i) =>
        orientation[i] * col * spacing[1] +
        orientation[i + 3] * row * spacing[0];
      const position = {
        "0048021E": { vr: "SL", Value: [col + 1] },
        "0048021F": { vr: "SL", Value: [row + 1] },
        "0040072A": { vr: "DS", Value: [formatDs(geometry.x + along(0))] },
        "0040073A": { vr: "DS", Value: [formatDs(geometry.y + along(1))] },
      };
      if (source?.["0040074A"]) {
        position["0040074A"] = structuredClone(source["0040074A"]);
      }
      items.push({ "0048021A": { vr: "SQ", Value: [position] } });
    }
  }
  const indices = dimensionIndexValues(base.dict, shared, items);
  indices?.forEach((values, i) => {
    items[i]["00209111"] = {
      vr: "SQ",
      Value: [{ "00209157": { vr: "UL", Value: values } }],
    };
  });
  return items;
}

/**
 * The shared functional groups item of the new levels: the base's shared
 * groups without the macros that each level gets new, plus each per-frame
 * macro (for example PixelMeasures) that is the same in every frame. Throws
 * when such a macro differs between frames, or is missing in some, because
 * one shared item cannot hold it.
 */
function sharedGroups({ dict, path: file }) {
  const shared = structuredClone(dict["52009229"]?.Value?.[0] ?? {});
  for (const tag of IMPLIED_PER_FRAME) {
    delete shared[tag];
  }
  const perFrame = dict["52009230"]?.Value ?? [];
  const tags = new Set(perFrame.flatMap((item) => Object.keys(item)));
  for (const tag of tags) {
    if (IMPLIED_PER_FRAME.has(tag) || shared[tag]) {
      continue;
    }
    const value = JSON.stringify(perFrame[0][tag]);
    if (perFrame.some((item) => JSON.stringify(item[tag]) !== value)) {
      throw new Error(
        `${file}: the per-frame functional group (${tag}) differs between ` +
          "frames, so it cannot move to the shared groups of a new level"
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
  geometry,
  plan,
  options,
  photometric,
  uids,
  lossyRatio,
}) {
  const meta = structuredClone(base.meta);
  // The per-frame sequence is the largest part of a sparse header, and
  // each level gets a new one, so it is not cloned.
  const rest = { ...base.dict };
  delete rest["52009230"];
  const dict = structuredClone(rest);
  const { tile, factor, target } = options;

  dict["52009229"] = { vr: "SQ", Value: [structuredClone(shared)] };
  const sparse = Boolean(geometry);
  if (sparse) {
    dict["52009230"] = {
      vr: "SQ",
      Value: planePositions({ base, shared, geometry, plan, tile }),
    };
  }
  for (const tag of CONCATENATION_TAGS) {
    delete dict[tag];
  }
  dropEncapsulatedIcon(dict);
  set(
    dict,
    "00080008",
    "CS",
    "DERIVED",
    "PRIMARY",
    "VOLUME",
    // A base that was itself a reduced level stays RESAMPLED.
    plan.level || base.dict["00080008"]?.Value?.[3] === "RESAMPLED"
      ? "RESAMPLED"
      : "NONE"
  );
  set(dict, "00080018", "UI", uids.sop);
  set(meta, "00020003", "UI", uids.sop);
  set(dict, "0020000E", "UI", uids.series);
  if (dict["00080019"]) {
    set(dict, "00080019", "UI", uids.pyramid);
  }
  set(dict, "00200013", "IS", uids.instance);
  set(dict, "00209311", "CS", sparse ? "TILED_SPARSE" : "TILED_FULL");
  // Type 1C for TILED_FULL; checkPlanes allows one of each per image.
  set(dict, "00480303", "UL", 1);
  set(dict, "00480302", "UL", 1);
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
    sourceUid: pixelLayoutSyntax(first(base.meta, "00020010")),
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
  remapUid,
  nextInstance,
}) {
  const { base } = group;
  checkBase(base);
  checkPyramid(group, inPlace);
  const shared = sharedGroups(base);
  // Only a group with its own Z offset can give sparse levels their Z.
  const geometry =
    group.multiPlane && group.z !== ""
      ? slideGeometry(base, shared)
      : undefined;
  // Before any file exists, so an off-grid tile leaves nothing behind.
  const frameCount = Number(first(base.dict, "00280008") ?? 1);
  const position = tilePosition(base.dict);
  const order = rasterOrder(position, frameCount);
  const others = group.levels.filter((l) => l !== base);
  const { tile, factor, target, encode } = options;
  const width = Number(first(base.dict, "00480006"));
  const height = Number(first(base.dict, "00480007"));
  const spp = first(base.dict, "00280002");
  const sourceUid = pixelLayoutSyntax(first(base.meta, "00020010"));
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
  progress?.startFile(base.path, frameCount, {
    tiles: levels.reduce((sum, l) => sum + l.frames, 0),
  });

  const sourcePyramid = first(base.dict, "00080019");
  const seriesUid = inPlace ? group.uid : remapUid(group.uid);
  const pyramidUid =
    inPlace || !sourcePyramid ? sourcePyramid : remapUid(sourcePyramid);
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
      instance: nextInstance(seriesUid),
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
    for (const level of others) {
      addTotals(before, await measure(dcmjs, level.path));
    }

    for (const output of outputs) {
      const { meta, dict } = levelDataset({
        base,
        shared,
        geometry,
        plan: output.plan,
        options,
        photometric,
        uids: {
          sop: output.sop,
          series: seriesUid,
          pyramid: pyramidUid,
          instance: output.instance,
        },
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

    // Every level is written; only now replace or delete anything. The base
    // goes last, so a failed rename leaves the old pyramid whole.
    const renamed = [];
    try {
      for (const output of [...outputs].reverse()) {
        fs.renameSync(output.tempPath, output.finalPath);
        renamed.push(output.finalPath);
      }
    } catch (err) {
      for (const file of renamed) {
        fs.rmSync(file, { force: true });
      }
      throw err;
    }
    if (inPlace) {
      // The new pyramid is in place; a file that cannot go is reported,
      // and the others are still deleted.
      report.deleted = [];
      report.notDeleted = [];
      for (const level of others) {
        try {
          fs.rmSync(level.path);
          report.deleted.push(level.path);
        } catch (err) {
          report.notDeleted.push({ path: level.path, error: err.message });
        }
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
  const unreadable = [];
  const unplaced = [];
  const ambiguous = new Map();
  try {
    groups = await findPyramids(
      dcmjs,
      positionals,
      unreadable,
      unplaced,
      ambiguous
    );
  } catch (err) {
    stderr(`dcmjs wsiresize: ${err.message}`);
    return 1;
  }
  for (const { file, error } of unreadable) {
    stderr(`dcmjs wsiresize: ${file}: skipped, ${error}`);
  }
  for (const file of unplaced) {
    stderr(
      `dcmjs wsiresize: warning: ${file}: the focal plane of this level is ` +
        "unclear, so it is left as it is and a -d copy does not hold it"
    );
  }
  const reports = [];
  let failed = unreadable.length;
  // WR-U4b: refused once for each optical path, before any file changes.
  if (inPlace) {
    for (const { uid, paths } of ambiguous.values()) {
      failed++;
      const name = paths ? `optical path "${paths}"` : "the optical path";
      const error =
        `${name} has several focal planes or levels on an unclear plane, ` +
        "so --in-place could delete a level of another plane; use -d";
      reports.push({ series: uid, opticalPaths: paths, error });
      stderr(`dcmjs wsiresize: series ${uid}: ${error}`);
    }
    groups = groups.filter((g) => !ambiguous.has(g.opticalKey));
  }
  if (!groups.length && !reports.length) {
    stderr("dcmjs wsiresize: no VL Whole Slide Microscopy pyramid found");
    return 1;
  }

  if (inPlace && options.target.lossy && !dryRun && groups.length) {
    stderr(
      `dcmjs wsiresize: warning: ${options.target.name} is lossy, and ` +
        "--in-place keeps the base SOPInstanceUID. A system that already " +
        "holds that instance can keep the old pixels."
    );
  }

  // Pyramids of one source series (channels, focal planes) share the new
  // series and PyramidUID, and are numbered as one series.
  const newUids = new Map();
  const remapUid = (uid) => {
    if (!newUids.has(uid)) {
      newUids.set(uid, dcmjs.data.DicomMetaDictionary.uid());
    }
    return newUids.get(uid);
  };
  const instances = new Map();
  const nextInstance = (seriesUid) => {
    instances.set(seriesUid, (instances.get(seriesUid) ?? 0) + 1);
    return instances.get(seriesUid);
  };

  const progress = new Progress({
    command: "wsiresize",
    totalFiles: groups.length,
    write: stderr,
    quiet: values.quiet || dryRun,
  });
  for (const group of groups) {
    try {
      const report = await resizeSeries({
        dcmjs,
        group,
        options,
        outDir: values.directory,
        inPlace,
        dryRun,
        progress,
        remapUid,
        nextInstance,
      });
      reports.push(report);
      for (const { path: file, error } of report.notDeleted ?? []) {
        failed++;
        stderr(
          `dcmjs wsiresize: warning: ${file} is an old level of the rebuilt ` +
            `pyramid and could not be deleted (${error}); delete it by hand`
        );
      }
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
          unreadable: unreadable.length ? unreadable : undefined,
          unplaced: unplaced.length ? unplaced : undefined,
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

// src/commands/multiframe.js
//
// dcmjs multiframe — convert classic single-frame CT, MR and PET images to
// Legacy Converted Enhanced multi-frame images (PS3.3 A.70 to A.72), from
// Part 10 files or from a Static-DICOMweb tree.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  discoverDicomFiles,
  looksLikeStaticDicomWeb,
  pathKey,
  tempPathFor,
} from "../io.js";
import {
  checkFrameCount,
  readPart10Frames,
  readPart10Header,
} from "../pixel/frameReader.js";
import { FrameSpool, writePart10WithFrames } from "../pixel/frameWriter.js";
import {
  EXPLICIT_LITTLE_ENDIAN,
  isLittleEndianNative,
  pixelLayoutSyntax,
} from "../pixel/transferSyntaxes.js";
import {
  LAYOUTS,
  buildLegacyConverted,
  groupInstances,
} from "../enhanced/legacyConverted.js";
import { fixValue, loadJson, saveJson } from "../utils/index.js";
import { frameToBuffer } from "../utils/streamToBuffer.js";
import { StaticDicomWebAccess } from "../staticdicomweb/StaticDicomWebAccess.js";

export const multiframeUsage = `usage: dcmjs multiframe <file-or-directory>... -d <dir> [options]
       dcmjs multiframe <static-dicomweb-root-or-study> (-d <dir> | --in-place) [options]

Converts classic single-frame CT, MR and PET images to Legacy Converted
Enhanced CT, MR and PET images (PS3.3 A.70 to A.72). The images of one
series, frame of reference, orientation, pixel layout and transfer syntax
make one stack. The frames are copied as they are, with no decode. Each new
instance gets a new SOPInstanceUID. A stack of one image is not converted.

References to the converted images in other instances (SR, SEG, KO) do not
change.

Input and output:
  Part 10 files or directories (for example a study directory), with -d <dir>
        writes <dir>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm for each new
        instance. The input files do not change.
  A Static-DICOMweb root (a directory with studies/) or one study directory
  of it (studies/<uid>), with -d <dir>
        the same Part 10 output, read from the tree.
  A Static-DICOMweb root or study directory, with --in-place
        adds the new instances to the tree. Without --new-series, the
        series metadata and query files list the new instances in place of
        the converted images. The files of the converted images stay in the
        tree.

Options:
  -d, --directory <dir>   write Part 10 files to <dir>
  --in-place              update the Static-DICOMweb tree
  --new-series            put the new instances in a new series, one for each
                          source series, with "(multi-frame)" added to the
                          SeriesDescription. The source series do not change,
                          so a viewer shows the old and the new images.
  --layout <layout>       a series with more than one image at a position
                          (time points, b-values, echoes, or Dixon FAT,
                          WATER, IN_PHASE, OPP_PHASE) has one volume for each:
                            split        one instance for each volume
                                         (default)
                            grouped      one instance, volume after volume
                            interleaved  one instance, by position, with
                                         the volumes in order at each position
  -S, --study <uid>       only this study (repeatable; tree root input only)
  --series <uid>          only this series (repeatable)
  --dry-run               print the planned instances; write nothing
  --json                  print the report as JSON
  -h, --help              show this help
`;

const first = (dict, tag) => dict?.[tag]?.Value?.[0];
const SOP_CLASS = "00080016";
const SOP_INSTANCE = "00080018";
const STUDY = "0020000D";
const SERIES = "0020000E";
const SERIES_DESCRIPTION = "0008103E";
const INSTANCE_NUMBER = "00200013";
const NUMBER_OF_FRAMES = "00280008";
const PIXEL_DATA = "7FE00010";
/** The ImplementationClassUID of the files that `multiframe` writes. */
const IMPLEMENTATION_CLASS_UID = "2.25.153674331502755447381779073915979849773";

/** Throws on a bad combination of options. */
export function parseMultiframeOptions(values, { tree, studyDir }) {
  if (values["in-place"] && values.directory) {
    throw new Error("give -d <dir> or --in-place, not both");
  }
  if (values["in-place"] && !tree) {
    throw new Error(
      "--in-place updates a Static-DICOMweb tree; for Part 10 input give -d <dir>"
    );
  }
  if (!values["in-place"] && !values.directory && !values["dry-run"]) {
    throw new Error(
      tree
        ? "give -d <dir> for Part 10 output, or --in-place to update the tree"
        : "give -d <dir> for the output"
    );
  }
  if (values.study?.length && !tree) {
    throw new Error("--study selects studies of a Static-DICOMweb tree only");
  }
  if (values.study?.length && studyDir) {
    throw new Error(
      "the input is one study directory; give the tree root to use --study"
    );
  }
  if (values.layout !== undefined && !LAYOUTS.includes(values.layout)) {
    throw new Error(
      `--layout must be one of ${LAYOUTS.join(", ")}, not "${values.layout}"`
    );
  }
}

/**
 * The tree root of a Static-DICOMweb input: the root itself, or a study
 * directory `<root>/studies/<uid>` with its study UID. Undefined for other
 * input.
 */
export function resolveTree(input) {
  if (looksLikeStaticDicomWeb(input)) {
    return { root: input };
  }
  const studyDir = path.resolve(input);
  const studies = path.dirname(studyDir);
  const isDir = (dir) =>
    fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory();
  if (
    path.basename(studies) === "studies" &&
    isDir(path.join(studyDir, "series"))
  ) {
    return { root: path.dirname(studies), study: path.basename(studyDir) };
  }
  return undefined;
}

/** The transfer syntax that the new file has for frames of `uid`. */
const outputSyntax = (uid) =>
  isLittleEndianNative(uid) ? EXPLICIT_LITTLE_ENDIAN : uid;

/**
 * Writes a Part 10 file through a temporary file and a rename, so a failed
 * write leaves no partial file (PX-I6). `addFrames(spool)` appends the
 * frames.
 */
async function writeFile({
  dcmjs,
  outputPath,
  dict,
  transferSyntaxUID,
  addFrames,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = tempPathFor(outputPath);
  const spool = new FrameSpool(tempPath);
  try {
    await addFrames(spool);
    const meta = {
      "00020001": { vr: "OB", Value: [new Uint8Array([0, 1]).buffer] },
      "00020002": { vr: "UI", Value: [first(dict, SOP_CLASS)] },
      "00020003": { vr: "UI", Value: [first(dict, SOP_INSTANCE)] },
      "00020010": { vr: "UI", Value: [transferSyntaxUID] },
      "00020012": { vr: "UI", Value: [IMPLEMENTATION_CLASS_UID] },
      "00020013": { vr: "SH", Value: ["DCMJS_COMMANDS"] },
    };
    const written = await writePart10WithFrames({
      dcmjs,
      outputPath: tempPath,
      meta,
      dict,
      spool,
      encapsulated: !isLittleEndianNative(transferSyntaxUID),
      pixelData: true,
    });
    fs.renameSync(tempPath, outputPath);
    return written;
  } finally {
    await spool.remove();
    fs.rmSync(tempPath, { force: true });
  }
}

/** The SeriesDescription (LO, 64 characters) of a new series. */
const newSeriesDescription = (description) =>
  description
    ? `${String(description).slice(0, 49)} (multi-frame)`
    : "(multi-frame)";

/**
 * A new SOP Instance UID, series and InstanceNumber for each stack. With
 * `newSeries`, each source series gets one new SeriesInstanceUID, and the
 * InstanceNumber of the new series starts at 1.
 */
function planStacks({ dcmjs, stacks, instanceNumberAfter, newSeries }) {
  const { uid } = dcmjs.data.DicomMetaDictionary;
  const seriesFor = new Map();
  const counters = new Map();
  return stacks.map((stack) => {
    if (!seriesFor.has(stack.seriesUID)) {
      seriesFor.set(stack.seriesUID, newSeries ? uid() : stack.seriesUID);
    }
    const seriesUID = seriesFor.get(stack.seriesUID);
    const next =
      (counters.get(seriesUID) ??
        (newSeries ? 0 : instanceNumberAfter(seriesUID))) + 1;
    counters.set(seriesUID, next);
    return { stack, seriesUID, sop: uid(), instanceNumber: next };
  });
}

/**
 * Builds each planned dataset. `dicts` are all the instances read, so that
 * `locate` can place a referenced image in its study and series.
 */
function buildPlans({ dcmjs, plans, dicts, json }) {
  const uid = () => dcmjs.data.DicomMetaDictionary.uid();
  const where = new Map(
    dicts.map((dict) => [
      first(dict, SOP_INSTANCE),
      { study: first(dict, STUDY), series: first(dict, SERIES) },
    ])
  );
  for (const plan of plans) {
    const { dict, dropped, unlocated } = buildLegacyConverted({
      stack: plan.stack,
      sopInstanceUID: plan.sop,
      instanceNumber: plan.instanceNumber,
      uid,
      locate: (sop) => where.get(sop),
      json,
    });
    if (plan.seriesUID !== plan.stack.seriesUID) {
      dict[SERIES] = { vr: "UI", Value: [plan.seriesUID] };
      dict[SERIES_DESCRIPTION] = {
        vr: "LO",
        Value: [newSeriesDescription(first(dict, SERIES_DESCRIPTION))],
      };
    }
    plan.dict = dict;
    plan.dropped = dropped;
    plan.unlocated = unlocated;
  }
}

const describePlan = (plan) => ({
  series: plan.seriesUID,
  sourceSeries:
    plan.seriesUID === plan.stack.seriesUID ? undefined : plan.stack.seriesUID,
  sopInstanceUID: plan.sop,
  sopClassUID: plan.stack.target.uid,
  modality: plan.stack.target.name,
  frames: plan.stack.instances.length,
  stack: plan.stack.isStack,
  layout: plan.stack.volumes.length > 1 ? plan.stack.layout : undefined,
  volumes: plan.stack.volumes.filter(Boolean).length
    ? plan.stack.volumes
    : undefined,
  sources: plan.stack.instances.map((i) => i.id),
  dropped: plan.dropped?.length ? plan.dropped : undefined,
  unknown: plan.stack.instances.some((i) => i.unknown?.size)
    ? [...new Set(plan.stack.instances.flatMap((i) => [...(i.unknown ?? [])]))]
    : undefined,
  unlocated: plan.unlocated?.length ? plan.unlocated : undefined,
});

const selected = (values, seriesUID) =>
  !values.series?.length || values.series.includes(seriesUID);

// ---------------------------------------------------------------- Part 10

async function runPart10({ dcmjs, positionals, values, report }) {
  const records = [];
  const seen = new Set();
  for (const input of positionals) {
    for (const file of discoverDicomFiles(input)) {
      const key = pathKey(file);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        const { meta, dict } = await readPart10Header({
          dcmjs,
          inputPath: file,
        });
        // A Deflated file has the pixel layout of Explicit VR LE.
        records.push({
          id: file,
          dict,
          transferSyntaxUID: pixelLayoutSyntax(first(meta, "00020010")),
        });
      } catch (err) {
        report.unreadable.push({ file, error: err.message });
      }
    }
  }
  const inputs = new Set(records.map((r) => pathKey(r.id, { foldCase: true })));
  const { stacks, refused, skipped } = groupInstances(
    records.filter((r) => selected(values, first(r.dict, SERIES))),
    { layout: values.layout }
  );
  report.refused.push(...refused);
  report.skipped.push(...skipped);
  const plans = planStacks({
    dcmjs,
    stacks,
    instanceNumberAfter: () => 0,
    newSeries: values["new-series"],
  });
  buildPlans({ dcmjs, plans, dicts: records.map((r) => r.dict), json: false });
  report.instances = plans.map(describePlan);
  if (values["dry-run"]) {
    return;
  }

  for (const [i, plan] of plans.entries()) {
    const entry = report.instances[i];
    try {
      const out = path.join(
        values.directory,
        plan.seriesUID,
        `${plan.sop}.dcm`
      );
      if (inputs.has(pathKey(out, { foldCase: true }))) {
        throw new Error(`${out} is an input file; give a different -d`);
      }
      await writeFile({
        dcmjs,
        outputPath: out,
        dict: plan.dict,
        transferSyntaxUID: outputSyntax(plan.stack.transferSyntaxUID),
        addFrames: async (spool) => {
          for (const source of plan.stack.instances) {
            const read = await readPart10Frames({
              dcmjs,
              inputPath: source.id,
              onFrame: (frame) => spool.append(frame),
            });
            checkFrameCount(read);
          }
        },
      });
      entry.path = out;
    } catch (err) {
      entry.error = err.message;
    }
  }
}

// ---------------------------------------------------------- Static-DICOMweb

/** The path of frame `n` of an instance: `<n>.mht` or `<n>.mht.gz`. */
function framePath(instanceDir, n) {
  const plain = path.join(instanceDir, "frames", `${n}.mht`);
  if (fs.existsSync(plain)) {
    return plain;
  }
  const gz = `${plain}.gz`;
  return fs.existsSync(gz) ? gz : undefined;
}

/** The transfer syntax that the multipart header of a frame file names. */
function frameTransferSyntax(file) {
  if (!file) {
    return undefined;
  }
  let bytes = fs.readFileSync(file);
  if (file.endsWith(".gz")) {
    bytes = zlib.gunzipSync(bytes);
  }
  const head = bytes.subarray(0, 1024).toString("latin1");
  return (
    head.match(/transfer-syntax=([0-9.]+)/i)?.[1] ?? EXPLICIT_LITTLE_ENDIAN
  );
}

/** Reads one study: each series dir with its metadata.gz. */
async function readStudy(root, studyUID) {
  const studyDir = path.join(root, "studies", studyUID);
  const seriesRoot = path.join(studyDir, "series");
  const series = new Map();
  if (!fs.existsSync(seriesRoot)) {
    return { studyDir, series };
  }
  for (const seriesUID of fs.readdirSync(seriesRoot).sort()) {
    const dir = path.join(seriesRoot, seriesUID);
    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }
    const metadata = await loadJson(dir, "metadata.gz", null);
    if (Array.isArray(metadata)) {
      series.set(seriesUID, { dir, metadata });
    }
  }
  return { studyDir, series };
}

/**
 * A copy of the DICOM JSON of a tree instance that can become a dataset:
 * - an element with no `vr` (some servers leave it out) gets the `vr` of
 *   the dictionary;
 * - the private blocks of the creator `dedupped` (the deduplication records
 *   of Static-DICOMweb, which name the hashes of the source instance) are
 *   left out;
 * - an element whose `vr` stays unknown cannot be written, and is left out
 *   and added to `unknown`.
 */
function datasetOf(dcmjs, json, unknown) {
  const { dictionary, punctuateTag } = dcmjs.data.DicomMetaDictionary;
  const dedupped = new Set(
    Object.keys(json)
      .filter(
        (tag) =>
          /^[0-9A-F]{4}00[1-9A-F][0-9A-F]$/i.test(tag) &&
          parseInt(tag.slice(0, 4), 16) % 2 === 1 &&
          first(json, tag) === "dedupped"
      )
      .map((tag) => `${tag.slice(0, 4)}${tag.slice(6)}`.toUpperCase())
  );
  const dict = {};
  for (const [tag, element] of Object.entries(json)) {
    const block = `${tag.slice(0, 4)}${tag.slice(4, 6)}`.toUpperCase();
    const creator = `${tag.slice(0, 4)}${tag.slice(6)}`.toUpperCase();
    if (
      dedupped.has(block) ||
      (tag.slice(4, 6) === "00" && dedupped.has(creator))
    ) {
      continue;
    }
    const vr = element?.vr ?? dictionary[punctuateTag(tag.toUpperCase())]?.vr;
    if (!vr) {
      unknown.add(tag.toUpperCase());
      continue;
    }
    dict[tag] =
      vr === "SQ"
        ? {
            ...element,
            vr,
            Value: element.Value?.map((child) =>
              datasetOf(dcmjs, child, unknown)
            ),
          }
        : { ...element, vr };
  }
  return dict;
}

/** The image records of the selected series, for groupInstances. */
function treeRecords(dcmjs, series, values) {
  const records = [];
  for (const [seriesUID, { dir, metadata }] of series) {
    if (!selected(values, seriesUID)) {
      continue;
    }
    for (const json of metadata) {
      const sop = first(json, SOP_INSTANCE);
      if (!json[PIXEL_DATA] || !sop) {
        continue;
      }
      const instanceDir = path.join(dir, "instances", sop);
      const unknown = new Set();
      records.push({
        id: sop,
        dict: datasetOf(dcmjs, json, unknown),
        unknown,
        seriesUID,
        instanceDir,
        transferSyntaxUID: frameTransferSyntax(framePath(instanceDir, 1)),
      });
    }
  }
  return records;
}

/** The byte size and DataView reader of each binary numeric VR. */
const NUMERIC_VRS = {
  SS: [2, "getInt16"],
  US: [2, "getUint16"],
  SL: [4, "getInt32"],
  UL: [4, "getUint32"],
  FL: [4, "getFloat32"],
  FD: [8, "getFloat64"],
  SV: [8, "getBigInt64"],
  UV: [8, "getBigUint64"],
};

/** The value of binary data: numbers for a numeric VR, else the bytes. */
function binaryValue(vr, bytes) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.length
  );
  const numeric = NUMERIC_VRS[vr];
  if (!numeric) {
    return [buffer];
  }
  const [size, read] = numeric;
  const view = new DataView(buffer);
  return Array.from({ length: Math.floor(bytes.length / size) }, (_, i) =>
    Number(view[read](i * size, true))
  );
}

/**
 * Fills each BulkDataURI and InlineBinary value of `json` with its data.
 * `DicomAccess.importBulkdata` keeps numeric values as bytes and does not
 * wait for nested items, so this command has its own copy.
 */
async function importBulkdata(instance, json) {
  for (const [tag, element] of Object.entries(json)) {
    if (element?.vr === "SQ") {
      for (const child of element.Value ?? []) {
        await importBulkdata(instance, child);
      }
    } else if (element?.BulkDataURI && tag !== PIXEL_DATA) {
      const { buffer } = await instance.openBulkdata(tag, element);
      json[tag] = {
        vr: element.vr,
        Value: binaryValue(element.vr, new Uint8Array(buffer)),
      };
    } else if (element?.InlineBinary) {
      json[tag] = {
        vr: element.vr,
        Value: binaryValue(
          element.vr,
          Buffer.from(element.InlineBinary, "base64")
        ),
      };
    } else {
      fixValue(element);
    }
  }
  delete json[PIXEL_DATA];
  return json;
}

/** Writes Part 10 files of the planned instances. */
async function treeToPart10({ dcmjs, root, studyUID, plans, values }) {
  const access = new StaticDicomWebAccess(root, {});
  const study = access.createAccess(studyUID);
  const instanceAccess = (seriesUID, sop) =>
    study.createAccess(seriesUID).createAccess(sop);

  for (const plan of plans) {
    const { seriesUID } = plan.stack;
    try {
      const sources = plan.stack.instances;
      const dict = await importBulkdata(
        instanceAccess(seriesUID, sources[0].id),
        structuredClone(plan.dict)
      );
      plan.entry.path = path.join(
        values.directory,
        plan.seriesUID,
        `${plan.sop}.dcm`
      );
      await writeFile({
        dcmjs,
        outputPath: plan.entry.path,
        dict,
        transferSyntaxUID: outputSyntax(plan.stack.transferSyntaxUID),
        addFrames: async (spool) => {
          for (const source of sources) {
            const frame = await instanceAccess(seriesUID, source.id).openFrame(
              1
            );
            const { buffer } = await frameToBuffer(frame);
            await spool.append(new Uint8Array(buffer));
          }
        },
      });
    } catch (err) {
      plan.entry.error = err.message;
      delete plan.entry.path;
    }
  }
}

/** Instance-relative BulkDataURI values, as create-dicomweb writes them. */
function instanceRelative(json, sop) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!node || typeof node !== "object") {
      return node;
    }
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        if (key === "BulkDataURI" && typeof value === "string") {
          if (value.replace(/^\.\//, "") === `instances/${sop}/frames`) {
            return [key, "./frames"];
          }
          return [
            key,
            value.replace(/^\.\.\/\.\.\/bulkdata\//, "../../../../bulkdata/"),
          ];
        }
        return [key, walk(value)];
      })
    );
  };
  return walk(json);
}

/** True when a query entry is in tag-keyed DICOM JSON, not keyword form. */
const tagForm = (entry) =>
  Object.keys(entry).some((key) => /^[0-9A-F]{8}$/i.test(key));

/** Sets a value of a query entry, in the form that the entry has. */
function setValue(entry, keyword, tag, vr, value) {
  if (tagForm(entry)) {
    entry[tag] = { vr, Value: [value] };
  } else {
    entry[keyword] = value;
  }
}

/** Changes a count of a query entry, when the entry has the count. */
function setCount(entry, keyword, tag, update) {
  if (keyword in entry) {
    entry[keyword] = update(Number(entry[keyword] ?? 0));
  } else if (entry[tag]) {
    entry[tag] = { vr: "IS", Value: [update(Number(first(entry, tag) ?? 0))] };
  }
}

const entryUid = (entry, keyword, tag) => entry?.[keyword] ?? first(entry, tag);

/** The instance query entry of a new instance, in the form of `like`. */
function instanceQueryEntry(json, like) {
  const tags = {
    StudyInstanceUID: STUDY,
    SeriesInstanceUID: SERIES,
    SOPInstanceUID: SOP_INSTANCE,
    SOPClassUID: SOP_CLASS,
    InstanceNumber: INSTANCE_NUMBER,
    NumberOfFrames: NUMBER_OF_FRAMES,
  };
  const keywordForm = like && !tagForm(like);
  const entry = {};
  for (const [keyword, tag] of Object.entries(tags)) {
    if (!json[tag]) {
      continue;
    }
    if (keywordForm) {
      entry[keyword] = first(json, tag);
    } else {
      entry[tag] = structuredClone(json[tag]);
    }
  }
  return entry;
}

/**
 * Writes the instance query files of the series dir `to`, in the form of
 * those of the source series dir `from`: the source entries whose SOP
 * Instance UID passes `keep`, then the entries of `added`. Only the files
 * that the source series has are written.
 */
async function writeInstanceIndexes(from, to, keep, added) {
  for (const sub of ["instances", "."]) {
    const index = await loadJson(path.join(from, sub), "index.json.gz", null);
    if (!Array.isArray(index)) {
      continue;
    }
    const kept = index.filter((entry) =>
      keep(entryUid(entry, "SOPInstanceUID", SOP_INSTANCE))
    );
    kept.push(...added.map((json) => instanceQueryEntry(json, index[0])));
    await saveJson(path.join(to, sub), "index.json.gz", kept);
  }
}

/**
 * Writes the frames of a new instance into `seriesDir` (copies of frame 1
 * of each source) and sets its PixelData BulkDataURI. When the source
 * instances have their own metadata.gz, as create-dicomweb writes it, the
 * new instance gets one too.
 */
async function writeTreeInstance(plan, seriesDir) {
  const sources = plan.stack.instances;
  const newDir = path.join(seriesDir, "instances", plan.sop);
  sources.forEach((source, i) => {
    const from = framePath(source.instanceDir, 1);
    if (!from) {
      throw new Error(
        `no frame file for ${source.id} in ${source.instanceDir}`
      );
    }
    const to = path.join(
      newDir,
      "frames",
      `${i + 1}.mht${from.endsWith(".gz") ? ".gz" : ""}`
    );
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  });
  const sourcePixel = sources[0].dict[PIXEL_DATA];
  const uri = String(
    sourcePixel.BulkDataURI ?? `instances/${sources[0].id}/frames`
  );
  plan.dict[PIXEL_DATA] = {
    vr: sourcePixel.vr ?? "OW",
    BulkDataURI: uri
      .replace(sources[0].id, plan.sop)
      .replace(`series/${plan.stack.seriesUID}/`, `series/${plan.seriesUID}/`),
  };
  const sourceMetadata = await loadJson(
    sources[0].instanceDir,
    "metadata.gz",
    null
  );
  if (sourceMetadata) {
    const own = instanceRelative(plan.dict, plan.sop);
    await saveJson(
      newDir,
      "metadata.gz",
      Array.isArray(sourceMetadata) ? [own] : own
    );
  }
  plan.entry.path = newDir;
}

/**
 * Writes the instance files of each plan into the series dir `dirOf(plan)`
 * before any metadata or query file changes. A plan that fails gets
 * `entry.error`, its partial files are removed, and it is left out of the
 * returned plans, so its source images stay listed.
 */
async function writeTreeInstances(plans, dirOf) {
  const written = [];
  for (const plan of plans) {
    try {
      await writeTreeInstance(plan, dirOf(plan));
      written.push(plan);
    } catch (err) {
      plan.entry.error = err.message;
      delete plan.entry.path;
      fs.rmSync(path.join(dirOf(plan), "instances", plan.sop), {
        recursive: true,
        force: true,
      });
    }
  }
  return written;
}

/**
 * Adds `instances` and `series` to the counts of the study query files,
 * and of the natural `study.json.gz` that `dcmjs dicomweb` writes.
 */
async function addStudyCounts(root, studyDir, studyUID, { instances, series }) {
  for (const [dir, name] of [
    [studyDir, "index.json.gz"],
    [studyDir, "study.json.gz"],
    [path.join(root, "studies"), "index.json.gz"],
  ]) {
    const index = await loadJson(dir, name, null);
    if (!Array.isArray(index)) {
      continue;
    }
    for (const entry of index) {
      if (entryUid(entry, "StudyInstanceUID", STUDY) === studyUID) {
        setCount(
          entry,
          "NumberOfStudyRelatedInstances",
          "00201208",
          (n) => n + instances
        );
        setCount(
          entry,
          "NumberOfStudyRelatedSeries",
          "00201206",
          (n) => n + series
        );
      }
    }
    await saveJson(dir, name, index);
  }
}

/** The plans of each target series, in plan order. */
function plansBySeries(plans) {
  const bySeries = new Map();
  for (const plan of plans) {
    if (!bySeries.has(plan.seriesUID)) {
      bySeries.set(plan.seriesUID, []);
    }
    bySeries.get(plan.seriesUID).push(plan);
  }
  return bySeries;
}

/**
 * Updates the tree in place: the new instances replace the converted
 * images in their series. The frames and the instance metadata are written
 * first, then the series metadata, and the query files last, so a reader
 * never finds a series that lists an instance whose frames are not there.
 */
async function replaceInTree({ root, studyUID, studyDir, series, plans }) {
  plans = await writeTreeInstances(
    plans,
    (plan) => series.get(plan.seriesUID).dir
  );
  if (!plans.length) {
    return;
  }
  const converted = new Set(
    plans.flatMap((plan) => plan.stack.instances.map((i) => i.id))
  );
  const counts = new Map();
  let studyDelta = 0;
  for (const [seriesUID, seriesPlans] of plansBySeries(plans)) {
    const { dir, metadata } = series.get(seriesUID);
    const added = seriesPlans.map((plan) => plan.dict);
    const next = [
      ...metadata.filter((json) => !converted.has(first(json, SOP_INSTANCE))),
      ...added,
    ];
    await saveJson(dir, "metadata.gz", next);
    counts.set(seriesUID, next.length);
    studyDelta += next.length - metadata.length;

    const singleton = await loadJson(dir, "series-singleton.json.gz", null);
    if (singleton) {
      for (const entry of [singleton].flat()) {
        setCount(
          entry,
          "NumberOfSeriesRelatedInstances",
          "00201209",
          () => next.length
        );
      }
      await saveJson(dir, "series-singleton.json.gz", singleton);
    }
    await writeInstanceIndexes(dir, dir, (sop) => !converted.has(sop), added);
  }

  const seriesIndex = await loadJson(studyDir, "series/index.json.gz", null);
  if (Array.isArray(seriesIndex)) {
    for (const entry of seriesIndex) {
      const count = counts.get(entryUid(entry, "SeriesInstanceUID", SERIES));
      if (count !== undefined) {
        setCount(
          entry,
          "NumberOfSeriesRelatedInstances",
          "00201209",
          () => count
        );
      }
    }
    await saveJson(studyDir, "series/index.json.gz", seriesIndex);
  }
  await addStudyCounts(root, studyDir, studyUID, {
    instances: studyDelta,
    series: 0,
  });
}

/** A query entry of a new series, made from the entry of its source. */
function newSeriesEntry(entry, { seriesUID, description, instances, frames }) {
  const copy = structuredClone(entry);
  setValue(copy, "SeriesInstanceUID", SERIES, "UI", seriesUID);
  setValue(copy, "SeriesDescription", SERIES_DESCRIPTION, "LO", description);
  setCount(copy, "NumberOfSeriesRelatedInstances", "00201209", () => instances);
  setCount(copy, "NumberOfFrames", NUMBER_OF_FRAMES, () => frames);
  return copy;
}

/**
 * Updates the tree in place with `--new-series`: each new series gets its
 * own directory, metadata and query files, made in the form of the source
 * series. The source series do not change.
 */
async function addSeriesToTree({ root, studyUID, studyDir, series, plans }) {
  plans = await writeTreeInstances(plans, (plan) =>
    path.join(studyDir, "series", plan.seriesUID)
  );
  if (!plans.length) {
    return;
  }
  const seriesIndex = await loadJson(studyDir, "series/index.json.gz", null);
  let instances = 0;
  const bySeries = plansBySeries(plans);
  for (const [seriesUID, seriesPlans] of bySeries) {
    const source = series.get(seriesPlans[0].stack.seriesUID);
    const dir = path.join(studyDir, "series", seriesUID);
    const added = seriesPlans.map((plan) => plan.dict);
    await saveJson(dir, "metadata.gz", added);
    instances += added.length;

    const values = {
      seriesUID,
      description: first(added[0], SERIES_DESCRIPTION),
      instances: added.length,
      frames: added.reduce((n, d) => n + Number(first(d, NUMBER_OF_FRAMES)), 0),
    };
    const singleton = await loadJson(
      source.dir,
      "series-singleton.json.gz",
      null
    );
    if (singleton) {
      const entries = [singleton]
        .flat()
        .map((entry) => newSeriesEntry(entry, values));
      await saveJson(
        dir,
        "series-singleton.json.gz",
        Array.isArray(singleton) ? entries : entries[0]
      );
    }
    await writeInstanceIndexes(source.dir, dir, () => false, added);
    const sourceEntry = seriesIndex?.find?.(
      (entry) =>
        entryUid(entry, "SeriesInstanceUID", SERIES) ===
        seriesPlans[0].stack.seriesUID
    );
    if (sourceEntry) {
      seriesIndex.push(newSeriesEntry(sourceEntry, values));
    }
  }
  if (Array.isArray(seriesIndex)) {
    await saveJson(studyDir, "series/index.json.gz", seriesIndex);
  }
  await addStudyCounts(root, studyDir, studyUID, {
    instances,
    series: bySeries.size,
  });
}

async function runTree({ dcmjs, tree, values, report }) {
  const { root } = tree;
  const studiesDir = path.join(root, "studies");
  const studyUIDs = tree.study
    ? [tree.study]
    : values.study?.length
      ? values.study
      : fs
          .readdirSync(studiesDir)
          .filter((name) =>
            fs.statSync(path.join(studiesDir, name)).isDirectory()
          )
          .sort();
  for (const studyUID of studyUIDs) {
    const { studyDir, series } = await readStudy(root, studyUID);
    if (!series.size) {
      report.errors.push({
        study: studyUID,
        error: `no series metadata in ${studyDir}`,
      });
      continue;
    }
    const { stacks, refused, skipped } = groupInstances(
      treeRecords(dcmjs, series, values),
      { layout: values.layout }
    );
    report.refused.push(...refused);
    report.skipped.push(...skipped);
    const converted = new Set(
      stacks.flatMap((s) => s.instances.map((i) => i.id))
    );
    const instanceNumberAfter = (seriesUID) =>
      Math.max(
        0,
        ...series
          .get(seriesUID)
          .metadata.filter((json) => !converted.has(first(json, SOP_INSTANCE)))
          .map((json) => Number(first(json, INSTANCE_NUMBER) ?? 0))
      );
    const plans = planStacks({
      dcmjs,
      stacks,
      instanceNumberAfter,
      newSeries: values["new-series"],
    });
    // In place, the new instance keeps the AT values of DICOM JSON.
    buildPlans({
      dcmjs,
      plans,
      dicts: [...series.values()].flatMap((s) => s.metadata),
      json: Boolean(values["in-place"]),
    });
    for (const plan of plans) {
      plan.entry = { study: studyUID, ...describePlan(plan) };
      report.instances.push(plan.entry);
    }
    if (values["dry-run"] || !plans.length) {
      continue;
    }
    try {
      if (!values["in-place"]) {
        await treeToPart10({ dcmjs, root, studyUID, plans, values });
      } else if (values["new-series"]) {
        await addSeriesToTree({ root, studyUID, studyDir, series, plans });
      } else {
        await replaceInTree({ root, studyUID, studyDir, series, plans });
      }
    } catch (err) {
      report.errors.push({ study: studyUID, error: err.message });
    }
  }
}

// ------------------------------------------------------------------ report

function printReport(report, stdout, dryRun) {
  for (const entry of report.instances) {
    const volumes = entry.volumes ? ` (${entry.volumes.join(", ")})` : "";
    stdout(
      `multiframe: series ${entry.sourceSeries ?? entry.series}: ` +
        `${entry.frames} ${entry.modality} images${volumes} -> ` +
        `${entry.sourceSeries ? `series ${entry.series}, ` : ""}` +
        `${entry.sopInstanceUID}${dryRun ? " (dry run)" : ""}`
    );
    if (entry.path) {
      stdout(`  wrote ${entry.path}`);
    }
  }
}

export async function runMultiframe({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const tree =
    positionals.length === 1 ? resolveTree(positionals[0]) : undefined;
  try {
    if (!positionals.length) {
      throw new Error("give at least one file or directory");
    }
    parseMultiframeOptions(values, {
      tree: Boolean(tree),
      studyDir: Boolean(tree?.study),
    });
  } catch (err) {
    stderr(`dcmjs multiframe: ${err.message}`);
    stderr(multiframeUsage);
    return 1;
  }
  const report = {
    input: tree ? "static-dicomweb" : "part10",
    inPlace: Boolean(values["in-place"]),
    newSeries: Boolean(values["new-series"]),
    layout: values.layout ?? "split",
    dryRun: Boolean(values["dry-run"]),
    instances: [],
    refused: [],
    skipped: [],
    unreadable: [],
    errors: [],
  };
  try {
    if (tree) {
      await runTree({ dcmjs, tree, values, report });
    } else {
      await runPart10({ dcmjs, positionals, values, report });
    }
  } catch (err) {
    stderr(`dcmjs multiframe: ${err.message}`);
    return 1;
  }

  for (const { file, error } of report.unreadable) {
    stderr(`dcmjs multiframe: ${file}: skipped, ${error}`);
  }
  for (const { id, reason } of [...report.refused, ...report.skipped]) {
    stderr(`dcmjs multiframe: ${id}: not converted, ${reason}`);
  }
  for (const entry of report.instances) {
    if (entry.error) {
      stderr(`dcmjs multiframe: ${entry.sopInstanceUID}: ${entry.error}`);
    }
    for (const tag of entry.dropped ?? []) {
      stderr(
        `dcmjs multiframe: warning: ${entry.sopInstanceUID}: (${tag.slice(0, 4)},` +
          `${tag.slice(4)}) is not allowed in a Legacy Converted image and was dropped`
      );
    }
    for (const tag of entry.unknown ?? []) {
      stderr(
        `dcmjs multiframe: warning: ${entry.sopInstanceUID}: (${tag.slice(0, 4)},` +
          `${tag.slice(4)}) has no VR in the tree metadata and was dropped`
      );
    }
    for (const sop of entry.unlocated ?? []) {
      stderr(
        `dcmjs multiframe: warning: ${entry.sopInstanceUID}: the referenced image ` +
          `${sop} is not in the input, so the Referenced or Source Image Evidence ` +
          `Sequence does not list it`
      );
    }
  }
  for (const { study, error } of report.errors) {
    stderr(`dcmjs multiframe: study ${study}: ${error}`);
  }
  if (!report.instances.length && !report.errors.length) {
    stderr(
      "dcmjs multiframe: no classic CT, MR or PET image to convert was found"
    );
    return 1;
  }

  if (values.json) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    printReport(report, stdout, report.dryRun);
  }
  const failed =
    report.unreadable.length +
    report.errors.length +
    report.instances.filter((e) => e.error).length;
  return failed ? 1 : 0;
}

// src/commands/multiframe.js
//
// dcmjs multiframe — convert classic single-frame CT, MR and PET images to
// Legacy Converted Enhanced multi-frame images (PS3.3 A.70 to A.72), from
// Part 10 files or from a Static-DICOMweb tree, and point the references of
// SR, SEG, KO and other objects to the new frames.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { discoverDicomFiles, looksLikeStaticDicomWeb, pathKey } from "../io.js";
import {
  checkFrameCount,
  readPart10Frames,
  readPart10Header,
} from "../pixel/frameReader.js";
import { FrameSpool, writePart10WithFrames } from "../pixel/frameWriter.js";
import { isLittleEndianNative } from "../pixel/transferSyntaxes.js";
import {
  buildLegacyConverted,
  groupInstances,
  hasReferences,
  rewriteReferences,
} from "../enhanced/legacyConverted.js";
import { loadJson, saveJson } from "../utils/index.js";
import { frameToBuffer } from "../utils/streamToBuffer.js";
import { StaticDicomWebAccess } from "../staticdicomweb/StaticDicomWebAccess.js";

export const multiframeUsage = `usage: dcmjs multiframe <file-or-directory>... -d <dir> [options]
       dcmjs multiframe <static-dicomweb-root> (-d <dir> | --in-place) [options]

Converts classic single-frame CT, MR and PET images to Legacy Converted
Enhanced CT, MR and PET images (PS3.3 A.70 to A.72): one multi-frame
instance for each stack of images with one series, frame of reference,
orientation, pixel layout and transfer syntax. The frames are copied as
they are, with no decode. Each new instance gets a new SOPInstanceUID and
keeps the SeriesInstanceUID of its source images.

References to the converted images in other instances (SR, SEG, KO,
presentation states, and any other ReferencedSOPInstanceUID) are changed
to the new instance and frame.

Input and output:
  Part 10 files or directories, with -d <dir>
        writes <dir>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm for each new
        instance and for each changed referencing instance. The input
        files do not change.
  A Static-DICOMweb root (a directory with studies/), with -d <dir>
        the same Part 10 output, read from the tree.
  A Static-DICOMweb root, with --in-place
        adds the new instances to the tree, and replaces the converted
        images with them in the series metadata, the series query files
        and the instance query files. The referencing instances are
        changed in place, and keep their SOPInstanceUID. The files of the
        converted images stay in the tree.

Options:
  -d, --directory <dir>   write Part 10 files to <dir>
  --in-place              update the Static-DICOMweb tree
  -S, --study <uid>       only this study (repeatable; tree input only)
  --series <uid>          only this series (repeatable)
  --dry-run               print the planned instances; write nothing
  --json                  print the report as JSON
  -h, --help              show this help
`;

const first = (dict, tag) => dict?.[tag]?.Value?.[0];
const SOP_CLASS = "00080016";
const SOP_INSTANCE = "00080018";
const SERIES = "0020000E";
const INSTANCE_NUMBER = "00200013";
const PIXEL_DATA = "7FE00010";
const EXPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
/** The ImplementationClassUID of the files that `multiframe` writes. */
const IMPLEMENTATION_CLASS_UID = "2.25.153674331502755447381779073915979849773";

/** Throws on a bad combination of options. */
export function parseMultiframeOptions(values, { tree }) {
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
}

/** The transfer syntax that the new file has for frames of `uid`. */
const outputSyntax = (uid) =>
  isLittleEndianNative(uid) ? EXPLICIT_LITTLE_ENDIAN : uid;

/**
 * Writes a Part 10 file through a temporary file and a rename, so a failed
 * write leaves no partial file (PX-I6). `addFrames(spool)` appends the
 * frames and can return `{ dict, transferSyntaxUID, pixelData }` to give
 * values that are known only after the read; `pixelData` false writes a
 * dataset with no PixelData.
 */
async function writeFile({
  dcmjs,
  outputPath,
  dict,
  transferSyntaxUID,
  addFrames,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  const spool = new FrameSpool(tempPath);
  try {
    const read = (await addFrames(spool)) ?? {};
    dict = read.dict ?? dict;
    transferSyntaxUID = read.transferSyntaxUID ?? transferSyntaxUID;
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
      pixelData: read.pixelData ?? true,
    });
    fs.renameSync(tempPath, outputPath);
    return written;
  } finally {
    await spool.remove();
    fs.rmSync(tempPath, { force: true });
  }
}

/** A new SOP Instance UID and InstanceNumber for each stack, and the refs. */
function planStacks({ dcmjs, stacks, instanceNumberAfter }) {
  const refs = new Map();
  const counters = new Map();
  const plans = stacks.map((stack) => {
    const sop = dcmjs.data.DicomMetaDictionary.uid();
    const next =
      (counters.get(stack.seriesUID) ?? instanceNumberAfter(stack.seriesUID)) +
      1;
    counters.set(stack.seriesUID, next);
    stack.instances.forEach((instance, i) => {
      refs.set(first(instance.dict, SOP_INSTANCE), {
        sop,
        sopClass: stack.target.uid,
        frame: i + 1,
      });
    });
    return { stack, sop, instanceNumber: next };
  });
  return { plans, refs };
}

/**
 * Builds each planned dataset; references between stacks are updated.
 * `dicts` are all the instances read, so that `locate` can place a
 * referenced image in its study and series.
 */
function buildPlans({ dcmjs, plans, refs, dicts, json }) {
  const uid = () => dcmjs.data.DicomMetaDictionary.uid();
  const where = new Map(
    dicts.map((dict) => [
      first(dict, SOP_INSTANCE),
      { study: first(dict, "0020000D"), series: first(dict, SERIES) },
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
    rewriteReferences(dict, refs);
    plan.dict = dict;
    plan.dropped = dropped;
    plan.unlocated = unlocated;
  }
}

const describePlan = (plan) => ({
  series: plan.stack.seriesUID,
  sopInstanceUID: plan.sop,
  sopClassUID: plan.stack.target.uid,
  modality: plan.stack.target.name,
  frames: plan.stack.instances.length,
  stack: plan.stack.isStack,
  sources: plan.stack.instances.map((i) => i.id),
  dropped: plan.dropped?.length ? plan.dropped : undefined,
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
        records.push({
          id: file,
          dict,
          transferSyntaxUID: first(meta, "00020010"),
        });
      } catch (err) {
        report.unreadable.push({ file, error: err.message });
      }
    }
  }
  const inputs = new Set(records.map((r) => pathKey(r.id, { foldCase: true })));
  const { stacks, refused } = groupInstances(
    records.filter((r) => selected(values, first(r.dict, SERIES)))
  );
  report.refused.push(...refused);
  const { plans, refs } = planStacks({
    dcmjs,
    stacks,
    instanceNumberAfter: () => 0,
  });
  buildPlans({
    dcmjs,
    plans,
    refs,
    dicts: records.map((r) => r.dict),
    json: false,
  });
  report.instances = plans.map(describePlan);

  const converted = new Set(refs.keys());
  const referencing = records.filter(
    (r) =>
      !converted.has(first(r.dict, SOP_INSTANCE)) && hasReferences(r.dict, refs)
  );
  report.references = referencing.map((r) => ({
    sopInstanceUID: first(r.dict, SOP_INSTANCE),
    series: first(r.dict, SERIES),
    source: r.id,
  }));
  if (values["dry-run"]) {
    return;
  }

  const outputPath = (dict) => {
    const out = path.join(
      values.directory,
      first(dict, SERIES),
      `${first(dict, SOP_INSTANCE)}.dcm`
    );
    if (inputs.has(pathKey(out, { foldCase: true }))) {
      throw new Error(`${out} is an input file; give a different -d`);
    }
    return out;
  };

  for (const [i, plan] of plans.entries()) {
    const entry = report.instances[i];
    try {
      const out = outputPath(plan.dict);
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

  for (const entry of report.references) {
    try {
      const out = outputPath({
        [SERIES]: { Value: [entry.series] },
        [SOP_INSTANCE]: { Value: [entry.sopInstanceUID] },
      });
      // The whole dataset is read again, with its frames: a header read
      // stops at PixelData.
      await writeFile({
        dcmjs,
        outputPath: out,
        addFrames: async (spool) => {
          const read = await readPart10Frames({
            dcmjs,
            inputPath: entry.source,
            onFrame: (frame) => spool.append(frame),
          });
          entry.changed = rewriteReferences(read.dict, refs);
          return {
            dict: read.dict,
            transferSyntaxUID: outputSyntax(read.transferSyntaxUID),
            pixelData: read.hasPixelData,
          };
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

/** The image records of the selected series, for groupInstances. */
function treeRecords(series, values) {
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
      records.push({
        id: sop,
        dict: json,
        seriesUID,
        instanceDir,
        transferSyntaxUID: frameTransferSyntax(framePath(instanceDir, 1)),
      });
    }
  }
  return records;
}

/** Fills each BulkDataURI and InlineBinary value of `json` with its bytes. */
async function importBulkdata(instance, json) {
  for (const [tag, element] of Object.entries(json)) {
    if (element?.vr === "SQ") {
      for (const child of element.Value ?? []) {
        await importBulkdata(instance, child);
      }
    } else if (element?.BulkDataURI && tag !== PIXEL_DATA) {
      const { buffer } = await instance.openBulkdata(tag, element);
      json[tag] = { vr: element.vr, Value: [buffer] };
    } else if (element?.InlineBinary) {
      const bytes = Buffer.from(element.InlineBinary, "base64");
      json[tag] = {
        vr: element.vr,
        Value: [
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        ],
      };
    } else if (element?.vr === "CS" && element.Value?.length === 1) {
      element.Value = String(element.Value[0]).split("\\");
    }
  }
  delete json[PIXEL_DATA];
  return json;
}

/** Writes Part 10 files of the planned instances and the referencing ones. */
async function treeToPart10({
  dcmjs,
  root,
  studyUID,
  plans,
  references,
  refs,
  values,
}) {
  const access = new StaticDicomWebAccess(root, {});
  const study = access.createAccess(studyUID);
  const instanceAccess = (seriesUID, sop) =>
    study.createAccess(seriesUID).createAccess(sop);
  const readFrame = async (instance, n) => {
    const { buffer } = await frameToBuffer(await instance.openFrame(n));
    return new Uint8Array(buffer);
  };
  const out = (seriesUID, sop) =>
    path.join(values.directory, seriesUID, `${sop}.dcm`);

  for (const plan of plans) {
    const { seriesUID } = plan.stack;
    try {
      const sources = plan.stack.instances;
      const dict = await importBulkdata(
        instanceAccess(seriesUID, sources[0].id),
        structuredClone(plan.dict)
      );
      plan.entry.path = out(seriesUID, plan.sop);
      await writeFile({
        dcmjs,
        outputPath: plan.entry.path,
        dict,
        transferSyntaxUID: outputSyntax(plan.stack.transferSyntaxUID),
        addFrames: async (spool) => {
          for (const source of sources) {
            await spool.append(
              await readFrame(instanceAccess(seriesUID, source.id), 1)
            );
          }
        },
      });
    } catch (err) {
      plan.entry.error = err.message;
      delete plan.entry.path;
    }
  }

  for (const reference of references) {
    const { entry, json, seriesUID } = reference;
    try {
      const instance = instanceAccess(seriesUID, entry.sopInstanceUID);
      const dict = structuredClone(json);
      entry.changed = rewriteReferences(dict, refs);
      const frames = Number(first(dict, "00280008") ?? 1);
      const hasPixels = Boolean(dict[PIXEL_DATA]);
      const transferSyntaxUID = hasPixels
        ? frameTransferSyntax(framePath(instance.url, 1))
        : EXPLICIT_LITTLE_ENDIAN;
      await importBulkdata(instance, dict);
      entry.path = out(seriesUID, entry.sopInstanceUID);
      await writeFile({
        dcmjs,
        outputPath: entry.path,
        dict,
        transferSyntaxUID: outputSyntax(transferSyntaxUID),
        addFrames: async (spool) => {
          for (let n = 1; hasPixels && n <= frames; n++) {
            await spool.append(await readFrame(instance, n));
          }
          return { pixelData: hasPixels };
        },
      });
    } catch (err) {
      entry.error = err.message;
      delete entry.path;
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

/**
 * Sets a count in a query entry, in the form the entry has: tag-keyed DICOM
 * JSON, or the keyword form that `dcmjs dicomweb` writes.
 */
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
    StudyInstanceUID: "0020000D",
    SeriesInstanceUID: SERIES,
    SOPInstanceUID: SOP_INSTANCE,
    SOPClassUID: SOP_CLASS,
    InstanceNumber: INSTANCE_NUMBER,
    NumberOfFrames: "00280008",
  };
  const keywordForm = like && "SOPInstanceUID" in like;
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

/** Updates an instance query file: the converted entries go, the new come. */
async function updateInstanceIndex(dir, name, converted, added) {
  const index = await loadJson(dir, name, null);
  if (!Array.isArray(index)) {
    return false;
  }
  const kept = index.filter(
    (entry) => !converted.has(entryUid(entry, "SOPInstanceUID", SOP_INSTANCE))
  );
  kept.push(...added.map((json) => instanceQueryEntry(json, index[0])));
  await saveJson(dir, name, kept);
  return true;
}

/**
 * Updates the tree in place (see the usage text). The new frames and
 * instance metadata are written first, then the referencing instances,
 * then the series metadata, and the query files last, so a reader never
 * finds a series that lists an instance whose frames are not there yet.
 */
async function treeInPlace({
  root,
  studyUID,
  studyDir,
  series,
  plans,
  references,
  refs,
}) {
  const changedSeries = new Set();
  const added = new Map();
  for (const plan of plans) {
    const { seriesUID } = plan.stack;
    const seriesDir = series.get(seriesUID).dir;
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
      BulkDataURI: uri.replace(sources[0].id, plan.sop),
    };
    // create-dicomweb also keeps the metadata of each instance, and builds
    // the series metadata from it; the new instance gets one too.
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
    if (!added.has(seriesUID)) {
      added.set(seriesUID, []);
    }
    added.get(seriesUID).push(plan.dict);
    changedSeries.add(seriesUID);
  }

  for (const { entry, json, seriesUID } of references) {
    entry.changed = rewriteReferences(json, refs);
    const instanceDir = path.join(
      series.get(seriesUID).dir,
      "instances",
      entry.sopInstanceUID
    );
    const own = await loadJson(instanceDir, "metadata.gz", null);
    if (own) {
      rewriteReferences(Array.isArray(own) ? own[0] : own, refs);
      await saveJson(instanceDir, "metadata.gz", own);
    }
    entry.path = instanceDir;
    changedSeries.add(seriesUID);
  }

  const converted = new Set(refs.keys());
  let studyDelta = 0;
  const counts = new Map();
  for (const seriesUID of changedSeries) {
    const { dir, metadata } = series.get(seriesUID);
    const before = metadata.length;
    const kept = metadata.filter(
      (json) => !converted.has(first(json, SOP_INSTANCE))
    );
    const next = [...kept, ...(added.get(seriesUID) ?? [])];
    await saveJson(dir, "metadata.gz", next);
    counts.set(seriesUID, next.length);
    studyDelta += next.length - before;

    const singleton = await loadJson(dir, "series-singleton.json.gz", null);
    if (singleton) {
      const entries = Array.isArray(singleton) ? singleton : [singleton];
      for (const entry of entries) {
        setCount(
          entry,
          "NumberOfSeriesRelatedInstances",
          "00201209",
          () => next.length
        );
      }
      await saveJson(dir, "series-singleton.json.gz", singleton);
    }
    const newOnes = added.get(seriesUID) ?? [];
    await updateInstanceIndex(
      path.join(dir, "instances"),
      "index.json.gz",
      converted,
      newOnes
    );
    await updateInstanceIndex(dir, "index.json.gz", converted, newOnes);
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
  if (studyDelta) {
    const adjust = (n) => n + studyDelta;
    for (const [dir, name] of [
      [studyDir, "index.json.gz"],
      [path.join(root, "studies"), "index.json.gz"],
    ]) {
      const index = await loadJson(dir, name, null);
      if (!Array.isArray(index)) {
        continue;
      }
      for (const entry of index) {
        if (entryUid(entry, "StudyInstanceUID", "0020000D") === studyUID) {
          setCount(entry, "NumberOfStudyRelatedInstances", "00201208", adjust);
        }
      }
      await saveJson(dir, name, index);
    }
  }
}

async function runTree({ dcmjs, root, values, report }) {
  const studiesDir = path.join(root, "studies");
  const studyUIDs = values.study?.length
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
    const records = treeRecords(series, values);
    const { stacks, refused } = groupInstances(records);
    report.refused.push(...refused);
    const instanceNumberAfter = (seriesUID) =>
      Math.max(
        0,
        ...series
          .get(seriesUID)
          .metadata.filter(
            (json) =>
              !stacks.some((s) => s.instances.some((i) => i.dict === json))
          )
          .map((json) => Number(first(json, INSTANCE_NUMBER) ?? 0))
      );
    const { plans, refs } = planStacks({ dcmjs, stacks, instanceNumberAfter });
    // In place, the new instance keeps the AT values of DICOM JSON.
    buildPlans({
      dcmjs,
      plans,
      refs,
      dicts: [...series.values()].flatMap((s) => s.metadata),
      json: Boolean(values["in-place"]),
    });
    for (const plan of plans) {
      plan.entry = { study: studyUID, ...describePlan(plan) };
      report.instances.push(plan.entry);
    }

    const references = [];
    for (const [seriesUID, { metadata }] of series) {
      for (const json of metadata) {
        if (!refs.has(first(json, SOP_INSTANCE)) && hasReferences(json, refs)) {
          const entry = {
            study: studyUID,
            series: seriesUID,
            sopInstanceUID: first(json, SOP_INSTANCE),
          };
          report.references.push(entry);
          references.push({ entry, json, seriesUID });
        }
      }
    }
    if (values["dry-run"] || (!plans.length && !references.length)) {
      continue;
    }
    if (values["in-place"]) {
      await treeInPlace({
        root,
        studyUID,
        studyDir,
        series,
        plans,
        references,
        refs,
      });
    } else {
      await treeToPart10({
        dcmjs,
        root,
        studyUID,
        plans,
        references,
        refs,
        values,
      });
    }
  }
}

// ------------------------------------------------------------------ report

function printReport(report, stdout, dryRun) {
  for (const entry of report.instances) {
    stdout(
      `multiframe: series ${entry.series}: ${entry.frames} ${entry.modality} ` +
        `images -> ${entry.sopInstanceUID}${dryRun ? " (dry run)" : ""}`
    );
    if (entry.path) {
      stdout(`  wrote ${entry.path}`);
    }
  }
  for (const entry of report.references) {
    stdout(
      `multiframe: references in ${entry.sopInstanceUID}` +
        `${entry.changed === undefined ? "" : ` (${entry.changed} changed)`}` +
        `${entry.path ? `: ${entry.path}` : ""}`
    );
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
    positionals.length === 1 && looksLikeStaticDicomWeb(positionals[0]);
  try {
    if (!positionals.length) {
      throw new Error("give at least one file or directory");
    }
    parseMultiframeOptions(values, { tree });
  } catch (err) {
    stderr(`dcmjs multiframe: ${err.message}`);
    stderr(multiframeUsage);
    return 1;
  }
  const report = {
    input: tree ? "static-dicomweb" : "part10",
    inPlace: Boolean(values["in-place"]),
    dryRun: Boolean(values["dry-run"]),
    instances: [],
    references: [],
    refused: [],
    unreadable: [],
    errors: [],
  };
  try {
    if (tree) {
      await runTree({ dcmjs, root: positionals[0], values, report });
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
  for (const { id, reason } of report.refused) {
    stderr(`dcmjs multiframe: ${id}: not converted, ${reason}`);
  }
  for (const entry of [...report.instances, ...report.references]) {
    if (entry.error) {
      stderr(`dcmjs multiframe: ${entry.sopInstanceUID}: ${entry.error}`);
    }
    for (const tag of entry.dropped ?? []) {
      stderr(
        `dcmjs multiframe: warning: ${entry.sopInstanceUID}: (${tag.slice(0, 4)},` +
          `${tag.slice(4)}) is not allowed in a Legacy Converted image and was dropped`
      );
    }
    for (const sop of entry.unlocated ?? []) {
      stderr(
        `dcmjs multiframe: warning: ${entry.sopInstanceUID}: the referenced image ` +
          `${sop} is not in the input, so ReferencedImageEvidenceSequence does not list it`
      );
    }
  }
  for (const { study, error } of report.errors) {
    stderr(`dcmjs multiframe: study ${study}: ${error}`);
  }
  if (
    !report.instances.length &&
    !report.references.length &&
    !report.errors.length
  ) {
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
    [...report.instances, ...report.references].filter((e) => e.error).length;
  return failed ? 1 : 0;
}

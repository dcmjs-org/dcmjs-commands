// test/multiframe.test.js
//
// dcmjs multiframe — classic CT/MR/PET to Legacy Converted Enhanced images,
// from Part 10 files and from a Static-DICOMweb tree.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import dcmjs from "../src/dcmjsBundle.js";
import { runMultiframe } from "../src/commands/multiframe.js";
import { runDicomweb } from "../src/commands/dicomweb.js";
import { readPart10Frames } from "../src/pixel/frameReader.js";
import { slicePixels, writeSyntheticCt } from "./helpers/syntheticCt.js";

dcmjs.log.setLevel("silent");

const LEGACY_CT = "1.2.840.10008.5.1.4.1.1.2.2";
const LEGACY_MR = "1.2.840.10008.5.1.4.1.1.4.4";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-multiframe-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function multiframe(positionals, values) {
  const out = [];
  const err = [];
  const code = await runMultiframe({
    dcmjs,
    positionals,
    values,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

async function readFile(file) {
  const frames = [];
  const read = await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async (frame) => frames.push(Buffer.from(frame)),
  });
  return { ...read, frames };
}

const first = (dict, tag) => dict?.[tag]?.Value?.[0];
const item = (dict, tag) => dict?.[tag]?.Value?.[0];
const gz = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));

/** A Static-DICOMweb tree of the synthetic CT series. */
async function makeTree(name) {
  const ct = writeSyntheticCt(dcmjs, path.join(tmpDir, `${name}-part10`));
  const root = path.join(tmpDir, `${name}-tree`);
  const code = await runDicomweb({
    dcmjs,
    positionals: [path.dirname(ct.slices[0].path)],
    values: { directory: root, quiet: true },
    stdout: () => {},
    stderr: () => {},
  });
  expect(code).toBe(0);
  const studyDir = path.join(root, "studies", ct.study);
  return {
    ct,
    root,
    studyDir,
    seriesDir: path.join(studyDir, "series", ct.series),
  };
}

// API: the Part 10 conversion of one stack.
test("converts a CT stack to one Legacy Converted Enhanced CT file, in slice order", async () => {
  const ct = writeSyntheticCt(dcmjs, path.join(tmpDir, "part10"));
  const outDir = path.join(tmpDir, "part10-out");
  const { code, text } = await multiframe([path.dirname(ct.slices[0].path)], {
    directory: outDir,
    json: true,
  });
  expect(code).toBe(0);
  const report = JSON.parse(text);
  expect(report.instances).toHaveLength(1);
  const [converted] = report.instances;
  expect(converted).toMatchObject({
    series: ct.series,
    frames: 4,
    stack: true,
  });

  const { dict, frames } = await readFile(converted.path);
  expect(first(dict, "00080016")).toBe(LEGACY_CT);
  expect(first(dict, "0020000E")).toBe(ct.series);
  expect(Number(first(dict, "00280008"))).toBe(4);
  // The frames are the source pixels in z order, not in file order.
  frames.forEach((frame, i) => {
    expect(frame.equals(Buffer.from(slicePixels(ct.slices[i].z).buffer))).toBe(
      true
    );
  });

  const shared = item(dict, "52009229");
  expect(first(item(shared, "00289110"), "00280030")).toBe(0.5);
  expect(item(shared, "00209116")).toBeDefined();
  expect(first(item(shared, "00289145"), "00281054")).toBe("HU");
  // CHEST maps to the Annex L code of the Anatomic Region Sequence.
  expect(first(item(item(shared, "00209071"), "00082218"), "00080100")).toBe(
    "816094009"
  );
  // Identical values that no module of the IOD defines are unassigned.
  expect(first(item(shared, "00209170"), "00180060")).toBe(120);

  const perFrame = dict["52009230"].Value;
  perFrame.forEach((frame, i) => {
    expect(item(frame, "00209113")["00200032"].Value.map(Number)).toEqual([
      -4,
      -4,
      ct.slices[i].z,
    ]);
    expect(first(item(frame, "00209172"), "00081155")).toBe(ct.slices[i].sop);
    expect(first(item(frame, "00209111"), "00209057")).toBe(i + 1);
    // Values that differ go to the unassigned per-frame item.
    expect(Number(first(item(frame, "00209171"), "00201041"))).toBe(
      ct.slices[i].z
    );
  });
  // The conversion equipment is recorded (DCM 109106).
  const contributing = dict["0018A001"].Value.at(-1);
  expect(first(item(contributing, "0040A170"), "00080100")).toBe("109106");
});

// User experience: interleaved echoes come out in echo order, in each of
// the three layouts.
test("orders interleaved MR echoes consistently in the split, grouped and interleaved layouts", async () => {
  const mr = writeSyntheticCt(dcmjs, path.join(tmpDir, "echo"), {
    echoes: 2,
  });
  const pixels = (s) => Buffer.from(slicePixels(s.z, s.echo).buffer);
  const byEcho = (e) => mr.slices.filter((s) => s.echo === e);
  const run = async (layout) => {
    const { code, text } = await multiframe([path.join(tmpDir, "echo")], {
      directory: path.join(tmpDir, `echo-${layout}`),
      layout,
      json: true,
    });
    expect(code).toBe(0);
    const { instances } = JSON.parse(text);
    return Promise.all(instances.map((i) => readFile(i.path)));
  };
  const frameContent = (dict) =>
    dict["52009230"].Value.map((f) => item(f, "00209111"));

  // split (the default): one instance for each echo, echo 1 first.
  const split = await run("split");
  expect(split).toHaveLength(2);
  split.forEach(({ dict, frames }, e) => {
    expect(first(dict, "00080016")).toBe(LEGACY_MR);
    expect(Number(first(dict, "00200013"))).toBe(e + 1);
    expect(frames).toEqual(byEcho(e + 1).map(pixels));
  });

  // grouped: echo 1 in z order, then echo 2; StackID is the echo.
  const [grouped] = await run("grouped");
  expect(grouped.frames).toEqual(mr.slices.map(pixels));
  expect(
    frameContent(grouped.dict).map((c) => c["00209157"].Value.map(Number))
  ).toEqual(mr.slices.map((s) => [s.echo, s.z / 2 + 1]));

  // interleaved: by position, with echo 1 before echo 2 at every position.
  const [interleaved] = await run("interleaved");
  const order = [...mr.slices].sort((a, b) => a.z - b.z || a.echo - b.echo);
  expect(interleaved.frames).toEqual(order.map(pixels));
  expect(
    frameContent(interleaved.dict).map((c) => c["00209157"].Value.map(Number))
  ).toEqual(order.map((s) => [s.z / 2 + 1, s.echo]));
});

// User experience: a dynamic or a diffusion series splits into one volume
// for each temporal position or b-value, in that order.
test.each([
  ["time", ["time 1", "time 2", "time 3"]],
  ["acquisition", ["acquisition 1", "acquisition 2", "acquisition 3"]],
  ["b", ["b 0", "b 1000", "b 2000"]],
  ["siemens-b", ["b 0", "b 1000", "b 2000"]],
])("splits a series by %s into volumes in order", async (vary, labels) => {
  const dir = path.join(tmpDir, `vary-${vary}`);
  const mr = writeSyntheticCt(dcmjs, dir, { echoes: 3, vary });
  const { code, text } = await multiframe([dir], {
    directory: `${dir}-out`,
    json: true,
  });
  expect(code).toBe(0);
  const { instances } = JSON.parse(text);
  expect(instances.map((i) => i.volumes)).toEqual(labels.map((l) => [l]));
  for (const [v, converted] of instances.entries()) {
    const { frames } = await readFile(converted.path);
    expect(frames).toEqual(
      mr.slices
        .filter((s) => s.echo === v + 1)
        .map((s) => Buffer.from(slicePixels(s.z, s.echo).buffer))
    );
  }
});

// User experience: an image that the IOD does not allow is named, not lost.
test("leaves a MONOCHROME1 slice out, names it, and converts the others", async () => {
  const ct = writeSyntheticCt(dcmjs, path.join(tmpDir, "mono1"), {
    photometric: "MONOCHROME1",
  });
  const { code, text, err } = await multiframe([path.join(tmpDir, "mono1")], {
    directory: path.join(tmpDir, "mono1-out"),
    json: true,
  });
  expect(code).toBe(0);
  expect(err).toContain(`${ct.slices[1].path}: not converted`);
  expect(err).toContain("MONOCHROME1");
  const [converted] = JSON.parse(text).instances;
  expect(converted.frames).toBe(3);
});

// User experience: the in-place tree update (the series shows the new
// instance; the old files stay).
test("--in-place replaces the series metadata and query files, and keeps the old files", async () => {
  const { ct, root, studyDir, seriesDir } = await makeTree("inplace");
  // The files that create-dicomweb also keeps: instance metadata and a
  // tag-keyed instance query.
  for (const slice of ct.slices) {
    const json = gz(path.join(seriesDir, "metadata.gz")).find(
      (m) => first(m, "00080018") === slice.sop
    );
    fs.writeFileSync(
      path.join(seriesDir, "instances", slice.sop, "metadata.gz"),
      zlib.gzipSync(JSON.stringify([json]))
    );
  }
  fs.mkdirSync(path.join(seriesDir, "instances"), { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, "instances", "index.json.gz"),
    zlib.gzipSync(
      JSON.stringify(
        ct.slices.map((s) => ({ "00080018": { vr: "UI", Value: [s.sop] } }))
      )
    )
  );

  const dry = await multiframe([root], { "in-place": true, "dry-run": true });
  expect(dry.code).toBe(0);
  expect(gz(path.join(seriesDir, "metadata.gz"))).toHaveLength(4);

  const { code, text } = await multiframe([root], {
    "in-place": true,
    json: true,
  });
  expect(code).toBe(0);
  const newSop = JSON.parse(text).instances[0].sopInstanceUID;

  const metadata = gz(path.join(seriesDir, "metadata.gz"));
  expect(metadata.map((m) => first(m, "00080018"))).toEqual([newSop]);
  expect(metadata[0]["7FE00010"].BulkDataURI).toBe(
    `instances/${newSop}/frames`
  );
  const newDir = path.join(seriesDir, "instances", newSop);
  expect(fs.readdirSync(path.join(newDir, "frames")).sort()).toEqual([
    "1.mht",
    "2.mht",
    "3.mht",
    "4.mht",
  ]);
  expect(gz(path.join(newDir, "metadata.gz"))[0]["7FE00010"].BulkDataURI).toBe(
    "./frames"
  );
  // The old instances stay in the tree, but no query lists them.
  for (const slice of ct.slices) {
    expect(
      fs.existsSync(path.join(seriesDir, "instances", slice.sop, "frames"))
    ).toBe(true);
  }
  expect(
    gz(path.join(seriesDir, "series-singleton.json.gz"))
      .NumberOfSeriesRelatedInstances
  ).toBe(1);
  expect(
    gz(path.join(seriesDir, "index.json.gz")).map((e) => e.SOPInstanceUID)
  ).toEqual([newSop]);
  expect(
    gz(path.join(seriesDir, "instances", "index.json.gz")).map((e) =>
      first(e, "00080018")
    )
  ).toEqual([newSop]);
  const seriesIndex = gz(path.join(studyDir, "series", "index.json.gz"));
  const entry = seriesIndex.find((s) => first(s, "0020000E") === ct.series);
  expect(Number(first(entry, "00201209"))).toBe(1);
  expect(
    Number(first(gz(path.join(studyDir, "index.json.gz"))[0], "00201208"))
  ).toBe(1);
});

// API: the DICOM JSON that a server writes (no vr on some elements, numbers
// as InlineBinary, Static-DICOMweb deduplication records) becomes Part 10.
test("-d from a tree reads server DICOM JSON: no vr, numeric InlineBinary, dedupped records", async () => {
  const { root, seriesDir } = await makeTree("server-json");
  const metadata = gz(path.join(seriesDir, "metadata.gz")).map((json) => {
    delete json["00080018"].vr;
    return {
      ...json,
      "00190010": { vr: "LO", Value: ["TEST"] },
      "00191012": { vr: "SL", InlineBinary: "AQAAAP7///8=" },
      "00090011": { vr: "CS", Value: ["dedupped"] },
      "00091110": { Value: ["hash"] },
      "00091011": { Value: ["patient"] },
    };
  });
  fs.writeFileSync(
    path.join(seriesDir, "metadata.gz"),
    zlib.gzipSync(JSON.stringify(metadata))
  );

  const { code, text, err } = await multiframe([root], {
    directory: path.join(tmpDir, "server-json-out"),
    json: true,
  });
  expect(code).toBe(0);
  // An element with no vr that no dictionary knows is named, not lost.
  expect(err).toContain("(0009,1011) has no VR in the tree metadata");
  const { dict } = await readFile(JSON.parse(text).instances[0].path);
  const unassigned = item(item(dict, "52009229"), "00209170");
  expect(unassigned["00191012"].Value).toEqual([1, -2]);
  expect(
    Object.keys({ ...dict, ...unassigned }).filter((t) => t.startsWith("0009"))
  ).toEqual([]);
});

// User experience: --new-series keeps the old series, so a viewer can show
// the old and the new images; the input is one study directory.
test("--in-place --new-series on a study directory adds a series and keeps the source series", async () => {
  const { ct, studyDir, seriesDir } = await makeTree("newseries");
  const before = fs.readFileSync(path.join(seriesDir, "metadata.gz"));

  const { code, text } = await multiframe([studyDir], {
    "in-place": true,
    "new-series": true,
    json: true,
  });
  expect(code).toBe(0);
  const [converted] = JSON.parse(text).instances;
  expect(converted.sourceSeries).toBe(ct.series);
  expect(converted.series).not.toBe(ct.series);

  expect(fs.readFileSync(path.join(seriesDir, "metadata.gz"))).toEqual(before);
  const newDir = path.join(studyDir, "series", converted.series);
  const [json] = gz(path.join(newDir, "metadata.gz"));
  expect(first(json, "0020000E")).toBe(converted.series);
  expect(first(json, "0008103E")).toBe("Chest (multi-frame)");
  expect(Number(first(json, "00200013"))).toBe(1);
  expect(
    fs.readdirSync(
      path.join(newDir, "instances", converted.sopInstanceUID, "frames")
    )
  ).toHaveLength(4);
  expect(gz(path.join(newDir, "series-singleton.json.gz"))).toMatchObject({
    SeriesInstanceUID: converted.series,
    NumberOfSeriesRelatedInstances: 1,
  });

  const seriesIndex = gz(path.join(studyDir, "series", "index.json.gz"));
  expect(seriesIndex.map((s) => first(s, "0020000E")).sort()).toEqual(
    [ct.series, converted.series].sort()
  );
  const study = gz(path.join(studyDir, "index.json.gz"))[0];
  expect(Number(first(study, "00201206"))).toBe(2);
  expect(Number(first(study, "00201208"))).toBe(5);
});

// API: the tree gives the same Part 10 file as the Part 10 input.
test("-d from a tree writes the same frames as -d from the Part 10 files", async () => {
  const { ct, root } = await makeTree("tree-d");
  const fromTree = await multiframe([root], {
    directory: path.join(tmpDir, "tree-d-out"),
    json: true,
  });
  expect(fromTree.code).toBe(0);
  const fromFiles = await multiframe([path.dirname(ct.slices[0].path)], {
    directory: path.join(tmpDir, "tree-d-files"),
    json: true,
  });
  const a = await readFile(JSON.parse(fromTree.text).instances[0].path);
  const b = await readFile(JSON.parse(fromFiles.text).instances[0].path);
  expect(a.frames).toHaveLength(4);
  a.frames.forEach((frame, i) => expect(frame.equals(b.frames[i])).toBe(true));
  expect(first(a.dict, "00080016")).toBe(LEGACY_CT);
});

// User experience: corrective errors for the output options.
test("refuses --in-place for Part 10 input, a run without an output, and an unknown layout", async () => {
  const ct = writeSyntheticCt(dcmjs, path.join(tmpDir, "options"));
  const dir = path.dirname(ct.slices[0].path);
  const inPlace = await multiframe([dir], { "in-place": true });
  expect(inPlace.code).toBe(1);
  expect(inPlace.err).toContain("for Part 10 input give -d <dir>");
  const none = await multiframe([dir], {});
  expect(none.code).toBe(1);
  expect(none.err).toContain("give -d <dir>");
  const layout = await multiframe([dir], { "dry-run": true, layout: "echo" });
  expect(layout.code).toBe(1);
  expect(layout.err).toContain("--layout must be one of split, grouped");
});

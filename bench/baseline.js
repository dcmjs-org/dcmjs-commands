#!/usr/bin/env node
// Performance baselines for dcmjs parse paths (roadmap Workstream A, "step 0").
//
// Measures usage, not just parse speed: for each corpus file and each path,
// times (a) bytes -> naturalized dataset, (b) metadata access (a Cornerstone3D
// metadata-provider-style tag workload, run 4x), and (c) write back to Part 10.
//
//   measure 0  pre-event-stream: DicomMessage.readFile + naturalizeDataset
//   measure 1  event-stream:     fromPart10 -> NaturalizedListener / Part10Writer
//   measure 1b dicom-parser:     optional, runs only if dicom-parser is installed
//
// Numbers land in large-files/perf-baselines.md; the final async-streaming
// version will not match these — the point is the trend line.
//
// Usage: node bench/baseline.js [--json] [file.dcm ...]

import { readFileSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dcmjs from "dcmjs";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const { fromPart10, NaturalizedListener, Part10Writer } =
    dcmjs.eventStream;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = [
    resolve(here, "../../dcmjs/test/sample-dicom.dcm"), // bread-and-butter single-frame
    resolve(here, "../../dcmjs/test/cine-test.dcm"), // multiframe
    resolve(here, "../../dcmjs/test/sample-sr.dcm"), // structured report
];

const WARMUP = 5;
const RUNS = 25;
const ACCESS_REPEATS = 4; // "access 3 or 4 times"

// Tag workload modeled on the Cornerstone3D metadata modules (generalSeries,
// imagePixel, imagePlane); until the real CS3D provider is wired in (pending
// harness conventions from Cornerstone3D-Codecs), this stands in for "access".
const ACCESS_TAGS = [
    "SOPClassUID",
    "SOPInstanceUID",
    "Modality",
    "SeriesInstanceUID",
    "StudyInstanceUID",
    "Rows",
    "Columns",
    "BitsAllocated",
    "BitsStored",
    "PhotometricInterpretation",
    "SamplesPerPixel",
    "PixelRepresentation",
    "PixelSpacing",
    "ImageOrientationPatient",
    "ImagePositionPatient",
    "RescaleIntercept",
    "RescaleSlope",
    "NumberOfFrames",
    "WindowCenter",
    "WindowWidth",
];

function accessWorkload(dataset) {
    let touched = 0;
    for (let i = 0; i < ACCESS_REPEATS; i++) {
        for (const tag of ACCESS_TAGS) {
            const v = dataset[tag];
            if (v !== undefined) {
                touched += Array.isArray(v) ? v.length : 1;
            }
        }
    }
    return touched; // returned so the reads cannot be optimized away
}

function stats(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { median: at(0.5), p10: at(0.1), p90: at(0.9) };
}

async function timePhase(fn) {
    const samples = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
        const t0 = performance.now();
        await fn();
        const ms = performance.now() - t0;
        if (i >= WARMUP) samples.push(ms);
    }
    return stats(samples);
}

async function measure0(bytes) {
    // Parse + naturalize, kept as one phase so it is comparable with the
    // event path, where the two are fused in a single listener pass.
    let dicomDict, naturalized;
    const toNaturalized = await timePhase(() => {
        dicomDict = DicomMessage.readFile(bytes.slice(0));
        naturalized = DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
    });
    const access = await timePhase(() => accessWorkload(naturalized));
    const write = await timePhase(() => dicomDict.write());
    return { toNaturalized, access, write };
}

async function measure1(bytes) {
    let naturalized;
    const toNaturalized = await timePhase(async () => {
        const listener = new NaturalizedListener();
        await fromPart10(bytes.slice(0), listener);
        naturalized = listener.result;
    });
    const access = await timePhase(() => accessWorkload(naturalized));
    // Serialization cost alone, from a collected event tree — the direct
    // counterpart of measure 0's dicomDict.write(). (Writing from the
    // NATURALIZED dataset via fromDataSet currently throws on UN values —
    // naturalization loses the ArrayBuffer form writeBytes needs; noted in
    // perf-baselines.md as a round-trip gap.)
    const writer = new Part10Writer();
    await fromPart10(bytes.slice(0), writer);
    const write = await timePhase(() => writer.write());
    return { toNaturalized, access, write };
}

async function measure1b(bytes) {
    let dicomParser;
    try {
        dicomParser = (await import("dicom-parser")).default;
    } catch {
        return null; // optional baseline; absent unless installed
    }
    const byteArray = new Uint8Array(bytes.slice(0));
    let dataSet;
    const toNaturalized = await timePhase(() => {
        dataSet = dicomParser.parseDicom(byteArray);
    });
    // dicom-parser has no naturalized model or writer; only parse is comparable.
    void dataSet;
    return { toNaturalized, access: null, write: null };
}

function fmt(phase) {
    if (!phase) return "—";
    return `${phase.median.toFixed(2)} (${phase.p10.toFixed(2)}–${phase.p90.toFixed(2)})`;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter(a => a !== "--json");
const corpus = files.length ? files : DEFAULT_CORPUS;

const results = [];
for (const file of corpus) {
    const bytes = readFileSync(file).buffer.slice(0);
    const entry = {
        file: basename(file),
        bytes: bytes.byteLength,
        m0: await measure0(bytes),
        m1: await measure1(bytes),
        m1b: await measure1b(bytes),
    };
    results.push(entry);
    if (!asJson) {
        console.log(`\n## ${entry.file} (${(entry.bytes / 1024).toFixed(0)} KiB)`);
        console.log(
            `   runs: ${RUNS} after ${WARMUP} warmup — median ms (p10–p90)`
        );
        console.log(
            `   phase           measure 0 (legacy)        measure 1 (event-stream)${entry.m1b ? "  measure 1b (dicom-parser)" : ""}`
        );
        for (const phase of ["toNaturalized", "access", "write"]) {
            console.log(
                `   ${phase.padEnd(15)} ${fmt(entry.m0[phase]).padEnd(25)} ${fmt(entry.m1[phase]).padEnd(25)}${entry.m1b ? fmt(entry.m1b[phase]) : ""}`
            );
        }
    }
}

if (asJson) {
    console.log(
        JSON.stringify(
            { node: process.version, warmup: WARMUP, runs: RUNS, results },
            null,
            2
        )
    );
}

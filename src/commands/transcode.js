// src/commands/transcode.js
//
// dcmjs transcode — rewrite the pixel data of DICOM files in another
// transfer syntax, one frame at a time, in place or into a new directory.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { discoverDicomFiles } from "../io.js";
import { readPart10Frames } from "../pixel/frameReader.js";
import { FrameSpool, writePart10WithFrames } from "../pixel/frameWriter.js";
import {
  hasDecoder,
  imageInfoFromDict,
  isBitstreamTranscode,
  nativeFrameBytes,
  transcodeFrame,
} from "../pixel/codec.js";
import {
  photometricAfter,
  renewSopInstanceUid,
  updatePixelHeader,
} from "../pixel/pixelHeader.js";
import {
  OUTPUT_ALIASES,
  distanceFromQuality,
  resolveOutputSyntax,
} from "../pixel/transferSyntaxes.js";
import {
  addTotals,
  emptyTotals,
  formatSizeReport,
} from "../pixel/sizeReport.js";
import { Progress } from "../pixel/progress.js";

export const transcodeUsage = `usage: dcmjs transcode <file-or-directory>... --to <syntax> [options]

Rewrites the pixel data of each DICOM file in another transfer syntax. Each
file is read and written as a stream, one frame at a time, so the file size
does not matter. By default each file is replaced in place: the new file is
written next to it and then renamed over it.

Options:
  -t, --to <syntax>       ${OUTPUT_ALIASES.join(", ")}, or a transfer syntax UID.
                          jxl-jpeg recompresses JPEG Baseline frames without
                          loss; transcode --to jpeg gives back the same JPEG.
  -d, --directory <dir>   write to <dir> with the same relative paths, and
                          copy the DICOM files that need no change; the
                          input stays as it is
  --lossy                 allow a lossy target (jpeg, jxl). A lossy file gets
                          a new SOPInstanceUID.
  --lossless              write jxl (1.2.840.10008.1.2.4.112) without loss
  --quality <q>           jpeg: quality 1..100 (default 90);
                          jxl: quality 0..100, mapped to a distance as cjxl does
  --distance <d>          jxl: Butteraugli distance 0..25 (default 1.0)
  --effort <e>            JPEG XL effort 1..9 (default 7)
  --progressive           write progressive JPEG XL
  --dry-run               list the files that would change; write nothing
  -q, --quiet             print no progress (the report is still printed)
  --json                  print the report as JSON
  -h, --help              show this help

Examples:
  dcmjs transcode ./slides --to jxl-jpeg            # JPEG WSI → JPEG XL, in place
  dcmjs transcode ./slides --to jpeg -d ./restored  # and back, byte for byte
`;

function parseNumber(values, name, min, max) {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** Encode options and target from the command line; throws on misuse. */
export function parseTranscodeOptions(values) {
  if (!values.to) {
    throw new Error("--to <syntax> is required");
  }
  const target = resolveOutputSyntax(values.to);
  const quality = parseNumber(values, "quality", 0, 100);
  let distance = parseNumber(values, "distance", 0, 25);
  if (
    distance === undefined &&
    quality !== undefined &&
    target.uid.endsWith(".112")
  ) {
    distance = distanceFromQuality(quality);
  }
  const lossless = Boolean(values.lossless) && target.uid.endsWith(".112");
  return {
    target,
    lossy: target.lossy && !lossless,
    allowLossy: Boolean(values.lossy),
    options: {
      quality,
      distance: distance ?? 1.0,
      lossless,
      effort: parseNumber(values, "effort", 1, 9),
      progressive: Boolean(values.progressive),
    },
  };
}

/** [file, root] pairs for every DICOM file under the inputs. */
function collectInputs(positionals) {
  const pairs = [];
  for (const input of positionals) {
    const root = fs.statSync(input).isDirectory() ? input : path.dirname(input);
    for (const file of discoverDicomFiles(input)) {
      pairs.push([file, root]);
    }
  }
  return pairs;
}

const tempPathFor = (target) =>
  path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );

/**
 * Transcodes one file to `outputPath` (which may be the input). Returns the
 * before/after sizes, or `{ skipped: reason }`.
 */
export async function transcodeFile({
  dcmjs,
  inputPath,
  outputPath,
  target,
  lossy: lossyTarget,
  allowLossy,
  options,
  dryRun,
  progress,
}) {
  let sourceUid;
  let imageInfo;
  let skip;
  let lossy = false;
  let frameBytes = 0;
  const spool = dryRun ? null : new FrameSpool(outputPath);

  try {
    const read = await readPart10Frames({
      dcmjs,
      inputPath,
      onHeader: ({ meta, dict }) => {
        sourceUid = meta["00020010"]?.Value?.[0];
        imageInfo = imageInfoFromDict(dict);
        if (sourceUid === target.uid) {
          skip = `already ${target.name}`;
        } else if (!hasDecoder(sourceUid)) {
          skip = `no decoder for transfer syntax ${sourceUid}`;
        } else if (
          target.uid === "1.2.840.10008.1.2.4.111" &&
          sourceUid !== "1.2.840.10008.1.2.4.50"
        ) {
          skip = "jxl-jpeg needs JPEG Baseline (1.2.840.10008.1.2.4.50) input";
        }
        // .111 → .50 rebuilds the original JPEG, so it is not lossy.
        lossy = lossyTarget && !isBitstreamTranscode(sourceUid, target.uid);
        if (!skip && lossy && !allowLossy) {
          throw new Error(
            `${target.name} is lossy — pass --lossy to accept the loss, or ` +
              "use --to jxl-lossless / --to jxl-jpeg"
          );
        }
        // Skipped files and dry runs only read, so they count no frames.
        progress?.startFile(
          inputPath,
          skip || dryRun ? 0 : Number(dict["00280008"]?.Value?.[0] ?? 1)
        );
      },
      onFrame: async (frame) => {
        if (skip || dryRun) {
          return;
        }
        if (lossy) {
          frameBytes += nativeFrameBytes(imageInfo);
        }
        await spool.append(
          await transcodeFrame(frame, imageInfo, sourceUid, target.uid, options)
        );
        progress?.frame();
      },
    });

    if (!read.hasPixelData) {
      skip = "no pixel data";
    }
    const before = {
      frames: read.frames,
      pixelBytes: read.pixelBytes,
      fileBytes: read.fileBytes,
    };
    if (skip || dryRun) {
      await spool?.remove();
      return skip ? { skipped: skip, before } : { before, sourceUid };
    }

    const { meta, dict } = read;
    updatePixelHeader({
      meta,
      dict,
      sourceUid,
      target,
      photometric: photometricAfter({
        photometric: dict["00280004"]?.Value?.[0],
        sourceUid,
        target,
      }),
      lossyRatio: lossy ? frameBytes / Math.max(1, spool.bytes) : undefined,
    });
    if (lossy) {
      renewSopInstanceUid({ dcmjs, meta, dict });
    }

    const tempPath = tempPathFor(outputPath);
    try {
      const written = await writePart10WithFrames({
        dcmjs,
        outputPath: tempPath,
        meta,
        dict,
        spool,
        encapsulated: target.encapsulated,
      });
      fs.renameSync(tempPath, outputPath);
      return {
        before,
        after: { frames: read.frames, ...written },
        dropped: written.dropped,
        sourceUid,
      };
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  } finally {
    await spool?.remove();
  }
}

export async function runTranscode({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  let parsed;
  try {
    if (!positionals.length) {
      throw new Error("give at least one file or directory");
    }
    parsed = parseTranscodeOptions(values);
  } catch (err) {
    stderr(`dcmjs transcode: ${err.message}`);
    stderr(transcodeUsage);
    return 1;
  }
  const { target, lossy, allowLossy, options } = parsed;
  const outDir = values.directory;
  const dryRun = Boolean(values["dry-run"]);

  let inputs;
  try {
    inputs = collectInputs(positionals);
  } catch (err) {
    stderr(`dcmjs transcode: ${err.message}`);
    return 1;
  }

  const before = emptyTotals();
  const after = emptyTotals();
  const files = [];
  let failed = 0;
  const progress = new Progress({
    command: "transcode",
    totalFiles: inputs.length,
    write: stderr,
    quiet: values.quiet,
  });

  for (const [inputPath, root] of inputs) {
    const outputPath = outDir
      ? path.join(outDir, path.relative(root, inputPath))
      : inputPath;
    try {
      if (outDir && !dryRun) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      }
      const result = await transcodeFile({
        dcmjs,
        inputPath,
        outputPath,
        target,
        lossy,
        allowLossy,
        options,
        dryRun,
        progress,
      });
      if (result.skipped) {
        if (outDir && !dryRun) {
          fs.copyFileSync(inputPath, outputPath);
        }
        files.push({ file: inputPath, skipped: result.skipped });
        continue;
      }
      addTotals(before, result.before);
      if (result.after) {
        addTotals(after, result.after);
      }
      for (const tag of result.dropped ?? []) {
        stderr(
          `dcmjs transcode: ${inputPath}: dropped (${tag}), which followed PixelData`
        );
      }
      files.push({
        file: inputPath,
        output: dryRun ? undefined : outputPath,
        from: result.sourceUid,
        before: result.before,
        after: result.after,
      });
    } catch (err) {
      failed++;
      files.push({ file: inputPath, error: err.message });
      stderr(`dcmjs transcode: ${inputPath}: ${err.message}`);
    } finally {
      progress.endFile();
    }
  }
  progress.flushBatch();

  const report = {
    target: target.uid,
    inPlace: !outDir,
    dryRun,
    before,
    after: dryRun ? undefined : after,
    files,
  };
  if (values.json) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    const changed = files.filter((f) => f.before && !f.skipped).length;
    const skipped = files.filter((f) => f.skipped);
    stdout(
      `transcode: ${changed} file${changed === 1 ? "" : "s"} → ` +
        `${target.name} (${target.uid}), ` +
        (dryRun ? "dry run" : outDir ? `into ${outDir}` : "in place")
    );
    if (!dryRun && changed) {
      stdout(formatSizeReport(before, after));
    }
    for (const s of skipped) {
      stdout(`  skipped ${s.file}: ${s.skipped}`);
    }
  }
  return failed ? 1 : 0;
}

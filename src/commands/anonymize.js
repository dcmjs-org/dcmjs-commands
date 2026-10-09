// src/commands/anonymize.mjs
//
// dcmjs anonymize <file.dcm> [-o out.dcm]
// anonymizer.cleanTags() over the parsed dict, written back to Part 10.
// Default output is <basename>-anon.dcm beside the input; overwriting the
// input in place is refused.

import path from "node:path";
import { readFileArrayBuffer, writeOutput } from "../io.js";

export const anonymizeUsage = `usage: dcmjs anonymize <file.dcm> [options]

Strip PHI tags (dcmjs anonymizer defaults) and write a scrubbed copy.

    -o, --output <file>    output path (default: <input>-anon.dcm)
    --dry-run              print the tag-level changes as JSON; write nothing
`;

/** One-line preview of a dict entry's value, safe for any VR. */
function summarizeValue(entry) {
  const values = entry?.Value;
  if (!Array.isArray(values) || !values.length) {
    return "";
  }
  const parts = values.map((v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      return `[binary ${v.byteLength} bytes]`;
    }
    if (v && typeof v === "object") {
      return v.Alphabetic || JSON.stringify(v);
    }
    return String(v);
  });
  const joined = parts.join("\\");
  return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
}

/** Diff two dicts (before/after cleanTags) into a change list. */
function diffDicts(before, after) {
  const changes = [];
  for (const tag of Object.keys(before)) {
    const was = summarizeValue(before[tag]);
    if (!(tag in after)) {
      changes.push({ tag, action: "removed", was });
      continue;
    }
    const now = summarizeValue(after[tag]);
    if (was !== now) {
      changes.push({
        tag,
        action: now === "" ? "emptied" : "replaced",
        was,
        now,
      });
    }
  }
  return changes;
}

export async function runAnonymize({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const [input] = positionals;
  if (!input) {
    stderr(anonymizeUsage);
    return 1;
  }

  const parsed = path.parse(input);
  const output =
    values.output ||
    path.join(parsed.dir, `${parsed.name}-anon${parsed.ext || ".dcm"}`);

  if (!values["dry-run"] && path.resolve(output) === path.resolve(input)) {
    stderr("anonymize: refusing to overwrite the input file in place");
    return 1;
  }

  try {
    const { DicomMessage } = dcmjs.data;
    const dicomDict = DicomMessage.readFile(readFileArrayBuffer(input));

    if (values["dry-run"]) {
      // Snapshot summaries before cleaning; the clean mutates in place.
      const before = {};
      for (const tag of Object.keys(dicomDict.dict)) {
        before[tag] = { Value: dicomDict.dict[tag].Value };
      }
      dcmjs.anonymizer.cleanTags(dicomDict.dict);
      const changes = diffDicts(before, dicomDict.dict);
      stdout(JSON.stringify({ file: input, changes }, null, 2));
      return 0;
    }

    dcmjs.anonymizer.cleanTags(dicomDict.dict);
    const written = writeOutput({
      output,
      data: Buffer.from(dicomDict.write()),
      stdout,
    });
    stdout(`anonymize: wrote ${written}`);
    return 0;
  } catch (err) {
    stderr(`anonymize: ${err.message}`);
    return 1;
  }
}

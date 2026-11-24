// src/commands/filter.js
//
// dcmjs filter <in.dcm> -o <out.dcm> [--set TAG=VALUE ...] [--drop TAG ...]
//                                    [--replace TAG=VALUE ...]
//                                    [--module <file.mjs> ...]
//
// Streaming file-to-file copy through an event-stream filter chain:
// fromPart10Stream -> filters -> StreamingPart10Writer. Nothing ever holds
// the whole dataset, so this works unchanged on multi-GB inputs (proven on a
// 21.8 GB Sup 225 video instance by the same pipeline).
//
// With no filters this is a streaming structural copy — output is valid,
// semantically equal Part 10 (byte-identical output is a non-goal; see
// StreamingPart10Writer's encoding notes).

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import dcmjsBundle from "../dcmjsBundle.js";
import { createFileSink } from "../io.js";
import {
  fhirPatientEntries,
  makeInsertFilter,
} from "../filters/fhirPatient.js";

const { nameMap, dictionary } = dcmjsBundle.data.DicomMetaDictionary;

export const filterUsage = `usage: dcmjs filter <in.dcm> -o <out.dcm> [options]

Stream a DICOM file through an event-stream filter chain to a new file.

    -o, --output <file>   output Part 10 file (required)
    --set TAG=VALUE       insert-or-replace a top-level element: a present
                          element gets the value, a missing one is added in
                          ascending tag order with the VR from the data
                          dictionary (repeatable; TAG is 8 hex digits or a
                          DICOM keyword, e.g. 00100010 or PatientName;
                          private tags, sequences and tags not in the
                          dictionary are refused — use --replace)
    --replace TAG=VALUE   replace the value of every element with this tag,
                          at any depth; a missing tag is skipped
                          (repeatable; same TAG forms as --set)
    --drop TAG            remove every element or sequence with this tag
                          (repeatable; same TAG forms as --set)
    --fhir-patient <file> apply a FHIR Patient resource to the patient module
                          (insert-or-replace of PatientName/ID/BirthDate/Sex;
                          fields absent from the resource are written empty)
    --module <file.mjs>   load custom filter(s) from a JS module whose default
                          export is a filter object or array of filter objects
                          (repeatable; applied before the other filters)

With no filters, performs a streaming structural copy.
`;

/** Load a FHIR Patient file and map it to patient-module attributes. */
export function loadFhirPatientAttrs(dcmjs, filePath) {
  let resource;
  try {
    resource = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`could not read FHIR Patient ${filePath}: ${err.message}`);
  }
  return dcmjs.fhir.patientToDataset(resource);
}

/**
 * Accept 00100010, 0010,0010, (0010,0010), or a DICOM keyword such as
 * PatientName (via the dictionary's nameMap); return canonical 8-hex.
 */
function normalizeTag(text) {
  if (/^[A-Za-z]/.test(text) && nameMap[text]) {
    return nameMap[text].tag.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  }
  const hex = text.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 8) {
    throw new Error(
      `invalid tag "${text}" — expected 8 hex digits or a DICOM keyword`
    );
  }
  return hex;
}

/** Parse TAG=VALUE assignments into [8-hex tag, value] pairs. */
function parseAssignments(assignments, flag) {
  return assignments.map((assignment) => {
    const eq = assignment.indexOf("=");
    if (eq < 1) {
      throw new Error(`invalid --${flag} "${assignment}" — expected TAG=VALUE`);
    }
    return [normalizeTag(assignment.slice(0, eq)), assignment.slice(eq + 1)];
  });
}

/**
 * --set entries for makeInsertFilter (insert-or-replace): the VR comes
 * from the data dictionary, and only top-level, single-VR, public,
 * non-sequence data elements are accepted.
 */
function makeSetEntries(assignments) {
  return parseAssignments(assignments, "set").map(([tag, value]) => {
    const group = parseInt(tag.slice(0, 4), 16);
    const entry = dictionary[`(${tag.slice(0, 4)},${tag.slice(4)})`];
    const refuse = (why) =>
      new Error(`--set ${tag}: ${why} — use --replace or --module instead`);
    if (group % 2 === 1) {
      throw refuse("a private tag has no dictionary VR");
    }
    if (group === 2) {
      throw refuse("the writer generates the file meta group (0002)");
    }
    if (!entry) {
      throw refuse("the tag is not in the data dictionary");
    }
    if (entry.vr === "SQ") {
      throw refuse("a sequence cannot be inserted from a TAG=VALUE");
    }
    if (!/^[A-Z]{2}$/.test(entry.vr)) {
      throw refuse(`the dictionary VR "${entry.vr}" is ambiguous`);
    }
    return { tag, vr: entry.vr, value };
  });
}

/**
 * --replace: replace the values of matching elements at any depth with
 * one value. Replace-only: a tag that never occurs is skipped.
 */
function makeReplaceFilter(assignments) {
  const replacements = new Map(parseAssignments(assignments, "replace"));
  let currentTag = null;
  let injected = false;
  return {
    startElement(next, tag, info) {
      currentTag = replacements.has(tag) ? tag : null;
      injected = false;
      return next(tag, info);
    },
    endElement(next) {
      // A zero-length element has no value event; inject the replacement
      if (currentTag !== null && !injected) {
        const replacement = replacements.get(currentTag);
        currentTag = null;
        this.value(replacement);
      }
      currentTag = null;
      return next();
    },
    value(next, v, opts) {
      if (currentTag === null) {
        return next(v, opts);
      }
      if (injected) {
        return; // collapse multi-valued elements to the one replacement
      }
      injected = true;
      return next(replacements.get(currentTag), opts);
    },
  };
}

/** Swallow every event belonging to a dropped element or sequence. */
function makeDropFilter(tags) {
  const drop = new Set(tags.map(normalizeTag));
  let skipElement = false;
  let skipSeqDepth = 0;
  const skipping = () => skipElement || skipSeqDepth > 0;
  const gate =
    () =>
    (next, ...args) => {
      if (skipping()) {
        return;
      }
      return next(...args);
    };
  return {
    startElement(next, tag, info) {
      if (skipSeqDepth > 0) {
        return;
      }
      if (drop.has(tag)) {
        skipElement = true;
        return;
      }
      return next(tag, info);
    },
    endElement(next) {
      if (skipSeqDepth > 0) {
        return;
      }
      if (skipElement) {
        skipElement = false;
        return;
      }
      return next();
    },
    startSequence(next, tag, info) {
      if (skipSeqDepth > 0) {
        skipSeqDepth++;
        return;
      }
      if (drop.has(tag)) {
        skipSeqDepth = 1;
        return;
      }
      return next(tag, info);
    },
    endSequence(next) {
      if (skipSeqDepth > 0) {
        skipSeqDepth--;
        return;
      }
      return next();
    },
    value: gate(),
    startBinary: gate(),
    binaryFragment: gate(),
    endBinary: gate(),
    bulkDataReference: gate(),
    startItem: gate(),
    endItem: gate(),
  };
}

/**
 * Load custom filters from --module files. Each module's default export
 * is a filter object (or array of them) whose methods are
 * `method(next, ...args)` over the event-stream vocabulary. Contract for
 * authors: `this` inside a filter method is the SHARED listener, per
 * EventStreamListener — keep private state in module scope when several
 * filters chain, or they will trample each other's fields.
 */
async function loadModuleFilters(files) {
  const filters = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    const exported = mod.default;
    if (!exported) {
      throw new Error(`filter module ${file} has no default export`);
    }
    filters.push(...(Array.isArray(exported) ? exported : [exported]));
  }
  return filters;
}

export async function runFilter({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  if (values.help) {
    stdout(filterUsage);
    return 0;
  }
  const [inFile] = positionals;
  const outFile = values.output;
  if (!inFile || !outFile) {
    stderr(filterUsage);
    return 1;
  }

  const { fromPart10Stream, StreamingPart10Writer } = dcmjs.eventStream;

  let filters;
  try {
    // --fhir-patient and --set share one insert filter; --set wins
    const inserts = [
      ...(values["fhir-patient"]
        ? fhirPatientEntries(
            loadFhirPatientAttrs(dcmjs, values["fhir-patient"])
          )
        : []),
      ...makeSetEntries(values.set ?? []),
    ];
    filters = [
      ...(await loadModuleFilters(values.module ?? [])),
      ...(values.replace?.length ? [makeReplaceFilter(values.replace)] : []),
      ...(values.drop?.length ? [makeDropFilter(values.drop)] : []),
      // Must be last: it synthesizes elements directly to the listener base
      ...(inserts.length ? [makeInsertFilter(inserts)] : []),
    ];
  } catch (e) {
    stderr(`dcmjs filter: ${e.message}`);
    return 1;
  }

  let sink;
  try {
    sink = createFileSink(outFile, { inputPath: inFile });
  } catch (e) {
    stderr(`dcmjs filter: ${e.message}`);
    return 1;
  }
  const writer = new StreamingPart10Writer(
    { onChunk: (chunk) => sink.write(chunk) },
    ...filters
  );
  writer.setDrain(() => sink.drain());

  try {
    const input = fs.createReadStream(inFile, {
      highWaterMark: 8 * 1024 * 1024,
    });
    await fromPart10Stream(input, writer);
    if (!writer.done) {
      throw new Error("input ended before the dataset completed");
    }
    await sink.finish();
  } catch (e) {
    sink.abort();
    stderr(`dcmjs filter: ${e.message}`);
    return 1;
  }
  stdout(
    `wrote ${outFile} (${writer.bytesWritten.toLocaleString("en-US")} bytes, ` +
      `${filters.length} filter${filters.length === 1 ? "" : "s"})`
  );
  return 0;
}

// src/dcmjsBundle.js
//
// Single import point for the dcmjs library; see loadEventStream and the
// default export for how the composite surface is reassembled.

import path from "node:path";

// process.getBuiltinModule reaches node's real module system even under
// jest, whose node:module shim cannot load the ESM sources the
// @dcmjs-org packages ship (node >= 22.12 require(esm) can).
const { createRequire } = process.getBuiltinModule("node:module");
const require = createRequire(import.meta.url);

let base;
try {
  base = require("dcmjs");
} catch (cause) {
  throw new Error(
    "The dcmjs bundle could not be loaded. Run `npm install` to fetch " +
      "@dcmjs-org/dcmjs (installed under the `dcmjs` alias).",
    { cause }
  );
}

const { media, encapsulated, image } = require("@dcmjs-org/media");
const fhirSink = require("@dcmjs-org/fhir");

/**
 * Load the `dcmjs/eventStream` subpath export.
 *
 * The subpath has only an `import` condition. Node loads it through the
 * public export. Jest's ESM loader treats the built `.es.js` file as CJS
 * and cannot parse it, so only then fall back to requiring the built file
 * next to the base bundle. Remove the fallback once dcmjs adds a
 * `require` condition for `./eventStream`.
 */
async function loadEventStream() {
  try {
    return await import("dcmjs/eventStream");
  } catch (importError) {
    try {
      return require(
        path.join(path.dirname(require.resolve("dcmjs")), "eventStream.es.js")
      );
    } catch {
      throw importError;
    }
  }
}

const eventStream = await loadEventStream();

const { DicomMessage, DicomMetaDictionary } = base.data;

/**
 * The published 1.0 beta splits the engines out of the default entry
 * (dcmjs-org/dcmjs#595): eventStream is a subpath export,
 * media/encapsulated/image live in @dcmjs-org/media, and the FHIR mappers
 * live in @dcmjs-org/fhir. The commands use the composite surface of the
 * earlier integration preview, so this object reassembles it, including
 * `fhir.fromPart10` (Part 10 ArrayBuffer → FHIR), which @dcmjs-org/fhir
 * does not ship because it has no reader dependency.
 */
const fhir = {
  ...fhirSink,
  fromPart10(arrayBuffer, options = {}) {
    const dicomDict = DicomMessage.readFile(
      arrayBuffer,
      options.readOptions || {}
    );
    const dataset = DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
    return fhirSink.toFhir(dataset, options);
  },
};

export default {
  ...base,
  eventStream,
  media,
  encapsulated,
  image,
  fhir,
};

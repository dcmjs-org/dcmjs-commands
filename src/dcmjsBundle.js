// src/dcmjsBundle.js
//
// Single import point for the dcmjs library. The published 1.0 beta keeps
// the classic 0.52 surface on the package's default entry and splits the
// new engines out (dcmjs-org/dcmjs#595): eventStream is an ESM-only
// subpath export, media/encapsulated/image live in @dcmjs-org/media, and
// the FHIR mappers live in @dcmjs-org/fhir. The commands are written
// against the composite surface, so this module reassembles it.
//
// The sibling packages load via createRequire: they ship ES sources with
// no "type": "module" marker, which native-ESM tooling (jest's loader)
// refuses to parse, while node's require loads them everywhere.

import path from "node:path";

// process.getBuiltinModule reaches node's real module system even under
// jest, whose own node:module shim compiles required files as CJS and so
// cannot load the ESM sources the @dcmjs-org packages ship. Node's require
// detects ESM syntax and loads them fine (require(esm), node >= 22.12).
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

// dcmjs/eventStream is an import-only subpath (no require condition), and
// jest's CJS pipeline can't parse the built ES file either — so resolve it
// next to the base bundle and require the file directly.
const eventStream = require(
  path.join(path.dirname(require.resolve("dcmjs")), "eventStream.es.js")
);

const { DicomMessage, DicomMetaDictionary } = base.data;

// The 1.0-beta integration wrapper shipped fhir.fromPart10 (a Part 10
// ArrayBuffer straight to FHIR); the published @dcmjs-org/fhir has no
// reader dependency, so compose it here from the classic reader and
// naturalizer, same as the wrapper did.
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

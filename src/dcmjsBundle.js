// src/dcmjsBundle.js
//
// Single import point for the dcmjs library; see the default export for
// how the composite surface is reassembled.
//
// Everything loads via createRequire: since dcmjs-org/dcmjs#618
// (1.0.0-beta.5) the packages ship real CommonJS builds behind "require"
// conditions, which load identically under node and under jest's module
// pipeline.

import { createRequire } from "node:module";

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

const eventStream = require("dcmjs/eventStream");
const { media, encapsulated, image } = require("@dcmjs-org/media");
const fhirSink = require("@dcmjs-org/fhir");

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

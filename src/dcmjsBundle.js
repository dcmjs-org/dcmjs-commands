// src/dcmjsBundle.js
//
// Single import point for the dcmjs library. Loads the built UMD bundle
// via createRequire: the dcmjs package's ES build has no "type": "module"
// marker, which native-ESM tooling (jest's loader) refuses to parse, while
// the CJS bundle loads everywhere.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let dcmjs;
try {
  dcmjs = require("dcmjs");
} catch (cause) {
  throw new Error(
    "The built dcmjs bundle could not be loaded. If dcmjs is installed via " +
      "file:../dcmjs, run `pnpm install && pnpm run build` in that checkout.",
    { cause }
  );
}

export default dcmjs;

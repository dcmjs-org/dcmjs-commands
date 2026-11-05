// src/pixel/selectTargetSyntax.js
//
// The compression rule: which transfer syntax to store a frame in, from the
// instance metadata and the transfer syntax the frame arrived in.

import { createRequire } from "node:module";
import { photometricAfter } from "./pixelHeader.js";
import {
  DEFLATED_IMAGE_FRAME,
  EXPLICIT_LITTLE_ENDIAN,
  JPEG_BASELINE,
  JPEG_LS_LOSSLESS,
  JPEG_XL_JPEG_RECOMPRESSION,
  JPEG_XL_LOSSLESS,
  bitDepthLimit,
  isNativeSyntax,
  resolveOutputSyntax,
} from "./transferSyntaxes.js";

// The core package only: the full bundle also loads the media and FHIR code.
const { isVideoTransferSyntax } = createRequire(import.meta.url)(
  "dcmjs"
).constants;

const WSI = "1.2.840.10008.5.1.4.1.1.77.1.6";
const VIDEO_SOP_CLASSES = [
  "1.2.840.10008.5.1.4.1.1.77.1.1.1", // Video Endoscopic
  "1.2.840.10008.5.1.4.1.1.77.1.2.1", // Video Microscopic
  "1.2.840.10008.5.1.4.1.1.77.1.4.1", // Video Photographic
];
const SEGMENTATION_SOP_CLASSES = [
  "1.2.840.10008.5.1.4.1.1.66.4", // Segmentation
  "1.2.840.10008.5.1.4.1.1.66.7", // Label Map Segmentation
];
// Always lossy; for other syntaxes LossyImageCompression (0028,2110) decides.
const LOSSY_SYNTAXES = [
  JPEG_BASELINE,
  "1.2.840.10008.1.2.4.51",
  "1.2.840.10008.1.2.4.81",
];

/**
 * The default rule table; first match wins. `target: null` keeps the frame
 * as it arrived. A `when` condition that is absent matches anything:
 * `video`, `colour`, `compressed`, `lossyInput` (booleans), `sopClassUID`,
 * `incoming` (lists of UIDs) and `bitsAllocated` (a number or a list). A
 * JSON table of the same shape can replace it. Compressed input other than
 * JPEG Baseline is re-encoded only by a rule that names it; the default
 * keeps it.
 */
export const DEFAULT_RULES = [
  { when: { video: true }, target: null, reason: "video" },
  {
    when: { sopClassUID: [WSI], incoming: [JPEG_BASELINE] },
    target: JPEG_XL_JPEG_RECOMPRESSION,
    reason: "WSI JPEG",
  },
  {
    when: { sopClassUID: SEGMENTATION_SOP_CLASSES },
    target: DEFLATED_IMAGE_FRAME,
    reason: "segmentation",
  },
  {
    // .111 input maps to itself, so it stays as it is.
    when: {
      colour: true,
      incoming: [JPEG_BASELINE, JPEG_XL_JPEG_RECOMPRESSION],
    },
    target: JPEG_XL_JPEG_RECOMPRESSION,
    reason: "colour JPEG",
  },
  {
    when: { colour: true, compressed: false },
    target: JPEG_XL_LOSSLESS,
    reason: "colour uncompressed",
  },
  { when: { compressed: true }, target: null, reason: "already compressed" },
  {
    when: { colour: false, compressed: false },
    target: JPEG_LS_LOSSLESS,
    reason: "grayscale uncompressed",
  },
];

const first = (dict, tag) => dict?.[tag]?.Value?.[0];

const WHEN_KEYS = [
  "video",
  "colour",
  "compressed",
  "lossyInput",
  "sopClassUID",
  "incoming",
  "bitsAllocated",
];
const checkedTables = new WeakSet();

/**
 * Throws for a rule that can never work: a `when` key that is not a fact
 * (a typo matches nothing), or a target that is not an output syntax.
 * Runs once for each table object.
 */
function checkRules(rules) {
  if (checkedTables.has(rules)) return;
  rules.forEach(({ when = {}, target }, index) => {
    const unknown = Object.keys(when).find((key) => !WHEN_KEYS.includes(key));
    if (unknown) {
      throw new Error(
        `rule ${index}: unknown 'when' key '${unknown}' — use one of ` +
          WHEN_KEYS.join(", ")
      );
    }
    if (target != null) {
      try {
        resolveOutputSyntax(target);
      } catch (error) {
        throw new Error(`rule ${index}: ${error.message}`);
      }
    }
  });
  checkedTables.add(rules);
}

function matches(when, facts) {
  return Object.entries(when).every(([key, expected]) =>
    Array.isArray(expected)
      ? expected.includes(facts[key])
      : expected === facts[key]
  );
}

/** Why `target` cannot hold this frame, or undefined when it can. */
function limitOf(target, facts, metadata) {
  if (facts.bitsAllocated === 1 && !target.bytePreserving) {
    return "Bits Allocated 1 needs explicit-le, rle or deflate";
  }
  const depth = bitDepthLimit(target, {
    bitsAllocated: facts.bitsAllocated,
    samplesPerPixel: first(metadata, "00280002") ?? 1,
  });
  if (depth) {
    return depth;
  }
  if (
    target.uid === JPEG_XL_JPEG_RECOMPRESSION &&
    facts.incoming !== JPEG_BASELINE
  ) {
    return "jxl-jpeg needs JPEG Baseline input";
  }
  try {
    photometricAfter({
      photometric: first(metadata, "00280004"),
      sourceUid: facts.incoming,
      target,
    });
  } catch (error) {
    return error.message;
  }
  return undefined;
}

/**
 * Selects the transfer syntax to store a frame in.
 *
 * @param {object} metadata DICOMweb JSON (tag-keyed) instance metadata.
 * @param {object} [options]
 * @param {string} [options.incomingTransferSyntax] the syntax of the frame
 *   response. Without it, AvailableTransferSyntaxUID or TransferSyntaxUID of
 *   the metadata; without those, native little endian (the same frame bytes
 *   in Implicit and Explicit VR) is assumed, for every SOP class.
 * @param {object[]} [options.rules] a table that replaces DEFAULT_RULES.
 * @returns {{ target: string | null, reason: string }} `target: null` keeps
 *   the frame unchanged. A target that is the same as the input, or that the
 *   codecs cannot write exactly for this frame (1-bit data, a bit depth over
 *   `maxBits` of the target, YBR_FULL, lossy PALETTE COLOR), also gives
 *   `null`, and `reason` says why.
 * @throws when a rule has an unknown `when` key, or names a target that is
 *   not in OUTPUT_SYNTAXES, whether or not the rule matches.
 */
export function selectTargetSyntax(
  metadata,
  { incomingTransferSyntax, rules = DEFAULT_RULES } = {}
) {
  checkRules(rules);
  const sopClassUID = first(metadata, "00080016");
  const given =
    incomingTransferSyntax ??
    first(metadata, "00083002") ??
    first(metadata, "00020010");
  const incoming = given ?? EXPLICIT_LITTLE_ENDIAN;
  const assumed = given ? "" : ` (assumed input ${incoming})`;
  const facts = {
    sopClassUID,
    incoming,
    bitsAllocated: first(metadata, "00280100"),
    video:
      VIDEO_SOP_CLASSES.includes(sopClassUID) ||
      Boolean(isVideoTransferSyntax(incoming)),
    colour: (first(metadata, "00280002") ?? 1) > 1,
    compressed: !isNativeSyntax(incoming),
    lossyInput:
      LOSSY_SYNTAXES.includes(incoming) || first(metadata, "00282110") === "01",
  };
  const rule = rules.find(({ when = {} }) => matches(when, facts));
  if (!rule?.target) {
    return { target: null, reason: (rule?.reason ?? "no rule") + assumed };
  }
  const target = resolveOutputSyntax(rule.target);
  const keep =
    target.uid === incoming ||
    (target.uid === EXPLICIT_LITTLE_ENDIAN && facts.compressed === false)
      ? "already in the target syntax"
      : limitOf(target, facts, metadata);
  return keep
    ? { target: null, reason: `${rule.reason}: ${keep}${assumed}` }
    : { target: target.uid, reason: rule.reason + assumed };
}

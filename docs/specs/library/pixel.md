# Specification: `@dcmjs/commands/pixel`

## Scope

This specification covers the library export `@dcmjs/commands/pixel`: the per-frame codec
API, the output transfer syntax table, and the compression rule `selectTargetSyntax`. A
program, for example a Static-DICOMweb proxy, uses the rule to choose the storage transfer
syntax of each frame. The commands `dcmjs transcode` and `dcmjs wsiresize` use the same
codec API; [cli/transcode-and-wsiresize.md](../cli/transcode-and-wsiresize.md) covers them.

The specification has two sections of requirements. The two sections have different change
rules:

- **User requirements** (`PL-U*`) state what a program that uses the library must be able to
  do, or must be able to know, to store frames safely. Change a user requirement only when
  the requirement describes the behaviour incorrectly, or when the intended user-facing
  behaviour changes. A more convenient implementation is never a reason to change a user
  requirement.
- **Implementation requirements** (`PL-I*`) state how the library does the work. You can
  change an implementation requirement when a better approach is available, if the user
  requirements stay true.

## § User requirements

- **PL-U1.** A program imports the per-frame API from `@dcmjs/commands/pixel` as an ES
  module: `decodeFrame`, `encodeFrame`, `transcodeFrame`, `isBitstreamTranscode`,
  `imageInfoFromDict`, `hasDecoder`, `photometricAfter`, `updatePixelHeader`,
  `OUTPUT_SYNTAXES`, `OUTPUT_ALIASES`, `resolveOutputSyntax`, the UID constants,
  `selectTargetSyntax` and `DEFAULT_RULES`.
- **PL-U2.** `selectTargetSyntax(metadata, { incomingTransferSyntax, rules })` reads the
  DICOMweb JSON metadata of one instance and gives `{ target, reason, incoming }`.
  `target: null` keeps the frame unchanged. `reason` says why, in text that a log can show.
  `incoming` is the input transfer syntax that the rule used.
- **PL-U3.** The default rule table gives these results. The first row that matches
  applies.

  | Instance | Input transfer syntax | Target |
  | --- | --- | --- |
  | Video SOP class, or video transfer syntax | any | keep |
  | Whole-slide image | JPEG Baseline | JPEG XL JPEG Recompression (`.4.111`) |
  | Segmentation | uncompressed | Deflated Image Frame (`1.2.840.10008.1.2.8.1`) |
  | Colour | JPEG Baseline or `.4.111` | `.4.111` |
  | Colour | uncompressed | JPEG XL Lossless (`.4.110`) |
  | Any | other compressed | keep |
  | Grayscale | uncompressed | JPEG-LS Lossless (`.4.80`) |

- **PL-U4.** The default rules keep compressed input unchanged, also compressed
  segmentations. The only exception is JPEG Baseline colour or whole-slide input, which goes
  to JPEG XL JPEG Recompression. That conversion is lossless, and a later conversion back
  gives the same JPEG bytes.
- **PL-U5.** A frame with Bits Allocated over 16 never changes, whatever the rule table
  says. A frame whose metadata has no Bits Allocated also never changes, because its depth
  can be over 16. `selectTargetSyntax` gives `null` before it reads a rule.
- **PL-U6.** Every target of the default rules is lossless. A custom rule can name a lossy
  target (`jpeg`, `jxl`). The program must then record the lossy step in the header
  (`updatePixelHeader` with `lossyRatio`) and give the instance a new SOP Instance UID.
- **PL-U7.** When the target cannot hold the frame exactly, the result is `null`, and
  `reason` names the limit: Bits Allocated 1, a bit depth over the limit of the target,
  `YBR_FULL`, and lossy `PALETTE COLOR`. When the target is the input syntax, the result is
  also `null`.
- **PL-U8.** Without `incomingTransferSyntax`, the rule reads `AvailableTransferSyntaxUID`
  or `TransferSyntaxUID` from the metadata. Without those, the rule assumes native little
  endian for every SOP class, and `reason` names the assumption.
- **PL-U9.** A program can replace the default rules with a JSON table of the same shape
  (the `rules` option). A table with an unknown `when` key or an unknown target fails at the
  first call, also when no frame matches that rule.
- **PL-U10.** `encodeFrame` refuses a frame that the target cannot hold exactly, with an
  error that names the limit and the targets that can hold the frame. The limits are the
  limits of TC-U16.

## § Implementation requirements

- **PL-I1.** A rule is `{ when, target, reason }`. The `when` keys are `video`, `colour`,
  `compressed`, `lossyInput` (booleans), `sopClassUID`, `incoming` (a UID or a list) and
  `bitsAllocated` (a number or a list). An absent key matches anything.
- **PL-I2.** Each row of `OUTPUT_SYNTAXES` can have `maxBits`, and `maxColourBits` for
  Samples per Pixel over 1. `bitDepthLimit` gives the reason text, and `encodeFrame` and
  `selectTargetSyntax` both use it, so the two always agree.
- **PL-I3.** `selectTargetSyntax` checks a table one time for each table object (a
  `WeakSet`), so the check costs nothing for each frame.
- **PL-I4.** `selectTargetSyntax` reads `isVideoTransferSyntax` from the core `dcmjs`
  package with `createRequire`, and not from `src/dcmjsBundle.js`, because the bundle also
  loads the media and FHIR packages, which a proxy does not need.
- **PL-I5.** Explicit VR Big Endian input counts as compressed (`isLittleEndianNative`),
  because the decoders read little endian samples only.
- **PL-I6.** A later change can write the rule table in the rule language of Cornerstone3D
  (`@cornerstonejs/metadata`). That change waits until Cornerstone3D uses the dcmjs 1.0
  beta, so that a program does not load two dcmjs versions.

## Known limits

- The HTJ2K encode changes the values of colour frames over 8 bits and of 32-bit frames
  ([cornerstonejs/codecs#98](https://github.com/cornerstonejs/codecs/issues/98)). HTJ2K
  refuses these frames (PL-U10) until the codec is correct.
- No lossless image codec of this package writes 32-bit frames, so PL-U5 also matches the
  codecs.
- Explicit VR Big Endian input is not converted. The default rules keep it unchanged
  (PL-I5); a custom rule that names a target for it gets a decode error, because the
  decoders read little endian only.

# Specification: `dimsejs` (implementation requirements)

## Scope

This specification states how the `dimsejs` commands do the work. You can change an
implementation requirement when a better approach is available, if the user requirements in
[dimsejs.md](dimsejs.md) stay true.

## Implementation requirements

- **DM-I1.** The commands use `dcmjs-dimse` for the DIMSE protocol. The `overrides` entry
  `"dcmjs": "$dcmjs"` in `package.json` makes `dcmjs-dimse` and `dcmjs-codecs` use the same
  `@dcmjs-org/dcmjs` 1.0 beta as dcmjs-commands. npm applies `overrides` only in the root
  project, so a project that installs `@dcmjs/commands` as a dependency gets the dcmjs version
  that `dcmjs-dimse` declares. (DM-U1 to DM-U9)
- **DM-I2.** `store` gives `dcmjs-dimse` a `Part10FileDataset` for each file
  (`src/dimse/Part10FileDataset.js`). `getDenaturalizedDataset()` returns the bytes of the
  file after the File Meta Information, without a decode. `dcmjs-dimse` sends these bytes
  when the accepted transfer syntax equals the transfer syntax of the file. (DM-U5)
- **DM-I3.** When the accepted transfer syntax is different, `dcmjs-dimse` transcodes from
  `getElements()`, and `Part10FileDataset` then decodes the whole file. `store` gives the
  DM-U5 warning when a file was decoded and its transfer syntax is not in
  `unencapsulatedTransferSyntaxes`. The `Transcoding.transcodeDataset` of `dcmjs-dimse` 0.3.4
  keeps the private creator elements, and removes the other private elements, when it
  decompresses. An Implicit to Explicit VR conversion keeps them. (DM-U5)
- **DM-I3a.** `store` records the status of each request. After the association closes, or
  after a network error, a request with no response is a failure. `dcmjs-dimse` sends no
  request for a rejected presentation context, and gives no event for it. (DM-U6)
- **DM-I4.** The affected SOP Class UID and SOP Instance UID of a C-STORE come from the
  dataset, (0008,0016) and (0008,0018), not from the File Meta Information. The meta values
  are the fallback. (DM-U5)
- **DM-I5.** `find` converts each match to DICOM JSON through the bytes of the match:
  `fromPart10Stream` with `allowMissingHeader` reads the encoded `dcmjs-dimse` dataset, and
  `DicomWebJsonWriter` writes the JSON, the same writer as the Part 10 source of
  `dcmjs dicomweb`. Thus the JSON does not
  depend on the naturalized form of the dcmjs version inside `dcmjs-dimse`, and an empty
  element has no `Value`. The reader detects Implicit or Explicit VR Little Endian from the
  first element, which covers the syntaxes of a C-FIND context. (DM-U2)
- **DM-I6.** `get` proposes the storage SOP classes with Implicit VR Little Endian and
  Explicit VR Little Endian, as `dcmjs-dimse` does for a C-GET. (DM-U7)
- **DM-I7.** `get` uses the SOPInstanceUID as the file name only when it matches
  `/^[0-9.]{1,64}$/`. The bin adapter refuses a port outside 1 to 65535 and a timeout that is
  not a positive number with exit code 2, before it connects. (DM-U7, DM-U8)
- **DM-I8.** `readPart10Header` reads the first 64 KiB of a file for the meta group and the
  SOP UIDs. It reads the whole file only when (0008,0018) is not in that part. (DM-U4)

## Known limits

- `store` holds one whole file in memory while it sends the file. A stream from the file
  needs a change in `dcmjs-dimse`.
- `get` writes each instance from the decoded dataset, because `dcmjs-dimse` 0.3.4 decodes
  every received instance on the client side. A store stream for the client needs a change
  in `dcmjs-dimse`.
- `get` does not propose compressed transfer syntaxes, so the SCP must send the instances
  uncompressed or convert them. An SCP on `dcmjs-dimse` 0.3.4 removes the private elements
  in that conversion (DM-I3).
- `dcmjs-dimse` proposes Implicit and Explicit VR Little Endian in one presentation context
  for an Implicit VR file. An SCP that prefers Explicit VR thus gets a converted file, not
  the file bytes.
- The commands have no MCP tools yet.

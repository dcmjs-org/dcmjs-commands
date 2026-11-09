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
  `getElements()`, and `Part10FileDataset` then decodes the whole file. (DM-U5)
- **DM-I4.** The affected SOP Class UID and SOP Instance UID of a C-STORE come from the
  dataset, (0008,0016) and (0008,0018), not from the File Meta Information. The meta values
  are the fallback. (DM-U5)
- **DM-I5.** `find` converts each match to DICOM JSON through the bytes of the match: the
  `dcmjs-dimse` dataset is encoded, and the dcmjs 1.0 reader decodes it. Thus the JSON does
  not depend on the naturalized form of the dcmjs version inside `dcmjs-dimse`. The output
  does not contain the dcmjs internal `_rawValue`. (DM-U2)
- **DM-I6.** `get` proposes the storage SOP classes with Implicit VR Little Endian and
  Explicit VR Little Endian, as `dcmjs-dimse` does for a C-GET. (DM-U7)

## Known limits

- `store` holds one whole file in memory while it sends the file. A stream from the file
  needs a change in `dcmjs-dimse`.
- `get` writes each instance from the decoded dataset, because `dcmjs-dimse` 0.3.4 decodes
  every received instance on the client side. A store stream for the client needs a change
  in `dcmjs-dimse`.
- `get` does not propose compressed transfer syntaxes, so the SCP must send the instances
  uncompressed or convert them.
- The commands have no MCP tools yet.

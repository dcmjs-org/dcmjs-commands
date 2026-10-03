# dcmjs-commands

Command-line tools, built on [dcmjs](https://github.com/awatson1978/dcmjs),
for working with medical imaging files — DICOM on disk (_Part 10_ files,
the `.dcm` format scanners and PACS systems produce) and DICOM on the web
(_DICOMweb_, the JSON-and-HTTP API for the same data).

What you can do with them:

- **Inspect and check**: dump any file's contents, validate whole
  directory trees, emit standard DICOM JSON.
- **Convert**: DICOM to and from JSON, FHIR, and PDF; rebuild real DICOM
  instances from PNG/JPEG exports and their saved metadata; encapsulate
  MP4 video verbatim as DICOM video instances and recover the
  byte-identical stream back out — streamed, so a 20 GB recording
  converts with the same command as a 20 MB clip.
- **Rewrite safely**: change or remove tags in a streaming pass (any file
  size), apply FHIR Patient demographics, strip PHI with an auditable
  dry-run.
- **Package and publish**: build DICOMDIR filesets for interchange media,
  or Static-DICOMweb trees that web viewers like OHIF read directly —
  optionally with a FHIR layer (the _dicomweb+fhir_ format) so FHIR
  systems can discover the study too.
- **Retrieve as a patient or on a patient's behalf**: `patient-access`
  implements the Argonaut SMART Imaging Access flow — discover the imaging
  server from a FHIR base, authorize via SMART App Launch, list the
  patient's ImagingStudies, and pull the DICOM through the referenced
  DICOMweb endpoint with the same token.
- **Hand it to an AI agent**: every verb is also available as a typed MCP
  tool, with guardrails designed for machine callers.

Four bins ship with the package:

| Bin          | Purpose                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dcmjs`      | local Part 10 files: dump, instance, convert, anonymize, validate, filter, dicomdir, dicomweb — plus patient-access (SMART Imaging Access retrieval) |
| `dcmjs-mcp`  | the same verbs as MCP tools over stdio, for LLM agents                                                                                               |
| `dicomwebjs` | DICOMweb sources: dump, instance, download, part10                                                                                                   |
| `dimsejs`    | DIMSE networking — **experimental stub, not implemented**                                                                                            |

For a worked tour of every command with runnable examples, see
[EXAMPLES.md](EXAMPLES.md). For where the tooling is headed (library-level
APIs, pipeable CLI, SMART-context inputs), see
[architecture-design.md](architecture-design.md).

## Install

Requires Node >= 22.13. This branch (`feat/patient-access`, which contains
the whole arc: the modernized CLI, the dcmjs 1.0 integration, and the
patient-access command) builds against the **dcmjs 1.0-beta preview** — the
merge of all ten open dcmjs assembly PRs. The `dcmjs` dependency points at a
sibling checkout named `dcmjs-integration`, which must be built first:

```bash
# this package and its dcmjs sibling, side by side — note the branch names
git clone -b feat/patient-access https://github.com/awatson1978/dcmjs-commands.git
git clone -b integration/1.0-beta-preview https://github.com/awatson1978/dcmjs.git dcmjs-integration

# build the sibling first (pnpm — it is a pnpm workspace)
(cd dcmjs-integration && pnpm install && pnpm run build)

# then install this package
cd dcmjs-commands
npm install

# optional: global link so the bins are on your PATH
npm link
```

## dcmjs commands

Run `dcmjs --help` for the command list, and `dcmjs <command> --help` for
the full options of each command. The sections below show common
invocations, not every flag.

### dump

```bash
dcmjs dump scan.dcm            # tag lines: (GGGG,EEEE) VR Keyword: value
dcmjs dump scan.dcm --json     # readable JSON: keyword keys, binary summarized
```

### instance

```bash
dcmjs instance scan.dcm --pretty   # standard DICOM JSON — what a DICOMweb
                                   # /metadata endpoint returns
```

### convert

```bash
dcmjs convert scan.dcm --to fhir --pretty        # Patient + ImagingStudy
dcmjs convert scan.dcm --to dicomweb-json        # DICOM JSON model
dcmjs convert scan.dcm --to json                 # naturalized JSON
dcmjs convert scan.dcm --to dcm -o copy.dcm      # Part 10 round trip

# Image in: rebuild DICOM from a PNG/JPEG export. A same-basename .json
# (DICOM JSON metadata, any wrapper document) is discovered automatically;
# when it identifies the original instance, the result is a conformant
# derived instance (fresh SOPInstanceUID, DERIVED\SECONDARY,
# SourceImageSequence — original UIDs are never reused for rebuilt pixels).
dcmjs convert slice.png --to dcm -o rebuilt.dcm
dcmjs convert slice.png --to dcm -o rebuilt.dcm --restore-values
    # invert WindowCenter/Width to approximate the original stored values

# PDF in: wrap a PDF into a DICOM Encapsulated PDF instance
dcmjs convert report.pdf --to dcm -o report.dcm \
    --patient-name "Doe^Jane" --patient-id MRN-42 --title "Discharge Summary"

# PDF out: extract the PDF from a PACS-sourced Encapsulated PDF instance
dcmjs convert report.dcm --to pdf -o report.pdf

# Video in: encapsulate an MP4's H.264 stream VERBATIM as a DICOM Video
# Photographic Image instance (Supplement 225) — no transcoding, streamed
# with bounded memory, so multi-GB recordings are fine. H.264
# Baseline/Main/High up to Level 4.2; anything else fails with the exact
# ffmpeg transcode command to run first.
dcmjs convert visit.mp4 --to dcm -o visit.dcm --patient-name "Doe^Jane"

# Video out: recover the byte-identical original MP4
dcmjs convert visit.dcm --to mp4 -o visit.mp4

# Any input kind: apply a FHIR Patient's demographics while converting
dcmjs convert slice.png --to dcm -o rebuilt.dcm --fhir-patient patient.json
```

### filter

Copy a file while rewriting or removing tags in a streaming pass. Memory
stays bounded by the largest piece of pixel data rather than the file, so
the same command works unchanged on multi-gigabyte inputs:

```bash
dcmjs filter in.dcm -o out.dcm --set 00100010=DOE^JANE --drop 00104000

# Apply a FHIR Patient resource to the patient identity tags.
# Insert-or-replace: de-identified files whose patient tags were removed
# still receive the full set; fields absent from the resource are written
# empty, so nothing of the previous identity survives.
dcmjs filter in.dcm -o out.dcm --fhir-patient patient.json

# Custom filters: a JS module whose methods intercept the streaming
# reader's events (startElement, value, binaryFragment, ...)
dcmjs filter in.dcm -o out.dcm --module ./my-filter.mjs
```

### anonymize

```bash
dcmjs anonymize scan.dcm -o anon.dcm    # default output: <input>-anon.dcm
dcmjs anonymize scan.dcm --dry-run      # tag-level change list as JSON, no write
```

The default rule set covers standard PHI tags only — private tags and
burned-in pixel data are not touched; audit before release.

### validate

```bash
dcmjs validate ./studies/               # recursive; exit 1 on any failure
dcmjs validate scan.dcm --json report.json --quiet
dcmjs validate scan.dcm --conformance   # + structure and cross-field checks
dcmjs validate scan.dcm --layers 1,2,3  # + the Part 3 IOD rulebook
```

Plain `validate` answers "does it parse?". `--conformance` runs the
dcmjs 2.0 validation engine on every file that parses: are the fields
well-formed, and do they agree with each other (pixel data length vs
rows × columns, bit depths, transfer-syntax coherence)? Adding layer 3
(`--layers 1,2,3`) also checks the file against the standard's own
definition of what its SOP Class requires — delete `Rows` from an MR
image and you get:

```
NONCONFORMANT  scan.dcm  (1 error, 0 warnings)
    error  iod.type1.missing  Type 1 attribute Rows (00280010) of module image-pixel is missing
```

Conformance _errors_ exit 1; warnings and infos inform. Suppress rules
you've triaged with `--ignore <rule-id>` (repeatable). Files too large
for eager parsing validate through the streaming engine — same rules,
bounded memory. `--json` reports include each file's conformance
summary and any non-info issues.

### dicomdir

Build a DICOMDIR — the index file on DICOM interchange media (CDs, DVDs,
USB filesets), whose records point at every file by byte position — for a
directory of DICOM files, with the offsets computed exactly:

```bash
dcmjs dicomdir ./study                  # writes ./study/DICOMDIR
dcmjs dicomdir ./study --copy ./cd      # conformant CD tree: DICOM/IM000001...
dcmjs dicomdir ./study --json           # dry run: record tree as JSON
```

### dicomweb

Publish a directory of DICOM files as a Static-DICOMweb tree — the
DICOMweb API's responses pre-computed as files on disk, which OHIF and
other web viewers read directly from any static file host. With `--fhir`,
also write a FHIR layer (the **dicomweb+fhir** format): a Patient, an
ImagingStudy, an Endpoint saying where the pixels are served, and a
transaction `Bundle.json` that loads the whole set into any FHIR server
with one POST.

```bash
dcmjs dicomweb ./study -d ./web                    # every study found
dcmjs dicomweb ./study -d ./web --fhir \
    --fhir-patient patient.json \
    --wado-root https://pacs.example.org/dicomweb

curl -X POST https://fhir.example.org/ \
    -H 'Content-Type: application/fhir+json' -d @./web/fhir/Bundle.json
```

A provided `--fhir-patient` is embedded verbatim as the authoritative
Patient; if it disagrees with the instance tags you get a warning (run
`dcmjs filter --fhir-patient` first when the instances should match).
`--fhir-encounter` embeds an Encounter and references it from
`ImagingStudy.encounter`.

### patient-access

Retrieve a patient's imaging per the [Argonaut SMART Imaging Access
IG](https://build.fhir.org/ig/argonautproject/smart-imaging/): SMART
configuration discovery, App Launch (PKCE) authorization, an
`ImagingStudy?patient=…&_include=ImagingStudy:endpoint` search, Endpoint
resolution, and WADO-RS retrieval with the same Bearer token.

```bash
# list what is available (no download), against the Argonaut reference stack
dcmjs patient-access --imaging-url https://imaging.argo.run/open/fhir \
  --patient <fhir-patient-id> --token open --dry-run

# pull one study as Part 10 files
dcmjs patient-access --imaging-url <imaging-fhir-base> --patient <id> \
  --token <bearer> --study-uid <StudyInstanceUID> -o ./out --format part10

# interactive SMART App Launch (opens a loopback listener, prints the
# authorization URL; --paste-code if the loopback cannot be reached)
dcmjs patient-access --fhir-url <clinical-fhir-base> --client-id <id> \
  --patient <id> -o ./out
```

See the `patient-access` section of [EXAMPLES.md](EXAMPLES.md) for a real
transcript against the reference server, and `dcmjs patient-access --help`
for the full flag set.

## dcmjs-mcp — MCP server for LLM toolchains

MCP is the standard protocol by which AI assistants call external tools.
`dcmjs-mcp` serves every verb above as a typed tool (`dicom_dump`,
`dicom_instance`, `dicom_validate`, `dicom_convert`, `dicom_anonymize`,
`dicom_filter`, `dicomdir_create`, `dicomweb_create`), so an agent can
inspect, convert, and publish DICOM without shell access:

```bash
claude mcp add dcmjs -- dcmjs-mcp     # Claude Code; any MCP client works
```

Then ask for what you actually want, in plain language:

> Claude, I have a CD with some XR and MRI images from 10 years ago that I
> would like to scan and convert into modern medical imaging formats.
> Please check the attached drives, and copy the data into my home
> directory.

> Claude, please make an anonymized copy of my MRI images from 2006.

> Claude, I got married, and changed my last name. Could you go through
> the images in my personal health records folder, and update the names
> from JANE DOE to JANE FOX in them.

The design contract is "help the agent make the correct choice": tool
descriptions state defaults and conformance behavior rather than just
labeling; errors are corrective (they state what happened, what it means,
and the exact parameter to change); warnings ride in every result payload
so partial successes are visible; destructive or derived operations offer
`dry_run`; and binary results are always file paths, never inline bytes.
The tool handlers are the same functions the CLI runs, so the two
surfaces cannot drift apart.

## dicomwebjs commands

### dump / instance

```bash
# Series query from a DICOMweb server
dicomwebjs dump https://server/dicomweb/studies/<studyUID>/series

# Metadata retrieve
dicomwebjs dump https://server/dicomweb/studies/<studyUID>/series/<seriesUID>/metadata

# Local Static DICOMweb files (plain or .gz)
dicomwebjs dump studies/<studyUID>/series/<seriesUID>/metadata.gz
```

### download

Downloads a study into the Static DICOMweb file layout. The source may be
a DICOMweb server URL, a Static-DICOMweb tree, **or a plain directory of
Part 10 files** (auto-detected by DICM magic). `--fhir` writes the FHIR
layer alongside; `--verbose` narrates per-instance progress.

```bash
dicomwebjs download https://server/dicomweb -S <StudyInstanceUID> -d ~/dicomweb
dicomwebjs download ./study -S <StudyInstanceUID> -d ~/dicomweb   # Part 10 dir
```

### part10

Converts DICOMweb data into binary Part 10 files.

```bash
dicomwebjs part10 https://server/dicomweb -S <StudyInstanceUID> -d ./downloads
```

### Static DICOMweb file locations

Tree-structured file sources follow the Static DICOMweb format, rooted at
`studies/` under the base directory. Each file is a pre-computed DICOMweb
response — QIDO is the query/search half of the API, WADO the retrieval
half:

- `studies/index.json.gz` — QIDO response index for the studies
- `studies/<studyUID>/index.json.gz` — the study's index entry
- `studies/<studyUID>/series/index.json.gz` — the series QIDO response
- `studies/<studyUID>/series/<seriesUID>/metadata.gz` — the metadata WADO response
- `studies/<studyUID>/bulkdata/...` — bulkdata files
- `studies/<studyUID>/series/<seriesUID>/instances/<sopUID>/frames/<n>.mht[.gz]` — frame data

Uncompressed variants are accepted, but will not be found on a search.

## Development

```bash
npm test              # jest (native ESM)
npm run lint          # eslint
npm run format:check  # prettier
```

Tests use the committed fixture `test/fixtures/sample-dicom.dcm` plus
synthesized data — no network and no submodules. CI (GitHub Actions) checks out and builds the sibling dcmjs 1.0-beta
preview (`awatson1978/dcmjs@integration/1.0-beta-preview`) before running
the suite on Node 22 and 24.

# dcmjs-commands by example

A worked tour of every command. Two terms up front for readers arriving
from outside DICOM: a *Part 10 file* is the standard on-disk DICOM file
format (the `.dcm` files a scanner or PACS produces), and *DICOMweb* is
the web API for the same data (JSON metadata, HTTP retrieval). The design
goal throughout these tools: work *streaming* — files pass through piece
by piece, so the same command that handles a 500 KB CT slice handles a
21.8 GB surgical video without loading it into memory. Every example
below was run against real files before being written down.

Four binaries:

| binary | purpose |
|---|---|
| `dcmjs` | local Part 10 files: inspect, convert, validate, anonymize, filter, dicomdir, dicomweb — plus patient-access (SMART Imaging Access retrieval) |
| `dcmjs-mcp` | the same verbs as MCP tools for LLM toolchains (stdio server) |
| `dicomwebjs` | DICOMweb sources (http or Static-DICOMWeb file trees): dump, instance, study transfer |
| `dimsejs` | DIMSE networking (stub — placeholder surface) |

Install per the [README](README.md#install) — in short: build the sibling
`../dcmjs` checkout first (`pnpm install && pnpm run build`), then
`npm install` here. Rebuild dcmjs after changing its `src/`, or the CLI
silently sees the old version. Run the tests with `npm test` (it sets the
`--experimental-vm-modules` flag Jest needs for ESM).

---

## `dcmjs dump` — look inside a file

The quickest way to see what a DICOM file contains. Default output is one
line per element; `--json` gives the *naturalized* form — dcmjs's readable
representation, with keyword keys (`PatientName`) instead of numeric tags
and binary values summarized rather than printed.

```bash
dcmjs dump study/slice001.dcm
# (0008,0060) CS Modality: MR
# (0010,0010) PN PatientName: Fall 3
# (7FE0,0010) OB PixelData: [OB 524288 bytes]
# ...

dcmjs dump study/slice001.dcm --json | jq .PatientName
```

## `dcmjs instance` — tag-keyed DICOM JSON

The same file as standard DICOM JSON (numeric tag keys, `vr`/`Value`
entries) — the exact shape a DICOMweb `/metadata` endpoint returns, and
the shape other tools here accept as metadata input. Use this when a
machine is the consumer; use `dump --json` when a human is.

```bash
dcmjs instance study/slice001.dcm --pretty
# {
#   "00080060": { "vr": "CS", "Value": ["MR"] },
#   ...
```

## `dcmjs convert` — between representations

Input kind is auto-detected from the file; `--to` picks the target.

```bash
# DICOM → naturalized JSON on stdout
dcmjs convert slice001.dcm --to json --pretty

# DICOM → a FHIR resource (ImagingStudy/DocumentReference as appropriate)
dcmjs convert report.dcm --to fhir --fhir-version R4B --pretty

# DICOM → the PDF embedded in an Encapsulated PDF instance
dcmjs convert report.dcm --to pdf -o report.pdf

# PDF → a new Encapsulated PDF DICOM instance, with patient context
dcmjs convert consent.pdf --to dcm -o consent.dcm \
  --patient-name "DOE^JANE" --patient-id 12345 \
  --title "Signed consent" --study-uid 1.2.840.113619.2.5.1762583153.215519.978957063.78
```

## `dcmjs convert` — images back into DICOM

The scenario: years ago a DICOM study was exported as PNGs or JPEGs, with
the DICOM metadata saved alongside as JSON, and now you want real DICOM
files again. The converter accepts the image plus its metadata document —
any wrapper format works, because it collects tag-keyed `{vr, Value}`
entries wherever they sit in the JSON and tells you which keys it
ignored.

```bash
# 001.json next to 001.png is discovered automatically
dcmjs convert 001.png --to dcm -o rebuilt/001.dcm
# convert: note: ignored non-DICOM sidecar keys: png, provenance

dcmjs dump rebuilt/001.dcm | grep -E "0008,0008|0020,000D"
# (0008,0008) CS ImageType: DERIVED\SECONDARY   ← source instance detected
# (0020,000D) UI StudyInstanceUID: 1.3.12...    ← original study preserved
```

Two safety rules are built in rather than left to the caller. First,
measurements taken from the actual image (rows, columns, bit depth)
always override what the metadata claims — a wrong `Rows` is a hard error
naming both numbers, because silently trusting either side would corrupt
the output. Second, when the metadata identifies the original instance,
the rebuilt file is marked as a *derived* copy: it gets a **fresh
SOPInstanceUID**, a `SourceImageSequence` pointing back at the original,
and `LossyImageCompression 01`. Reusing the original UID would assert
that this file *is* the original — it is not; the pixels passed through a
lossy export.

About that lossiness: the PNG export was typically made by applying the
display window (a brightness/contrast mapping) to 16-bit data and saving
8-bit results. When the metadata still carries the window parameters
(WindowCenter/WindowWidth), the transform can be approximately inverted
to recover 16-bit-range stored values:

```bash
dcmjs convert 001.png --to dcm -o rebuilt/001.dcm --restore-values
# convert: restored ~12-bit stored values from WindowCenter 312 / WindowWidth 673 (lossy 8-bit source)
```

Gray-stored-as-RGB (the usual screenshot/export shape) collapses to
MONOCHROME2 automatically; real color stays RGB. A bare image with no
metadata becomes a plain Secondary Capture instance.

## `dcmjs convert` — video in and out of DICOM

DICOM can carry an H.264 video stream **verbatim**: the MP4's bytes become
the pixel data of a Video Photographic Image instance, split into fragments
that are just consecutive byte ranges of the one stream (DICOM Supplement
225). Nothing is transcoded and no pixels are ever decoded — which means
converting back out is concatenation, and the recovered file is
byte-identical to the original.

```bash
# MP4 → DICOM. Geometry, frame count, and frame rate are read from the
# MP4's own metadata; the H.264 profile/level picks the transfer syntax.
dcmjs convert visit-recording.mp4 --to dcm -o visit-recording.dcm \
    --patient-name "DOE^JANE" --patient-id 12345
# convert: encapsulated 1,421,948,796 MP4 bytes as 6 fragments → visit-recording.dcm

# DICOM → MP4: the byte-identical original stream back out
dcmjs convert visit-recording.dcm --to mp4 -o recovered.mp4
cmp recovered.mp4 visit-recording.mp4 && echo byte-identical
```

Both directions **stream**: the MP4 is read one fragment at a time (256 MiB
each by default; `--fragment-bytes` changes it) and written incrementally,
so peak memory is about one fragment no matter how large the file is. A
21.8 GB recording converts with the same command as a 20 MB clip.

Supported input codecs are what DICOM defines transfer syntaxes for:
H.264 Baseline/Main/High up to Level 4.2 (1080p60). Anything else — HEVC,
10-bit profiles, 4K levels — fails with the exact command to run first:

```
convert: unsupported video codec 'hev1' — DICOM video encapsulation
supports H.264 Baseline/Main/High up to Level 4.2. Transcode first, e.g.:
ffmpeg -i in.mp4 -c:v libx264 -profile:v high -level 4.2 -c:a copy out.mp4
```

Two details make the round trip exact. Fragment lengths must be even, so
an odd-length stream gets one padding byte on its final fragment — and the
instance also records the exact stream length in `(7FE0,0003)
EncapsulatedPixelDataValueTotalLength` (a 64-bit value; this is what the
`UV` value representation exists for), so extraction knows to drop that
pad byte. Files from writers that omit the element still convert, with a
warning that one trailing byte may survive.

### Trust, but verify — at 21.8 GB

The conversion was developed against a real stress fixture: a 21.8 GB
1080p60 H.264 recording (208,948 frames), plus an *independently built*
reference DICOM encapsulation of it — a ~150-line Python-stdlib script
(`scripts/build_dicom_video.py`) that implements Supplement 225 straight
from the spec, with a plain-Node verifier
(`scripts/verify_dicom_video.mjs`, no dcmjs imports) that walks the
written file and SHA-256-compares the reconstructed stream against the
source MP4. Cross-implementation agreement, both ways: our encoder's
output must satisfy their verifier, and their encoder's output must
convert back through us byte-identically.

Both scripts ship in this repo. The fixture itself is built from a public
download — see
[Obtaining the large test fixtures](#obtaining-the-large-test-fixtures).

```bash
# our encoder, their verifier
dcmjs convert video48-h264-50mbps.mp4 --to dcm -o ours.dcm
node scripts/verify_dicom_video.mjs ours.dcm video48-h264-50mbps.mp4
# MATCH — byte-identical round trip

# their encoder, our decoder
dcmjs convert video48-h264-50mbps.dcm --to mp4 -o back.mp4
cmp back.mp4 video48-h264-50mbps.mp4 && echo byte-identical
```

To prove the memory stays bounded, measure the peak resident set — not the
V8 heap. Node keeps binary data in Buffers *outside* the JavaScript heap,
so `--max-old-space-size` would never notice a 20 GB buffering bug;
`/usr/bin/time -l` (macOS; `-v` on Linux) catches it:

```bash
/usr/bin/time -l dcmjs convert video48-h264-50mbps.mp4 --to dcm -o ours.dcm
#  ... maximum resident set size — stays near one fragment (~256 MiB),
#      flat regardless of the 21.8 GB input
```

## Whole-slide imaging — pathology at scale

The CMB-MML whole-slide microscopy study (one H&E slide, imaged as a
pyramid of five DICOM SM instances from a 4.5 MB thumbnail to a 4.7 GB
full-resolution level; public — see
[Obtaining the large test fixtures](#obtaining-the-large-test-fixtures))
exercises both ends of the toolkit: the big instances prove the streaming
story on real data, and the tiles inside them are ordinary JPEGs the
image-conversion path can round-trip.

The big end first — the same commands from the earlier sections, unchanged
on a 4.7 GB instance:

```bash
dcmjs dump full-resolution-level.dcm | head -40   # 0.2 s: the reader stops
                                                  # before pixel data
dcmjs validate ./cmb_mml/                         # 5/5 clean — files above
                                                  # 2 GiB validate through
                                                  # the streaming parser
dcmjs dicomweb ./cmb_mml/ -d ./slide-web          # Static-DICOMweb publish
```

One honest boundary: the publisher's frame extractor still reads whole
files, and Node caps a single read at 2 GiB — so `dcmjs dicomweb`
publishes the four pyramid levels below that (26,522 frames in ~11 s)
and reports the full-resolution level as skipped, on stderr, with the
reason. Streaming publish for over-2-GiB instances is a flagged
follow-up; a skipped instance is always announced, never silent.

The tiles: a whole-slide level with the JPEG transfer syntax stores one
JPEG per frame, so a frame's bytes are a complete `.jpg` file. The library
is right there, so extracting one is a dozen lines — save this as
`extract-frame.mjs` in the dcmjs-commands checkout:

```js
// extract-frame.mjs — usage: node extract-frame.mjs in.dcm out.jpg [frame]
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");

const [, , input, output, frameArg] = process.argv;
const frame = Number(frameArg ?? 1);
const buffer = fs.readFileSync(input);
const { dict } = await dcmjs.eventStream.DicomEventStream.fromPart10(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
).toDataSet();
const fragments = dict["7FE00010"]?.Value ?? [];
if (!fragments.length) throw new Error("no encapsulated PixelData fragments");
fs.writeFileSync(output, new Uint8Array(fragments[frame - 1]));
console.log(`frame ${frame}/${fragments.length} → ${output}`);
```

```bash
# a 240x240 H&E tile out of the pyramid's thumbnail level...
node extract-frame.mjs thumbnail-level.dcm tile.jpg 56
file tile.jpg
# tile.jpg: JPEG image data, baseline, precision 8, 240x240, components 3

# ...and back into DICOM as a derived Secondary Capture
dcmjs convert tile.jpg --to dcm -o tile.dcm \
    --patient-name "DOE^JANE" --patient-id 12345
```

That last command is the same forward-migration path as the PNG examples
above: real pathology pixels, rebuilt into a conformant instance. Pair the
extracted tile with a DICOM JSON sidecar naming the source instance and
the rebuild gets the full derived-instance treatment (fresh
SOPInstanceUID, `DERIVED\SECONDARY`, `SourceImageSequence`).

## Obtaining the large test fixtures

Neither large fixture is committed — one is ~6 GB of public data, the
other is built by re-encoding a public download. Both sources are free;
note the licenses.

### The whole-slide study (CMB-MML, ~6.1 GB)

From the NCI Imaging Data Commons **CMB-MML** collection (Cancer Moonshot
Biobank, Multiple Myeloma), distributed under **CC BY 4.0**:

```bash
python -m pip install --upgrade idc-index

idc download 1.3.6.1.4.1.5962.99.1.1152570677.393312001.1714844554549.4.0 \
  --download-dir ./cmb-mml-wsi
```

That series is the five-instance pyramid used above (StudyInstanceUID
`2.25.38486921415375192085119638789590997695`). The 4.7 GiB
full-resolution instance alone can be fetched resumably without the
client:

```bash
curl -L -C - \
  "https://s3.amazonaws.com/idc-open-data/cf4b8b66-a98b-41d0-a938-f5d069bb9eea/17a26857-3a5a-40d1-8e3a-6f0777383465.dcm" \
  -o large-wsi.dcm
```

Browse the collection at
<https://portal.imaging.datacommons.cancer.gov/collections/cmb_mml/>, or
open the study in IDC's Slim viewer:
<https://viewer.imaging.datacommons.cancer.gov/slim/studies/2.25.38486921415375192085119638789590997695>.

### The 21.8 GB video (MIPO video48, re-encoded)

The source is `video48.mp4` from the **MIPO dataset** — surgical
recordings of distal-radius-fracture operations (1920×1080, ~60 fps),
distributed under **CC BY-NC 4.0** (non-commercial):

```bash
curl -L -C - \
  "https://zenodo.org/api/records/17698695/files/video48.mp4/content" \
  -o video48.mp4
md5sum video48.mp4   # a69af405ff0f7d7ccf3b58afebb10596
```

That download is 1.3 GB (a complete ~58-minute operation). The 21.8 GB
stress fixture is *manufactured* from it: re-encode at a constant
50 Mb/s, which crosses the 16 GiB mark while staying within H.264 High
Profile Level 4.2:

```bash
ffmpeg -i video48.mp4 \
  -map 0:v:0 -map 0:a? \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -r 60 -fps_mode cfr \
  -c:v libx264 -preset medium -profile:v high -level:v 4.2 -pix_fmt yuv420p \
  -b:v 50M -minrate 50M -maxrate 50M -bufsize 50M \
  -x264-params "nal-hrd=cbr:force-cfr=1:keyint=120:min-keyint=120:scenecut=0" \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  video48-h264-50mbps.mp4
```

The re-encode takes a while — it is an hour of 1080p60 at constant
bitrate. Dataset documentation:
<https://github.com/camGcam/MIPO-Dataset>; video downloads:
<https://zenodo.org/records/17698695>.

## `dcmjs validate` — sweep a corpus

Parse everything under a directory and report what fails — useful before
pointing a pipeline at a pile of files of unknown provenance.

```bash
dcmjs validate ./incoming --quiet
# incoming/bad-transfer-syntax.dcm: parse failure ...
# 214 files, 212 ok, 2 failed

dcmjs validate ./incoming --json report.json   # full machine-readable report
```

## `dcmjs dicomdir` — index a tree onto media

A DICOMDIR is the index file on DICOM interchange media (CDs, DVDs, USB
filesets): one DICOM file whose patient/study/series/image records point
at all the others by byte position. This command builds one for every
DICOM file under a directory. Indexing is fast because each file is only
parsed up to (not including) its pixel data, and the record offsets are
computed exactly — the hard part of writing a DICOMDIR, and the reason
many tools leave them as zeros and hope the reader doesn't check.

```bash
dcmjs dicomdir ./study
# dicomdir: 480 instances, 8 series, 1 study, 1 patient → ./study/DICOMDIR (198,364 bytes)

dcmjs dump ./study/DICOMDIR | head -6   # it's a DICOM file; dump reads it
```

One rule inherited from the CD era: the file names a DICOMDIR references
must fit the old ISO 9660 disc filesystem — uppercase A–Z, digits,
underscore, at most 8 characters per path component. Real directory trees
rarely comply. By default that's a warning, `--strict` makes it an error,
and `--copy` sidesteps the problem by staging a conformant CD-style tree
with generated names:

```bash
dcmjs dicomdir ./study --copy ./cd
# ./cd/DICOM/IM000001 ... IM000480, plus ./cd/DICOMDIR referencing them

dcmjs dicomdir ./study --json | jq .summary   # dry run: records, warnings, skips
```

## `dcmjs dicomweb` — publish a tree for web viewers

The modern sibling of `dcmjs dicomdir`: same input (a folder of DICOM
files), different index. Instead of a CD-style DICOMDIR, this writes the
*Static-DICOMweb* layout — the DICOMweb API's responses pre-computed as
files on disk (`studies/<uid>/...` with gzipped JSON metadata and
per-frame pixel files). OHIF and other DICOMweb viewers can read the
result directly from any static file host; no server-side DICOM logic is
required.

```bash
dcmjs dicomweb ./study -d ./web
# dicomweb: study 1.3.12... → ./web/studies/1.3.12...
# dicomweb: 1 study published to ./web

dcmjs dicomweb ./mixed-folder -d ./web        # every study found is published
dcmjs dicomweb ./study -d ./web -S 1.3.12...  # or just one
```

The same machinery makes `dicomwebjs download` accept a plain directory of
Part 10 files as its source (auto-detected — a `studies/` subdirectory
means Static-DICOMweb, DICM magic anywhere means Part 10):

```bash
dicomwebjs download ./study -S 1.3.12... -d ./web   # Part 10 dir in
dicomwebjs part10 ./web -S 1.3.12... -d ./exported  # Part 10 back out
```

A wrong study UID answers with the studies actually found (patient, description,
counts) instead of a stack trace. For heavyweight publishing (thumbnails,
deduplicated metadata trees, a server), `@radicalimaging/static-wado-creator`'s
`mkdicomweb` remains the production tool — this is the right-sized native path.

### dicomweb+fhir: `--fhir`

FHIR is how the rest of healthcare IT exchanges data; DICOM is where the
pixels live. The `--fhir` flag produces both halves of that partnership
in one output: the DICOMweb tree carries the images, and a `fhir/` layer
describes them to FHIR systems — a Patient, an ImagingStudy (id =
StudyInstanceUID, `subject` → the Patient, `endpoint` → where the pixels
are served), and a **transaction Bundle** that loads the whole set into
any FHIR server with one request:

```bash
dcmjs dicomweb ./study -d ./web --fhir \
  --fhir-patient jane-fox.json \
  --wado-root https://pacs.example.org/dicomweb
# dicomweb: fhir: Patient/22446688, ImagingStudy/1.3.12... → ./web/fhir

curl -X POST https://fhir.example.org/ -H 'Content-Type: application/fhir+json' \
  -d @./web/fhir/Bundle.json    # idempotent PUT entries — safe to re-run
```

FHIR resources also work as *inputs*. A provided `--fhir-patient` is
embedded verbatim as the authoritative Patient; if it disagrees with what
the instance tags say, you get a warning rather than a silent resolution
— run `dcmjs filter --fhir-patient` first when the instances themselves
should be updated. `--fhir-encounter` embeds an Encounter and references
it from `ImagingStudy.encounter` (it is deliberately *not* written into
DICOM tags — see below). Without `--fhir-patient`, the Patient is derived
from the instance tags.

Two questions are knowingly open, flagged for team discussion in
[architecture-design.md](architecture-design.md): what `Endpoint.address`
should be for a static tree that cannot know its eventual serving URL
(the default suits a local static-wado-webserver; set `--wado-root` for
anything else), and how far Encounter/order context should map onto DICOM
tags. `dicomwebjs download` accepts the same flags, so a study pulled
from a live server can emit its FHIR layer on the way down.

## `dcmjs anonymize` — strip PHI (current form)

Today's anonymize applies the dcmjs anonymizer's default tag rules and writes
a scrubbed copy (`--dry-run` prints the tag-level change list as JSON
without writing anything):

```bash
dcmjs anonymize slice001.dcm -o slice001-anon.dcm
dcmjs dump slice001-anon.dcm | grep 0010,0010
# (0010,0010) PN PatientName: ANON^PATIENT
```

Know the limits before relying on it: the default rules cover the
*standard* PHI tags only. Vendor private tags and text burned into the
pixels themselves are not touched — audit the output before releasing
anything. A streaming rewrite is planned (salt-derived deterministic
UIDs, consistent date offsets, name-list substitution) built on `filter`,
below — this command stays as-is until the filter version reaches parity.

### Anonymizing a whole DICOMDIR fileset

The trap this example exists to teach: the DICOMDIR itself carries the
patient name in its directory records, so anonymizing the instances while
keeping the old index would leak the identity anyway. Scrub the files,
then **rebuild** the index over the scrubbed copies:

```bash
mkdir -p ./anon-files
for f in ./cd/DICOM/*; do
  dcmjs anonymize "$f" -o "./anon-files/$(basename "$f")" > /dev/null
done

dcmjs dicomdir ./anon-files --copy ./anon-cd --fileset-id ANON_CD
# dicomdir: 481 instances, 13 series, 1 study, 1 patient → ./anon-cd/DICOMDIR

dcmjs validate ./anon-cd --quiet                    # 482/482 clean (files + new DICOMDIR)
dcmjs dump ./anon-cd/DICOM/IM000001 | grep "(0010,0010)"
# (0010,0010) PN PatientName: ANON^PATIENT
dcmjs dump ./anon-cd/DICOMDIR | grep -c "FOX"       # 0 — the index was rebuilt clean
```

(Run against a 481-instance test fileset carrying the JANE FOX test
identity; the old DICOMDIR's patient record read `FOX^JANE`, the rebuilt
one reads `ANON^PATIENT`.)

## `dcmjs filter` — the streaming workhorse

`filter` copies a file to a new file while a chain of filters watches (and
optionally rewrites) every element as it streams past. Nothing ever holds
the whole dataset in memory, so the same command works on inputs of any
size — the pipeline underneath is the one verified on a 21.8 GB fragmented
video instance (peak memory about two pixel fragments, output video
bit-identical to the source).

### Structural copy (no filters)

With no filters given, the copy still passes through the full
parse-and-serialize cycle. The output is not byte-identical to the input
— encoding details like sequence lengths are legitimately rewritten — but
it is semantically equal: every tag, VR, and binary payload survives
re-parse exactly. Useful for normalizing a file's encoding, or as a cheap
proof that a file round-trips cleanly:

```bash
dcmjs filter in.dcm -o copy.dcm
# wrote copy.dcm (527,456 bytes, 0 filters)
```

### Replace values in place: `--set TAG=VALUE`

Repeatable; the tag is 8 hex digits. Multi-valued elements collapse to the
one replacement.

```bash
# Rename the patient and re-identify the instance in one streaming pass
dcmjs filter in.dcm -o out.dcm \
  --set 00100010=RESEARCH^SUBJECT^42 \
  --set 00080018=2.25.107441562676745974564652992770535752833
```

The same shape at scale: swapping the SOP Instance UID inside a 21.8 GB video
instance took one pass at ~2 GB peak memory, and the video payload's SHA-256
was unchanged.

### Remove elements or whole sequences: `--drop TAG`

Dropping a sequence tag removes the sequence and everything nested in it, at
any depth.

```bash
dcmjs filter in.dcm -o out.dcm \
  --drop 00104000 \
  --drop 00081140   # ReferencedImageSequence, 3 items — gone as a unit
```

### Custom filters: `--module file.mjs`

The escape hatch that makes `filter` a framework. A module's default
export is a filter object (or an array of them) whose methods are named
after the streaming reader's events — `startElement`, `value`,
`binaryFragment`, and so on. Each method has the shape
`method(next, ...args)`: call `next(...)` to pass the event along, change
the arguments to rewrite it, or return without calling `next` to swallow
it entirely.

A working example — fingerprint every binary element while copying, without
buffering anything:

```js
// sha256-binaries.mjs
import crypto from "node:crypto";

let tag = null;
let hash = null;

export default {
  startElement(next, t, info)  { tag = t; return next(t, info); },
  startBinary(next, opts)      { hash = crypto.createHash("sha256"); return next(opts); },
  binaryFragment(next, chunk) {
    hash.update(Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk));
    return next(chunk);
  },
  endBinary(next) {
    console.error(`sha256(${tag}) = ${hash.digest("hex")}`);
    return next();
  }
};
```

```bash
dcmjs filter in.dcm -o copy.dcm --module ./sha256-binaries.mjs
# sha256(20011003) = df3f6198...
# sha256(7FE00010) = c8f81c31...   ← PixelData digest, computed as it streamed
# wrote copy.dcm (527,828 bytes, 1 filter)
```

Two things worth knowing when writing modules:

- **`this` is the shared listener**, not your filter object — several filters
  chain onto one listener, so keep private state in module scope (as above)
  to avoid collisions.
- **Order**: `--module` filters run before the built-in `--set`/`--drop`
  filters, and multiple modules run in the order given.

### Demographics from FHIR: `--fhir-patient resource.json`

The two standards meet here in both directions: `convert --to fhir` maps
DICOM out to FHIR, and `--fhir-patient` maps a FHIR Patient resource back
onto DICOM's patient tags — no hand-written field mapping required. The
mapping decisions live in one audited place (`@dcmjs/fhir`): where a
Patient carries several names, the `official` one wins over the `maiden`;
among identifiers, one typed MR (medical record number) is preferred; and
administrative gender converts narrowly (male→M, female→F, other or any
unrecognized value→O, unknown or absent→empty — profile extensions are
deliberately never consulted, because they carry different semantics).

```bash
cat jane-fox.json
# { "resourceType": "Patient",
#   "name": [ { "use": "official", "family": "FOX", "given": ["JANE"] },
#             { "use": "maiden",   "family": "DOE", "given": ["JANE"] } ],
#   "identifier": [ { "type": { "coding": [{ "code": "MR" }] }, "value": "22446688" } ],
#   "gender": "female", "birthDate": "1980-04-15" }

dcmjs filter in.dcm -o out.dcm --fhir-patient jane-fox.json
dcmjs dump out.dcm | grep "(0010"
# (0010,0010) PN PatientName: FOX^JANE     ← official, not the maiden DOE
# (0010,0020) LO PatientID: 22446688
# (0010,0030) DA PatientBirthDate: 19800415
# (0010,0040) CS PatientSex: F
```

Unlike `--set` (replace-only), this is **insert-or-replace**: a
de-identified file whose patient tags were removed outright still receives
the full module, emitted at the correct tag-ordered position. And it's a
deterministic overwrite — fields the resource doesn't carry are written
present-but-empty, so no trace of the previous identity survives.

The same flag works on `convert` for any input kind:

```bash
dcmjs convert scan.png --to dcm -o out.dcm --fhir-patient jane-fox.json
dcmjs convert report.pdf --to dcm -o out.dcm --fhir-patient jane-fox.json
```

### Combine everything

```bash
dcmjs filter in.dcm -o out.dcm \
  --module ./sha256-binaries.mjs \
  --set 00100010=ANON \
  --drop 00104000
# wrote out.dcm (527,462 bytes, 3 filters)
```

---

## `dcmjs-mcp` — the toolbox for LLM toolchains

Decades of legacy DICOM files exist, and increasingly the thing doing the
migration work is an LLM agent. `dcmjs-mcp` is an MCP server — the
standard protocol by which AI assistants call external tools — exposing
every verb above as a typed tool: `dicom_dump`, `dicom_instance`,
`dicom_validate`, `dicom_convert`, `dicom_anonymize`, `dicom_filter`,
`dicomdir_create`, `dicomweb_create`.

Register it (Claude Code shown; any MCP client works):

```bash
claude mcp add dcmjs -- dcmjs-mcp
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

The design contract is "help the agent make the correct choice":

- **Descriptions are guidance, not labels** — each tool states its defaults
  and conformance behavior ("original UIDs are never reused for rebuilt
  pixels", "validate the output and audit before release").
- **Errors are corrective**: state → consequence → the parameter to change.
  `"target \"dcm\" produces binary — pass output: <path> to receive
  { written: path }"`; `"image is 8-bit but metadata claims BitsStored=12 —
  pass restore_values true or accept 8-bit output"`.
- **Warnings ride along**: every result is `{ ok, warnings, ... }`, so a
  partial success (ignored sidecar keys, non-conformant file names, skipped
  files) is visible in the payload the agent reasons over.
- **Dry runs before destruction**: `dicom_anonymize` returns its tag-level
  change list and `dicomdir_create` its full record tree without writing
  anything when `dry_run` is set.
- **Binary stays on disk** — tools return `{ written: path }`, never inline
  bytes.

Under the hood the tool handlers are the very same command functions the
CLI runs — one implementation, two front ends — so CLI behavior and agent
behavior can never drift apart. (If `dcmjs-mcp` is missing from your PATH
after updating, re-run `npm link` here — new binary names need
relinking.)

---

## `dicomwebjs` — DICOMweb sources

The same inspect verbs, pointed at DICOMweb sources — a live http server,
a Static-DICOMweb file tree on disk, or (auto-detected) a plain directory
of Part 10 files — plus study transfer in both directions. Transfers
print one completion line by default; `--verbose` narrates per-instance
progress.

```bash
# Dump query/metadata responses (local Static-DICOMweb trees store
# compressed files — name them explicitly: metadata.gz)
dicomwebjs dump https://server/dicomweb/studies?PatientID=12345
dicomwebjs dump ./dicomweb/studies/1.2.840.../series/1.2.840.../metadata.gz

# Instance metadata as DICOM JSON
dicomwebjs instance https://server/dicomweb/studies/1.2.840.../metadata --pretty

# Pull a whole study into a local Static-DICOMWeb layout
dicomwebjs download https://server/dicomweb -S 1.2.840.113619.2.5.1762583153... -d ./local-cache

# Pull a study back out as Part 10 .dcm files
dicomwebjs part10 ./local-cache -S 1.2.840.113619.2.5.1762583153... -d ./exported
```

---

## `dcmjs patient-access` — SMART Imaging Access

The [SMART Imaging Access IG](https://build.fhir.org/ig/argonautproject/smart-imaging/)
flow end to end: discover the imaging endpoint from the clinical FHIR
server's `/.well-known/smart-configuration`, authorize via SMART App
Launch (public client + PKCE, loopback redirect on
`http://127.0.0.1:<port>/callback`), search
`ImagingStudy?patient=...&_include=ImagingStudy:endpoint`, resolve each
study's WADO-RS `Endpoint.address`, and retrieve with the same Bearer
token — into a Static-DICOMweb tree (default) or Part 10 files
(`--format part10`).

```bash
# See what's there before downloading anything: --dry-run lists studies
# and their resolved WADO-RS endpoints. --token skips authorization —
# for pre-authorized tokens, open test servers, or scripted flows.
dcmjs patient-access \
  --fhir-url https://imaging.example/fhir \
  --token "$ACCESS_TOKEN" --patient pat123 \
  --dry-run

# The full interactive flow: prints the authorization URL (and tries to
# open a browser), waits on the loopback, exchanges the code, searches,
# downloads. --paste-code replaces the loopback when the browser can't
# reach this machine (SSH session, container).
dcmjs patient-access \
  --fhir-url https://ehr.example/fhir \
  --client-id my-registered-client --redirect-port 8765 \
  --output ./patient-studies --format part10
```

A real transcript against the Argonaut reference stack's open
(no-authorization) configuration at `https://imaging.argo.run/open/fhir`
(run 2026-10-03, re-verified 2026-10-05; `--token dummy` because open
mode ignores the Authorization header; NODE_TLS_REJECT_UNAUTHORIZED=0
was needed because the server's TLS certificate expired on 2026-09-23 —
drop it once the cert is renewed):

```bash
dcmjs patient-access \
  --fhir-url https://imaging.argo.run/open/fhir \
  --token dummy --patient 87a339d0-8cae-418e-89c7-8651e6aab3c6 \
  --study-uid 1.3.6.1.4.1.37476.9000.163.4311018110517522394140143231184931061 \
  --output ./pa-e2e --format part10
# patient-access: 1 study for patient 87a339d0-8cae-418e-89c7-8651e6aab3c6 at https://imaging.argo.run/open/fhir
#   1.3.6.1.4.1.37476.9000.163.43110181105...  [Upper Extremity]  endpoint=https://imaging.argo.run/open/wado/eyJhbGciOiJkaXIiLCJlbm...
# patient-access: study 1.3.6.1.4.1.37476.9000.163.43110181105... → ./pa-e2e/studies/1.3.6.1.4.1.37476.9000.163.43110181105...
# patient-access: 1 study retrieved to ./pa-e2e (part10)

dcmjs dump ./pa-e2e/studies/*/series/*/instances/*/part10.dcm | grep -E "Modality|PatientName|SeriesDescription"
# (0008,0060) CS Modality: CR
# (0008,103E) LO SeriesDescription: Wrist LAT
# (0010,0010) PN PatientName: Lopez^Camila Maria^^^
```

Three CR instances (41 MB) came back over WADO-RS. Note two reference-server
behaviors the command absorbs: its WADO endpoints are retrieve-only (no
study-level QIDO — the source falls back to the study UID it already has),
and it ignores the `identifier` search parameter (`--study-uid` narrows
client-side as well).

The authorized flow against the same stack pairs the SMART sandbox with
the token-validating configuration — this one genuinely requires
interactive authorization in a browser, so it is a recipe, not a
transcript:

```bash
# 1. Register/choose a patient in the SMART App Launch sandbox
#    (https://launch.smarthealthit.org, R4, Patient Standalone Launch,
#    redirect http://127.0.0.1:8765/callback — the sandbox accepts any
#    client id).
# 2. Authorize against the sandbox; search and retrieve from the
#    token-validating imaging server:
dcmjs patient-access \
  --fhir-url "https://launch.smarthealthit.org/v/r4/sim/<launch-config>/fhir" \
  --imaging-url https://imaging.argo.run/smart-sandbox/fhir \
  --client-id whatever --scope "launch/patient patient/ImagingStudy.rs" \
  --output ./sandbox-studies
# A browser opens on the sandbox's authorization screen; pick the patient
# and approve. The loopback catches the redirect, the token (and its
# patient launch context — no --patient needed) comes back, and the
# imaging server validates that token before serving the studies.
```

---

## Measuring: the performance harness

`bench/baseline.js` times the three things people actually do with a file —
open it, read its metadata, save it back — through both the classic parse
path and the event-stream path, so improvements (and regressions) are
provable rather than anecdotal:

```bash
node bench/baseline.js          # human table
node bench/baseline.js --json   # machine-readable
```

Current recorded baseline: event-stream parse+naturalize is 1.4–1.8× slower
than the classic path (a constant ~0.2–0.3 ms per parse), write cost is
equivalent. Those numbers exist to be beaten; the trend line is the point.

## The streaming story in one table

Numbers from a 21.8 GB DICOM surgical-video instance (21 pixel-data
fragments of 1 GiB each), the fixture these tools are tested against:

| operation | peak memory | integrity check |
|---|---|---|
| read only (parse every element) | 1.9 GB | all 21 fragments, byte counts exact |
| filter copy with UID rewrite | 2.0 GB | payload SHA-256 identical to source |
| independent verifier (no dcmjs) | 59 MB | reconstructed video == source MP4 |

Memory is bounded by the largest *fragment*, never the file: the same
commands run on the same hardware whether the input is 500 KB or 21.8 GB.

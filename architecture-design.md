# Architecture & Design Notes — dcmjs / dcmjs-commands

Where the tooling stands after the 2026-08 feature arc, how the pieces layer,
and the design directions under discussion. Written to frame a team
conversation; the **Open questions** section at the bottom is the part that
needs more eyes.

## The one-sentence thesis

Forward-migration of legacy DICOM (old CDs, PNG exports, orphaned archives)
into modern representations — DICOMweb, FHIR — should be **infrastructure,
not glue code**: one audited implementation of every mapping, strong
conformance defaults, equally usable by a human at a shell, an LLM agent
over MCP, or a server in-process.

## The layer cake (current state)

```
┌────────────────────────────────────────────────────────────┐
│ SURFACES                                                   │
│   dcmjs / dicomwebjs CLIs      human hands                 │
│   dcmjs-mcp (MCP stdio)        LLM agents (typed tools)    │
│   [future] server / HTTP MCP   live systems                │
├────────────────────────────────────────────────────────────┤
│ TOOLKIT (dcmjs-commands src/ — Node-level)                 │
│   DicomAccess hierarchy: sources/destinations for          │
│     DICOMweb servers, Static-DICOMweb trees, and plain     │
│     Part 10 directories (auto-detected)                    │
│   publishFhir: FHIR layer assembly (Bundle/ImagingStudy/   │
│     Endpoint decoration over the dcmjs mappers)            │
│   image decode (pngjs/jpeg-js), sidecar-JSON extraction,   │
│     event-stream filters, DICOMDIR command logic           │
├────────────────────────────────────────────────────────────┤
│ LIBRARY (dcmjs — browser + node, dependency-free core)     │
│   event stream: fromPart10(Stream)/fromDataSet/fromImage,  │
│     Part10Writer/StreamingPart10Writer, filter chains      │
│   image: buildImageDataset (decoded pixels → instance,     │
│     geometry-wins, derived-instance conformance)           │
│   media: DICOMDIR builder (measure-then-write offsets)     │
│   fhir (@dcmjs/fhir): BOTH directions — patientFromDataset │
│     / imagingStudyFromDatasets (sink) and patientToDataset │
│     (source; official-name-over-maiden, MR identifier,     │
│     narrow administrative-gender table)                    │
└────────────────────────────────────────────────────────────┘
```

Design invariants that hold everywhere:

- **Actual data beats claims.** Decoded image geometry overrides metadata;
  identity mismatches warn rather than silently resolve.
- **Original UIDs are never reused for rebuilt pixels** — derived instances
  get fresh SOPInstanceUIDs with a SourceImageSequence back-reference.
- **Deterministic overwrite for demographics** — applying a FHIR Patient
  replaces the whole patient module; absent fields are written empty so no
  previous identity leaks through.
- **Errors are corrective**: state → consequence → the parameter to change.
- **The FHIR input/output split**: FHIR *into* DICOM is filter-shaped (one
  file at a time in the event-stream chain); FHIR *out of* DICOM is
  publisher-shaped (an ImagingStudy aggregates a whole study).

## Direction 1 — promote the pure pieces to library level

Several toolkit functions are already pure and belong one layer down, so
servers can import them without shelling out (and browsers get them free):

| today (dcmjs-commands) | proposed home | why |
|---|---|---|
| `makeFhirPatientFilter` (insert-or-replace demographics in the stream) | dcmjs `eventStream` filters | it speaks the event-stream vocabulary; nothing Node about it |
| `buildFhirLayer` decoration (ids, subject/endpoint/encounter refs, transaction Bundle) | `@dcmjs/fhir` | it decorates the mappers that live there; fs-writing stays in the toolkit |
| `extractTagKeyedJson` (schema-free DICOM-JSON plucking) | dcmjs utilities | pure, broadly useful |

Then give dcmjs-commands a real `exports` map so the Node-only pieces
(DicomAccess, Part 10 directory source, publish pipelines) are a
programmatic API — `import { publishStudy } from "@dcmjs/commands"` — with
the CLI and MCP server as thin front ends over it. Three surfaces, one core.

**This promotion is also the answer to both open questions below**: they are
symptoms of doing deployment-time work at build time. A live server knows
its own serving URL (dissolves the Endpoint.address question) and holds the
launch context — Patient, Encounter, ServiceRequest with the accession —
at the moment it publishes (dissolves the "where do accession semantics
come from" question).

## Direction 2 — a pipeable CLI ("SMART launch into a command")

The streaming core already accepts ReadableStreams, so Unix-style piping is
mostly surface work:

- `-` as input/output on the streaming commands (relax the no-binary-to-
  stdout guard when stdout is not a TTY).
- Replace the growing flag family (`--fhir-patient`, `--fhir-encounter`,
  ...) with a single **`--fhir-context`** accepting a context document —
  file, stdin (`-`), or env — exactly the shape a SMART on FHIR launch
  delivers:

```bash
smart-context-fetch | dcmjs filter in.dcm -o out.dcm --fhir-context -
```

- Proposed context mapping (the concrete proposal the Encounter question
  was missing — accession is *order* semantics, not visit semantics):
  - `Patient`        → patient module (exists today)
  - `ServiceRequest` → AccessionNumber (identifier type ACSN),
                       RequestedProcedure context
  - `Encounter`      → admission context (AdmissionID, ...) — scope TBD

The existing per-resource flags stay as sugar over the context document.

## Direction 3 — documents both ways (the "FHIR inbox as a DICOM CD" pair)

Two small follow-ups that make document-class content round-trip between
the standards as *filesets*, not just single instances. Both are
standards-blessed; the design position that keeps them respectable is
**dosage**: reference-don't-embed for pixel studies (that is what the
dicomweb+fhir Endpoint is for), embedding tolerated for document-class
payloads — SR, KOS manifests, Encapsulated PDFs, single key images. IHE
already ships the precedent (XDS-I / MHD-I move DICOM manifests as
documents).

1. **`ENCAP DOC` record-type inference in `dcmjs dicomdir`.** PS3.3
   defines the `ENCAP DOC` DirectoryRecordType precisely for Encapsulated
   Document instances; our builder accepts a recordType but the command
   defaults every leaf to `IMAGE`. Infer from SOPClassUID
   (Encapsulated PDF/CDA/STL → `ENCAP DOC`, SR classes → `SR DOCUMENT`).
   ~10 lines. Result: `fromFhir(documentReference)` instances +
   `dcmjs dicomdir` = a fully conformant DICOM fileset of documents.
2. **`application/dicom` attachment passthrough in `fromFhir`.** An
   attachment whose contentType is `application/dicom` needs no mapping —
   the bytes ARE the instance: base64 → `fromPart10`. Makes a Bundle of
   DocumentReferences with embedded DICOM (SRs, KOS, encapsulated docs)
   directly ingestible.

Together these close a loop with demo value for the WG-20-adjacent crowd:
a FHIR Bundle of documents → a valid DICOM CD with a proper DICOMDIR, and
the CD back as one POST-able Bundle.

## Sequencing

1. Library promotion (enabler; de-risks the server conversation).
2. `exports` map + programmatic API docs for dcmjs-commands.
3. Pipeable surface: `-` streams, `--fhir-context`.
4. Documents both ways (Direction 3 — small, can ride any of the above).
5. Server-side story (live Endpoint/accession) — after team discussion.

## Open questions (need team input)

1. **Endpoint.address for static artifacts.** The dicomweb+fhir publisher
   emits a FHIR Endpoint whose address defaults to
   `http://localhost:5000/dicomweb` (static-wado-webserver's default),
   overridable with `--wado-root`. A static tree cannot know its eventual
   serving URL. What is the deployment story — rewrite-on-deploy, relative
   references, per-environment config? (Server-side publishing dissolves
   this; the static path still needs an answer.)
2. **Encounter/order semantics → DICOM tags.** Today a provided Encounter
   is embedded and referenced from `ImagingStudy.encounter`, never mapped
   onto tags. The ServiceRequest→AccessionNumber proposal above may be the
   right first mapping; how far into visit/order context should tag
   injection go, and who owns that mapping table?
3. **Administrative gender** (settled, but worth ratifying): the
   `genderToSex` table is deliberately narrow — `Patient.gender` only,
   never profile extensions; male→M, female→F, other/unrecognized→O,
   unknown/absent→empty. Documented as quicksand at the implementation.
4. **Where is the embed/reference line for DICOM-in-FHIR?** Direction 3
   proposes accepting `application/dicom` attachments. Which SOP classes
   belong inline in a Bundle (SR, KOS, Encapsulated PDF, key images?) and
   at what size does an attachment become an anti-pattern that should have
   been an Endpoint reference? This one is worth raising beyond the team —
   it is exactly the kind of question the dcmjs-org / OHIF / WG-20
   community should own.

## Provenance

The 2026-08 arc landed as a revertible PR stack: dcmjs #52 (fromImage),
#53 (DICOMDIR builder), #54 (FHIR source direction); dcmjs-commands #6
(image convert), #7 (dicomdir), #8 (MCP server), #9 (--fhir-patient),
#10 (Part 10 → DICOMweb publishing), #11 (dicomweb+fhir format). Worked
examples for every command: [EXAMPLES.md](EXAMPLES.md).

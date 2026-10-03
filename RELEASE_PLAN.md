# RELEASE_PLAN — bringing the modernized dcmjs-commands upstream

This document describes how the awatson1978/dcmjs-commands fork comes home to
dcmjs-org/dcmjs-commands, so maintainers can review the process before any
code moves. It follows the same playbook as the dcmjs 1.0 staged landing
(dcmjs-org/dcmjs RELEASE_PLAN.md): plain description first, evidence with
every step, nothing self-executing.

## 1. Where things stand

Upstream dcmjs-org/dcmjs-commands is the original bun-based CLI: `dcmjs dump`
plus the `dicomwebjs` trio (dump, download, part10), built against dcmjs 0.x.

The fork is a full modernization, about fifty commits ahead, developed against
the dcmjs 1.0 rewrite as it landed:

| Area     | What the fork adds                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime  | npm + Node >= 22.13 (bun removed), ESM throughout, jest test suite (190 tests)                                                                                                                                                                                                          |
| Commands | `dump`, `instance`, `convert` (JSON/FHIR/PDF/PNG/JPEG/MP4 in both directions), `filter` (streaming `--set`/`--drop`/`--module`/`--fhir-patient`), `anonymize`, `validate` (+`--conformance`, feature-detected), `dicomdir`, `dicomweb` (Static-DICOMweb publisher, optional FHIR layer) |
| DICOMweb | `dicomwebjs` retained and extended (Part 10 ↔ Static-DICOMweb both directions)                                                                                                                                                                                                          |
| Agents   | `dcmjs-mcp` — an MCP stdio server exposing every command as a typed tool                                                                                                                                                                                                                |
| FHIR     | Patient demographics injection, Patient/ImagingStudy/Endpoint layer publishing — the SMART-imaging pattern                                                                                                                                                                              |
| Docs     | EXAMPLES.md (worked tour of every command), architecture-design.md                                                                                                                                                                                                                      |

Everything above runs against dcmjs 1.0: we built a preview of dcmjs
`1.0-beta` with all ten open assembly PRs merged (dcmjs-org/dcmjs #518, #519,
#542, #543, #575, #577, #584, #585, #588, #595 — branch
`integration/1.0-beta-preview` on awatson1978/dcmjs, 1,051 of its own tests
green), linked the fork against it, and brought the fork to fully green:
**190 tests — 187 passing, 3 deliberately skipped, 0 failing**, lint and
format clean, plus a command-by-command run of every EXAMPLES.md recipe.

## 2. The shape: two pull requests

**PR-1 — the modernization.** The whole feature arc, from the fork's
development line into upstream `main`. This is the big review: the command
set, the MCP server, the test suite, the examples. Its dcmjs dependency is
declared as a `file:` sibling plus a CI step that checks out and builds the
dcmjs integration branch — deliberately, see section 3.

**PR-2 — the dcmjs 1.0 integration.** Stacked on PR-1: the five commits that
make the fork true on dcmjs 1.0-beta — the validate feature-detect, two
hygiene fixes, the dependency pointer, and the CI wiring. Small and
reviewable on its own.

Both PRs carry the full description standard from the dcmjs landing:
first-person narrative, worked read and write examples actually executed,
test evidence with counts, honest caveats.

## 3. The dependency chicken-and-egg, in three stages

The fork needs dcmjs 1.0, which is not on npm yet; the maintainers want
evidence before publishing it. So the dependency is staged:

1. **Now (these PRs):** `"dcmjs": "file:../dcmjs-integration"` with CI
   building `awatson1978/dcmjs@integration/1.0-beta-preview` as a sibling.
   The green CLI suite _is_ the downstream evidence that the ten dcmjs
   assembly PRs compose correctly — this repo is dcmjs 1.0's first consumer.
2. **Maintainers merge the dcmjs assemblies and flip the publish switch:**
   `@dcmjs-org/dcmjs@1.0.0-beta.N` appears on npm under the `beta` tag
   (publishing machinery already verified by dry run on the dcmjs side).
3. **A one-commit follow-up here** swaps the dependency to
   `@dcmjs-org/dcmjs@^1.0.0-beta` and deletes the CI sibling checkout. From
   then on, this repo installs like any other package.

## 4. Test evidence standards

Every PR in this landing states: jest counts (expected: 187 passed, 3
skipped — the skips are conformance tests awaiting the validation engine,
each commented), lint and format-check clean, the EXAMPLES.md sweep result,
and Node versions (22 and 24, matching dcmjs's matrix). CI runs on the fork
are currently queued behind a GitHub Actions billing lock on the account; the
identical gate sequence (`npm ci`, lint, format:check, test) was verified
green locally and the PR checks re-run once the lock clears.

## 5. Known gaps, stated plainly

- **Conformance validation.** `validate --conformance` requires the dcmjs
  validation engine, which 1.0-beta does not ship (the `@dcmjs-org/validator`
  package is a deliberate stub). The command feature-detects the engine and
  exits with a corrective message; three conformance tests skip with a
  comment naming the future home. Everything returns when the validator
  package becomes real.
- **`metadata` vs `metadata.gz`.** The Static-DICOMweb publisher writes
  `metadata.gz`; one EXAMPLES.md recipe shows the uncompressed path and the
  reader does no fallback. Pre-existing documentation/implementation mismatch,
  unrelated to dcmjs 1.0 — fixed or documented inside PR-1 before it opens.
- **Bench corpus assumption.** `bench/baseline.js` defaults to fixture paths
  from the dcmjs 0.x checkout layout; it runs fine with explicit file
  arguments. Cosmetic.
- **Version self-report.** The integration bundle reports dcmjs 0.49.2 until
  the real beta is stamped by the dcmjs publish pipeline. Expected.

## 6. Deliberately not in these PRs

- **`patient-access`** — the new command implementing the Argonaut SMART
  Imaging Access IG (discovery via `.well-known/smart-configuration`, SMART
  App Launch with PKCE, `ImagingStudy?patient=…&_include=ImagingStudy:endpoint`,
  Endpoint resolution, WADO-RS retrieval with the same token). It is being
  built now on `feat/patient-access` and arrives as its own follow-up PR with
  its own evidence, so the modernization review isn't entangled with a new
  feature.
- **`dimsejs`** — remains the stub it has always been.
- **SMART Backend Services** — the system-to-system authorization mode;
  planned as patient-access v2.

## 7. What we ask of the maintainers

1. Review PR-1 and PR-2 (the RELEASE_PLAN you are reading rides with them).
2. Use the green downstream suite as the evidence case for merging the ten
   dcmjs assembly PRs and flipping the dcmjs publish environment switch.
3. After `@dcmjs-org/dcmjs@beta` publishes, approve the stage-3 dependency
   swap here.
4. Decide the npm identity of this package itself (`dcmjs-commands` is
   currently unpublished; `@dcmjs-org/commands` would match the family) — no
   publishing config lands until that decision.

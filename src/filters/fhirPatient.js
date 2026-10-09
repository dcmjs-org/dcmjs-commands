// src/filters/fhirPatient.js
//
// Streaming demographics injection: apply a FHIR Patient's mapped
// attributes (dcmjs.fhir.patientToDataset output) to the patient module of
// a DICOM stream. Unlike --set (replace-only), this is insert-or-replace —
// de-identified files whose patient tags were removed outright still get
// the full module, emitted at the correct tag-ordered position.
//
// The filter MUST be last in the chain: it synthesizes elements by calling
// the listener's _base* methods directly, which is exactly what `next`
// resolves to for the final filter — synthesized events reach the writer
// through the same door the passed-through ones do.

const PATIENT_MODULE = [
  { tag: "00100010", vr: "PN", keyword: "PatientName" },
  { tag: "00100020", vr: "LO", keyword: "PatientID" },
  { tag: "00100030", vr: "DA", keyword: "PatientBirthDate" },
  { tag: "00100040", vr: "CS", keyword: "PatientSex" },
];

/**
 * @param {Object} attrs - patientToDataset output: all four patient-module
 *   keywords, "" for absent (deterministic overwrite — empties are written
 *   as present-but-empty Type 2 elements, clearing any previous identity)
 * @returns {Object} event-stream filter (place last in the chain)
 */
export function makeFhirPatientFilter(attrs) {
  // Tag-ordered work list; entries are consumed as they are applied.
  const pending = PATIENT_MODULE.map(({ tag, vr, keyword }) => ({
    tag,
    vr,
    value: attrs[keyword] ?? "",
  }));

  let inMeta = false;
  let seqDepth = 0;
  let replacing = false;

  function emitPendingBefore(listener, tag) {
    while (pending.length && (tag === null || pending[0].tag < tag)) {
      const entry = pending.shift();
      listener._baseStartElement(entry.tag, { vr: entry.vr });
      if (entry.value !== "") {
        listener._baseValue(entry.value, { index: 0 });
      }
      listener._baseEndElement();
    }
  }

  return {
    startFileMetaInformation(next) {
      inMeta = true;
      return next();
    },
    endFileMetaInformation(next) {
      inMeta = false;
      return next();
    },
    startElement(next, tag, info) {
      if (inMeta || seqDepth > 0) {
        return next(tag, info);
      }
      emitPendingBefore(this, tag);
      if (pending.length && pending[0].tag === tag) {
        // Replace in place: keep the element, swallow its original values,
        // emit the replacement right after the start event.
        const entry = pending.shift();
        replacing = true;
        const result = next(tag, info);
        if (entry.value !== "") {
          this._baseValue(entry.value, { index: 0 });
        }
        return result;
      }
      return next(tag, info);
    },
    value(next, v, opts) {
      if (replacing) {
        return; // original values of a replaced element
      }
      return next(v, opts);
    },
    endElement(next) {
      replacing = false;
      return next();
    },
    startSequence(next, tag, info) {
      if (!inMeta && seqDepth === 0) {
        emitPendingBefore(this, tag);
      }
      seqDepth++;
      return next(tag, info);
    },
    endSequence(next) {
      seqDepth--;
      return next();
    },
    endDataSet(next) {
      // Anything not yet placed (tiny datasets ending before group 0010)
      emitPendingBefore(this, null);
      return next();
    },
  };
}

// src/part10/Part10Study.js

import { StudyAccess } from "../access/DicomAccess.js";
import { denaturalize } from "../utils/naturalize.js";
import { Part10Series } from "./Part10Series.js";

/** Study-query attributes assembled from a representative instance. */
function buildStudyNatural(seriesMap) {
  const modalities = new Set();
  let instanceCount = 0;
  let representative = null;
  for (const instances of seriesMap.values()) {
    for (const entry of instances.values()) {
      representative = representative || entry.natural;
      if (entry.natural.Modality) {
        modalities.add(entry.natural.Modality);
      }
      instanceCount++;
    }
  }

  const natural = {};
  for (const keyword of [
    "StudyInstanceUID",
    "StudyDate",
    "StudyTime",
    "StudyID",
    "StudyDescription",
    "AccessionNumber",
    "ReferringPhysicianName",
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientSex",
  ]) {
    if (representative[keyword] !== undefined) {
      natural[keyword] = representative[keyword];
    }
  }
  natural.ModalitiesInStudy = [...modalities];
  natural.NumberOfStudyRelatedSeries = seriesMap.size;
  natural.NumberOfStudyRelatedInstances = instanceCount;
  return natural;
}

export class Part10Study extends StudyAccess {
  async read() {
    const { groups } = await this.dicomAccess.scan();
    this.seriesMap = groups.get(this.uid);
    if (!this.seriesMap) {
      const found = await this.dicomAccess.describeStudies();
      throw new Error(
        `study ${this.uid} not found under ${this.dicomAccess.url} — ` +
          `found these studies instead:\n  ${found.join("\n  ")}`
      );
    }
    const studyNatural = buildStudyNatural(this.seriesMap);
    this.natural = [studyNatural];
    this.jsonData = [denaturalize(studyNatural)];
  }

  createAccess(seriesUID, natural) {
    return new Part10Series(this, seriesUID, natural);
  }

  async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const children = [];
    for (const [seriesUID, instances] of this.seriesMap) {
      const first = instances.values().next().value.natural;
      const seriesNatural = {
        SeriesInstanceUID: seriesUID,
        Modality: first.Modality || "OT",
        SeriesNumber: first.SeriesNumber ?? 1,
      };
      if (first.SeriesDescription !== undefined) {
        seriesNatural.SeriesDescription = first.SeriesDescription;
      }
      const series = this.addJson(seriesNatural);
      series.instanceEntries = instances;
      children.push(series);
    }
    return children;
  }
}

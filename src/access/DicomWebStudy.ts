import { StudyAccess } from "./DicomAccess";

export class DicomWebStudy extends StudyAccess {
  constructor(url, options, metadata) {
    this.url = url;
    this.options = options;
    this.StudyInstanceUID = options.StudyInstanceUID;
    this.metadata = metadata;
  }

  // Return previously fetched metadata
  getMetadata() {
    return this.metadata;
  }
}

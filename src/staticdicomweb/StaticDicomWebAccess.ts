import fs from "fs";

// Abstract base class for DICOM storage implementations
export class StaticDicomWebAccess {
  constructor(url, options) {
    this.url = url;
  }

  async queryStudy(studyInstanceUID) {
    const path = `${this.url}/${studyInstanceUID}`;
    fs.mkdir(path, { recursive: true });
    return new StaticDicomWebStudy(this, path);
  }
}

export default StaticDicomWebAccess;

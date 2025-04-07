// Abstract base class for DICOM access implementations
export class DicomAccess {
  static async createInstance(url, options) {
    if (url.startsWith("http")) {
      // Dynamically import DICOMweb support
      const { DicomWebAccess } = await import("./DicomWebAccess.js");
      return new DicomWebAccess(url, options);
    }

    throw new Error(`Unsupported DICOM source: ${url}`);
  }

  // Subclasses must implement study query
  async queryStudy() {
    throw new Error("queryStudy() must be implemented by subclass");
  }

  // Subclasses must implement series query
  async querySeries() {
    throw new Error("querySeries() must be implemented by subclass");
  }
}

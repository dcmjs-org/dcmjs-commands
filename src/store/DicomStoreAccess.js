// Abstract base class for DICOM storage implementations
export class DicomStoreAccess {
  async storeStudy(path, studyAccess) {
    throw new Error("storeStudy() must be implemented by subclass");
  }

  async storeSeries(path, seriesAccess) {
    throw new Error("storeSeries() must be implemented by subclass");
  }

  async storeInstances(path, seriesAccess) {
    throw new Error("storeInstances() must be implemented by subclass");
  }

  async storeFrames(path, seriesAccess) {
    throw new Error("storeFrames() must be implemented by subclass");
  }

  async storeBulkData(path, seriesAccess) {
    throw new Error("storeBulkData() must be implemented by subclass");
  }
}

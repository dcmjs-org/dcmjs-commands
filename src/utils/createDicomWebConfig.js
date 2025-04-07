export function createDicomWebConfig({
  dicomwebUrl,
  relativeResolution = "studies",
}) {
  return {
    wadoRoot: dicomwebUrl,
    bulkDataURI: {
      relativeResolution,
    },
  };
}

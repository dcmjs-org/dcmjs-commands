export const SeriesKeys = [
  "StudyInstanceUID",
  "SeriesInstanceUID",
  "SeriesDate",
  "SeriesTime",
  "AvailableTransferSyntaxUID",
  "Modality",
];

export function selectSeries(naturalInstance) {
  const series = {};
  for (const key of SeriesKeys) {
    if (naturalInstance[key]) {
      series[key] = naturalInstance[key];
    }
  }
  return series;
}

export const InstanceKeys = [
  "StudyInstanceUID",
  "SeriesInstanceUID",
  "SOPInstanceUID",
  "SOPClassUID",
  "AvailableTransferSyntaxUID",
  "InstanceNumber",
];

export function selectInstance(naturalInstance) {
  const series = {};
  for (const key of InstanceKeys) {
    if (naturalInstance[key]) {
      series[key] = naturalInstance[key];
    }
  }
  return series;
}

export type JsonData = object;

export type StudyNatural = {
  PatientName: string;
  PatientID: string;
  PatientSex: string;
  [key: string]: string | number | boolean;
};

export type SeriesNatural = {
  SeriesInstanceUID: string;
  AccessionNumber: string;
  Modality: string;
  [key: string]: string | number | boolean;
};

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

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

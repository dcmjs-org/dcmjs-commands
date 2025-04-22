export type JsonData = object;

export type StudyData = {
  PatientName: string;
  PatientID: string;
  PatientSex: string;
  [key: string]: string | number | boolean;
};

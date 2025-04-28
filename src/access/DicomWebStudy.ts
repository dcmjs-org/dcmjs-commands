import { StudyAccess } from "./DicomAccess";

export class DicomWebStudy extends StudyAccess {
  constructor(parent, uid, natural) {
    super(parent, uid, natural);
  }
}

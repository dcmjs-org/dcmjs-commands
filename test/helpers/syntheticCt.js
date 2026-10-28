// test/helpers/syntheticCt.js
//
// Writes a small classic CT series for the multiframe tests: single-frame
// slices of 16 x 16 signed 16-bit pixels, in a file order that is not the
// slice order, plus an SR, a KO and a SEG that refer to the slices.

import fs from "node:fs";
import path from "node:path";

const CT = "1.2.840.10008.5.1.4.1.1.2";
const SR = "1.2.840.10008.5.1.4.1.1.88.33";
const KO = "1.2.840.10008.5.1.4.1.1.88.59";
const SEG = "1.2.840.10008.5.1.4.1.1.66.4";
const EXPLICIT_LE = "1.2.840.10008.1.2.1";
const SIZE = 16;

function write(dcmjs, file, dataset, pixelData) {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  if (pixelData) {
    dict["7FE00010"] = pixelData;
  }
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: EXPLICIT_LE,
    ImplementationClassUID: "2.25.80302813137786398554742050926734630921",
  });
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(part10.write()));
}

/** The pixels of slice `z`: z * 100 plus the pixel index. */
export function slicePixels(z) {
  const pixels = new Int16Array(SIZE * SIZE);
  pixels.forEach((_, i) => (pixels[i] = z * 100 + i));
  return pixels;
}

const ref = (classUid, sop) => ({
  ReferencedSOPClassUID: classUid,
  ReferencedSOPInstanceUID: sop,
});

/**
 * Writes the series into `dir`. The slices are at z = 0, 2, 4, ... and
 * InstanceNumber counts down from the first slice. `photometric` labels
 * slice index 1 (to test a refusal). With `references`, also writes
 * `refs/sr.dcm`, `refs/ko.dcm` and `refs/seg.dcm` in a second series.
 *
 * @returns {{ study, series, slices: Array<{ path, sop, z }>, sr, ko, seg }}
 *   `slices` is in z order.
 */
export function writeSyntheticCt(
  dcmjs,
  dir,
  { count = 4, photometric, references = true } = {}
) {
  const { uid } = dcmjs.data.DicomMetaDictionary;
  const study = uid();
  const series = uid();
  const frameOfReference = uid();
  // The file names follow InstanceNumber, which runs against z.
  const slices = Array.from({ length: count }, (_, i) => ({
    sop: uid(),
    z: i * 2,
    path: path.join(dir, `slice-${count - i}.dcm`),
  }));
  const common = {
    PatientName: "TEST^CT",
    PatientID: "CT001",
    PatientBirthDate: "19700101",
    PatientSex: "O",
    StudyInstanceUID: study,
    StudyDate: "20260101",
    StudyTime: "080000",
    AccessionNumber: "A1",
    ReferringPhysicianName: "",
    StudyID: "1",
    Manufacturer: "Test",
  };
  for (const [i, slice] of slices.entries()) {
    write(
      dcmjs,
      slice.path,
      {
        ...common,
        SOPClassUID: CT,
        SOPInstanceUID: slice.sop,
        SeriesInstanceUID: series,
        FrameOfReferenceUID: frameOfReference,
        PositionReferenceIndicator: "",
        Modality: "CT",
        SeriesNumber: 2,
        InstanceNumber: count - i,
        ImageType: ["ORIGINAL", "PRIMARY", "AXIAL"],
        ContentDate: "20260101",
        ContentTime: `0800${String(10 + i).padStart(2, "0")}`,
        AcquisitionNumber: 1,
        BodyPartExamined: "CHEST",
        KVP: 120,
        SliceLocation: slice.z,
        ImagePositionPatient: [-4, -4, slice.z],
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        PixelSpacing: [0.5, 0.5],
        SliceThickness: 2,
        Rows: SIZE,
        Columns: SIZE,
        SamplesPerPixel: 1,
        PhotometricInterpretation:
          i === 1 && photometric ? photometric : "MONOCHROME2",
        BitsAllocated: 16,
        BitsStored: 12,
        HighBit: 11,
        PixelRepresentation: 1,
        RescaleIntercept: -1024,
        RescaleSlope: 1,
        RescaleType: "HU",
        WindowCenter: 40,
        WindowWidth: 400,
      },
      { vr: "OW", Value: [slicePixels(slice.z).buffer] }
    );
  }
  const result = { study, series, frameOfReference, slices };
  if (!references) {
    return result;
  }

  const refSeries = uid();
  const evidence = [
    {
      StudyInstanceUID: study,
      ReferencedSeriesSequence: [
        {
          SeriesInstanceUID: series,
          ReferencedSOPSequence: slices.map((s) => ref(CT, s.sop)),
        },
      ],
    },
  ];
  const image = (s) => ({
    RelationshipType: "CONTAINS",
    ValueType: "IMAGE",
    ReferencedSOPSequence: [ref(CT, s.sop)],
  });
  const document = (classUid, sop, number, content) => ({
    ...common,
    SOPClassUID: classUid,
    SOPInstanceUID: sop,
    SeriesInstanceUID: refSeries,
    Modality: classUid === KO ? "KO" : "SR",
    SeriesNumber: 10,
    InstanceNumber: number,
    ValueType: "CONTAINER",
    ContinuityOfContent: "SEPARATE",
    ConceptNameCodeSequence: [
      {
        CodeValue: "113000",
        CodingSchemeDesignator: "DCM",
        CodeMeaning: "Of Interest",
      },
    ],
    CurrentRequestedProcedureEvidenceSequence: evidence,
    ContentSequence: content,
  });
  result.sr = { sop: uid(), path: path.join(dir, "refs", "sr.dcm") };
  write(
    dcmjs,
    result.sr.path,
    document(SR, result.sr.sop, 1, [image(slices[1])])
  );
  result.ko = { sop: uid(), path: path.join(dir, "refs", "ko.dcm") };
  write(
    dcmjs,
    result.ko.path,
    document(KO, result.ko.sop, 2, [image(slices[0]), image(slices[2])])
  );

  result.seg = { sop: uid(), path: path.join(dir, "refs", "seg.dcm") };
  write(
    dcmjs,
    result.seg.path,
    {
      ...common,
      SOPClassUID: SEG,
      SOPInstanceUID: result.seg.sop,
      SeriesInstanceUID: refSeries,
      FrameOfReferenceUID: frameOfReference,
      Modality: "SEG",
      SeriesNumber: 10,
      InstanceNumber: 3,
      ReferencedSeriesSequence: [
        {
          SeriesInstanceUID: series,
          ReferencedInstanceSequence: slices.map((s) => ref(CT, s.sop)),
        },
      ],
      PerFrameFunctionalGroupsSequence: [slices[1], slices[2]].map((s) => ({
        DerivationImageSequence: [{ SourceImageSequence: [ref(CT, s.sop)] }],
      })),
      NumberOfFrames: 2,
      Rows: SIZE,
      Columns: SIZE,
      SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2",
      BitsAllocated: 1,
      BitsStored: 1,
      HighBit: 0,
      PixelRepresentation: 0,
    },
    {
      vr: "OB",
      Value: [new Uint8Array((SIZE * SIZE * 2) / 8).fill(0x0f).buffer],
    }
  );
  return result;
}

# Specification: `dcmjs multiframe`

## Scope

This specification covers the `dcmjs multiframe` command. The command converts classic
single-frame CT, MR and PET images to Legacy Converted Enhanced CT, MR and PET images
(PS3.3 A.70, A.71 and A.72). The command reads Part 10 files or a Static-DICOMweb tree.
The command also changes the references to the converted images in other instances, for
example in SR, SEG and KO instances.

The specification has two sections of requirements. The two sections have different change
rules:

- **User requirements** (`LC-U*`) state what the user must be able to do, or must be able to
  know, to use the command safely. Change a user requirement only when the requirement
  describes the behaviour incorrectly, or when the intended user-facing behaviour changes. A
  more convenient implementation is never a reason to change a user requirement.
- **Implementation requirements** (`LC-I*`) state how the command does the work. You can
  change an implementation requirement when a better approach is available, if the user
  requirements stay true.

## § User requirements

- **LC-U1.** The user can convert the classic CT Image, MR Image and PET Image instances in
  one or more Part 10 files or directories to Legacy Converted Enhanced instances with one
  command. The output goes to `-d <dir>`, as
  `<dir>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm`. The input files do not change.
- **LC-U2.** The user can convert the images of a Static-DICOMweb tree. With `-d <dir>`, the
  command writes Part 10 files as LC-U1 states, and the tree does not change. With
  `--in-place`, the command updates the tree (LC-U6). `-S <uid>` and `--series <uid>` limit
  the work to the given studies and series.
- **LC-U3.** One new instance holds one stack: the images of one series, one SOP class, one
  frame of reference, one orientation, one pixel layout and one transfer syntax. A series
  with more than one stack, for example a localizer and an axial series, gives more than one
  new instance.
- **LC-U4.** The new instance has a new SOPInstanceUID, and keeps the SeriesInstanceUID and
  the StudyInstanceUID of its source images. The frames are in slice order along the slice
  normal, and each frame holds the pixel data of its source image byte for byte. The command
  does not decode or encode the pixel data.
- **LC-U5.** References to a converted image change to the new instance and to the frame of
  that image. This applies to every instance in the input that holds such a reference, for
  example SR, KO, SEG and presentation state instances. A list of instances, for example
  the evidence of an SR, holds the new instance once. The referencing instances keep their
  SOPInstanceUID.
- **LC-U6.** With `--in-place`, the series metadata, the series query and the instance query
  of the tree list the new instance in place of the converted images. The study and series
  counts change to match. The changed referencing instances are written back to the tree.
  The files of the converted images stay in the tree. A later cleanup operation can remove
  them.
- **LC-U7.** The command never drops an image silently. An image that the Legacy Converted
  IODs do not allow is not converted, stays as it is, and is named on stderr with the
  reason. The reasons are: more than one frame, a PhotometricInterpretation other than
  MONOCHROME2, no ImagePositionPatient or ImageOrientationPatient, and Explicit VR Big
  Endian.
- **LC-U8.** The command names on stderr each attribute that it drops because the IOD does
  not allow it (overlays, curves, the VOI LUT Sequence, the icon, digital signatures). It
  also names each referenced image that it cannot list in the
  ReferencedImageEvidenceSequence.
- **LC-U9.** `--dry-run` prints the planned instances and the referencing instances, and
  writes nothing. `--json` prints the report as JSON.
- **LC-U10.** The output of the command has no error from `dciodvfy` (dicom3tools) that the
  source images do not also have, except the cases that LC-U8 names.

## § Implementation requirements

- **LC-I1.** `groupInstances` (`src/enhanced/legacyConverted.js`) groups the instances by
  SeriesInstanceUID, SOPClassUID, transfer syntax, SpecificCharacterSet,
  FrameOfReferenceUID, the Image Pixel attributes, and the ImageOrientationPatient rounded
  to 1e-4. The frames are sorted by their position along the slice normal, then by
  AcquisitionNumber, InstanceNumber and SOPInstanceUID. A stack whose frames all have
  different positions gets StackID `1`, an InStackPositionNumber, and a Multi-frame
  Dimension Module with one dimension on InStackPositionNumber.
- **LC-I2.** The attributes are placed as PS3.3 C.7.6.16.2.25 states:
  - An attribute that a functional group macro holds moves into that macro: Pixel Measures,
    Plane Position (Patient), Plane Orientation (Patient), Frame VOI LUT, Pixel Value
    Transformation, Referenced Image, Frame Anatomy, Irradiation Event Identification, and
    the CT, MR or PET Image Frame Type. A macro that is the same in every frame is shared.
  - Frame Content, Image Frame Conversion Source and Unassigned Per-Frame Converted
    Attributes are always per frame. Every frame has an Unassigned Per-Frame item, which
    can be empty.
  - Any other attribute that is the same in every frame stays at the top level when a
    Module of the IOD defines it (the `TOP_LEVEL` list), and goes to the Unassigned Shared
    Converted Attributes Sequence otherwise. An attribute that differs goes to the
    Unassigned Per-Frame item of each frame that has it. An absent attribute equals an empty
    one. A private element goes with its Private Creator.
  - An attribute whose value the conversion sets again (InstanceNumber, ImageType,
    ContentDate, ContentTime, InstanceCreationDate, InstanceCreationTime,
    ContributingEquipmentSequence) keeps its source values in the Unassigned groups.
- **LC-I3.** The new top level has: the Legacy Converted SOP class; ImageType with value 4
  empty, as C.8.16.1 allows for Legacy Converted images, and `MIXED` for a value that
  differs between frames; PixelPresentation `MONOCHROME`, VolumetricProperties `VOLUME`,
  VolumeBasedCalculationTechnique `NONE`, and for MR ComplexImageComponent `MAGNITUDE` and
  AcquisitionContrast `UNKNOWN`; PresentationLUTShape `IDENTITY` when the source has none;
  an empty AcquisitionContextSequence when the source has none; the earliest ContentDate and
  ContentTime; and a ContributingEquipmentSequence item with the purpose DCM 109106
  "Enhanced Multi-frame Conversion Equipment".
- **LC-I4.** The Frame VOI LUT macro is Type M for CT and PET. A source without a window
  gets a window over the full stored range, in rescaled values. The Pixel Value
  Transformation macro of CT and PET gets RescaleType `HU` (CT) or the PET Units, when the
  source has none. A classic reference without PurposeOfReferenceCodeSequence gets
  DCM 121311 "Localizer". BodyPartExamined maps to the Anatomic Region Sequence through
  PS3.16 Annex L (`src/enhanced/bodyPartCodes.js`, made from Table L-1); FrameLaterality is
  ImageLaterality, else Laterality, else `U`.
- **LC-I5.** `rewriteReferences` changes each item with a mapped ReferencedSOPInstanceUID: it
  sets the new SOP instance and class, and ReferencedFrameNumber. The items of one sequence
  that then differ only in ReferencedFrameNumber merge into one item with all the frames. In
  a ReferencedInstanceSequence, and in a ReferencedSOPSequence inside a
  ReferencedSeriesSequence item (the Hierarchical SOP Instance Reference Macro), the command
  sets no frame number and removes the duplicates. The ConversionSourceAttributesSequence
  keeps the classic UIDs.
- **LC-I6.** The Part 10 path reads each source with `readPart10Frames` and spools its frame;
  `writePart10WithFrames` writes the file. Native little endian input becomes Explicit VR
  Little Endian; encapsulated input keeps its transfer syntax. Each file goes to a temporary
  file and a rename puts it in place. An output path that is an input path is refused.
- **LC-I7.** The tree path reads `metadata.gz` of each series, and gets the transfer syntax
  of each image from the multipart header of its first frame file. With `--in-place`, the
  order of the writes is:
  1. the frame files of the new instance (copies of `frames/1.mht[.gz]` of each source) and,
     when the source instances have one, its own `metadata.gz` with instance-relative
     BulkDataURI values, as create-dicomweb writes them;
  2. the referencing instances, in their own `metadata.gz` when they have one;
  3. the series `metadata.gz` of each changed series;
  4. `series-singleton.json.gz`, `instances/index.json.gz` and the series `index.json.gz`
     (each when it exists), then `series/index.json.gz`, the study `index.json.gz`, and
     `studies/index.json.gz`.

  The query files keep their form: tag-keyed DICOM JSON, or the keyword form that
  `dcmjs dicomweb` writes.

## Known limits

- **A server can bring the old instances back.** create-dicomweb builds the series metadata
  again from the directories under `instances/` when new data arrives for the series. The
  converted images are still there (LC-U6), so such a build lists them again, next to the
  new instance. The cleanup operation must remove or move them.
- **Source Image Sequence.** The Derivation Image macro needs a DerivationCodeSequence, and a
  classic image does not tell why it was derived. A SourceImageSequence thus stays in the
  Unassigned groups, and the Derivation Image macro is not written.
- **Referenced images outside the input.** A classic ReferencedImageSequence names no series.
  The command lists a referenced image in ReferencedImageEvidenceSequence only when the
  image is in the input (LC-U8).
- **MONOCHROME1.** The IODs need MONOCHROME2. The command does not invert pixel data, so it
  refuses a MONOCHROME1 image (LC-U7).
- **The referencing instances keep their SOPInstanceUID** (LC-U5), although their content
  changes. This keeps the references between them, for example a KO that lists an SR.

# Specification: `dcmjs multiframe`

## Scope

This specification covers the `dcmjs multiframe` command. The command converts classic
single-frame CT, MR and PET images to Legacy Converted Enhanced CT, MR and PET images
(PS3.3 A.70, A.71 and A.72). The command reads Part 10 files or a Static-DICOMweb tree.

The command does not change the references to the converted images in other instances,
for example in SR, SEG and KO instances. A later command or option can do that work.

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
  one or more Part 10 files or directories, for example a study directory, to Legacy
  Converted Enhanced instances with one command. The output goes to `-d <dir>`, as
  `<dir>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm`. The input files do not change.
- **LC-U2.** The user can convert the images of a Static-DICOMweb tree. The input is the
  tree root or one study directory of the tree (`studies/<uid>`). With `-d <dir>`, the
  command writes Part 10 files as LC-U1 states, and the tree does not change. With
  `--in-place`, the command updates the tree (LC-U6). `-S <uid>` (tree root only) and
  `--series <uid>` limit the work to the given studies and series.
- **LC-U3.** The images of one series, one SOP class, one frame of reference, one
  orientation, one pixel layout and one transfer syntax make one group. A series with more
  than one group, for example a localizer and an axial series, gives more than one new
  instance. A group of one image is not converted, and is named on stderr.
- **LC-U4.** A group with more than one image at a position has one volume for each
  temporal position, b-value, EchoNumbers value and ImageType from value 4 on. Examples
  are the phases of a dynamic series, the b-values of a diffusion series, echo 1 and
  echo 2, and the FAT, WATER, IN_PHASE and OPP_PHASE images of a Dixon series. The volumes
  are in the order of temporal position, b-value, EchoNumbers, then ImageType. The report
  names each volume by the values that differ between the volumes, for example
  `acquisition 2`, `b 600` or `echo 1 FAT`. A group with repeated positions that none of
  these values separates stays one instance in slice order. `--layout` gives the
  instances:
  - `split` (the default): one instance for each volume, with the InstanceNumber in the
    volume order;
  - `grouped`: one instance that holds the volumes one after the other;
  - `interleaved`: one instance in slice order, with the volumes in the volume order at
    each position.

  In every layout, the order of the echoes is the same at every position, whatever the
  InstanceNumber order of the source images.

- **LC-U5.** Each new instance has a new SOPInstanceUID. The frames of a volume are in slice
  order along the slice normal, and each frame holds the pixel data of its source image
  byte for byte. The command does not decode or encode the pixel data.
- **LC-U6.** With `--in-place` and no `--new-series`, the new instances keep the
  SeriesInstanceUID of their source images. The series metadata, the series query and the
  instance query of the tree list the new instances in place of the converted images. The
  study and series counts change to match.
- **LC-U7.** With `--new-series`, the new instances of one source series go to one new
  series, with a new SeriesInstanceUID and "(multi-frame)" added to the SeriesDescription.
  With `--in-place`, the tree gets the new series with its own metadata and query files,
  and the study counts change to match. The source series do not change, so a viewer can
  show the old and the new images in one study.
- **LC-U8.** References to the converted images in other instances do not change. With
  `--in-place`, the files of the converted images stay in the tree. A later cleanup
  operation can remove them.
- **LC-U9.** The command never drops an image silently. An image that the Legacy Converted
  IODs do not allow is not converted, stays as it is, and is named on stderr with the
  reason. The reasons are: more than one frame, a PhotometricInterpretation other than
  MONOCHROME2, no ImagePositionPatient or ImageOrientationPatient, and Explicit VR Big
  Endian.
- **LC-U10.** The command names on stderr each attribute that it drops: an attribute that
  the IOD does not allow (overlays, curves, the VOI LUT Sequence, the icon, digital
  signatures), and an element of the tree metadata with no VR that no dictionary gives. It
  also names each referenced or source image that it cannot list in the
  ReferencedImageEvidenceSequence or the SourceImageEvidenceSequence.
- **LC-U11.** `--dry-run` prints the planned instances and writes nothing. `--json` prints
  the report as JSON.
- **LC-U12.** The output of the command has no error from `dciodvfy` (dicom3tools) that the
  source images do not also have, except the cases that LC-U10 names.

## § Implementation requirements

- **LC-I1.** `groupInstances` (`src/enhanced/legacyConverted.js`) groups the instances by
  SeriesInstanceUID, SOPClassUID, transfer syntax, SpecificCharacterSet,
  FrameOfReferenceUID, the Image Pixel attributes, and the ImageOrientationPatient rounded
  to 1e-4. `volumesOf` splits a group by the temporal position, the b-value, EchoNumbers
  and ImageType from value 4 on. A value of a string element that is joined with `\` (as
  some DICOM JSON writes it) is split first. The frames of a volume are sorted by their
  position along the slice normal, then by AcquisitionNumber, InstanceNumber and
  SOPInstanceUID.
  - `positionSlots` gives each image a slot: the index of its position along the
    normal. A position within 0.01 mm of the previous position has the same slot. The
    stack test, the sort and the interleaved order compare slots, not raw positions.
  - A group whose slots do not repeat is one volume, and is not split.
  - The temporal position is TemporalPositionIdentifier. When no image has it and
    positions repeat, AcquisitionNumber is the temporal position, but only if every
    volume then is a stack of 2 or more images. Many CT series give each slice its own
    AcquisitionNumber, so the command does not split by AcquisitionNumber otherwise.
  - The b-value (`bValueOf`) is DiffusionBValue, else the private b-value of Siemens
    (`SIEMENS MR HEADER` 0019,xx0C), GE (`GEMS_PARM_01` 0043,xx39, modulo 1e9) or Philips
    (`Philips Imaging DD 001` 2001,xx03). The Private Creator gives the block.
  - The b-value and the temporal position stay in the Unassigned groups. The volumes use
    StackID and InStackPositionNumber, as LC-I2 states, and not the Temporal Position
    Index or the MR Diffusion macro.
- **LC-I2.** A volume whose frames all have different positions is a stack. Each frame gets
  StackID, InStackPositionNumber and DimensionIndexValues in the Frame Content macro:
  - one volume: StackID `1`, one dimension on InStackPositionNumber, and
    DimensionOrganizationType `3D`;
  - `grouped`: StackID is the volume number, and the dimensions are StackID, then
    InStackPositionNumber;
  - `interleaved`: StackID is the volume number, and the dimensions are
    InStackPositionNumber, then StackID.

  The first dimension varies slowest in the frame order. A multi-volume instance has no
  DimensionOrganizationType, because its volumes are at the same positions.

- **LC-I3.** The attributes are placed as PS3.3 C.7.6.16.2.25 states:
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
- **LC-I4.** The new top level has: the Legacy Converted SOP class; ImageType with the
  source values 1 to 4, and `MIXED` for a value that differs between frames (value 4 may be
  empty, as C.8.16.1 allows for Legacy Converted images); PixelPresentation `MONOCHROME`,
  VolumetricProperties `VOLUME`, VolumeBasedCalculationTechnique `NONE`, and for MR
  ComplexImageComponent `MAGNITUDE` and AcquisitionContrast `UNKNOWN`; PresentationLUTShape
  `IDENTITY` when the source has none; an empty AcquisitionContextSequence when the source
  has none; the earliest ContentDate and ContentTime; and a ContributingEquipmentSequence
  item with the purpose DCM 109106 "Enhanced Multi-frame Conversion Equipment". FrameType
  of each frame has the ImageType values 1 to 4 of its source image.
- **LC-I5.** The Frame VOI LUT macro is Type M for CT and PET. A source without a window
  gets a window over the full stored range, in rescaled values. The Pixel Value
  Transformation macro of CT and PET gets RescaleType `HU` (CT) or the PET Units, when the
  source has none. A classic reference without PurposeOfReferenceCodeSequence gets
  DCM 121311 "Localizer". BodyPartExamined maps to the Anatomic Region Sequence through
  PS3.16 Annex L (`src/enhanced/bodyPartCodes.js`, made from Table L-1); FrameLaterality is
  ImageLaterality, else Laterality, else `U`. ReferencedImageEvidenceSequence and
  SourceImageEvidenceSequence list the images of the ReferencedImageSequence and the
  SourceImageSequence of the sources that are in the input.
- **LC-I6.** With `--new-series`, the command makes one SeriesInstanceUID for each source
  series, sets the SeriesDescription to the first 49 characters of the source value and
  ` (multi-frame)`, and starts the InstanceNumber at 1. The SeriesNumber stays.
- **LC-I7.** The Part 10 path reads each source with `readPart10Frames` and spools its frame;
  `writePart10WithFrames` writes the file. Native little endian input and Deflated
  Explicit VR Little Endian input become Explicit VR Little Endian; encapsulated input
  keeps its transfer syntax. The tree path gunzips a `.mht.gz` frame file
  (`frameToBuffer`). Each file goes to a temporary
  file and a rename puts it in place. An output path that is an input path is refused.
- **LC-I8.** The tree path reads `metadata.gz` of each series, and gets the transfer syntax
  of each image from the multipart header of its first frame file. Before the grouping,
  `datasetOf` gives an element with no `vr` the `vr` of the dictionary, leaves out the
  private blocks of the creator `dedupped` (the deduplication records of Static-DICOMweb),
  and leaves out an element whose `vr` stays unknown. For `-d`, `importBulkdata` decodes a
  BulkDataURI or InlineBinary value of a numeric VR (SS, US, SL, UL, FL, FD, SV, UV) to
  numbers, and keeps the bytes for the other VRs. AT values are written as DICOM JSON
  strings of 8 hex characters (PS3.18 F.2.3).
- **LC-I9.** With `--in-place`, the order of the writes is:
  1. the frame files of all new instances of the study (copies of `frames/1.mht[.gz]` of
     each source) and, when the source instances have one, the own `metadata.gz` of each
     new instance, with instance-relative BulkDataURI values, as create-dicomweb writes
     them. An instance that fails gets an error in the report, its files are removed, and
     the later steps leave it out, so its source images stay listed;
  2. the series `metadata.gz` of each changed or new series;
  3. `series-singleton.json.gz`, `instances/index.json.gz` and the series `index.json.gz`
     (each when the source series has it), then `series/index.json.gz`, the study
     `index.json.gz` and `study.json.gz`, and `studies/index.json.gz`.

  An error in steps 2 or 3 is reported for the study, and the report is still printed.
  The command does not change `series-natural.json.gz`. No reader in dcmjs-commands or
  Static-DICOMweb uses that file. With `--new-series`, a series-qualified PixelData BulkDataURI gets the new
  SeriesInstanceUID.

  The query files keep their form: tag-keyed DICOM JSON, or the keyword form that
  `dcmjs dicomweb` writes. A new series copies the query entries of its source series, and
  changes the SeriesInstanceUID, the SeriesDescription and the counts.

## Known limits

- **A server can bring the old instances back.** create-dicomweb builds the series metadata
  again from the directories under `instances/` when new data arrives for the series. The
  converted images are still there (LC-U8), so such a build lists them again, next to the
  new instance. The cleanup operation must remove or move them. `--new-series` does not have
  this problem, because the source series stays complete.
- **References do not change** (LC-U8). Without `--new-series`, an SR, SEG or KO that refers
  to a converted image refers to an instance that the series metadata no longer lists.
- **Other repeated positions.** A series whose repeated positions none of the LC-I1 values
  separates becomes one instance in slice order, with no StackID and no dimensions.
  Examples are a time series at one position (each volume has one image), a dynamic
  series that gives its phases only in a private element or in the AcquisitionTime, and a
  diffusion series of a vendor other than Siemens, GE and Philips with no
  DiffusionBValue.
- **Source Image Sequence.** The Derivation Image macro needs a DerivationCodeSequence, and a
  classic image does not tell why it was derived. A SourceImageSequence thus stays in the
  Unassigned groups, and the Derivation Image macro is not written.
- **Referenced images outside the input.** A classic ReferencedImageSequence or
  SourceImageSequence names no series. The command lists a referenced image in the
  evidence sequences only when the image is in the input (LC-U10).
- **MONOCHROME1.** The IODs need MONOCHROME2. The command does not invert pixel data, so it
  refuses a MONOCHROME1 image (LC-U9).

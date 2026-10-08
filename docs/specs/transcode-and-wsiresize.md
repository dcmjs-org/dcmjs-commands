# Specification: `dcmjs transcode` and `dcmjs wsiresize`

## Scope

This specification covers two commands of the `dcmjs` executable:

- `dcmjs transcode` writes the pixel data of DICOM files in a different transfer syntax.
- `dcmjs wsiresize` builds a new pyramid for a whole-slide image (WSI) series: a new tile
  size, a new factor between levels, and a new transfer syntax.

The specification has two sections of requirements. The two sections have different change
rules:

- **User requirements** (`TC-U*`, `WR-U*`) state what the user must be able to do, or must
  be able to know, to use the commands safely. Change a user requirement only when the
  requirement describes the behaviour incorrectly, or when the intended user-facing
  behaviour changes. A more convenient implementation is never a reason to change a user
  requirement.
- **Implementation requirements** (`TC-I*`, `WR-I*`, `PX-I*`) state how the commands do the
  work. You can change an implementation requirement when a better approach is available,
  if the user requirements stay true.

## § User requirements

### `dcmjs transcode`

- **TC-U1.** The user can convert every DICOM file in one or more files or directories to a
  chosen transfer syntax with one command.
- **TC-U2.** By default, the command replaces each file in place. With `-d <dir>`, the
  command writes the new files to `<dir>` with the same relative paths, and the input files
  do not change.
- **TC-U3.** A conversion from JPEG Baseline (`1.2.840.10008.1.2.4.50`) to JPEG XL JPEG
  Recompression (`1.2.840.10008.1.2.4.111`) is lossless. A conversion back to JPEG Baseline
  gives the same JPEG bytes for each frame. Both conversions keep the SOPInstanceUID.
- **TC-U4.** The command never makes a lossy change silently. A lossy target needs the
  `--lossy` option. A lossy file gets a new SOPInstanceUID, and its header records the lossy
  step (`LossyImageCompression`, `LossyImageCompressionRatio`,
  `LossyImageCompressionMethod`).
- **TC-U5.** The command prints, before and after the conversion: the number of instances,
  the number of frames, the header bytes, the image bytes, and the file bytes.
- **TC-U6.** The command can convert a file of any size. The size of the file does not
  change the memory that the command uses.
- **TC-U7.** If the command fails on a file, that file does not change, and no partial file
  stays in the output location.
- **TC-U8.** `--dry-run` lists the files that the command would change, and writes nothing.
- **TC-U9.** The command shows its progress on stderr. A file with many frames gets a line
  when it starts and lines that show how many of its frames are done. Small files are
  reported in batches. With `-q` or `--quiet`, the command shows no progress. The progress
  never goes to stdout, so `--json` output stays valid.
- **TC-U10.** With `--new-series`, the user can make copies of existing DICOM files that an
  archive accepts as new data, to test a re-upload. The command needs `-d <dir>`, so the
  originals never change, and `--to` is optional.
  - Each series, instance, pyramid and concatenation gets a new UID. The StudyInstanceUID
    and the FrameOfReferenceUID do not change.
  - References between the copies stay valid. For example, a copied bulk annotation
    refers to the copied image.
  - SeriesNumber increases by 1000. SeriesDescription gets ` (copy N)`, and N increases by
    one for each copy of a copy, so the user can see which iteration an upload came from.
  - The instance creation, series and content date and time get the time of the run.
  - The pixel data does not change, unless `--to` asks for a different transfer syntax.

### `dcmjs wsiresize`

- **WR-U1.** The user can rebuild the pyramid of a VL Whole Slide Microscopy series from its
  largest VOLUME level, with a chosen tile size, a chosen factor between levels, and a
  chosen transfer syntax.
- **WR-U2.** The user can select a preset. The presets include JPEG XL lossy at three loss
  levels and JPEG XL lossless, all with 1024 x 1024 tiles, a factor of 4, and progressive
  encoding. The user can override each value of a preset.
- **WR-U3.** The command does not replace the input by default. The user must give
  `-d <dir>` (a new series) or `--in-place`.
- **WR-U4.** With `--in-place`, the base level keeps its SOPInstanceUID and the series keeps
  its SeriesInstanceUID, so that references to the base level stay valid. For example, the
  2D coordinates of a bulk annotation stay valid, because the total pixel matrix of the base
  level does not change. The command deletes the old pyramid levels other than the base,
  and does not change LABEL and OVERVIEW images.
- **WR-U5.** The command prints the size of the total pixel matrix, the levels before and
  after, and the same totals as TC-U5.
- **WR-U6.** The pixels of the new base level come from the source base level, at the same
  positions. Each lower level is the level above it, reduced by the factor.
- **WR-U7.** No source file changes until all new levels are complete.
- **WR-U8.** The command shows its progress as TC-U9 states, with one series as one file and
  the frames of its base level as the frames.

## § Implementation requirements

### Shared pixel pipeline (`src/pixel/`)

- **PX-I1.** One streaming pass reads each file (`readPart10Frames`). The header goes to a
  `CollectorListener`. Each frame goes to an async callback inside the drain gate of the
  event stream, so the reader does not read the next fragment before the callback ends.
- **PX-I2.** Fragments become frames by the Basic Offset Table, else by the Extended Offset
  Table, else all fragments for one frame, else at each fragment that ends with an EOI/EOC
  marker (JPEG family), else one fragment for each frame.
- **PX-I3.** Encoded frames go to a temporary spool file. After the last frame, the writer
  writes the header with `DicomDict.write()`, then the PixelData element, with a Basic Offset
  Table when all offsets fit in 32 bits, then the frames from the spool. Thus the header can
  hold values that are known only after encoding.
- **PX-I4.** The writer drops elements after PixelData, because they cannot follow new
  pixel data, and reports their tags. The writer drops the Extended Offset Table of the
  source.
- **PX-I5.** All codecs come from `@cornerstonejs/dicom-codec`. The command loads the codecs
  on first use. JPEG Baseline to and from JPEG XL JPEG Recompression goes through the
  bitstream path of the codec, with no pixel decode.
- **PX-I6.** Output files go to a temporary file in the target directory, and a rename puts
  each file in its final location.
- **PX-I7.** `Progress` (`src/pixel/progress.js`) writes lines, not carriage returns, so the
  output is the same in a terminal and in a log. A file with 500 frames or more gets a start
  line, a line at each 10% of its frames, and an end line. Smaller files get one line for
  each batch of 20 files, and one line at the end.

### `dcmjs transcode`

- **TC-I1.** The command skips a file that has no pixel data, a file that already has the
  target syntax, and a file that has no decoder. With `-d`, the command copies such DICOM
  files unchanged.
- **TC-I3.** `--new-series` reads the header of each input first and maps each identifying
  UID (0020,000E), (0008,0018), (0008,0019) and (0020,9161) to a new UID. A rewrite then
  sends every UI value of each file, in all sequences and in the file meta, through the
  same map. With `--new-series`, files that `transcode` would skip are written too: their
  frames are copied without a codec, and a file without pixel data gets only the new
  header.
- **TC-I2.** Native input frames come from one PixelData buffer, because the stream reader
  gives a native value as one buffer. Thus a native input must be smaller than 2 GiB.

### `dcmjs wsiresize`

- **WR-I1.** The base level is decoded one source tile at a time. A `TileRowAssembler`
  makes full-width strips. A chain of `LevelBuilder` objects keeps one band of `tile` rows
  for each level, encodes the band tiles, and passes the band, reduced by a box filter, to
  the next level.
- **WR-I2.** Source frames out of raster order go to a spool file first, and the command
  reads them back in raster order.
- **WR-I3.** Each new level is `TILED_FULL`, has no PerFrameFunctionalGroupsSequence and no
  concatenation attributes, has ImageType `DERIVED\PRIMARY\VOLUME\(NONE|RESAMPLED)`, and has
  its PixelSpacing multiplied by the scale of the level.
- **WR-I4.** Only 8-bit samples, one or three samples per pixel, one focal plane and one
  optical path are supported. A concatenation of more than one part is refused.
- **WR-I5.** Partial edge tiles are filled with white (255), or with black (0) for
  MONOCHROME2.

## Known limits

- The writer from dcmjs writes sequences with undefined length. Thus the header can be
  larger than the header of the source, with the same content.
- `wsiresize` encodes one tile at a time on one thread. A JPEG XL tile of 1024 x 1024 at
  effort 7 takes about 0.4 s.

import { DicomAccess } from "@dcmjs/commands";

const action = async (url, options) => {
  try {
    const destination = await DicomAccess.createInstance(options.directory, {
      ...options,
      scheme: "file",
    });

    // Create access instance (currently supports only DICOMweb)
    console.debug(
      "🔌 Creating DICOM access instance...",
      url,
      "to",
      options.directory
    );
    const access = await DicomAccess.createInstance(url, options);

    const { StudyInstanceUID: studyUID } = options;
    if (!studyUID) {
      console.warn("Please provide a studyUID");
      return -2;
    }
    const srcStudy = await access.queryStudy(studyUID);

    await destination.store(srcStudy, {
      ...DicomAccess.PART10_OPTIONS,
      ...options,
    });

    console.log(
      `🎉 Part 10 conversion complete. Study saved to: ${options.directory}/studies/${studyUID}`
    );
  } catch (err) {
    console.warn("❌ An error occurred during download:", err);
    process.exit(1);
  }

  process.exit(0);
};

// CLI registration
export default async function cliDownload(program) {
  program
    .command("part10")
    .description("Convert local or remote DICOMweb metadata files to part 10")
    .argument("<url>", "DICOMweb URL or local path (e.g. ./study, scp://...)")
    .option(
      "-S, --StudyInstanceUID <StudyInstanceUID>",
      "StudyInstanceUID to download"
    )
    .option("-d, --directory <targetDir>", "Download to local directory", ".")
    .option("--debug", "Enable debug logging")
    .action(action);
}

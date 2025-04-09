import { DicomAccess } from "@dcmjs/commands";

const action = async (url, options) => {
  try {
    const destination = await DicomAccess.createInstance(options.directory, {
      ...options,
      scheme: "sdw",
    });

    // Create access instance (currently supports only DICOMweb)
    console.log("🔌 Creating DICOM access instance...");
    const access = await DicomAccess.createInstance(url, options);

    const destStudy = await destination.queryStudy(options.StudyInstanceUID);
    const srcStudy = await access.queryStudy(options.StudyInstanceUID);

    destStudy.store(srcStudy, options);

    // Fetch study metadata
    console.log("📚 Querying study metadata...");
    const studyAccess = await access.queryStudy();

    // Fetch series metadata
    console.log("📚 Querying series metadata...");
    const seriesAccess = await access.querySeries();

    // Download series-level metadata
    console.log("📄 Downloading metadata for each series...");
    await seriesAccess.querySeriesInstanceUIDsMetadata();
    console.log("✅ Metadata downloaded.");

    // Download instances (SOPs)
    console.log("📦 Downloading DICOM instances...");
    await seriesAccess.querySeriesInstanceUIDsInstances();
    console.log("✅ Instances downloaded.");

    // Download frames for multi-frame instances
    console.log("🖼️  Downloading image frames...");
    await seriesAccess.querySeriesInstanceUIDsFrames();
    console.log("✅ Frames downloaded.");

    // Download external bulk data (non-pixel data)
    console.log("🧱 Downloading bulk data...");
    await seriesAccess.querySeriesInstanceUIDsBulkData();
    console.log("✅ Bulk data downloaded.");

    // Save everything to disk in SDW structure
    console.log("💾 Saving study to disk...");
    await new DicomStoreSDW().store(downloadDir, studyAccess, seriesAccess);
    console.log(`🎉 Download complete. Study saved to: ${downloadDir}`);
  } catch (err) {
    console.error("❌ An error occurred during download:", err);
    process.exit(1);
  }

  process.exit(0);
};

// CLI registration
export default async function cliDownload(program) {
  program
    .command("download")
    .description("Download a full DICOM study from any supported source")
    .argument("<url>", "DICOMweb URL or local path (e.g. ./study, scp://...)")
    .option(
      "-S, --StudyInstanceUID <StudyInstanceUID>",
      "StudyInstanceUID to download"
    )
    .option("-d, --directory <targetDir>", "Download to local directory", "./")
    .option("--debug", "Enable debug logging")
    .action(action);
}

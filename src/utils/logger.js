import loglevel from "loglevel";

/**
 * Gets a logger and adds a getLogger function to id to get child loggers.
 * This looks like the loggers in the unreleased loglevel 2.0 and is intended
 * for forwards compatibility.
 */
export function getRootLogger(name) {
  const logger = loglevel.getLogger(name);
  logger.getLogger = (...names) => {
    return getRootLogger(`${logger.name}.${names.join(".")}`);
  };
  return logger;
}

/** Gets a nested logger.
 * This will eventually inherit the level from the parent level, but right now
 * it doesn't
 */
export function getLogger(...name) {
  return getRootLogger(name.join("."));
}

/** Pre-setup cateogires for easy logging, by package name */
export const dcmjsLog = getLogger("dcmjs");
export const commandsLog = dcmjsLog.getLogger("commands");

/** Dicom issue log is for reporting inconsistencies and issues with DICOM logging */
export const dicomIssueLog = getLogger("dicom", "issue");

export function setOptions(options = {}) {
  if (options.loglevel) {
    loglevel.setLevel(options.loglevel);
  } else if (options.debug) {
    loglevel.setLevel("debug");
  } else if (options.verbose) {
    loglevel.setLevel("info");
  } else if (options.quiet) {
    loglevel.setLevel("error");
  } else {
    // Default is quiet: the per-instance transfer narration is info-level;
    // command results go to stdout, not the log. --verbose restores it.
    loglevel.setLevel("warn");
  }
  loglevel.rebuild();
}

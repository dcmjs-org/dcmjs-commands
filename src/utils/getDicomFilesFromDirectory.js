import fs from "fs";
import path from "path";

export function getDicomFilesFromDirectory(directory) {
  return fs
    .readdirSync(directory)
    .filter((f) => f.endsWith(".dcm"))
    .map((f) => path.join(directory, f));
}

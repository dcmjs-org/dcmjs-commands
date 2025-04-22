import { homedir } from "os";
import path from "path";

export function handleHomeRelative(dirName) {
  return dirName[0] == "~"
    ? path.join(homedir(), dirName.substring(1))
    : dirName;
}

export default handleHomeRelative;

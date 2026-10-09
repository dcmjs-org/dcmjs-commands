// test/utils/handleHomeRelative.test.js

import os from "os";
import path from "path";
import { handleHomeRelative } from "../../src/utils/handleHomeRelative.js";

test("expands ~ to the home directory", () => {
  expect(handleHomeRelative("~/studies")).toBe(
    path.join(os.homedir(), "studies")
  );
});

test("leaves absolute and relative paths alone", () => {
  expect(handleHomeRelative("/tmp/x")).toBe("/tmp/x");
  expect(handleHomeRelative("relative/dir")).toBe("relative/dir");
});

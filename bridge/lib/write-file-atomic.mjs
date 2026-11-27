import { randomUUID } from "node:crypto";
import fs from "node:fs";

/** Replace a UTF-8 file only after its complete contents reach disk. @param {string} file @param {string} text */
export function writeFileAtomic(file, text) {
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temp, "wx", mode ?? 0o666);
    created = true;
    // open applies umask; an existing target keeps its permissions exactly.
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(temp); } catch {}
    }
    throw error;
  }
}

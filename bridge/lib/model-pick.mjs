import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The owner's model and effort picks from Rivet → Settings → Who does what, as the bridge writes them to
// ~/.rivet/model-routing.json. Rivet's own copy of the reading in scripts/model-routing.mjs, for the jobs it runs: a
// pick its job's list here does not name is ignored, and the job runs as it did before there were picks.

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const PICK_MODELS = {
  "small-jobs": ["claude-haiku-5-5", "claude-opus-5-5"],
  "work-chats": ["claude-opus-5-5", "claude-fable-5-2"],
};

export const MAX_PICK_FILE_BYTES = 64 * 1024;

export const modelPickFile =(env = process.env) => env.RIVET_MODEL_ROUTING_FILE || path.join(os.homedir(), ".rivet", "model-routing.json");

/**
 * The job's `{ model, effort }` when the Mac file picks one its list allows, else null.
 * @param {keyof typeof PICK_MODELS} job @returns {{ model: string, effort: string } | null}
 */
export function readModelPick(job, file = modelPickFile()) {
  let entry;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    // Checked on the open file: a FIFO would hang the bridge, and a huge file has no pick worth parsing.
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_PICK_FILE_BYTES + 1);
    let size = 0;
    for (let n = 1; n && size < buf.length; size += n) n = fs.readSync(fd, buf, size, buf.length - size, null);
    if (size > MAX_PICK_FILE_BYTES) return null;
    entry = JSON.parse(buf.toString("utf8", 0, size))?.jobs?.[job];
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!entry || typeof entry !== "object" || !Object.hasOwn(PICK_MODELS, job)) return null;
  if (!PICK_MODELS[job].includes(entry.model) || !EFFORTS.includes(entry.effort)) return null;
  return { model: entry.model, effort: entry.effort };
}

/**
 * @typedef {{ type: "event", event: string, data: string, id?: string }
 *   | { type: "comment", text: string }} SseItem
 */

export const MAX_EVENT_BYTES = 256 * 1024;

/**
 * Incremental text/event-stream parser (WHATWG rules): LF, CR and CRLF line ends,
 * a CR at the end of one chunk paired with an LF at the start of the next,
 * multi-line `data`, comment lines, and a leading BOM.
 */
export class SseParser {
  constructor({ maxEventBytes = MAX_EVENT_BYTES } = {}) {
    this.maxEventBytes = maxEventBytes;
    this.buf = "";
    this.skipLf = false;
    this.started = false;
    this.resetEvent();
  }

  resetEvent() {
    /** @type {string[]} */
    this.data = [];
    this.dataSize = 0;
    this.event = "";
    /** @type {string | undefined} */
    this.id = undefined;
  }

  /**
   * @param {string} chunk decoded text
   * @returns {SseItem[]}
   */
  push(chunk) {
    /** @type {SseItem[]} */
    const out = [];
    let s = chunk;
    if (!this.started && s.length > 0) {
      this.started = true;
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    }
    if (s.length === 0) return out;
    if (this.skipLf && s.startsWith("\n")) s = s.slice(1);
    this.skipLf = false;
    this.buf += s;
    let start = 0;
    for (;;) {
      const cr = this.buf.indexOf("\r", start);
      const lf = this.buf.indexOf("\n", start);
      let end;
      if (cr === -1 && lf === -1) break;
      if (cr === -1) end = lf;
      else if (lf === -1) end = cr;
      else end = Math.min(cr, lf);
      const line = this.buf.slice(start, end);
      if (this.buf[end] === "\r") {
        if (end + 1 < this.buf.length) {
          start = this.buf[end + 1] === "\n" ? end + 2 : end + 1;
        } else {
          start = end + 1;
          this.skipLf = true;
        }
      } else {
        start = end + 1;
      }
      this.line(line, out);
    }
    this.buf = this.buf.slice(start);
    if (this.buf.length > this.maxEventBytes) throw new Error("sse line too long");
    return out;
  }

  /**
   * @param {string} line
   * @param {SseItem[]} out
   */
  line(line, out) {
    if (line === "") {
      if (this.data.length > 0) {
        /** @type {SseItem} */
        const ev = { type: "event", event: this.event || "message", data: this.data.join("\n") };
        if (this.id !== undefined) ev.id = this.id;
        out.push(ev);
      }
      this.resetEvent();
      return;
    }
    if (line.startsWith(":")) {
      out.push({ type: "comment", text: line.slice(1).replace(/^ /, "") });
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.dataSize += value.length + 1;
      if (this.dataSize > this.maxEventBytes) throw new Error("sse event too large");
      this.data.push(value);
    } else if (field === "event") {
      this.event = value;
    } else if (field === "id") {
      if (!value.includes("\0")) this.id = value;
    }
  }
}

import { loadConfig } from "./config.js";
import { createApp } from "./http.js";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, () => {
  const disabled = [
    config.boardTokenDigest ? null : "board",
    config.bridgeTokenDigest ? null : "bridge",
    config.enrollTokenDigest ? null : "enrol",
  ].filter(Boolean);
  const push = app.push.configured ? "push on" : "push off";
  console.log(
    `[rivet] listening on :${config.port} for ${config.origin}, ${push}` +
      (disabled.length ? ` (token routes off: ${disabled.join(", ")})` : ""),
  );
});

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[rivet] ${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  void app.close().then(() => process.exit(0));
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

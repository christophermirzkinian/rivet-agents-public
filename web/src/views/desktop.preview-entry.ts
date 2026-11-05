// Old Ops preview links need the Ops fixtures, too. Load only one mock API.
const params = new URLSearchParams(location.search);
const readings = ["ops", "usage", "code", "machines"];
export const previewReady = readings.includes(params.get("tab") ?? "") || (params.get("tab") === "more" && readings.includes(params.get("page") ?? ""))
  ? import("./ops.preview.js")
  : import("./desktop.preview.js");

const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (value) => typeof value === "string" && value.length > 0 && !unsafe.has(value);

/** Clone a snapshot, removing only properties explicitly rejected by a strict receiver. */
export function snapshotWithoutRejectedKeys(snapshot, issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  // Refuse malformed paths and mixed validation failures; stripping fields cannot fix those.
  for (const issue of issues) {
    if (!issue || issue.code !== "unrecognized_keys" || !Array.isArray(issue.path)
      || !Array.isArray(issue.keys) || !issue.keys.length || !issue.keys.every(key)) return null;
    let target = snapshot;
    for (const part of issue.path) {
      if (typeof part === "number") {
        if (!Number.isSafeInteger(part) || part < 0 || !Array.isArray(target) || !Object.hasOwn(target, part)) return null;
      } else if (!key(part) || !object(target) || !Object.hasOwn(target, part)) return null;
      target = target[part];
    }
    if (!object(target)) return null;
  }
  const copy = structuredClone(snapshot);
  let changed = false;
  function remove(target, path, keys) {
    if (!path.length) {
      if (object(target)) for (const name of keys) {
        if (Object.hasOwn(target, name)) {
          delete target[name];
          changed = true;
        }
      }
      return;
    }
    const [part, ...rest] = path;
    // The server caps its issue list at 20: an array item's schema applies to every row.
    if (typeof part === "number") {
      if (Array.isArray(target)) for (const item of target) remove(item, rest, keys);
    } else if (object(target) && Object.hasOwn(target, part)) remove(target[part], rest, keys);
  }
  for (const issue of issues) remove(copy, issue.path, issue.keys);
  return changed ? copy : null;
}

/** Bounded progress retries let later errors surface behind the server's 20-issue cap. */
export async function putSnapshot(put, snapshot, legacyFallback) {
  let payload = snapshot;
  let legacyUsed = false;
  for (let attempt = 0; ; attempt++) {
    const response = await put(payload);
    if (response.status !== 400 || attempt === 4) return response;
    const detail = await response.json().catch(() => null);
    const hasIssues = object(detail) && Object.hasOwn(detail, "issues");
    let compatible;
    if (hasIssues) compatible = snapshotWithoutRejectedKeys(payload, detail.issues);
    else if (!legacyUsed && legacyFallback) {
      legacyUsed = true;
      compatible = legacyFallback(payload);
    }
    if (!compatible) return response;
    payload = compatible;
  }
}

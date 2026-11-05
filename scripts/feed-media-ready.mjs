/** Browser-side check: fixture generation precedes the media decoder's loading budget. */
export async function unloaded(id) {
  // The preview initially points at missing /media/ files, then swaps in drawn blobs.
  // Recording a clip is setup work, not a failed load of the final media source.
  await window.previewMediaDrawn();
  const media = [...document.querySelectorAll(`[data-need="${id}"] :is(img, video)`)];
  const ready = (el) => (el.tagName === "IMG" ? el.complete && el.naturalWidth > 0 : el.readyState >= 1);
  for (let waited = 0; waited < 15_000 && !media.every(ready); waited += 100) await new Promise((done) => setTimeout(done, 100));
  return media.length ? media.filter((el) => !ready(el)).map((el) => el.tagName.toLowerCase()) : ["no img or video"];
}

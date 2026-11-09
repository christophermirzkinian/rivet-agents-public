import "./command.css";

import type { AudioClip, CardFile, Media, MediaRef } from "../../../src/shared/board.js";
import { FULL_SCREEN_EVENTS, fullScreenElement, h, svg } from "../dom.js";
import { autoplay, unwatch, type AutoPlayer } from "./autoplay.js";
import { fetchDocument, fileSize, openDocument, previewKind } from "./documents.js";
import { openImages } from "./lightbox.js";

// Before/after clips on a feed card: side by side on a wide screen, one at a time
// with a Before/After toggle on a phone. A clip is as wide as the card, in its own
// shape (read from the video once it loads), and no taller than 70% of the screen;
// the clip showing sets the block's width.
// Both play inline and in step from one Play button and one scrubber; a tap on a
// clip plays it there with sound (or pauses it), never full screen; the Full screen button opens
// the one showing full screen.
// They play muted on their own while on screen (autoplay.ts) until the owner pauses them;
// Play turns the sound on and the speaker button toggles it. Only the clip
// showing (After when both do) is ever heard, so a pair never plays twice over.
// Sound clips (a voice to pick, say) each get a player of their own, one playing at a
// time. Screenshots sit under the clips in a strip that scrolls sideways; a tap opens
// one full screen to zoom into, as does a tap on a before or after image. Documents come
// last, one big Open button each; the full-screen viewer has Download and Share. The card's one Share sends its
// files. The block is
// kept per card and reused across feed renders so a poll never restarts a clip.

const cache = new Map<string, HTMLElement>();
/** Each cached block's signal, aborted when the block leaves the cache, so a download still coming is dropped. */
const aborts = new WeakMap<HTMLElement, AbortController>();

const SPEAKER = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>';
const SOUND_ON = `<svg viewBox="0 0 24 24">${SPEAKER}<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const SOUND_OFF = `<svg viewBox="0 0 24 24">${SPEAKER}<path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const FULL = '<svg viewBox="0 0 24 24"><path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z" fill="currentColor"/></svg>';
const DOC =
  '<svg viewBox="0 0 24 24"><path d="M6.5 2.5h7.5l5 5v13a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 2.5V8H19M8.5 13h7M8.5 17h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const url = (ref: { sha256: string }) => `/media/${ref.sha256}`;

const EXTENSIONS: Record<MediaRef["type"] | AudioClip["type"], string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

/** A shared clip or picture's file name: the card's title, then which one it is, e.g. `banner-clip-after.mp4`. */
export function mediaName(title: string, part: string, ref: MediaRef | AudioClip): string {
  const slug = `${title}-${part}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return `${slug || "rivet"}.${EXTENSIONS[ref.type]}`;
}

/** A card's clip, picture or sound as a File to share, or what to tell the owner. */
const getMedia = (ref: MediaRef | AudioClip, name: string, signal: AbortSignal) => () => fetchDocument(url(ref), name, ref.type, signal);

/** Fired (bubbling) on a media block whose height may have changed after the feed laid out its card. */
export const MEDIA_RESIZED = "media-resized";
const OVERLAY_GAP = 8;
/** The corner's two 44 px buttons stacked, with their gaps and margins: a shorter clip lays them in a row. */
const CORNER_COLUMN = 2 * 44 + 3 * OVERLAY_GAP;

function clip(ref: MediaRef, poster: MediaRef | undefined, label: string): HTMLVideoElement | HTMLImageElement {
  if (ref.type.startsWith("image/")) return h("img", { class: "media-clip", attrs: { src: url(ref), alt: label, loading: "lazy", decoding: "async", "data-use": "media.player.image" } });
  const video = h("video", {
    class: "media-clip",
    attrs: { src: url(ref), preload: poster ? "none" : "metadata", "aria-label": label, "data-use": "media.player.clip", ...(poster ? { poster: url(poster) } : {}) },
  });
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  return video;
}

function build(media: Media, title: string): HTMLElement {
  const pairs: [string, MediaRef][] = [];
  if (media.before) pairs.push(["Before", media.before]);
  if (media.after) pairs.push(["After", media.after]);
  const clips = pairs.map(([label, ref]) => ({ label, element: clip(ref, media.poster, label) }));
  const videos = clips.map((c) => c.element).filter((e): e is HTMLVideoElement => e instanceof HTMLVideoElement);
  const lead = videos[0];

  const root = h("div", { class: `card-media${pairs.length === 2 ? " pair show-after" : ""}` });
  const controller = new AbortController();
  aborts.set(root, controller);
  const live = () => !controller.signal.aborted && root.isConnected;
  const figures = clips.map(({ label, element }) =>
    h("figure", { class: `media-pane ${label.toLowerCase()}` }, element, pairs.length === 2 ? h("figcaption", { class: "media-cap" }, label) : null),
  );
  const resized = () => root.dispatchEvent(new Event(MEDIA_RESIZED, { bubbles: true }));
  // Each clip keeps its own shape; the one showing (After while both do) sets the block's width.
  const ratios: (number | undefined)[] = clips.map(() => undefined);
  const applyRatio = () => {
    const ratio = ratios[root.classList.contains("show-before") ? 0 : clips.length - 1];
    // A clip whose shape is not known yet shows at 16:9, never its partner's shape.
    if (ratio) root.style.setProperty("--ratio", ratio.toFixed(4));
    else root.style.removeProperty("--ratio");
    resized();
  };
  const fit = (i: number, width: number, height: number) => {
    if (!(width > 0 && height > 0)) return;
    ratios[i] = width / height;
    figures[i]!.style.setProperty("--ratio", ratios[i]!.toFixed(4));
    applyRatio();
  };
  const sized = new Set<number>();
  clips.forEach(({ element }, i) => {
    if (element instanceof HTMLVideoElement) {
      element.addEventListener("loadedmetadata", () => {
        sized.add(i);
        fit(i, element.videoWidth, element.videoHeight);
      });
    } else {
      element.addEventListener("load", () => fit(i, element.naturalWidth, element.naturalHeight));
    }
  });
  // With a poster a clip loads nothing until Play, so the poster gives the shape until then.
  if (media.poster && videos.length) {
    const poster = new Image();
    poster.addEventListener("load", () => {
      clips.forEach(({ element }, i) => {
        if (element instanceof HTMLVideoElement && !sized.has(i)) fit(i, poster.naturalWidth, poster.naturalHeight);
      });
    });
    poster.src = url(media.poster);
  }
  clips.forEach(({ label, element }, i) => {
    const ref = pairs[i]![1];
    if (element instanceof HTMLImageElement) {
      element.addEventListener("click", () => openImages([url(ref)], 0, label, (_, signal) => getMedia(ref, mediaName(title, label, ref), signal)()));
    }
  });
  const panes = h("div", { class: "media-panes" }, ...figures);
  if (pairs.length) root.append(panes);
  const controls = h("div", { class: "media-controls" });
  let place: (() => void) | undefined;
  let select: ((which: "before" | "after") => void) | undefined;
  if (pairs.length === 2) {
    const show = (which: "before" | "after") => {
      if (root.classList.contains(`show-${which}`)) return;
      root.classList.toggle("show-after", which === "after");
      root.classList.toggle("show-before", which === "before");
      beforeBtn.setAttribute("aria-pressed", String(which === "before"));
      afterBtn.setAttribute("aria-pressed", String(which === "after"));
      applyRatio();
    };
    const beforeBtn = h("button", { class: "media-toggle", attrs: { type: "button", "aria-pressed": "false", "data-use": "media.player.before-after" }, on: { click: () => show("before") } }, "Before");
    const afterBtn = h("button", { class: "media-toggle", attrs: { type: "button", "aria-pressed": "true", "data-use": "media.player.before-after" }, on: { click: () => show("after") } }, "After");
    const toggles = h("div", { class: "media-toggles", attrs: { role: "group", "aria-label": "Show" } }, beforeBtn, afterBtn);
    panes.append(toggles);
    select = show;
    // Over the clip's top-left corner while it clears the corner buttons, so it is in reach however tall the clip
    // is; under the clip when it is too narrow for both, so neither takes the other's taps.
    place = () => {
      if (!panes.clientWidth) return;
      const corner = panes.querySelector<HTMLElement>(".media-corner");
      const fits = toggles.offsetWidth <= panes.clientWidth - (corner?.offsetWidth ?? 0) - 3 * OVERLAY_GAP;
      if (fits === (toggles.parentElement === panes)) return;
      if (fits) panes.insertBefore(toggles, corner);
      else panes.after(toggles);
      resized();
    };
  }
  if (lead) {
    const { play, scrub, speaker, auto, tap } = playControls(root, lead, videos);
    controls.append(play, scrub);
    // Both clips show on a wide screen: a tap picks the one tapped, so its sound follows it.
    for (const { label, element } of clips) {
      if (!(element instanceof HTMLVideoElement)) continue;
      element.addEventListener("click", () => {
        select?.(label === "Before" ? "before" : "after");
        tap(element);
      });
    }
    autoplay(panes, auto);
    // Over the clip's top-right corner, so they cost the card no height however tall the clip is.
    panes.append(h("div", { class: "media-corner" }, speaker, fullScreen(root, videos)));
  }
  if (lead || place) {
    new ResizeObserver(() => {
      if (lead && panes.clientHeight) root.classList.toggle("short-clip", panes.clientHeight < CORNER_COLUMN);
      place?.();
    }).observe(panes);
  }
  if (controls.childElementCount) root.append(controls);
  if (media.clips) root.append(audioList(media.clips));
  if (media.stills) root.append(stillStrip(media.stills, title));
  if (media.files) {
    root.append(h("div", { class: "media-files" }, ...media.files.map((file) => fileButtons(file, controller.signal, live))));
  }
  return root;
}

/**
 * A document on the card: Open shows it in the app's own viewer (PDFs, Markdown, text and JSON; any other type says
 * it can't be shown), whose Download and Share save or send it. In the installed iPhone app the session cookie lives
 * only in the app's own web view, and a document opened in it has no way back, so it is fetched here (share.ts).
 * Nothing is kept or opened once the card has gone (`live` false): a late download never lands on another screen.
 */
function fileButtons(file: CardFile, signal: AbortSignal, live: () => boolean): HTMLElement {
  const noun = file.type === "application/pdf" ? "PDF" : "file";
  const previewable = previewKind(file.type) !== null;
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toUpperCase();
  const openButton = h(
    "button",
    { class: `btn media-file${previewable ? "" : " no-preview"}`, attrs: { type: "button", "data-use": "media.player.file" } },
    svg(DOC, "media-icon media-file-icon"),
    h(
      "span",
      { class: "media-file-text" },
      h(
        "span",
        { class: "media-file-top" },
        h("span", { class: "media-file-action" }, previewable ? `Open ${extension}` : `Download ${extension}`),
        h("span", { class: "media-file-size" }, fileSize(file.bytes)),
      ),
      h("span", { class: "media-file-name" }, file.name),
    ),
  );
  let kept: File | null = null;
  const get = async (): Promise<File | string> => {
    if (kept) return kept;
    const got = await fetchDocument(url(file), file.name, file.type, signal);
    if (got instanceof File && live()) kept = got;
    return got;
  };
  if (previewable) openButton.addEventListener("click", () => live() && openDocument(file.name, file.type, get));
  // No preview here: the phone downloads it, so a spreadsheet or archive is still his to open.
  else openButton.addEventListener("click", () => live() && window.open(url(file), "_blank", "noopener"));
  return h("div", { class: "media-file-row" }, h("div", { class: "media-file-buttons" }, openButton));
}

function audioList(clips: AudioClip[]): HTMLElement {
  const players = clips.map((ref, i) => audioPlayer(ref, ref.label ?? `Clip ${i + 1}`));
  for (const { audio } of players) {
    audio.addEventListener("play", () => {
      for (const other of players) if (other.audio !== audio) other.audio.pause();
    });
  }
  return h("div", { class: "media-audio", attrs: { role: "group", "aria-label": "Sound clips" } }, ...players.map((player) => player.el));
}

const clock = (seconds: number) => (Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "0:00");

function audioPlayer(ref: AudioClip, label: string): { el: HTMLElement; audio: HTMLAudioElement } {
  const audio = h("audio", { attrs: { src: url(ref), preload: "metadata" } });
  const play = h("button", { class: "btn primary media-audio-play", attrs: { type: "button", "aria-label": `Play ${label}`, "data-use": "media.player.audio-play" } }, svg(PLAY, "media-icon"));
  const scrub = h("input", { class: "media-scrub", attrs: { type: "range", min: "0", max: "1000", value: "0", "aria-label": `${label} position`, "data-use": "media.player.scrub" } });
  const time = h("span", { class: "media-audio-time" }, "0:00");
  const setPlaying = (on: boolean) => {
    play.replaceChildren(svg(on ? PAUSE : PLAY, "media-icon"));
    play.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${label}`);
  };
  play.addEventListener("click", () => {
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  });
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("ended", () => setPlaying(false));
  audio.addEventListener("timeupdate", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) scrub.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    time.textContent = clock(audio.currentTime);
  });
  audio.addEventListener("loadedmetadata", () => (time.textContent = clock(audio.duration)));
  scrub.addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(scrub.value) / 1000) * audio.duration;
  });
  const el = h(
    "div",
    { class: "media-audio-row" },
    play,
    h("div", { class: "media-audio-main" }, h("span", { class: "media-audio-label" }, label), h("div", { class: "media-audio-track" }, scrub, time)),
    // The phone downloads the clip, so a sound Rivet sent can leave the card (Share carries it too).
    h("button", { class: "btn ghost media-audio-save", attrs: { type: "button", "aria-label": `Save ${label}`, "data-use": "media.player.audio-save" }, on: { click: () => window.open(url(ref), "_blank", "noopener") } }, "Save"),
    audio,
  );
  return { el, audio };
}

type FullScreenVideo = HTMLVideoElement & { webkitEnterFullscreen?(): void };

/** An icon and its word; on a phone only the icon shows. */
const iconLabel = (icon: string, word: string) => [svg(icon, "media-icon"), h("span", { class: "media-word" }, word)];

/** A clip in the browser's own full-screen player. */
function fullScreenVideo(video: FullScreenVideo): void {
  if (fullScreenElement() === video) return;
  // iPhone Safari has no element full screen, only its video player's.
  if (video.requestFullscreen) void video.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
  else video.webkitEnterFullscreen?.();
}

/** The clip showing (the After one of a phone pair unless Before is picked) in the browser's own full-screen player. */
function fullScreen(root: HTMLElement, videos: HTMLVideoElement[]): HTMLElement {
  return h(
    "button",
    {
      class: "btn media-full",
      attrs: { type: "button", "aria-label": "Full screen", "data-use": "media.player.fullscreen" },
      on: {
        click: () => {
          const video = root.classList.contains("show-before") ? videos[0] : videos.at(-1);
          if (video) fullScreenVideo(video);
        },
      },
    },
    svg(FULL, "media-icon"),
  );
}

function stillStrip(stills: MediaRef[], title: string): HTMLElement {
  return h(
    "div",
    { class: "media-stills", attrs: { "aria-label": `${stills.length} screenshot${stills.length === 1 ? "" : "s"}` } },
    ...stills.map((ref, i) =>
      h(
        "button",
        {
          class: "media-still",
          attrs: { type: "button", "aria-label": `Screenshot ${i + 1} of ${stills.length}, full screen`, "data-use": "media.player.still" },
          on: {
            click: () =>
              openImages(
                stills.map(url),
                i,
                undefined,
                (n, signal) => getMedia(stills[n]!, mediaName(title, `screenshot-${n + 1}`, stills[n]!), signal)(),
              ),
          },
        },
        h("img", { attrs: { src: url(ref), alt: "", loading: "lazy", decoding: "async" } }),
      ),
    ),
  );
}

/** One Play button and one scrubber driving every clip, kept within a quarter second of the first. */
function playControls(
  root: HTMLElement,
  lead: HTMLVideoElement,
  videos: HTMLVideoElement[],
): { play: HTMLElement; scrub: HTMLElement; speaker: HTMLElement; auto: AutoPlayer; tap(video: HTMLVideoElement): void } {
  const play = h("button", { class: "btn media-play", attrs: { type: "button", "aria-label": "Play", "data-use": "media.player.play" } }, ...iconLabel(PLAY, "Play"));
  const speaker = h("button", { class: "btn media-sound", attrs: { type: "button", "aria-pressed": "false", "data-use": "media.player.sound" } });
  let sound = false;
  const heard = () => (root.classList.contains("show-before") ? videos[0] : videos.at(-1));
  // Set inside the tap itself: iPhone Safari lets a clip unmute only from a user gesture.
  const setSound = (on: boolean) => {
    sound = on;
    const voiced = heard();
    for (const video of videos) video.muted = !(on && video === voiced);
    speaker.replaceChildren(svg(on ? SOUND_ON : SOUND_OFF, "media-icon"));
    speaker.setAttribute("aria-pressed", String(on));
    speaker.setAttribute("aria-label", on ? "Mute" : "Turn the sound on");
  };
  setSound(false);
  speaker.addEventListener("click", () => setSound(!sound));
  new MutationObserver(() => setSound(sound)).observe(root, { attributes: true, attributeFilter: ["class"] });
  const scrub = h("input", { class: "media-scrub", attrs: { type: "range", min: "0", max: "1000", value: "0", "aria-label": "Position", "data-use": "media.player.scrub" } });
  const setPlaying = (on: boolean) => {
    play.replaceChildren(...iconLabel(on ? PAUSE : PLAY, on ? "Pause" : "Play"));
    play.setAttribute("aria-label", on ? "Pause" : "Play");
  };
  const start = () => {
    for (const video of videos) {
      if (video !== lead) video.currentTime = lead.currentTime;
      void video.play().catch(() => {});
    }
    setPlaying(true);
  };
  const stop = () => {
    for (const video of videos) video.pause();
    setPlaying(false);
  };
  // Once the owner pauses, the clips wait for his Play instead of starting on their own again.
  let held = false;
  play.addEventListener("click", () => {
    held = !lead.paused;
    if (lead.paused) {
      setSound(true);
      start();
    } else {
      stop();
    }
  });
  scrub.addEventListener("input", () => {
    if (!Number.isFinite(lead.duration)) return;
    const at = (Number(scrub.value) / 1000) * lead.duration;
    for (const video of videos) video.currentTime = Math.min(at, Number.isFinite(video.duration) ? video.duration : at);
  });
  // One clip in full screen plays alone, so seeking it is never undone by the sync; the rest catch up when it exits.
  let solo: HTMLVideoElement | null = null;
  const onFullScreen = () => {
    const now = videos.find((video) => video === fullScreenElement()) ?? null;
    if (now === solo) return;
    const from = solo;
    solo = now;
    // The clip carries no controls inline (one Play drives the set); full screen needs its own.
    if (from) from.controls = false;
    if (now) {
      now.controls = true;
      for (const video of videos) if (video !== now) video.pause();
    } else if (from) {
      for (const video of videos) {
        if (video === from) continue;
        // Its own controls may have changed the speed; clips at different speeds would re-sync forever.
        video.playbackRate = from.playbackRate;
        video.currentTime = from.currentTime;
        if (!from.paused) void video.play().catch(() => {});
      }
      setPlaying(!from.paused);
      // A pause from full screen's own controls counts as the owner's pause, like the Play button's.
      held = from.paused;
    }
  };
  for (const video of videos) for (const type of FULL_SCREEN_EVENTS) video.addEventListener(type, onFullScreen);
  lead.addEventListener("timeupdate", () => {
    if (solo) return;
    if (Number.isFinite(lead.duration) && lead.duration > 0) scrub.value = String(Math.round((lead.currentTime / lead.duration) * 1000));
    for (const video of videos) {
      if (video !== lead && !lead.paused && Math.abs(video.currentTime - lead.currentTime) > 0.25) video.currentTime = lead.currentTime;
    }
  });

  const auto: AutoPlayer = {
    start(motion) {
      if (motion && !held && lead.paused) start();
    },
    // Off screen they stop and fall quiet, so they come back muted; a clip in full screen is left playing.
    stop() {
      if (solo || lead.paused) return;
      stop();
      setSound(false);
    },
  };

  // A tap on a clip: one playing aloud pauses; any other (silent, paused, or its partner the one heard) plays with
  // sound. Full screen's own controls take a tap there.
  const tap = (video: HTMLVideoElement) => {
    if (fullScreenElement() === video) return;
    if (!video.paused && !video.muted) {
      held = true;
      stop();
      return;
    }
    held = false;
    setSound(true);
    if (video.paused) start();
  };

  return { play, scrub, speaker, auto, tap };
}

/** The media block for a card, or null. Reused while the card's media is unchanged. */
export function cardMedia(needId: string, media: Media | undefined, title = ""): HTMLElement | null {
  if (!media) return null;
  const key = `${needId}\n${media.before?.sha256 ?? ""}\n${media.after?.sha256 ?? ""}\n${media.poster?.sha256 ?? ""}\n${(media.stills ?? []).map((ref) => ref.sha256).join(",")}\n${(media.clips ?? []).map((ref) => `${ref.sha256}:${ref.label ?? ""}`).join(",")}\n${(media.files ?? []).map((ref) => `${ref.sha256}:${ref.name}`).join(",")}`;
  let element = cache.get(key);
  if (!element) {
    element = build(media, title);
    cache.set(key, element);
  }
  return element;
}

/**
 * Silences every card no longer on screen and forgets it; `all` does the same to the ones on screen. A clip or voice
 * note plays on after its element leaves the page, so every feed render calls this once the new cards are in.
 */
export function stopCardMedia(all = false): void {
  for (const [key, block] of cache) {
    if (!all && block.isConnected) continue;
    for (const player of block.querySelectorAll<HTMLMediaElement>("video, audio")) player.pause();
    for (const watched of block.querySelectorAll(".media-panes")) unwatch(watched);
    aborts.get(block)?.abort();
    cache.delete(key);
  }
}

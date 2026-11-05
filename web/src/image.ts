// Photos and screenshots the owner attaches are redrawn on a canvas before upload:
// Safari decodes HEIC, so every photo leaves the phone as JPEG or PNG, at most
// MAX_EDGE px on its long edge and without its EXIF (location included).

import { within } from "./within.js";

export const MAX_EDGE = 2560;
/** A screenshot stays PNG, so its text stays sharp, unless that is bigger than this. */
const PNG_MAX_BYTES = 4 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

/** A decode or re-encode that has not finished by then fails the photo, so it never holds the upload queue. */
export const IMAGE_STEP_MS = 20_000;

export class ImageError extends Error {}

function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  const decoded = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageError("Couldn't read that image. Try a photo from the camera roll or a screenshot."));
    img.src = url;
  });
  return within(decoded, IMAGE_STEP_MS, "Reading that image took too long. Try again.").finally(() => URL.revokeObjectURL(url));
}

function encode(img: HTMLImageElement, width: number, height: number, type: "image/png" | "image/jpeg"): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new ImageError("This browser can't prepare images."));
  if (type === "image/jpeg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(img, 0, 0, width, height);
  return within(
    new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImageError("Couldn't prepare that image."))), type, JPEG_QUALITY),
    ),
    IMAGE_STEP_MS,
    "Preparing that image took too long. Try again.",
  );
}

/** The file as it will be uploaded: decoded, scaled down to MAX_EDGE and re-encoded. */
export async function prepareImage(file: Blob): Promise<Blob> {
  const img = await decode(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (!longest) throw new ImageError("Couldn't read that image. Try a photo from the camera roll or a screenshot.");
  const scale = Math.min(1, MAX_EDGE / longest);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  if (file.type === "image/png") {
    const png = await encode(img, width, height, "image/png");
    if (png.size <= PNG_MAX_BYTES) return png;
  }
  return encode(img, width, height, "image/jpeg");
}

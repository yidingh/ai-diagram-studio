import { byteLength } from "./contracts";
import { MAX_JSON_BYTES } from "./http";
import {
  inspectDataUrl,
  inspectImage,
  MAX_IMAGE_BYTES,
  MAX_CANVAS_SOURCE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_SOURCE_BYTES,
  type ImageInput,
} from "./images";

type VisualRequest = {
  prompt: string;
  xml: string;
  canvasImage: ImageInput;
  referenceImages: ImageInput[];
};
const budgetError = () =>
  new Error(
    "Images cannot fit the 4 MiB request with readable detail. Use smaller or fewer reference images.",
  );
function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

async function decode(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    throw new Error(
      "Could not decode image. Use a valid PNG, JPEG or WebP file.",
    );
  }
  return image;
}
/** PNG first preserves text; JPEG never goes below quality .8 or 75% of initial dimensions. */
async function encode(
  image: ImageInput,
  maxBytes: number,
  signal?: AbortSignal,
  maxSourceBytes = MAX_SOURCE_BYTES,
): Promise<ImageInput> {
  check(signal);
  inspectDataUrl(image.dataUrl, maxSourceBytes);
  const decoded = await decode(image.dataUrl);
  check(signal);
  const scale = Math.min(
    1,
    MAX_IMAGE_SIDE / Math.max(decoded.naturalWidth, decoded.naturalHeight),
  );
  if (scale === 1) {
    try {
      inspectDataUrl(image.dataUrl, maxBytes);
      return image;
    } catch {
      /* Re-encode to fit. */
    }
  }
  const canvas = document.createElement("canvas");
  try {
    for (const factor of [1, 0.875, 0.75]) {
      check(signal);
      canvas.width = Math.max(
        1,
        Math.floor(decoded.naturalWidth * scale * factor),
      );
      canvas.height = Math.max(
        1,
        Math.floor(decoded.naturalHeight * scale * factor),
      );
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Image processing is unavailable in this browser.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(decoded, 0, 0, canvas.width, canvas.height);
      for (const [mime, quality] of [
        ["image/png", 1],
        ["image/jpeg", 0.92],
        ["image/jpeg", 0.85],
        ["image/jpeg", 0.8],
      ] as const) {
        const dataUrl = canvas.toDataURL(mime, quality);
        try {
          inspectDataUrl(dataUrl, maxBytes);
          return { ...image, dataUrl };
        } catch {
          /* Try the next readable encoding. */
        }
      }
    }
  } finally {
    canvas.width = canvas.height = 0;
  }
  throw budgetError();
}
export async function prepareReference(file: File): Promise<ImageInput> {
  if (file.size > MAX_SOURCE_BYTES)
    throw new Error("Each reference must be at most 5 MiB.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Use PNG, JPEG or WebP reference images.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  inspectImage(bytes, file.type);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
  return encode(
    { name: file.name.slice(0, 200) || "reference", dataUrl },
    MAX_IMAGE_BYTES,
  );
}
export function blankCanvasImage(): ImageInput {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Image processing is unavailable in this browser.");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1, 1);
  return { name: "current-canvas.png", dataUrl: canvas.toDataURL("image/png") };
}
/** Fit actual UTF-8 JSON including XML escaping and base64; never omit an image. */
export async function fitProposal(
  request: VisualRequest,
  signal?: AbortSignal,
): Promise<string> {
  const originals = [request.canvasImage, ...request.referenceImages];
  // Reserve exact JSON envelope cost (including names) before allocating image bytes.
  const empty = {
    ...request,
    canvasImage: { ...request.canvasImage, dataUrl: "" },
    referenceImages: request.referenceImages.map((image) => ({
      ...image,
      dataUrl: "",
    })),
  };
  const available = MAX_JSON_BYTES - byteLength(JSON.stringify(empty));
  if (available < 1024 * originals.length) throw budgetError();
  let images: ImageInput[] = [];
  for (let index = 0; index < originals.length; index++)
    images.push(
      await encode(
        originals[index],
        MAX_IMAGE_BYTES,
        signal,
        index === 0 ? MAX_CANVAS_SOURCE_BYTES : MAX_SOURCE_BYTES,
      ),
    );
  const serialize = () =>
    JSON.stringify({
      ...request,
      canvasImage: images[0],
      referenceImages: images.slice(1),
    });
  let body = serialize();
  if (byteLength(body) <= MAX_JSON_BYTES) {
    check(signal);
    return body;
  }
  // Weighted allocation keeps small images small; large images share the remaining budget.
  const encoded = images;
  const total = images.reduce((sum, image) => sum + image.dataUrl.length, 0);
  const ratio = Math.min(0.95, (available / total) * 0.98);
  images = [];
  for (let index = 0; index < originals.length; index++) {
    const target = Math.min(
      MAX_IMAGE_BYTES,
      Math.floor(encoded[index].dataUrl.length * ratio * 0.75),
    );
    images.push(
      await encode(
        originals[index],
        Math.max(512, target),
        signal,
        index === 0 ? MAX_CANVAS_SOURCE_BYTES : MAX_SOURCE_BYTES,
      ),
    );
  }
  body = serialize();
  check(signal);
  if (byteLength(body) > MAX_JSON_BYTES) throw budgetError();
  return body;
}

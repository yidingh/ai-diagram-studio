import { z } from "zod";

export const MAX_REFERENCES = 10;
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_CANVAS_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGE_SIDE = 1600;
export const MAX_DECODED_SIDE = 16384;
export const MAX_DECODED_PIXELS = 16_000_000;
export type ImageInput = { name: string; dataUrl: string };
export type ImageInfo = { width: number; height: number; mime: string };

/** Inspect raster headers before browser allocation. No SVGs, URLs or arbitrary MIME labels. */
export function inspectImage(bytes: Uint8Array, mime: string): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  let width = 0,
    height = 0;
  if (
    mime === "image/png" &&
    bytes.length >= 33 &&
    bytes[0] === 137 &&
    ascii(1, 7) === "PNG\r\n\x1a\n" &&
    view.getUint32(8) === 13 &&
    ascii(12, 4) === "IHDR"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    mime === "image/jpeg" &&
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    mime === "image/webp" &&
    bytes.length >= 30 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WEBP" &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    const kind = ascii(12, 4);
    if (kind === "VP8X") {
      // Animated input is ambiguous visual context; use a still image.
      if (bytes[20] & 2)
        throw new Error("Use a still PNG, JPEG or WebP image.");
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (
      kind === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (kind === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  }
  if (!width || !height)
    throw new Error("Invalid image. Use a PNG, JPEG or WebP file.");
  if (
    width > MAX_DECODED_SIDE ||
    height > MAX_DECODED_SIDE ||
    width * height > MAX_DECODED_PIXELS
  )
    throw new Error(
      "Image dimensions are too large (maximum 16 million pixels and 16,384 per side).",
    );
  return { width, height, mime };
}

export function inspectDataUrl(
  dataUrl: string,
  maxBytes = MAX_IMAGE_BYTES,
): ImageInfo {
  if (dataUrl.length > Math.ceil(maxBytes / 3) * 4 + 32)
    throw new Error("Image exceeds its byte limit.");
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match || match[2].length % 4 !== 0)
    throw new Error("Invalid image data URL.");
  const binary = atob(match[2]);
  if (binary.length > maxBytes || btoa(binary) !== match[2])
    throw new Error("Invalid or oversized image encoding.");
  return inspectImage(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    match[1],
  );
}
export const imageInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  dataUrl: z
    .string()
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32)
    .superRefine((value, ctx) => {
      try {
        const info = inspectDataUrl(value);
        if (Math.max(info.width, info.height) > MAX_IMAGE_SIDE)
          throw new Error("Outgoing image exceeds 1,600 pixels.");
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "Invalid PNG, JPEG or WebP image (maximum 512 KiB and 1,600 pixels).",
        });
      }
    }),
});

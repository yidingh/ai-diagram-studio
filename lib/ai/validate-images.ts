import "server-only";
import sharp from "sharp";
import { AppError } from "../contracts";
import { MAX_IMAGE_SIDE, type ImageInput } from "../images";

/** Header validation bounds allocations; a bounded full decode catches truncated/corrupt rasters. */
export async function validateImagePixels(
  images: ImageInput[],
  signal: AbortSignal,
): Promise<void> {
  for (const image of images) {
    signal.throwIfAborted();
    try {
      const bytes = Buffer.from(
        image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
        "base64",
      );
      await sharp(bytes, {
        limitInputPixels: MAX_IMAGE_SIDE * MAX_IMAGE_SIDE,
        failOn: "warning",
        animated: false,
      })
        .resize(1, 1)
        .raw()
        .toBuffer();
    } catch {
      throw new AppError(
        "INVALID_REQUEST",
        "An image is malformed or cannot be decoded. Use a valid PNG, JPEG or WebP image.",
      );
    }
    signal.throwIfAborted();
  }
}

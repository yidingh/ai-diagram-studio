import { expect, it } from "vitest";
import {
  imageInputSchema,
  MAX_IMAGE_BYTES,
  MAX_REFERENCES,
} from "../lib/images";
import { proposalRequestSchema } from "../lib/proposal";
import { createEmptyDocument } from "../lib/diagram/document";
export const png = {
  name: "sample.png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
};
it("accepts ten references in addition to the canvas and rejects an eleventh", () => {
  const request = {
    prompt: "Change",
    xml: createEmptyDocument(),
    canvasImage: png,
    referenceImages: Array(MAX_REFERENCES).fill(png),
  };
  expect(proposalRequestSchema.safeParse(request).success).toBe(true);
  expect(
    proposalRequestSchema.safeParse({
      ...request,
      referenceImages: [...request.referenceImages, png],
    }).success,
  ).toBe(false);
});
it.each([
  "data:image/svg+xml;base64,PHN2Zy8+",
  "https://example.com/a.png",
  "data:image/png;base64,!!!!",
  "data:image/jpeg;base64,aGVsbG8=",
  "data:image/png;base64," + "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
])("rejects unsupported, malformed or oversized image", (dataUrl) => {
  expect(imageInputSchema.safeParse({ ...png, dataUrl }).success).toBe(false);
});
it("rejects oversized decoded dimensions before decoding", () => {
  const bytes = Buffer.from(png.dataUrl.split(",")[1], "base64");
  bytes.writeUInt32BE(100000, 16);
  expect(
    imageInputSchema.safeParse({
      ...png,
      dataUrl: "data:image/png;base64," + bytes.toString("base64"),
    }).success,
  ).toBe(false);
});

import { z } from "zod";
import { byteLength, errorCodeSchema } from "./contracts";
import { imageInputSchema, MAX_REFERENCES } from "./images";
import { MAX_XML_BYTES } from "./drawio/limits";
const xml = z
  .string()
  .min(1)
  .refine((value) => byteLength(value) <= MAX_XML_BYTES);
export const proposalRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4000),
  xml,
  canvasImage: imageInputSchema,
  referenceImages: z.array(imageInputSchema).max(MAX_REFERENCES),
});
export const proposalResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal("proposal"),
    xml,
    summary: z.array(z.string().max(12000)).max(50),
    requestId: z.string().max(128),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal("clarification"),
    message: z.string().min(1).max(2000),
    requestId: z.string().max(128),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    kind: z.literal("error"),
    code: errorCodeSchema,
    message: z.string().max(512),
    requestId: z.string().max(128),
  }),
]);
export type ProposalResult = z.infer<typeof proposalResultSchema>;
export type Candidate = {
  xml: string;
  baseXml: string;
  summary: string[];
  requestId: string;
};

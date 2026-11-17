import { z } from "zod";
const id = z.string().min(1).max(256);
const geometry = z.strictObject({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().nonnegative().optional(),
  height: z.number().finite().nonnegative().optional(),
});
export const changeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("updateCell"),
    cellId: id,
    label: z.string().max(4000).optional(),
    style: z.record(z.string(), z.string().max(4000).nullable()).optional(),
    geometry: geometry.optional(),
  }),
  z.strictObject({
    type: z.literal("addCell"),
    xml: z
      .string()
      .min(1)
      .max(128 * 1024),
    beforeId: id.optional(),
  }),
  z.strictObject({
    type: z.literal("replaceCell"),
    cellId: id,
    xml: z
      .string()
      .min(1)
      .max(128 * 1024),
    beforeId: id.optional(),
  }),
  z.strictObject({ type: z.literal("removeCell"), cellId: id }),
]);
export const changesSchema = z.array(changeSchema).min(1).max(50);
export type Change = z.infer<typeof changeSchema>;

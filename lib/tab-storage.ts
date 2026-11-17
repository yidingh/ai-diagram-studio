import { z } from "zod";
import { validateDocument } from "./diagram/document";
const recoveryKey = "diagram-studio:recovery";
const apiKey = "diagram-studio:key";
const recoverySchema = z.strictObject({
  version: z.literal(1),
  current: z
    .string()
    .min(1)
    .max(512 * 1024),
  backup: z
    .string()
    .min(1)
    .max(512 * 1024)
    .nullable(),
  undo: z
    .strictObject({
      before: z
        .string()
        .min(1)
        .max(512 * 1024),
      after: z
        .string()
        .min(1)
        .max(512 * 1024),
    })
    .nullable(),
});
export type Recovery = z.infer<typeof recoverySchema>;
export function readRecovery(storage: Storage): Recovery | null {
  const value = storage.getItem(recoveryKey);
  if (value === null) return null;
  if (value.length > 4 * 1024 * 1024)
    throw new Error("Saved draft is too large.");
  const record = recoverySchema.parse(JSON.parse(value));
  for (const xml of [
    record.current,
    record.backup,
    record.undo?.before,
    record.undo?.after,
  ]) {
    if (xml !== null && xml !== undefined) validateDocument(xml);
  }
  return record;
}
export function writeRecovery(storage: Storage, record: Recovery): void {
  storage.setItem(recoveryKey, JSON.stringify(record));
}
export function readKey(storage: Storage): string {
  return storage.getItem(apiKey) ?? "";
}
export function saveKey(storage: Storage, key: string): void {
  if (key) storage.setItem(apiKey, key);
  else storage.removeItem(apiKey);
}

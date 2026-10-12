import { z } from 'zod';
import { MAX_FRAGMENT_BYTES, MAX_MODEL_ENVELOPE_BYTES, MAX_PROMPT_CHARS, MAX_XML_BYTES } from './drawio/limits';

export const errorCodeSchema = z.enum(['INVALID_REQUEST','LIMIT_EXCEEDED','CONFIG_MISSING','PROVIDER_ERROR','PROVIDER_REFUSAL','EMPTY_OUTPUT','TRUNCATED_OUTPUT','INVALID_MODEL_OUTPUT','INVALID_XML','TIMEOUT','CANCELED','UNSUPPORTED_DOCUMENT','INVALID_OPERATION','STALE_DOCUMENT']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
/** Carries an application error code and message that may be returned to the browser. */
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'AppError'; }
}
export const byteLength = (value: string) => new TextEncoder().encode(value).length;
export const generateRequestSchema = z.strictObject({prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS)});
export const modelEnvelopeSchema = z.strictObject({xml: z.string()});
// The ok field selects the success or failure shape at runtime and narrows its inferred TypeScript type.
export const generateResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ok:z.literal(true), xml:z.string().min(1).refine(x=>byteLength(x)<=MAX_XML_BYTES), requestId:z.string().min(1).max(128), durationMs:z.number().finite().nonnegative()}),
  z.strictObject({ok:z.literal(false), code:errorCodeSchema, message:z.string().max(512), requestId:z.string().min(1).max(128)}),
]);
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type GenerateResult = z.infer<typeof generateResultSchema>;
/** Accepts only bounded JSON containing an XML string; rejects empty/malformed output without repairing it. */
export function parseModelEnvelope(text: string): {xml:string} {
  if (!text.trim()) throw new AppError('EMPTY_OUTPUT','The model returned no diagram. Retry generation.');
  if (byteLength(text)>MAX_MODEL_ENVELOPE_BYTES) throw new AppError('LIMIT_EXCEEDED','Model response exceeds the size limit. Try a smaller diagram.');
  let value: unknown;
  try { value=JSON.parse(text); } catch { throw new AppError('INVALID_MODEL_OUTPUT','The model did not return the required JSON object. Retry generation.'); }
  const parsed=modelEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_MODEL_OUTPUT','The model response must contain only an xml string. Retry generation.');
  if (!parsed.data.xml.trim()) throw new AppError('EMPTY_OUTPUT','The model returned an empty diagram. Retry generation.');
  if (byteLength(parsed.data.xml)>MAX_FRAGMENT_BYTES) throw new AppError('LIMIT_EXCEEDED','Generated XML exceeds the fragment size limit. Try a smaller diagram.');
  return parsed.data;
}
/** Preserves application errors and hides unknown failures behind a generic provider error. */
export function safeError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError('PROVIDER_ERROR','Generation failed. Check server configuration or retry.');
}

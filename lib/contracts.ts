import { z } from "zod";

export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "LIMIT_EXCEEDED",
  "CONFIG_MISSING",
  "PROVIDER_ERROR",
  "PROVIDER_REFUSAL",
  "EMPTY_OUTPUT",
  "TRUNCATED_OUTPUT",
  "INVALID_MODEL_OUTPUT",
  "INVALID_XML",
  "TIMEOUT",
  "CANCELED",
  "UNSUPPORTED_DOCUMENT",
  "INVALID_OPERATION",
  "STALE_DOCUMENT",
  "INVALID_CREDENTIALS",
  "RATE_LIMITED",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
/** Carries an application error code and message that may be returned to the browser. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const byteLength = (value: string) =>
  new TextEncoder().encode(value).length;
/** Preserves application errors and hides unknown failures behind a generic provider error. */
export function safeError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        "PROVIDER_ERROR",
        "Unable to propose changes. Please retry.",
      );
}

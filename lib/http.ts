import { AppError } from "./contracts";

export const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Count actual UTF-8 bytes, even when Content-Length is missing or incorrect. */
export async function readJson(
  message: Request | Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (Number(message.headers.get("content-length")) > MAX_JSON_BYTES) {
    throw new AppError("LIMIT_EXCEEDED", "Request or response exceeds 4 MiB.");
  }
  if (!message.body)
    throw new AppError("INVALID_REQUEST", "Missing JSON body.");
  const reader = message.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw new AppError("CANCELED", "Request canceled.");
      const chunk = await reader.read();
      if (signal.aborted) throw new AppError("CANCELED", "Request canceled.");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_JSON_BYTES) {
        cancel();
        throw new AppError(
          "LIMIT_EXCEEDED",
          "Request or response exceeds 4 MiB.",
        );
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new AppError("INVALID_REQUEST", "Invalid UTF-8 body.");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new AppError("INVALID_REQUEST", "Invalid UTF-8 body.");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError("INVALID_REQUEST", "Invalid JSON body.");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

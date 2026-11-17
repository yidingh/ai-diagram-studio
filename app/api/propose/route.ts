import "server-only";
import { AppError, safeError } from "../../../lib/contracts";
import { readJson } from "../../../lib/http";
import {
  proposalRequestSchema,
  proposalResultSchema,
  type ProposalResult,
} from "../../../lib/proposal";
import { validateImagePixels } from "../../../lib/ai/validate-images";
import { askForChanges } from "../../../lib/ai/propose";
import { applyChanges } from "../../../lib/diagram/changes";
import { validateDocument } from "../../../lib/diagram/document";

export const runtime = "nodejs";
export const maxDuration = 50;

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const controller = new AbortController();
  let stopReason: AppError | undefined;
  let rejectStop!: (error: AppError) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  function stop(error: AppError) {
    if (stopReason) return;
    stopReason = error;
    rejectStop(error);
    controller.abort();
  }
  function checkDeadline() {
    if (Date.now() - started >= 45_000)
      stop(
        new AppError(
          "TIMEOUT",
          "AI took longer than 45 seconds. Try a smaller change.",
        ),
      );
    if (stopReason) throw stopReason;
  }
  const cancel = () => stop(new AppError("CANCELED", "Request canceled."));
  const timer = setTimeout(
    () =>
      stop(
        new AppError(
          "TIMEOUT",
          "AI took longer than 45 seconds. Try a smaller change.",
        ),
      ),
    45_000,
  );
  request.signal.addEventListener("abort", cancel, { once: true });
  let result: ProposalResult;
  let status = 200;
  try {
    const work = async (): Promise<ProposalResult> => {
      if (request.signal.aborted) cancel();
      const origin = request.headers.get("origin");
      const requestUrl = new URL(request.url);
      // Next.js can normalize request.url to localhost in development.
      // Host retains the browser-facing authority, including its port.
      const host = request.headers.get("host") ?? requestUrl.host;
      const expectedOrigin = `${requestUrl.protocol}//${host}`;
      if (origin && origin !== expectedOrigin) {
        status = 403;
        throw new AppError(
          "INVALID_REQUEST",
          "Cross-origin requests are not accepted.",
        );
      }
      const authorization = request.headers.get("authorization") ?? "";
      const key = authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";
      if (!key || key.length > 512 || /[\s\x00-\x1f]/.test(key))
        throw new AppError(
          "INVALID_CREDENTIALS",
          "Add your OpenAI API key to use AI.",
        );
      const input = proposalRequestSchema.safeParse(
        await readJson(request, controller.signal),
      );
      if (!input.success)
        throw new AppError(
          "INVALID_REQUEST",
          "Send a prompt (1–4,000 characters), XML (up to 512 KiB), a canvas image and up to 10 PNG/JPEG/WebP references (512 KiB and 1,600 pixels each).",
        );
      validateDocument(input.data.xml);
      await validateImagePixels(
        [input.data.canvasImage, ...input.data.referenceImages],
        controller.signal,
      );
      checkDeadline();
      const answer = await askForChanges(
        input.data.prompt,
        input.data.xml,
        key,
        controller.signal,
        input.data.canvasImage,
        input.data.referenceImages,
      );
      checkDeadline();
      const common = {
        ok: true as const,
        requestId,
        durationMs: Date.now() - started,
      };
      if (answer.kind === "clarification") {
        if (!answer.message.trim() || answer.changes.length)
          throw new AppError(
            "INVALID_MODEL_OUTPUT",
            "Invalid clarification response.",
          );
        return { ...common, kind: "clarification", message: answer.message };
      }
      const candidate = applyChanges(input.data.xml, answer.changes);
      checkDeadline();
      common.durationMs = Date.now() - started;
      if (!candidate.summary.length)
        return {
          ...common,
          kind: "clarification",
          message: "The requested change does not alter the diagram.",
        };
      return { ...common, kind: "proposal", ...candidate };
    };
    result = proposalResultSchema.parse(await Promise.race([work(), stopped]));
  } catch (error) {
    const failure = stopReason ?? safeError(error);
    result = {
      ok: false,
      kind: "error",
      code: failure.code,
      message: failure.message,
      requestId,
    };
    if (status !== 403)
      status =
        (
          {
            INVALID_REQUEST: 400,
            INVALID_CREDENTIALS: 401,
            RATE_LIMITED: 429,
            LIMIT_EXCEEDED: 413,
            INVALID_XML: 422,
            UNSUPPORTED_DOCUMENT: 422,
            INVALID_OPERATION: 422,
            TIMEOUT: 504,
            CANCELED: 499,
          } as Record<string, number>
        )[failure.code] ?? 502;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  }
  console.info("proposal", {
    requestId,
    code: result.ok ? "OK" : result.code,
    durationMs: Date.now() - started,
  });
  return Response.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

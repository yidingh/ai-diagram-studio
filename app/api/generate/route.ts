import 'server-only';
import OpenAI from 'openai';
import { AppError, type ErrorCode } from '../../../lib/contracts';
import { CREATION_PROMPT, generate } from '../../../lib/ai/generate';
import { MAX_GENERATE_BODY_BYTES, MAX_OUTPUT_TOKENS, SERVER_DEADLINE_MS } from '../../../lib/drawio/limits';

export const runtime = 'nodejs';
export const maxDuration = 50;

/** Reads bounded request bytes into JSON, canceling the body reader on abort and rejecting invalid input. */
async function readInput(request: Request, signal: AbortSignal): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_GENERATE_BODY_BYTES) throw new AppError('LIMIT_EXCEEDED', 'Request body exceeds 32 KiB. Shorten the prompt.');
  if (!request.body) throw new AppError('INVALID_REQUEST', 'Send a JSON object with a prompt.');
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true});
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (signal.aborted) throw new AppError('CANCELED', 'Request canceled.');
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new AppError('CANCELED', 'Request canceled.');
      if (chunk.done) break;
      // Enforce the actual byte count even when Content-Length is missing or understates the body.
      size += chunk.value.byteLength;
      if (size > MAX_GENERATE_BODY_BYTES) { cancel(); throw new AppError('LIMIT_EXCEEDED', 'Request body exceeds 32 KiB. Shorten the prompt.'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { throw new AppError('INVALID_REQUEST', 'Send valid UTF-8 JSON with a prompt.'); }
  } finally { signal.removeEventListener('abort',cancel); reader.releaseLock(); }
}
const statusFor = (code: ErrorCode): number => ({INVALID_REQUEST:400,LIMIT_EXCEEDED:413,CONFIG_MISSING:503,INVALID_XML:422,UNSUPPORTED_DOCUMENT:422,INVALID_OPERATION:422,STALE_DOCUMENT:409,TIMEOUT:504,CANCELED:499}[code as string] ?? 502);

/** Next.js POST handler: supplies server credentials and the SDK adapter, then returns a no-store result. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  // Only this server adapter reads credentials; the browser receives the shared result contract.
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const result = await generate({
    requestId, configured:!!apiKey, signal:request.signal,
    readInput: signal => readInput(request,signal),
    call: async (prompt,signal) => {
      // Disable SDK retries so the orchestration budget covers one provider attempt.
      const client = new OpenAI({apiKey, maxRetries:0, timeout:SERVER_DEADLINE_MS, logLevel:'off'});
      let response;
      try {
        response = await client.responses.create({
          model:'gpt-6-luna', instructions:CREATION_PROMPT, input:prompt,
          reasoning:{effort:'low'}, max_output_tokens:MAX_OUTPUT_TOKENS,
          stream:false, store:false,
          // Structured output constrains JSON shape; the shared pipeline still validates its XML.
          text:{format:{type:'json_schema',name:'diagram_fragments',strict:true,schema:{type:'object',properties:{xml:{type:'string'}},required:['xml'],additionalProperties:false}}},
        }, {signal, maxRetries:0, timeout:SERVER_DEADLINE_MS});
      } catch { throw new AppError('PROVIDER_ERROR', 'The model provider failed. Retry explicitly or check server configuration.'); }
      if (response.output?.some(item => item.type==='message' && item.content.some(part=>part.type==='refusal')) || response.incomplete_details?.reason==='content_filter')
        throw new AppError('PROVIDER_REFUSAL', 'The provider declined this request. Revise the prompt.');
      if (response.incomplete_details?.reason==='max_output_tokens') throw new AppError('TRUNCATED_OUTPUT', 'The model reached its output limit. Request a smaller diagram.');
      if (response.status!=='completed') throw new AppError('PROVIDER_ERROR', 'The provider did not complete the response. Retry explicitly.');
      // SDK types do not validate upstream JSON at runtime. Never log opaque fields.
      const inputTokens = response.usage?.input_tokens;
      const outputTokens = response.usage?.output_tokens;
      const usage = typeof inputTokens==='number' && Number.isSafeInteger(inputTokens) && inputTokens>=0 &&
        typeof outputTokens==='number' && Number.isSafeInteger(outputTokens) && outputTokens>=0
        ? {inputTokens,outputTokens} : undefined;
      return {text:response.output_text ?? '', ...(usage?{usage}:{})};
    },
    log: entry => console.info('generation',entry),
  });
  return Response.json(result,{status:result.ok?200:statusFor(result.code),headers:{'Cache-Control':'no-store'}});
}

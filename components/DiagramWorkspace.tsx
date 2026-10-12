'use client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import DrawioEditor, { type EditorHandle } from './DrawioEditor';
import { documentReducer, initialDocumentState, type Capture } from '../lib/document-state';
import { AppError, generateResultSchema, type ErrorCode } from '../lib/contracts';
import { validateGeneratedDocument } from '../lib/diagram/xml';
import { downloadXml } from '../lib/drawio/download';
import { BROWSER_DEADLINE_MS, MAX_GENERATE_RESPONSE_BYTES, MAX_PROMPT_CHARS } from '../lib/drawio/limits';

type ReplacementReason = 'apply' | 'restore' | 'fixture';
type Attempt = {
  id: string;
  prompt: string;
  controller: AbortController;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};
const actions: Partial<Record<ErrorCode, string>> = {
  CONFIG_MISSING: 'Configure OPENAI_API_KEY on the server, then retry.',
  INVALID_REQUEST: 'Enter a prompt of 1–4,000 characters.',
  LIMIT_EXCEEDED: 'The response exceeded a size limit. Request a smaller diagram.',
  PROVIDER_REFUSAL: 'The provider declined the request. Revise your prompt.',
  TRUNCATED_OUTPUT: 'The model reached its output limit. Request a smaller diagram.',
  TIMEOUT: 'Generation timed out. Retry explicitly or simplify the prompt.',
  CANCELED: 'Generation canceled. You can generate again.',
};

/** Reads bounded UTF-8 JSON as unknown: TypeScript cannot guarantee what arrived over HTTP.
 * Canceling the reader also lets Cancel/timeout interrupt a response whose body is still arriving. */
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_GENERATE_RESPONSE_BYTES) {
    throw new AppError('LIMIT_EXCEEDED', 'Response too large.');
  }
  if (!response.body) throw new AppError('INVALID_MODEL_OUTPUT', 'Missing response body.');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    if (signal.aborted) throw new AppError('CANCELED', 'Canceled.');
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new AppError('CANCELED', 'Canceled.');
      if (chunk.done) break;
      // Content-Length may be absent or inaccurate, so also count the actual bytes.
      size += chunk.value.byteLength;
      if (size > MAX_GENERATE_RESPONSE_BYTES) {
        cancel();
        throw new AppError('LIMIT_EXCEEDED', 'Response too large.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new AppError('INVALID_MODEL_OUTPUT', 'Invalid JSON response.'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Coordinates generation and history; the child editor owns live XML and protected replacement. */
export default function DiagramWorkspace({ initialXml, demoXml }: { initialXml: string; demoXml?: string }) {
  const [documents, dispatch] = useReducer(documentReducer, initialDocumentState);
  const editor = useRef<EditorHandle>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  // Refs update immediately; React state drives the next render. Both roles are needed here.
  const replacing = useRef(false);
  const active = useRef<Attempt | null>(null);
  const capture = useCallback((value: Capture) => dispatch({ type: 'capture', capture: value }), []);

  // This cleanup belongs to the workspace lifetime, independently of any iframe retries.
  useEffect(() => () => {
    const attempt = active.current;
    active.current = null; // Invalidate before abort; old promise cleanup owns nothing now.
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
    }
  }, []);

  /** Invalidates an attempt before aborting it; Retry remembers the submitted prompt, not later edits. */
  function stop(attempt: Attempt, message: string) {
    if (active.current !== attempt) return;
    active.current = null;
    clearTimeout(attempt.timer);
    setPending(false);
    setRetryPrompt(attempt.prompt);
    setError(`${message} Request: ${attempt.id} (browser attempt)`);
    attempt.controller.abort();
  }

  /** Rejects old or expired work, including when the event loop has not run the timeout callback yet. */
  function isCurrent(attempt: Attempt): boolean {
    if (active.current !== attempt) return false;
    if (Date.now() >= attempt.deadline) {
      stop(attempt, 'Generation exceeded 50 seconds. Retry explicitly or simplify the prompt.');
      return false;
    }
    return true;
  }

  /** Requests and validates a candidate; this function never loads the live editor. */
  async function generate(submitted = prompt) {
    if (active.current || documents.candidate || replacing.current) return;
    const submittedPrompt = submitted.trim();
    if (!submittedPrompt || submittedPrompt.length > MAX_PROMPT_CHARS) return;
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      prompt: submittedPrompt,
      controller: new AbortController(),
      deadline: Date.now() + BROWSER_DEADLINE_MS,
    };
    active.current = attempt; // Same-tick duplicate clicks see this before the next render.
    attempt.timer = setTimeout(
      () => stop(attempt, 'Generation exceeded 50 seconds. Retry explicitly or simplify the prompt.'),
      BROWSER_DEADLINE_MS,
    );
    setPending(true);
    setError('');
    setRetryPrompt(null);
    let requestId = attempt.id;
    let serverIdentity = false;
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: attempt.prompt }),
        signal: attempt.controller.signal,
      });
      if (!isCurrent(attempt)) return;
      const raw = await readResponse(response, attempt.controller.signal);
      if (!isCurrent(attempt)) return;
      const parsed = generateResultSchema.safeParse(raw);
      if (!parsed.success) throw new AppError('INVALID_MODEL_OUTPUT', 'Invalid response contract.');
      const result = parsed.data;
      requestId = result.requestId;
      serverIdentity = true;
      if (!result.ok) throw new AppError(result.code, 'Generation failed.');
      if (!response.ok) throw new AppError('PROVIDER_ERROR', 'Unexpected HTTP response.');
      const counts = validateGeneratedDocument(result.xml);
      if (!isCurrent(attempt)) return;
      // Counts are derived once from accepted XML; renders do not need to parse the candidate again.
      dispatch({ type: 'candidate', candidate: { xml: result.xml, requestId, ...counts } });
    } catch (failure) {
      if (!isCurrent(attempt)) return;
      const code = failure instanceof AppError ? failure.code : 'PROVIDER_ERROR';
      const guidance = actions[code] ?? 'Generation failed validation or the provider was unavailable. Retry explicitly or revise the prompt.';
      setError(`${guidance} Request: ${requestId}${serverIdentity ? '' : ' (browser attempt)'}`);
      setRetryPrompt(attempt.prompt);
    } finally {
      // An old finally must not clear a newer attempt, even if the old fetch ignored abort.
      if (active.current === attempt) {
        active.current = null;
        clearTimeout(attempt.timer);
        attempt.controller.abort();
        setPending(false);
      }
    }
  }

  /** Commits verified captures together; the reason determines validation and candidate consumption. */
  async function replace(xml: string, reason: ReplacementReason) {
    if (replacing.current || active.current || !editorReady || !editor.current) return;
    replacing.current = true;
    dispatch({ type: 'begin' });
    setError('');
    try {
      const result = await editor.current.replace({
        xml,
        validation: reason === 'restore' ? 'preserved' : 'generated',
      });
      dispatch({ type: 'replaced', ...result, appliedCandidate: reason === 'apply' });
    } catch {
      dispatch({ type: 'failed' });
      setError('Replacement failed. Retained XML is available below; use Retry editor if unavailable.');
    } finally {
      replacing.current = false;
    }
  }

  const { candidate, previous, applying } = documents;
  return <>
    <label htmlFor="diagram-prompt">Describe the diagram</label>
    <textarea id="diagram-prompt" value={prompt} maxLength={MAX_PROMPT_CHARS}
      onChange={event => setPrompt(event.target.value)} disabled={pending || applying} />
    <div className="actions">
      <button onClick={() => void generate()} disabled={pending || applying || !!candidate || !prompt.trim()}>Generate</button>
      {pending && <button onClick={() => {
        if (active.current) stop(active.current, 'Generation canceled. You can generate again.');
      }}>Cancel</button>}
      {retryPrompt !== null && !pending && !candidate &&
        <button disabled={applying} onClick={() => void generate(retryPrompt)}>Retry generation</button>}
    </div>
    {pending && <p>Generating a candidate. You can keep editing.</p>}
    {error && <p role="alert">{error}</p>}
    {candidate && <section aria-label="Candidate">
      <p>Candidate: {candidate.nodeCount} nodes, {candidate.edgeCount} edges. Request: {candidate.requestId}</p>
      <div className="actions">
        <button disabled={!editorReady || applying} onClick={() => void replace(candidate.xml, 'apply')}>
          Apply new diagram — replaces the current diagram; previous version can be restored
        </button>
        <button disabled={applying} onClick={() => dispatch({ type: 'discard' })}>Discard</button>
        <button onClick={() => downloadXml(candidate.xml, 'candidate.drawio')}>Download candidate</button>
      </div>
    </section>}
    {previous && <div className="actions">
      <button disabled={!editorReady || applying || pending} onClick={() => void replace(previous.xml, 'restore')}>Restore previous</button>
      <button onClick={() => downloadXml(previous.xml, 'previous.drawio')}>Download previous ({previous.capturedAt})</button>
    </div>}
    {demoXml && <button disabled={!editorReady || pending || applying || !!candidate}
      onClick={() => void replace(demoXml, 'fixture')}>Load development fixture (replaces current)</button>}
    <DrawioEditor ref={editor} initialXml={initialXml} startupLabel="empty document" onCapture={capture} onAvailable={setEditorReady} />
    <small>Memory only: refreshing this page clears current, previous, and candidate captures. Download to retain work.</small>
  </>;
}

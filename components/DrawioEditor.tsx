"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { EditorBridge } from "../lib/drawio/bridge";
import { assertReloadMatches, inspectSnapshot } from "../lib/drawio/snapshot";
import { downloadXml } from "../lib/drawio/download";
import { inspectEditorDocument, validateGeneratedDocument } from "../lib/diagram/xml";
import type { Capture } from "../lib/document-state";

type ReplacementTarget = { xml: string; validation: "generated" | "preserved" };
type ReplacementResult = { outgoing: Capture; current: Capture };
/** The parent gets a command, not access to iframe internals. Failure rejects with its cause. */
export type EditorHandle = { replace: (target: ReplacementTarget) => Promise<ReplacementResult> };
type Props = {
  initialXml: string;
  ref?: Ref<EditorHandle>;
  onCapture?: (capture: Capture) => void;
  onAvailable?: (available: boolean) => void;
  startupLabel?: string;
};
type EditorPhase = "starting" | "ready" | "capturing" | "replacing" | "unavailable";

/** Holds recovery XML across iframe retries. A full page refresh still clears this memory. */
export default function DrawioEditor({ initialXml, ref, onCapture, onAvailable, startupLabel = "startup fixture" }: Props) {
  const saved = useRef<Capture | null>(null);
  // Stable identity prevents unrelated parent renders from restarting the editor effect.
  const remember = useCallback((capture: Capture, notify = true) => {
    saved.current = capture;
    if (notify) onCapture?.(capture);
  }, [onCapture]);
  const [session, setSession] = useState({ id: 0, xml: initialXml, fixture: true });

  return <EditorSession key={session.id} initialXml={session.xml} initialFixture={session.fixture}
    retained={saved.current} remember={remember} editorRef={ref} onAvailable={onAvailable} startupLabel={startupLabel}
    // A new key destroys the old iframe/bridge, while saved in this outer component survives.
    retry={() => setSession({ id: session.id + 1, xml: saved.current?.xml ?? initialXml, fixture: !saved.current })} />;
}

/** Owns one iframe lifetime, including initialization, fresh captures, and protected replacement. */
function EditorSession({ initialXml, initialFixture, retained, remember, retry, editorRef, onAvailable, startupLabel }: {
  initialXml: string;
  initialFixture: boolean;
  retained: Capture | null;
  remember: (capture: Capture, notify?: boolean) => void;
  retry: () => void;
  editorRef?: Ref<EditorHandle>;
  onAvailable?: (available: boolean) => void;
  startupLabel: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const frameRegion = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<HTMLParagraphElement>(null);
  const bridgeRef = useRef<EditorBridge | null>(null);
  const busy = useRef(true); // Guards same-tick actions before React can render the new phase.
  const alive = useRef(false);
  const [phase, setPhase] = useState<EditorPhase>("starting");
  // Locking is separate: after a pre-load failure the editor may still offer File > Save as.
  const [locked, setLocked] = useState(true);
  const [captured, setCaptured] = useState<Capture | null>(retained);
  const [downloadOnly, setDownloadOnly] = useState<Capture | null>(null);
  const [status, setStatus] = useState("Editor starting…");
  const [error, setError] = useState("");

  /** Blocks keyboard and pointer input synchronously, before an outgoing snapshot is requested. */
  const lock = useCallback((value: boolean) => {
    if (value) {
      frame.current?.blur();
      focusTarget.current?.focus();
    }
    frameRegion.current?.toggleAttribute("inert", value);
    if (frame.current) {
      frame.current.tabIndex = value ? -1 : 0;
      frame.current.style.pointerEvents = value ? "none" : "auto";
    }
    setLocked(value);
  }, []);

  /** Retains untouched XML and a timestamp. Parent replacements commit history separately on success. */
  const publish = useCallback((xml: string, notify = true): Capture => {
    const capture = { xml, capturedAt: new Date().toISOString() };
    remember(capture, notify);
    setCaptured(capture);
    return capture;
  }, [remember]);

  useEffect(() => { onAvailable?.(phase === "ready"); }, [phase, onAvailable]);
  useImperativeHandle(editorRef, () => ({ replace: replaceSafely }));

  useEffect(() => {
    // Effect-local ownership also handles React's development setup → cleanup → setup cycle.
    let active = true;
    alive.current = true;
    busy.current = true;
    lock(true);
    const bridge = new EditorBridge(window, frame.current!.contentWindow!);
    bridgeRef.current = bridge;

    /** Protocol readiness and a verified export, not iframe onLoad, make startup successful. */
    async function initialize() {
      try {
        inspectSnapshot(initialXml);
        if (!inspectEditorDocument(initialXml).recoverable) throw new Error("Startup document is not supported for recovery.");
        await bridge.ready();
        await bridge.load(initialXml);
        const xml = await bridge.snapshot();
        assertReloadMatches(initialXml, xml, initialFixture);
        if (!inspectEditorDocument(xml).recoverable) throw new Error("Editor returned an unsupported recovery document.");
        if (active) {
          publish(xml);
          setStatus("Editor ready.");
          setPhase("ready");
          lock(false);
        }
      } catch (failure) {
        bridge.dispose();
        if (active) {
          setStatus("Editor unavailable.");
          setError((failure as Error).message);
          setPhase("unavailable");
        }
      } finally {
        if (active) busy.current = false;
      }
    }
    void initialize();
    return () => {
      active = false;
      alive.current = false;
      bridge.dispose();
    };
  }, [initialXml, initialFixture, lock, publish]);

  /** Checks both mount and bridge identity so an older effect cannot publish into a newer session. */
  function ownsSession(bridge: EditorBridge): boolean {
    return alive.current && bridgeRef.current === bridge;
  }

  /** Exports fresh XML and retains it. Safe unsupported content is download-only, never recovery state. */
  async function captureFresh(bridge: EditorBridge) {
    const snapshot = inspectSnapshot(await bridge.snapshot());
    if (!ownsSession(bridge)) throw new Error("Editor session closed.");
    const preservation = inspectEditorDocument(snapshot.xml);
    if (snapshot.pageCount !== 1 || !preservation.recoverable) {
      const capture = { xml: snapshot.xml, capturedAt: new Date().toISOString() };
      const reason = preservation.reason ?? "Unsupported recovery document. Download intact XML or use the editor File > Save as path.";
      setDownloadOnly(capture);
      return { capture, recoverable: false, reason };
    }
    setDownloadOnly(null);
    return { capture: publish(snapshot.xml), recoverable: true, reason: "" };
  }

  /** Shows an operation failure without replacing either recovery capture or document history. */
  function reportFailure(bridge: EditorBridge, failure: unknown) {
    if (!ownsSession(bridge)) return;
    setError((failure as Error).message);
    setStatus(bridge.usable ? "Editor ready. Operation failed; last capture retained." : "Editor unavailable. Last capture retained.");
  }

  /** Releases the operation guard; an uncertain load stays locked until a new iframe is created. */
  function finishOperation(bridge: EditorBridge, loadStarted = false) {
    if (!ownsSession(bridge)) return;
    busy.current = false;
    setPhase(bridge.usable ? "ready" : "unavailable");
    lock(loadStarted && !bridge.usable);
  }

  /** Capture and Download share a fresh export, but neither performs an editor load. */
  async function captureOrDownload(action: "capture" | "download") {
    const bridge = bridgeRef.current;
    if (busy.current || !bridge?.usable) return;
    busy.current = true;
    setPhase("capturing");
    setError("");
    setStatus("Capturing fresh editor XML…");
    try {
      const fresh = await captureFresh(bridge);
      if (action === "download") downloadXml(fresh.capture.xml);
      if (!fresh.recoverable) setError(fresh.reason);
      setStatus(fresh.recoverable ? "Editor ready. Fresh capture saved in memory." : "Editor ready. Unsupported XML captured for download only.");
    } catch (failure) {
      reportFailure(bridge, failure);
    } finally {
      finishOperation(bridge);
    }
  }

  /** Apply/Restore use a fixed target; Reload uses the fresh outgoing capture as its target.
   * Resolves only after verification. Every failure rejects; outgoing XML survives an uncertain load. */
  async function replaceSafely(target: ReplacementTarget | "reload"): Promise<ReplacementResult> {
    const bridge = bridgeRef.current;
    if (busy.current) throw new Error("An editor operation is already in progress.");
    if (!bridge?.usable) throw new Error("Editor session unavailable. Retry editor.");
    if (target !== "reload") {
      if (target.validation === "generated") validateGeneratedDocument(target.xml);
      else if (!inspectEditorDocument(target.xml).recoverable) throw new Error("The target is unsupported for recovery.");
    }

    busy.current = true;
    setPhase("replacing");
    setError("");
    setStatus("Editor protected replacement in progress…");
    lock(true);
    let loadStarted = false;
    try {
      const fresh = await captureFresh(bridge);
      if (!fresh.recoverable) throw new Error(fresh.reason);
      const outgoing = fresh.capture; // Already retained before any load.
      const xml = target === "reload" ? outgoing.xml : target.xml;
      loadStarted = true;
      await bridge.load(xml);
      const result = await bridge.snapshot();
      assertReloadMatches(xml, result, target !== "reload" && target.validation === "generated");
      if (!inspectEditorDocument(result).recoverable) throw new Error("Loaded document is not supported for recovery.");
      if (!ownsSession(bridge)) throw new Error("Editor session closed.");
      // Parent replacements return both captures for one history commit; Reload only updates current.
      const current = publish(result, target === "reload");
      setStatus(target === "reload" ? "Editor ready. Reload verified." : "Editor ready. Replacement verified.");
      return { outgoing, current };
    } catch (failure) {
      if (loadStarted) bridge.dispose();
      reportFailure(bridge, failure);
      throw failure;
    } finally {
      finishOperation(bridge, loadStarted);
    }
  }

  const ready = phase === "ready";
  return <>
    <p role="status" ref={focusTarget} tabIndex={-1}>{status}</p>
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button disabled={!ready} onClick={() => void captureOrDownload("capture")}>Capture</button>
      {/* replaceSafely already reports failures; this button has no parent awaiting its promise. */}
      <button disabled={!ready} onClick={() => void replaceSafely("reload").catch(() => {})}>Protected reload</button>
      <button disabled={!ready} onClick={() => void captureOrDownload("download")}>Download .drawio</button>
      {phase === "unavailable" && <button onClick={retry}>
        {captured ? "Retry editor — reload last capture" : `Retry editor — load ${startupLabel}`}
      </button>}
    </div>
    {captured && <>
      <button onClick={() => downloadXml(captured.xml, "last-capture.drawio")}>Download last capture ({captured.capturedAt})</button>
      <small>This capture may omit unsynchronized edits. Retry editor reloads this capture; later edits can be lost.</small>
    </>}
    {downloadOnly && <div className="actions"><button onClick={() => downloadXml(downloadOnly.xml, "unsupported-capture.drawio")}>
      Download unsupported capture ({downloadOnly.capturedAt})
    </button></div>}
    <section aria-label="Diagram editor" className="editor-region">
      <div ref={frameRegion} className="editor-frame" inert={locked}>
        <iframe ref={frame} title="draw.io editor" tabIndex={locked ? -1 : 0}
          style={{ pointerEvents: locked ? "none" : "auto" }}
          src="https://embed.diagrams.net/?embed=1&proto=json&libraries=1&noExitBtn=1&drafts=0" />
      </div>
      {locked && <div className="editor-cover">{phase !== "unavailable" ? "Waiting for verified editor content…" : "Editor unavailable. Use recovery download or Retry editor."}</div>}
    </section>
  </>;
}

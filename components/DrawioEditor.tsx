"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { EditorBridge } from "../lib/drawio/bridge";
import {
  documentsMatch,
  validateDocument,
  elements,
  type Element,
} from "../lib/diagram/document";
import { assertReloadMatches, inspectSnapshot } from "../lib/drawio/snapshot";
import { downloadXml } from "../lib/drawio/download";
import type { ImageInput } from "../lib/images";
import { blankCanvasImage } from "../lib/browser-images";
import { AppError } from "../lib/contracts";

export type ReplacementResult = { outgoing: string; current: string };
export type EditorHandle = {
  capture: () => Promise<string>;
  captureForAI: (
    signal?: AbortSignal,
  ) => Promise<{ xml: string; image: ImageInput }>;
  replace: (xml: string, expectedBase?: string) => Promise<ReplacementResult>;
  download: () => Promise<void>;
};
type Props = {
  initialXml: string;
  ref?: Ref<EditorHandle>;
  onCapture: (xml: string) => void;
  onBackup: (xml: string) => void;
  onAvailable: (ready: boolean) => void;
  onDirty: (dirty: boolean) => void;
};

/** Remounting only the editor session makes recovery explicit and invalidates old messages. */
export default function DrawioEditor(props: Props) {
  const retained = useRef(props.initialXml);
  const [session, setSession] = useState(0);
  const capture = useCallback(
    (xml: string) => {
      retained.current = xml;
      props.onCapture(xml);
    },
    [props.onCapture],
  );
  return (
    <EditorSession
      key={session}
      {...props}
      initialXml={retained.current}
      onCapture={capture}
      onRetry={() => setSession((value) => value + 1)}
    />
  );
}

function EditorSession({
  initialXml,
  ref,
  onCapture,
  onBackup,
  onAvailable,
  onDirty,
  onRetry,
}: Props & { onRetry: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const statusElement = useRef<HTMLParagraphElement>(null);
  const bridgeRef = useRef<EditorBridge | null>(null);
  const active = useRef(true);
  const operation = useRef<Promise<unknown> | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [phase, setPhase] = useState<
    "starting" | "ready" | "replacing" | "unavailable"
  >("starting");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(true);

  function lock(value: boolean) {
    if (value) {
      frame.current?.blur();
      statusElement.current?.focus();
    }
    region.current?.toggleAttribute("inert", value);
    if (frame.current) {
      frame.current.tabIndex = value ? -1 : 0;
      frame.current.style.pointerEvents = value ? "none" : "auto";
    }
    setLocked(value);
  }

  function scheduleCapture() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!active.current || !dirty.current || !bridgeRef.current?.usable)
        return;
      if (operation.current) {
        scheduleCapture();
        return;
      }
      void capture(false).catch(reportError);
    }, 750);
  }

  function owns(bridge: EditorBridge): boolean {
    return active.current && bridgeRef.current === bridge;
  }

  function reportError(failure: unknown, bridge?: EditorBridge) {
    if (!active.current || (bridge && !owns(bridge))) return;
    if (failure instanceof Error && failure.name === "AbortError") return;
    if (failure instanceof AppError && failure.code === "STALE_DOCUMENT")
      return;
    setError(
      failure instanceof Error ? failure.message : "Editor operation failed.",
    );
    if (!bridgeRef.current?.usable) {
      lock(true);
      setPhase("unavailable");
      onAvailable(false);
    }
  }

  async function run<T>(
    work: (bridge: EditorBridge) => Promise<T>,
  ): Promise<T> {
    clearTimeout(timer.current);
    while (operation.current) await operation.current.catch(() => {});
    const bridge = bridgeRef.current;
    if (!active.current || !bridge?.usable)
      throw new Error("Editor unavailable. Retry the editor.");
    const pending = work(bridge);
    operation.current = pending;
    try {
      return await pending;
    } catch (failure) {
      reportError(failure, bridge);
      throw failure;
    } finally {
      if (operation.current === pending) operation.current = null;
      if (dirty.current && active.current) scheduleCapture();
    }
  }

  async function capture(commit = true): Promise<string> {
    return run(async (bridge) => {
      if (commit) bridge.commitText();
      dirty.current = false;
      const xml = await bridge.snapshot();
      validateDocument(xml);
      if (!owns(bridge)) throw new Error("Editor session closed.");
      onCapture(xml);
      onDirty(dirty.current);
      return xml;
    });
  }

  async function captureForAI(
    signal?: AbortSignal,
  ): Promise<{ xml: string; image: ImageInput }> {
    return run(async (bridge) => {
      signal?.throwIfAborted();
      lock(true);
      // Cancellation releases interaction immediately. The serialized operation still drains
      // its outstanding protocol reply before another capture may start.
      const unlock = () => {
        if (owns(bridge) && bridge.usable) lock(false);
      };
      signal?.addEventListener("abort", unlock, { once: true });
      const wasDirty = dirty.current;
      let published = false;
      try {
        bridge.commitText();
        dirty.current = false;
        const before = await bridge.snapshotWithBounds();
        signal?.throwIfAborted();
        const document = validateDocument(before.xml);
        const hasContent = (node: Element): boolean =>
          node.attributes.vertex === "1" ||
          node.attributes.edge === "1" ||
          !!node.attributes.backgroundImage ||
          elements(node).some(hasContent);
        let image: ImageInput;
        if (before.bounds.width === 0 && before.bounds.height === 0) {
          if (hasContent(document))
            throw new Error(
              "Could not capture the nonempty diagram image. Please retry.",
            );
          // A proven empty page has no pixels to export. Include a blank snapshot explicitly.
          image = blankCanvasImage();
        } else {
          const exported = await bridge.exportPng(before.xml, before.bounds);
          signal?.throwIfAborted();
          if (!documentsMatch(before.xml, exported.xml))
            throw new Error(
              "Diagram changed during image capture. Please retry.",
            );
          image = { name: "current-canvas.png", dataUrl: exported.dataUrl };
        }
        const after = await bridge.snapshot();
        signal?.throwIfAborted();
        if (!documentsMatch(before.xml, after))
          throw new Error(
            "Diagram changed during image capture. Please retry.",
          );
        if (!owns(bridge)) throw new Error("Editor session closed.");
        onCapture(after);
        onDirty(dirty.current);
        published = true;
        return { xml: after, image };
      } finally {
        if (!published && wasDirty && owns(bridge)) {
          dirty.current = true;
          onDirty(true);
        }
        signal?.removeEventListener("abort", unlock);
        unlock();
      }
    });
  }

  async function replace(
    xml: string,
    expectedBase?: string,
  ): Promise<ReplacementResult> {
    validateDocument(xml);
    return run(async (bridge) => {
      setPhase("replacing");
      setError("");
      onAvailable(false);
      lock(true);
      let loadStarted = false;
      try {
        bridge.commitText();
        const outgoing = await bridge.snapshot();
        validateDocument(outgoing);
        if (!owns(bridge)) throw new Error("Editor session closed.");
        onCapture(outgoing);
        if (expectedBase && !documentsMatch(expectedBase, outgoing)) {
          throw new AppError(
            "STALE_DOCUMENT",
            "The diagram changed. Generate a new suggestion from the latest diagram.",
          );
        }
        // The parent synchronously stores this backup before the external editor can change.
        onBackup(outgoing);
        loadStarted = true;
        await bridge.load(xml);
        const current = await bridge.snapshot();
        assertReloadMatches(xml, current);
        validateDocument(current);
        if (!owns(bridge)) throw new Error("Editor session closed.");
        dirty.current = false;
        onCapture(current);
        onDirty(false);
        return { outgoing, current };
      } catch (failure) {
        if (loadStarted)
          bridge.dispose(
            "Replacement could not be verified. Retry to recover the retained document.",
          );
        reportError(failure, bridge);
        throw failure;
      } finally {
        if (owns(bridge)) {
          setPhase(bridge.usable ? "ready" : "unavailable");
          onAvailable(bridge.usable);
          lock(!bridge.usable);
        }
      }
    });
  }

  async function download(): Promise<void> {
    await run(async (bridge) => {
      bridge.commitText();
      const xml = await bridge.snapshot();
      inspectSnapshot(xml);
      downloadXml(xml);
      try {
        validateDocument(xml);
        onCapture(xml);
      } catch {
        setError(
          "Downloaded intact. This document is outside the single-page recovery scope.",
        );
      }
    });
  }

  useImperativeHandle(ref, () => ({
    capture: () => capture(),
    captureForAI,
    replace,
    download,
  }));
  useEffect(() => {
    active.current = true;
    const bridge = new EditorBridge(
      window,
      frame.current!.contentWindow!,
      () => {
        dirty.current = true;
        onDirty(true);
        scheduleCapture();
      },
      () => {
        void download().catch(reportError);
      },
    );
    bridgeRef.current = bridge;
    const startup = (async () => {
      try {
        validateDocument(initialXml);
        await bridge.ready();
        await bridge.load(initialXml);
        const xml = await bridge.snapshot();
        assertReloadMatches(initialXml, xml, true);
        validateDocument(xml);
        if (!owns(bridge)) return;
        dirty.current = false;
        onCapture(xml);
        onDirty(false);
        setPhase("ready");
        onAvailable(true);
        lock(false);
      } catch (failure) {
        bridge.dispose("Startup could not be verified. Retry editor.");
        reportError(failure, bridge);
      }
    })();
    operation.current = startup;
    void startup.finally(() => {
      if (operation.current === startup) operation.current = null;
    });
    return () => {
      active.current = false;
      clearTimeout(timer.current);
      bridge.dispose();
    };
  }, []);

  return (
    <section className="editor-region" aria-label="Diagram editor">
      <div className="editor-frame" ref={region} inert={locked}>
        <iframe
          ref={frame}
          title="draw.io editor"
          tabIndex={locked ? -1 : 0}
          src="https://embed.diagrams.net/?embed=1&proto=json&libraries=1&noExitBtn=1&drafts=0"
          style={{ pointerEvents: locked ? "none" : "auto" }}
        />
      </div>
      <p
        className={phase === "ready" ? "sr-only" : "editor-status"}
        ref={statusElement}
        tabIndex={-1}
        role="status"
      >
        {phase === "starting"
          ? "Loading draw.io…"
          : phase === "replacing"
            ? "Applying and verifying…"
            : phase === "unavailable"
              ? "Editor unavailable"
              : "Editor ready"}
      </p>
      {locked && (
        <div className="editor-cover">
          {error && <p role="alert">{error}</p>}
          {phase === "unavailable" && (
            <button onClick={onRetry}>
              Retry editor — restore retained document
            </button>
          )}
        </div>
      )}
      {!locked && error && (
        <div className="editor-notice" role="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
    </section>
  );
}

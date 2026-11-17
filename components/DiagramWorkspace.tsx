"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AiPanel from "./AiPanel";
import DrawioEditor, { type EditorHandle } from "./DrawioEditor";
import { documentsMatch, validateDocument } from "../lib/diagram/document";
import { proposalResultSchema, type Candidate } from "../lib/proposal";
import { readJson } from "../lib/http";
import {
  readKey,
  readRecovery,
  saveKey,
  writeRecovery,
  type Recovery,
} from "../lib/tab-storage";
import { downloadXml } from "../lib/drawio/download";
import { MAX_REFERENCES, type ImageInput } from "../lib/images";
import { fitProposal, prepareReference } from "../lib/browser-images";
import { AppError } from "../lib/contracts";

type Attempt = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
export default function DiagramWorkspace({
  initialXml,
}: {
  initialXml: string;
}) {
  const editor = useRef<EditorHandle>(null);
  const activeAttempt = useRef<Attempt | null>(null);
  const replacing = useRef(false);
  // Commands need the latest record synchronously, before React's next render.
  const recordRef = useRef<Recovery>({
    version: 1,
    current: initialXml,
    backup: null,
    undo: null,
  });
  const allowStorage = useRef(true);
  const [record, setRecord] = useState(recordRef.current);
  const [startup, setStartup] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const referencesRef = useRef<ImageInput[]>([]);
  const [references, setReferences] = useState<ImageInput[]>([]);
  const [applying, setApplying] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageMessage, setStorageMessage] = useState("Opening tab draft…");
  const [undoConfirmation, setUndoConfirmation] = useState<{
    before: string;
    current: string;
  } | null>(null);
  const dirty = useRef(false);

  const persist = useCallback((next: Recovery) => {
    recordRef.current = next;
    setRecord(next);
    if (!allowStorage.current) return;
    try {
      writeRecovery(sessionStorage, next);
      setStorageMessage(
        "Draft saved in this tab. Download to keep it after closing.",
      );
    } catch {
      setStorageMessage(
        "Refresh recovery unavailable. Work is retained in memory; download a copy.",
      );
    }
  }, []);
  const capture = useCallback(
    (xml: string) => persist({ ...recordRef.current, current: xml }),
    [persist],
  );
  const backup = useCallback(
    (xml: string) =>
      persist({ ...recordRef.current, current: xml, backup: xml }),
    [persist],
  );
  const markDirty = useCallback((value: boolean) => {
    dirty.current = value;
    if (value && allowStorage.current) setStorageMessage("Saving draft…");
  }, []);

  useEffect(() => {
    try {
      const saved = readRecovery(sessionStorage);
      if (saved) {
        recordRef.current = saved;
        setRecord(saved);
      }
    } catch {
      allowStorage.current = false;
      setStorageMessage(
        "Saved draft could not be read. It has been left untouched; new work is in memory only.",
      );
    }
    try {
      setApiKey(readKey(sessionStorage));
    } catch {
      setError(
        "Browser key storage is unavailable. You can use a key in memory for this visit.",
      );
    }
    setStartup(recordRef.current.current);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current || replacing.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      const attempt = activeAttempt.current;
      activeAttempt.current = null;
      if (attempt) {
        clearTimeout(attempt.timer);
        attempt.controller.abort();
      }
    };
  }, []);

  function cancel(text = "AI request canceled.") {
    const attempt = activeAttempt.current;
    if (!attempt) return;
    activeAttempt.current = null;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    setPending(false);
    setMessage(text);
  }

  async function submit(regenerate = false) {
    if (
      activeAttempt.current ||
      preparingRef.current ||
      replacing.current ||
      !editor.current ||
      !ready ||
      (!regenerate && candidate)
    )
      return;
    if (!apiKey) {
      setError(
        "Add your OpenAI API key in Settings to use AI. Manual editing works without a key.",
      );
      return;
    }
    const submittedPrompt = prompt.trim();
    const submittedReferences = referencesRef.current.map((image) => ({
      ...image,
    }));
    if (!submittedPrompt) return;
    setCandidate(null);
    setUndoConfirmation(null);
    setError("");
    setMessage("");
    const controller = new AbortController();
    const attempt: Attempt = {
      controller,
      timer: setTimeout(() => {
        if (activeAttempt.current === attempt)
          cancel("AI took longer than 50 seconds. Try a smaller change.");
      }, 50_000),
    };
    activeAttempt.current = attempt;
    setPending(true);
    try {
      const captured = await editor.current.captureForAI(controller.signal);
      if (activeAttempt.current !== attempt) return;
      const baseXml = captured.xml;
      const body = await fitProposal(
        {
          prompt: submittedPrompt,
          xml: baseXml,
          canvasImage: captured.image,
          referenceImages: submittedReferences,
        },
        controller.signal,
      );
      if (activeAttempt.current !== attempt) return;
      const response = await fetch("/api/propose", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      const raw = await readJson(response, controller.signal);
      if (activeAttempt.current !== attempt) return;
      const parsed = proposalResultSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          "The server returned an invalid proposal. Please retry.",
        );
      const result = parsed.data;
      if (!result.ok) throw new Error(result.message);
      if (!response.ok)
        throw new Error("The server could not complete this request.");
      if (result.kind === "clarification") {
        setMessage(result.message);
        return;
      }
      validateDocument(result.xml);
      setCandidate({
        xml: result.xml,
        baseXml,
        summary: result.summary,
        requestId: result.requestId,
      });
    } catch (failure) {
      if (activeAttempt.current === attempt)
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to request changes.",
        );
    } finally {
      if (activeAttempt.current === attempt) {
        activeAttempt.current = null;
        clearTimeout(attempt.timer);
        controller.abort();
        setPending(false);
      }
    }
  }

  async function apply() {
    if (
      !candidate ||
      replacing.current ||
      activeAttempt.current ||
      !editor.current
    )
      return;
    replacing.current = true;
    setApplying(true);
    setError("");
    try {
      const result = await editor.current.replace(
        candidate.xml,
        candidate.baseXml,
      );
      persist({
        ...recordRef.current,
        current: result.current,
        undo: { before: result.outgoing, after: result.current },
      });
      setCandidate(null);
      setMessage("Changes applied.");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Changes could not be applied.",
      );
    } finally {
      replacing.current = false;
      setApplying(false);
    }
  }

  async function restore(before: string, expected: string) {
    if (!editor.current) return;
    const result = await editor.current.replace(before, expected);
    persist({
      ...recordRef.current,
      current: result.current,
      undo: null,
      backup: result.outgoing,
    });
    setCandidate(null);
    setUndoConfirmation(null);
    setMessage(
      "Restored the diagram from before AI. The displaced version is available in recovery downloads.",
    );
  }

  async function undo(confirmed = false) {
    const savedUndo = recordRef.current.undo;
    if (
      !savedUndo ||
      replacing.current ||
      activeAttempt.current ||
      !editor.current
    )
      return;
    replacing.current = true;
    setApplying(true);
    setError("");
    try {
      if (confirmed && undoConfirmation) {
        await restore(undoConfirmation.before, undoConfirmation.current);
      } else {
        const current = await editor.current.capture();
        if (!documentsMatch(current, savedUndo.after)) {
          setUndoConfirmation({ before: savedUndo.before, current });
        } else await restore(savedUndo.before, current);
      }
    } catch (failure) {
      setError(
        failure instanceof AppError && failure.code === "STALE_DOCUMENT"
          ? "The diagram changed again. Choose Undo AI change to review the latest version."
          : failure instanceof Error
            ? failure.message
            : "Undo failed. Recovery copy retained.",
      );
      setUndoConfirmation(null);
    } finally {
      replacing.current = false;
      setApplying(false);
    }
  }

  async function attach(files: File[]) {
    if (preparingRef.current || activeAttempt.current || replacing.current)
      return;
    if (referencesRef.current.length + files.length > MAX_REFERENCES) {
      setError(
        "Attach up to 10 reference images. Remove an image before adding more.",
      );
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    setError("");
    try {
      const added: ImageInput[] = [];
      for (const file of files) added.push(await prepareReference(file));
      referencesRef.current = [...referencesRef.current, ...added];
      setReferences(referencesRef.current);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not prepare images.",
      );
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }
  function removeReference(index: number) {
    if (preparingRef.current || activeAttempt.current || replacing.current)
      return;
    referencesRef.current = referencesRef.current.filter(
      (_, position) => position !== index,
    );
    setReferences(referencesRef.current);
  }

  function updateKey(value: string) {
    cancel();
    setApiKey(value);
    try {
      saveKey(sessionStorage, value);
      setError("");
    } catch {
      setError(
        "Key storage is unavailable. This key is only kept in memory until refresh.",
      );
    }
  }
  async function download() {
    try {
      await editor.current?.download();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Download failed.");
    }
  }

  return (
    <div className={`workspace ${panelOpen ? "panel-open" : ""}`}>
      {startup !== null ? (
        <DrawioEditor
          ref={editor}
          initialXml={startup}
          onCapture={capture}
          onBackup={backup}
          onAvailable={setReady}
          onDirty={markDirty}
        />
      ) : (
        <p role="status">Opening diagram…</p>
      )}
      {panelOpen ? (
        <AiPanel
          references={references}
          preparing={preparing}
          onAttach={(files) => void attach(files)}
          onRemove={removeReference}
          prompt={prompt}
          onPrompt={setPrompt}
          apiKey={apiKey}
          onKey={updateKey}
          pending={pending}
          applying={applying}
          ready={ready}
          candidate={candidate}
          message={message}
          error={error}
          storageMessage={storageMessage}
          canUndo={!!record.undo}
          confirmUndo={!!undoConfirmation}
          hasBackup={!!record.backup}
          onSubmit={() => void submit()}
          onCancel={() => cancel()}
          onApply={() => void apply()}
          onDiscard={() => setCandidate(null)}
          onUndo={() => void undo()}
          onConfirmUndo={() => void undo(true)}
          onCancelUndo={() => setUndoConfirmation(null)}
          onDownload={() => void download()}
          onDownloadBackup={() => {
            if (record.backup) downloadXml(record.backup, "recovery.drawio");
          }}
          onRegenerate={() => void submit(true)}
          onClose={() => setPanelOpen(false)}
        />
      ) : (
        <button className="ai-launcher" onClick={() => setPanelOpen(true)}>
          {pending ? "AI working…" : candidate ? "Review AI changes" : "Ask AI"}
        </button>
      )}
    </div>
  );
}

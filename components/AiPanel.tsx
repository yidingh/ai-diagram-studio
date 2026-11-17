"use client";
import { useState } from "react";
import type { ImageInput } from "../lib/images";
import type { Candidate } from "../lib/proposal";

type Props = {
  references: ImageInput[];
  preparing: boolean;
  onAttach: (files: File[]) => void;
  onRemove: (index: number) => void;
  prompt: string;
  onPrompt: (value: string) => void;
  apiKey: string;
  onKey: (value: string) => void;
  pending: boolean;
  applying: boolean;
  ready: boolean;
  candidate: Candidate | null;
  message: string;
  error: string;
  storageMessage: string;
  canUndo: boolean;
  confirmUndo: boolean;
  hasBackup: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onConfirmUndo: () => void;
  onCancelUndo: () => void;
  onDownload: () => void;
  onDownloadBackup: () => void;
  onRegenerate: () => void;
  onClose: () => void;
};
export default function AiPanel(props: Props) {
  const [settings, setSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <header className="panel-header">
        <h1>AI assistant</h1>
        <button aria-label="Minimize AI panel" onClick={props.onClose}>
          −
        </button>
      </header>
      <div className="panel-body">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <label htmlFor="diagram-prompt">What should change?</label>
          <textarea
            id="diagram-prompt"
            placeholder="Add a cache between the API and database…"
            value={props.prompt}
            onChange={(event) => props.onPrompt(event.target.value)}
            maxLength={4000}
            disabled={props.pending || props.applying || props.preparing}
          />
          <p className="muted">
            A fresh image of the complete current diagram is included
            automatically.
          </p>
          <label htmlFor="reference-images">Attach images</label>
          <input
            id="reference-images"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={props.pending || props.applying || props.preparing}
            onChange={(event) => {
              props.onAttach(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <p className="muted" role="status">
            {props.preparing
              ? "Preparing images…"
              : `${props.references.length}/10 reference images`}
          </p>
          <ul className="reference-images" aria-label="Reference images">
            {props.references.map((image, index) => (
              <li key={index}>
                {/* These data URLs are prepared raster images held only in memory. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.dataUrl}
                  alt={`Reference ${index + 1}: ${image.name}`}
                />
                <span title={image.name}>{image.name}</span>
                <button
                  type="button"
                  disabled={props.pending || props.applying || props.preparing}
                  aria-label={`Remove ${image.name}`}
                  onClick={() => props.onRemove(index)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">
            PNG, JPEG or WebP · 5 MiB each. Images stay in memory until removed
            or refreshed. Large images may be compressed; all images and XML
            must fit 4 MiB.
          </p>
          <button
            className="primary"
            disabled={
              !props.ready ||
              props.pending ||
              props.preparing ||
              props.applying ||
              !!props.candidate ||
              !props.prompt.trim()
            }
          >
            {props.pending ? "Thinking…" : "Suggest changes"}
          </button>
          {props.pending && (
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </form>
        {props.pending && (
          <p className="muted">You can keep editing while AI works.</p>
        )}
        {props.error && <p role="alert">{props.error}</p>}
        {props.message && <p role="status">{props.message}</p>}
        {props.candidate && (
          <section aria-label="Suggested changes" className="suggestion">
            <h2>Suggested changes</h2>
            <ul>
              {props.candidate.summary.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <div className="actions">
              <button
                className="primary"
                disabled={!props.ready || props.applying}
                onClick={props.onApply}
              >
                Apply
              </button>
              <button disabled={props.applying} onClick={props.onDiscard}>
                Discard
              </button>
            </div>
            <p className="muted">
              Applying saves a recovery copy and resets draw.io’s undo history.
            </p>
            <button
              disabled={props.pending || props.applying || !props.ready}
              onClick={props.onRegenerate}
            >
              Regenerate from latest diagram
            </button>
          </section>
        )}
        {props.canUndo && (
          <button
            disabled={!props.ready || props.pending || props.applying}
            onClick={props.onUndo}
          >
            Undo AI change
          </button>
        )}
        {props.confirmUndo && (
          <section className="suggestion" aria-label="Confirm undo">
            <p>
              Restoring the diagram from before AI also removes your newer
              manual edits. The current document will remain available as a
              recovery download.
            </p>
            <div className="actions">
              <button onClick={props.onDownload}>Download current first</button>
              <button onClick={props.onConfirmUndo} disabled={props.applying}>
                Restore before AI
              </button>
              <button onClick={props.onCancelUndo}>Keep current</button>
            </div>
          </section>
        )}
        <details className="file-actions">
          <summary>Files and recovery</summary>
          <p className="muted">
            Use draw.io’s File menu to import a diagram. Download to keep a file
            after this tab closes.
          </p>
          <button
            disabled={
              !props.ready || props.applying || props.pending || props.preparing
            }
            onClick={props.onDownload}
          >
            Download .drawio
          </button>
          {props.hasBackup && (
            <button onClick={props.onDownloadBackup}>
              Download recovery copy
            </button>
          )}
        </details>
      </div>
      <footer>
        <p className="muted" role="status">
          {props.storageMessage}
        </p>
        <button
          aria-label="API key settings"
          onClick={() => {
            setSettings(!settings);
            setKeyDraft("");
          }}
        >
          {props.apiKey ? "API key connected · Settings" : "Add OpenAI API key"}
        </button>
        {settings && (
          <form
            className="key-settings"
            onSubmit={(event) => {
              event.preventDefault();
              props.onKey(keyDraft.trim());
              setKeyDraft("");
              setSettings(false);
            }}
          >
            <label htmlFor="api-key">OpenAI API key</label>
            <input
              id="api-key"
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              maxLength={512}
              autoComplete="off"
            />
            <p className="muted">
              Kept in this tab’s session storage. Your prompt, diagram XML,
              canvas image and reference images pass through this server to
              OpenAI and use your API account. The server does not save or log
              the key or images.
            </p>
            <div className="actions">
              <button disabled={!keyDraft.trim()}>Use key</button>
              <button
                type="button"
                onClick={() => {
                  props.onKey("");
                  setKeyDraft("");
                }}
              >
                Clear key
              </button>
            </div>
          </form>
        )}
      </footer>
    </aside>
  );
}

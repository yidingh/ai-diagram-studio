import { EDITOR_ORIGIN, MAX_MESSAGE_BYTES, OPERATION_TIMEOUT_MS, READY_TIMEOUT_MS } from "./limits";

type Pending = {
  event: "init" | "load" | "export";
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Narrow direct transport fallback: see the pinned wrapper capability evidence.
 * A bridge belongs to one iframe window for its entire lifetime. */
export class EditorBridge {
  private initialized = false;
  private closed = false;
  private pending?: Pending;
  private initialization: Promise<string>;

  /** Binds to one iframe window and starts its readiness deadline immediately. */
  constructor(private host: Window, private frame: Window) {
    host.addEventListener("message", this.receive);
    this.initialization = this.wait("init", READY_TIMEOUT_MS);
    // Cleanup can precede the consumer's await (React Strict Mode).
    void this.initialization.catch(() => {});
  }

  /** Resolves on protocol init (normally an empty string); closing before init rejects. */
  ready(): Promise<string> { return this.initialization; }
  get usable(): boolean { return this.initialized && !this.closed; }

  /** Sends full XML and waits for a load acknowledgment; callers must verify content separately. */
  async load(xml: string): Promise<void> {
    await this.request("load", { action: "load", xml, autosave: 1 });
  }

  /** Requests a fresh XML export; rejects if unavailable, busy, or timed out. */
  snapshot(): Promise<string> {
    return this.request("export", { action: "export", format: "xml" });
  }

  /** Permanently closes this bridge, removes its listener, and rejects any pending operation. */
  dispose(reason = "Editor session closed. Retry editor to continue."): void {
    if (this.closed) return;
    this.closed = true;
    this.host.removeEventListener("message", this.receive);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = undefined;
    }
  }

  /** Registers the expected reply before posting; concurrent requests are rejected, not queued. */
  private request(event: "load" | "export", action: object): Promise<string> {
    if (this.closed || !this.initialized) return Promise.reject(new Error("Editor session unavailable. Retry editor."));
    if (this.pending) return Promise.reject(new Error("An editor operation is already in progress."));
    const response = this.wait(event, OPERATION_TIMEOUT_MS);
    try { this.frame.postMessage(JSON.stringify(action), EDITOR_ORIGIN); }
    catch { this.dispose("Could not contact editor. Retry editor; any existing capture is retained."); }
    return response;
  }

  // Replies have no request ID. Closing on timeout prevents a late reply from satisfying later work.
  private wait(event: Pending["event"], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(
        `Editor ${event === "init" ? "initialization" : event === "export" ? "snapshot" : "load"} timed out after ${timeout / 1000} seconds. Retry editor; any existing capture is retained.`,
      ), timeout);
      this.pending = { event, resolve, reject, timer };
    });
  }

  /** Accepts only the expected protocol reply from this exact iframe; unsolicited autosaves are ignored. */
  private receive = (event: MessageEvent): void => {
    // Origin alone is insufficient: another iframe on the same host could send matching events.
    if (this.closed || event.origin !== EDITOR_ORIGIN || event.source !== this.frame || typeof event.data !== "string") return;
    if (event.data.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(event.data).length > MAX_MESSAGE_BYTES) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const pending = this.pending;
    // Unsolicited autosaves never become captured state: they have no operation
    // identity and may arrive from before a protected reload. Full fresh
    // snapshots are the sole publication path, during and after operations.
    if (!pending || data.event !== pending.event) return;
    if (pending.event === "export" && (data.format !== "xml" || typeof data.xml !== "string")) return;
    if (data.error) { this.dispose("Editor operation failed. Retry editor; any existing capture is retained."); return; }
    clearTimeout(pending.timer);
    this.pending = undefined;
    if (data.event === "init") this.initialized = true;
    pending.resolve(typeof data.xml === "string" ? data.xml : "");
  };
}

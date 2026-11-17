import {
  EDITOR_ORIGIN,
  MAX_MESSAGE_BYTES,
  MAX_PNG_MESSAGE_BYTES,
  OPERATION_TIMEOUT_MS,
  READY_TIMEOUT_MS,
} from "./limits";

export type DiagramBounds = { width: number; height: number };
type Reply = Record<string, unknown>;
type Pending = {
  format?: "xml" | "png";
  event: "init" | "load" | "export";
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Direct transport for the documented draw.io embed protocol.
 * A bridge belongs to one iframe window for its entire lifetime. */
export class EditorBridge {
  private initialized = false;
  private closed = false;
  private pending?: Pending;
  private initialization: Promise<Reply>;

  /** Binds to one iframe window and starts its readiness deadline immediately. */
  constructor(
    private host: Window,
    private frame: Window,
    private onChange?: () => void,
    private onSave?: () => void,
  ) {
    host.addEventListener("message", this.receive);
    this.initialization = this.wait("init", READY_TIMEOUT_MS);
    // Cleanup can precede the consumer's await (React Strict Mode).
    void this.initialization.catch(() => {});
  }

  /** Resolves on protocol init (normally an empty string); closing before init rejects. */
  ready(): Promise<string> {
    return this.initialization.then(() => "");
  }
  get usable(): boolean {
    return this.initialized && !this.closed;
  }

  /** Sends full XML and waits for a load acknowledgment; callers must verify content separately. */
  async load(xml: string): Promise<void> {
    await this.request("load", { action: "load", xml, autosave: 1 });
  }

  /** Commit in-place label editing before a user-initiated capture. */
  commitText(): void {
    if (!this.usable) throw new Error("Editor session unavailable.");
    this.frame.postMessage(
      JSON.stringify({ action: "resetEditor" }),
      EDITOR_ORIGIN,
    );
  }

  /** Requests a fresh XML export; rejects if unavailable, busy, or timed out. */
  snapshot(): Promise<string> {
    return this.request(
      "export",
      { action: "export", format: "xml" },
      "xml",
    ).then((reply) => reply.xml as string);
  }

  /** Bounds from the same fresh XML reply let us cap the raster before rendering. */
  async snapshotWithBounds(): Promise<{ xml: string; bounds: DiagramBounds }> {
    const reply = await this.request(
      "export",
      { action: "export", format: "xml" },
      "xml",
    );
    const bounds = reply.modelBounds as DiagramBounds | undefined;
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width < 0 ||
      bounds.height < 0
    )
      throw new Error("Editor did not provide diagram bounds. Retry capture.");
    return { xml: reply.xml as string, bounds };
  }

  async exportPng(
    xml: string,
    bounds: DiagramBounds,
  ): Promise<{ xml: string; dataUrl: string }> {
    const longest = Math.max(bounds.width, bounds.height, 1);
    const reply = await this.request(
      "export",
      {
        action: "export",
        format: "png",
        xml,
        scale: Math.min(1, 1600 / longest),
        currentPage: true,
        size: "diagram",
        grid: false,
        border: 0,
        background: "#ffffff",
        transparent: false,
      },
      "png",
    );
    return { xml: reply.xml as string, dataUrl: reply.data as string };
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
  private request(
    event: "load" | "export",
    action: object,
    format?: Pending["format"],
  ): Promise<Reply> {
    if (this.closed || !this.initialized)
      return Promise.reject(
        new Error("Editor session unavailable. Retry editor."),
      );
    if (this.pending)
      return Promise.reject(
        new Error("An editor operation is already in progress."),
      );
    const response = this.wait(event, OPERATION_TIMEOUT_MS, format);
    try {
      this.frame.postMessage(JSON.stringify(action), EDITOR_ORIGIN);
    } catch {
      this.dispose(
        "Could not contact editor. Retry editor; any existing capture is retained.",
      );
    }
    return response;
  }

  // Replies have no request ID. Closing on timeout prevents a late reply from satisfying later work.
  private wait(
    event: Pending["event"],
    timeout: number,
    format?: Pending["format"],
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.dispose(
            `Editor ${event === "init" ? "initialization" : event === "export" ? "snapshot" : "load"} timed out after ${timeout / 1000} seconds. Retry editor; any existing capture is retained.`,
          ),
        timeout,
      );
      this.pending = { event, format, resolve, reject, timer };
    });
  }

  /** Accepts only the expected protocol reply from this exact iframe; autosaves only trigger a fresh capture. */
  private receive = (event: MessageEvent): void => {
    // Origin alone is insufficient: another iframe on the same host could send matching events.
    if (
      this.closed ||
      event.origin !== EDITOR_ORIGIN ||
      event.source !== this.frame ||
      typeof event.data !== "string"
    )
      return;
    const limit =
      this.pending?.format === "png"
        ? MAX_PNG_MESSAGE_BYTES
        : MAX_MESSAGE_BYTES;
    if (
      event.data.length > limit ||
      new TextEncoder().encode(event.data).length > limit
    ) {
      if (this.pending?.format === "png")
        this.dispose(
          "Editor image export failed: intermediate image exceeds 20 MiB. Retry with a smaller diagram.",
        );
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.event === "autosave") {
      this.onChange?.();
      return;
    }
    if (data.event === "save") {
      this.onSave?.();
      return;
    }
    const pending = this.pending;
    // Unsolicited autosaves never become captured state: they have no operation
    // identity and may arrive from before a protected reload. Full fresh
    // snapshots are the sole publication path, during and after operations.
    if (!pending || data.event !== pending.event) return;
    if (
      pending.event === "export" &&
      data.format !== pending.format &&
      !(data.error && data.format === undefined)
    )
      return;
    // Errors often omit xml/data. Route by event/format before checking success fields.
    if (data.error) {
      this.dispose(
        "Editor operation failed. Retry editor; any existing capture is retained.",
      );
      return;
    }
    if (
      pending.event === "export" &&
      (typeof data.xml !== "string" ||
        (pending.format === "png" && typeof data.data !== "string"))
    ) {
      this.dispose("Editor export failed: missing image or XML. Retry editor.");
      return;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    if (data.event === "init") this.initialized = true;
    pending.resolve(data);
  };
}

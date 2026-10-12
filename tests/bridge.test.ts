import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorBridge } from "../lib/drawio/bridge";

const origin = "https://embed.diagrams.net";
let frame: HTMLIFrameElement;
let bridge: EditorBridge;
let send: ReturnType<typeof vi.spyOn>;
function emit(data: unknown, source = frame.contentWindow, from = origin) {
  window.dispatchEvent(new MessageEvent("message", {
    origin: from, source, data: typeof data === "string" ? data : JSON.stringify(data),
  }));
}
beforeEach(() => {
  vi.useFakeTimers();
  frame = document.createElement("iframe");
  document.body.append(frame);
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  bridge = new EditorBridge(window, frame.contentWindow!);
});
afterEach(() => { bridge.dispose(); frame.remove(); vi.useRealTimers(); });

it("waits for a valid init, ignores duplicate init, and sends load to exact origin", async () => {
  const ready = bridge.ready();
  let initialized = false;
  void ready.then(() => { initialized = true; });
  emit({ event: "init" }, window);
  emit({ event: "init" }, frame.contentWindow, "https://embed.diagrams.net.evil.example");
  emit("{"); emit(null); emit("x".repeat(4 * 1024 * 1024 + 1));
  await Promise.resolve();
  expect(initialized).toBe(false);
  expect(send).not.toHaveBeenCalled();
  emit({ event: "init" });
  await ready;
  const loaded = bridge.load("<mxfile/>");
  emit({ event: "init" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({ action: "load", xml: "<mxfile/>" });
  expect(send.mock.calls[0][1]).toBe(origin);
  emit({ event: "load" });
  await loaded;
});

it("reports readiness timeout and cannot reuse the unavailable session", async () => {
  const ready = expect(bridge.ready()).rejects.toThrow(/20 seconds.*Retry editor/i);
  await vi.advanceTimersByTimeAsync(20_000);
  await ready;
  emit({ event: "init" });
  await expect(bridge.snapshot()).rejects.toThrow(/session/i);
});

it("exports fresh XML, rejects concurrent requests, and ignores autosaves/images", async () => {
  emit({ event: "init" }); await bridge.ready();
  const snapshot = bridge.snapshot();
  await expect(bridge.snapshot()).rejects.toThrow(/in progress/i);
  emit({ event: "autosave", xml: "old" });
  emit({ event: "export", format: "png", xml: "old" });
  expect(JSON.parse(send.mock.calls[0][0] as string)).toEqual({ action: "export", format: "xml" });
  emit({ event: "export", format: "xml", xml: "<mxfile/>" });
  await expect(snapshot).resolves.toBe("<mxfile/>");
});

it("invalidates a timed-out session so late exports cannot complete later work", async () => {
  emit({ event: "init" }); await bridge.ready();
  const failed = expect(bridge.snapshot()).rejects.toThrow(/10 seconds.*Retry editor/i);
  await vi.advanceTimersByTimeAsync(10_000); await failed;
  await expect(bridge.snapshot()).rejects.toThrow(/session/i);
  emit({ event: "export", format: "xml", xml: "late" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("ignores old-window responses after remount and cleans up pending operations", async () => {
  emit({ event: "init" }); await bridge.ready();
  const pending = expect(bridge.snapshot()).rejects.toThrow(/closed/i);
  const oldWindow = frame.contentWindow;
  bridge.dispose(); await pending;
  expect(vi.getTimerCount()).toBe(0);
  frame.remove(); frame = document.createElement("iframe"); document.body.append(frame);
  bridge = new EditorBridge(window, frame.contentWindow!);
  const ready = bridge.ready();
  emit({ event: "init" }, oldWindow);
  emit({ event: "init" }); await ready;
  const captured = bridge.snapshot();
  emit({ event: "export", format: "xml", xml: "old" }, oldWindow);
  emit({ event: "export", format: "xml", xml: "new" });
  await expect(captured).resolves.toBe("new");
});

it("load timeout invalidates the session and removes listeners/timers", async () => {
  emit({ event: "init" }); await bridge.ready();
  const failed = expect(bridge.load("<mxfile/>")).rejects.toThrow(/10 seconds/);
  await vi.advanceTimersByTimeAsync(10_000); await failed;
  expect(vi.getTimerCount()).toBe(0);
  await expect(bridge.load("<mxfile/>")).rejects.toThrow(/session/i);
});

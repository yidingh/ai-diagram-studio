import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { createRef, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DrawioEditor, { type EditorHandle } from "../components/DrawioEditor";

const fixture = readFileSync("tests/fixtures/three-node.drawio", "utf8");
const changed = fixture.replace('x="290"', 'x="350"').replace('value="API"', 'value="Backend"');
let frame: HTMLIFrameElement;
let send: ReturnType<typeof vi.spyOn>;
let blobs: Blob[];
let links: string[];
async function emit(data: object, source = frame.contentWindow) {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", {
    origin: "https://embed.diagrams.net", source, data: JSON.stringify(data),
  })); });
}
function commands(): { action: string; xml?: string }[] {
  return send.mock.calls.map((args: unknown[]) => JSON.parse(args[0] as string));
}
async function mount(editorRef = createRef<EditorHandle>()) {
  render(<StrictMode><DrawioEditor ref={editorRef} initialXml={fixture} /></StrictMode>);
  frame = screen.getByTitle("draw.io editor") as HTMLIFrameElement;
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  await emit({ event: "init" });
  expect(commands().filter((c) => c.action === "load")).toHaveLength(1);
  await emit({ event: "load" });
  await emit({ event: "export", format: "xml", xml: fixture });
}
beforeEach(() => {
  vi.useFakeTimers(); blobs = []; links = [];
  vi.stubGlobal("Blob", NodeBlob);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:test"; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { links.push(this.download); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("waits for protocol readiness and post-load capture before enabling actions", async () => {
  render(<DrawioEditor initialXml={fixture} />);
  frame = screen.getByTitle("draw.io editor") as HTMLIFrameElement;
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  expect(send).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(true);
  await emit({ event: "init" }); await emit({ event: "load" });
  expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(true);
  await emit({ event: "export", format: "xml", xml: fixture });
  expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(false);
});

it("captures immediately, downloads fresh XML, and revokes its download URL", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Download .drawio" }));
  await emit({ event: "autosave", xml: fixture });
  expect(blobs).toHaveLength(0);
  await emit({ event: "export", format: "xml", xml: changed });
  expect(await blobs[0].text()).toBe(changed);
  expect(links).toEqual(["diagram.drawio"]);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});

it("locks before fresh reload capture, ignores intermediate autosaves, and verifies before unlocking", async () => {
  await mount();
  frame.focus();
  fireEvent.click(screen.getByRole("button", { name: "Protected reload" }));
  expect(document.activeElement).not.toBe(frame);
  expect(frame.parentElement!.hasAttribute("inert")).toBe(true);
  expect(frame.style.pointerEvents).toBe("none");
  const loads = commands().filter((c) => c.action === "load").length;
  await emit({ event: "export", format: "xml", xml: changed });
  expect(commands().filter((c) => c.action === "load")).toHaveLength(loads + 1);
  expect(commands().at(-1)!.xml).toBe(changed);
  await emit({ event: "autosave", xml: fixture });
  await emit({ event: "load" });
  expect(frame.parentElement!.hasAttribute("inert")).toBe(true);
  await emit({ event: "export", format: "xml", xml: changed });
  expect(frame.parentElement!.hasAttribute("inert")).toBe(false);
  await emit({ event: "autosave", xml: fixture });
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs.at(-1)!.text()).toBe(changed);
});

it("retains the outgoing capture on mismatched reload and recovers it in a new iframe", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Protected reload" }));
  await emit({ event: "export", format: "xml", xml: changed });
  await emit({ event: "load" });
  await emit({ event: "export", format: "xml", xml: fixture });
  expect(screen.getByRole("alert").textContent).toMatch(/does not match/i);
  const oldWindow = frame.contentWindow;
  fireEvent.click(screen.getByRole("button", { name: /Retry editor/ }));
  frame = screen.getByTitle("draw.io editor") as HTMLIFrameElement;
  expect(frame.contentWindow).not.toBe(oldWindow);
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  await emit({ event: "init" }, oldWindow);
  expect(send).not.toHaveBeenCalled();
  await emit({ event: "init" });
  expect(commands().at(-1)!.xml).toBe(changed);
});

it("times out without silently downloading stale content; last capture is explicitly timestamped", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  await emit({ event: "export", format: "xml", xml: changed });
  fireEvent.click(screen.getByRole("button", { name: "Download .drawio" }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toMatch(/timed out/);
  expect(blobs).toHaveLength(0);
  const fallback = screen.getByRole("button", { name: /Download last capture/ });
  expect(fallback.textContent).toMatch(/\d{4}-\d\d-\d\dT/);
  fireEvent.click(fallback);
  expect(await blobs[0].text()).toBe(changed);
  expect(screen.getByText(/may omit unsynchronized edits/i)).toBeTruthy();
});

it("rejects unsupported multi-page snapshots without losing the prior capture or live editor access", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Protected reload" }));
  const multiple = fixture.replace('</mxfile>', '<diagram id="two"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>');
  await emit({ event: "export", format: "xml", xml: multiple });
  expect(screen.getByRole("alert").textContent).toMatch(/multi-page.*File > Save as/i);
  expect(commands().filter((c) => c.action === "load")).toHaveLength(1);
  expect(frame.parentElement!.hasAttribute("inert")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs[0].text()).toBe(fixture);
});

it("downloads bounded multi-page XML intact without replacing the single-page recovery capture", async () => {
  await mount();
  const multiple = fixture.replace('</mxfile>', '<diagram id="two"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>');
  fireEvent.click(screen.getByRole("button", { name: "Download .drawio" }));
  await emit({ event: "export", format: "xml", xml: multiple });
  expect(await blobs[0].text()).toBe(multiple);
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs[1].text()).toBe(fixture);
  expect(screen.getByRole("alert").textContent).toMatch(/multi-page.*reload.*unsupported/i);
});

it("shows Retry editor after the readiness deadline and removes all bridge timers on unmount", async () => {
  const rendered = render(<DrawioEditor initialXml={fixture} />);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(screen.getByRole("alert").textContent).toMatch(/20 seconds/);
  expect(screen.getByRole("button", { name: /Retry editor/ })).toBeTruthy();
  rendered.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries the retained capture after an operation timeout and a subsequent initialization timeout", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  await emit({ event: "export", format: "xml", xml: changed });
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs.at(-1)!.text()).toBe(changed);
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  fireEvent.click(screen.getByRole("button", { name: "Retry editor — reload last capture" }));
  // The replacement iframe is blocked; the host page stays mounted.
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(screen.getByRole("alert").textContent).toMatch(/20 seconds/);
  fireEvent.click(screen.getByRole("button", { name: "Retry editor — reload last capture" }));
  frame = screen.getByTitle("draw.io editor") as HTMLIFrameElement;
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  await emit({ event: "init" });
  expect(commands().at(-1)).toMatchObject({ action: "load", xml: changed });
  await emit({ event: "load" });
  await emit({ event: "export", format: "xml", xml: changed });
  expect(screen.getByRole("status").textContent).toBe("Editor ready.");
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs.at(-1)!.text()).toBe(changed);
});

it("clears captures with the host page and labels Retry's startup-fixture fallback honestly", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Capture" }));
  await emit({ event: "export", format: "xml", xml: changed });
  fireEvent.click(screen.getByRole("button", { name: /Download last capture/ }));
  expect(await blobs.at(-1)!.text()).toBe(changed);
  // A full page reload destroys the outer component and its in-memory ref.
  cleanup();
  render(<DrawioEditor initialXml={fixture} />);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(screen.queryByRole("button", { name: /Download last capture/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry editor — load startup fixture" }));
  frame = screen.getByTitle("draw.io editor") as HTMLIFrameElement;
  send = vi.spyOn(frame.contentWindow!, "postMessage");
  await emit({ event: "init" });
  expect(commands().at(-1)).toMatchObject({ action: "load", xml: fixture });
  await emit({ event: "load" });
  await emit({ event: "export", format: "xml", xml: fixture });
  expect(screen.getByRole("status").textContent).toBe("Editor ready.");
});

// These exercise the parent-facing command, where failures must reject with their cause.
it('rejects an invalid replacement target before export or locking, then permits Capture', async () => {
  const editor = createRef<EditorHandle>();
  await mount(editor);
  const before = commands().length;
  await act(async () => {
    await expect(editor.current!.replace({xml:'<mxfile/>',validation:'generated'})).rejects.toThrow();
  });
  expect(commands()).toHaveLength(before);
  expect(frame.parentElement!.hasAttribute('inert')).toBe(false);
  fireEvent.click(screen.getByRole('button', {name:'Capture'}));
  await emit({event:'export',format:'xml',xml:changed});
  fireEvent.click(screen.getByRole('button', {name:/Download last capture/}));
  expect(await blobs.at(-1)!.text()).toBe(changed);
});
it('rejects snapshot timeout before loading and keeps editor-owned save access', async () => {
  const editor = createRef<EditorHandle>();
  await mount(editor);
  let failed!: Promise<unknown>;
  act(() => {
    failed = expect(editor.current!.replace({xml:fixture,validation:'generated'})).rejects.toThrow(/snapshot.*timed out/i);
  });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await failed;
  expect(commands().filter(c=>c.action==='load')).toHaveLength(1);
  expect(frame.parentElement!.hasAttribute('inert')).toBe(false);
  expect(screen.getByRole('button', {name:/Retry editor/})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name:/Download last capture/}));
  expect(await blobs.at(-1)!.text()).toBe(fixture);
});
it('rejects mismatched replacement with its cause and retains the outgoing recovery XML', async () => {
  const editor = createRef<EditorHandle>();
  await mount(editor);
  let failed!: Promise<unknown>;
  act(() => {
    failed = expect(editor.current!.replace({xml:fixture,validation:'generated'})).rejects.toThrow(/does not match/i);
  });
  await emit({event:'export',format:'xml',xml:changed});
  await emit({event:'load'});
  await emit({event:'export',format:'xml',xml:changed});
  await failed;
  expect(frame.parentElement!.hasAttribute('inert')).toBe(true);
  fireEvent.click(screen.getByRole('button', {name:/Download last capture/}));
  expect(await blobs.at(-1)!.text()).toBe(changed);
});
it('rejects a concurrent replacement without interrupting the first one', async () => {
  const editor = createRef<EditorHandle>();
  await mount(editor);
  let replacing!: ReturnType<EditorHandle['replace']>;
  await act(async () => {
    replacing = editor.current!.replace({xml:fixture,validation:'generated'});
    await expect(editor.current!.replace({xml:fixture,validation:'generated'})).rejects.toThrow(/in progress/i);
  });
  expect(commands().filter(c=>c.action==='export')).toHaveLength(2);
  await emit({event:'export',format:'xml',xml:changed});
  await emit({event:'load'});
  await emit({event:'export',format:'xml',xml:fixture});
  await expect(replacing).resolves.toMatchObject({outgoing:{xml:changed},current:{xml:fixture}});
});

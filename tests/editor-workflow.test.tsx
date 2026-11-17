import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const png = {
  name: "canvas.png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
};
vi.mock("../lib/browser-images", () => ({
  prepareReference: async (file: File) => ({
    name: file.name,
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  }),
  fitProposal: async (request: object) => JSON.stringify(request),
  blankCanvasImage: () => ({ name: "canvas.png", dataUrl: "blank" }),
}));
import DiagramWorkspace from "../components/DiagramWorkspace";
const base = readFileSync("tests/fixtures/three-node.drawio", "utf8");
const candidate = base.replace('value="API"', 'value="Backend"');
let live = base;
let frame: HTMLIFrameElement;
let mismatch = false;
let dropExports = false;
let startupMismatch = false;
let sends: { action: string; xml?: string }[];
let holdPng = false;
let pngXml: string | undefined;
let bounds = { width: 600, height: 400 };
async function emit(data: object) {
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://embed.diagrams.net",
        source: frame.contentWindow,
        data: JSON.stringify(data),
      }),
    ),
  );
}
async function boot(strict = false, initialXml = base) {
  const app = <DiagramWorkspace initialXml={initialXml} />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  frame = (await screen.findByTitle("draw.io editor")) as HTMLIFrameElement;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
    (raw: unknown) => {
      const message = JSON.parse(String(raw));
      sends.push(message);
      queueMicrotask(() => {
        if (message.action === "load") {
          live = startupMismatch ? candidate : mismatch ? base : message.xml;
          window.dispatchEvent(
            new MessageEvent("message", {
              origin: "https://embed.diagrams.net",
              source: frame.contentWindow,
              data: JSON.stringify({ event: "load" }),
            }),
          );
        }
        if (
          message.action === "export" &&
          !dropExports &&
          !(holdPng && message.format === "png")
        )
          window.dispatchEvent(
            new MessageEvent("message", {
              origin: "https://embed.diagrams.net",
              source: frame.contentWindow,
              data: JSON.stringify({
                event: "export",
                format: message.format,
                xml: message.format === "png" ? (pngXml ?? message.xml) : live,
                data: message.format === "png" ? png.dataUrl : undefined,
                modelBounds: bounds,
              }),
            }),
          );
      });
    },
  );
  await emit({ event: "init" });
  await screen.findByText(
    startupMismatch ? "Editor unavailable" : "Editor ready",
  );
}
function proposalResponse() {
  return Response.json({
    ok: true,
    kind: "proposal",
    xml: candidate,
    summary: ["Change API: label"],
    requestId: "test",
    durationMs: 1,
  });
}
async function propose() {
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Rename API to Backend" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await screen.findByRole("button", { name: "Apply" });
}
beforeEach(() => {
  live = base;
  holdPng = false;
  pngXml = undefined;
  bounds = { width: 600, height: 400 };
  mismatch = false;
  dropExports = false;
  startupMismatch = false;
  sends = [];
  sessionStorage.setItem("diagram-studio:key", "visitor-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => proposalResponse()),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("applies a verified candidate and restores it with one-level Undo AI", async () => {
  await boot();
  await propose();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Changes applied.");
  expect(live).toContain('value="Backend"');
  fireEvent.click(screen.getByRole("button", { name: "Undo AI change" }));
  await screen.findByText(/Restored the diagram from before AI/);
  expect(live).toBe(base);
  expect(screen.queryByRole("button", { name: "Undo AI change" })).toBeNull();
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).backup,
  ).toContain("Backend");
});
it("rejects a stale proposal using a fresh snapshot even before an autosave", async () => {
  await boot();
  await propose();
  live = base.replace('x="290"', 'x="330"');
  const loads = sends.filter((message) => message.action === "load").length;
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText(/The diagram changed/);
  expect(sends.filter((message) => message.action === "load")).toHaveLength(
    loads,
  );
  expect(live).toContain('x="330"');
});
it("requires confirmation to undo after newer manual changes", async () => {
  await boot();
  await propose();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Changes applied.");
  live = candidate.replace("Backend", "My manual label");
  fireEvent.click(screen.getByRole("button", { name: "Undo AI change" }));
  await screen.findByRole("button", { name: "Restore before AI" });
  expect(live).toContain("My manual label");
  fireEvent.click(screen.getByRole("button", { name: "Restore before AI" }));
  await screen.findByText(/Restored the diagram from before AI/);
  expect(live).toBe(base);
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).backup,
  ).toContain("My manual label");
});
it("retains outgoing XML when a replacement cannot be verified", async () => {
  await boot();
  await propose();
  mismatch = true;
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByRole("button", { name: /Retry editor/ });
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).backup,
  ).toBe(base);
  expect(screen.queryByText("Changes applied.")).toBeNull();
});
it("ignores a canceled response that arrives late", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  await boot();
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Rename API" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => resolve(proposalResponse()));
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(live).toBe(base);
});
it("does not publish a closed startup effect in StrictMode", async () => {
  await boot(true);
  expect(screen.queryByText(/session closed/i)).toBeNull();
  expect(sends.filter((message) => message.action === "load")).toHaveLength(1);
});

it("offers recovery after startup timeout", async () => {
  vi.useFakeTimers();
  render(<DiagramWorkspace initialXml={base} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_001);
  });
  expect(screen.getByRole("button", { name: /Retry editor/ })).toBeTruthy();
});
it("offers recovery after an autosave capture timeout", async () => {
  await boot();
  vi.useFakeTimers();
  dropExports = true;
  await emit({ event: "autosave", xml: "untrusted unsolicited data" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_751);
  });
  expect(screen.getByRole("button", { name: /Retry editor/ })).toBeTruthy();
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).current,
  ).toBe(base);
});
it("keeps the unavailable storage warning when a corrupt draft cannot be replaced", async () => {
  sessionStorage.setItem("diagram-studio:recovery", "corrupt");
  await boot();
  await emit({ event: "autosave" });
  expect(screen.getByText(/Saved draft could not be read/)).toBeTruthy();
  expect(sessionStorage.getItem("diagram-studio:recovery")).toBe("corrupt");
});

it("invalidates a mismatched startup export and leaves recovery untouched", async () => {
  sessionStorage.setItem(
    "diagram-studio:recovery",
    JSON.stringify({ version: 1, current: base, backup: null, undo: null }),
  );
  startupMismatch = true;
  await boot();
  expect(screen.getByRole("button", { name: /Retry editor/ })).toBeTruthy();
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).current,
  ).toBe(base);
});

it("freezes ten references and prompt, rejects eleventh without losing them, and keeps images out of recovery", async () => {
  await boot();
  const input = screen.getByLabelText(/Attach images/) as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: Array.from(
        { length: 10 },
        (_, i) => new File(["x"], `ref-${i}.png`, { type: "image/png" }),
      ),
    },
  });
  await screen.findByText("10/10 reference images");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "eleventh.png", { type: "image/png" })] },
  });
  await screen.findByText(/up to 10 reference/i);
  expect(screen.getAllByRole("button", { name: /Remove ref-/ })).toHaveLength(
    10,
  );
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Original request" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await screen.findByRole("button", { name: "Apply" });
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.prompt).toBe("Original request");
  expect(body.referenceImages).toHaveLength(10);
  expect(body.canvasImage.dataUrl).toBe(png.dataUrl);
  expect(body.xml).toBe(base);
  expect(sessionStorage.getItem("diagram-studio:recovery")).not.toContain(
    "base64",
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove ref-0.png" }));
  expect(screen.getByText("9/10 reference images")).toBeTruthy();
});
it("cancels during PNG capture, unlocks editor, and never sends a later request", async () => {
  await boot();
  holdPng = true;
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Rename API" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await waitFor(() =>
    expect(
      sends.some((message) =>
        JSON.stringify(message).includes('"format":"png"'),
      ),
    ).toBe(true),
  );
  expect(frame.style.pointerEvents).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(frame.style.pointerEvents).toBe("auto");
  await emit({ event: "export", format: "png", xml: base, data: png.dataUrl });
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});
it("rejects mismatched image XML and retains prompt for retry", async () => {
  await boot();
  pngXml = candidate;
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Original prompt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await screen.findAllByText(/changed during.*capture/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("What should change?") as HTMLTextAreaElement).value,
  ).toBe("Original prompt");
  expect(frame.style.pointerEvents).toBe("auto");
});

it("includes an explicit blank image for an empty page without issuing a PNG export", async () => {
  const empty =
    '<mxfile><diagram name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  bounds = { width: 0, height: 0 };
  await boot(false, empty);
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Create from references" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.xml).toBe(empty);
  expect(body.canvasImage.dataUrl).toBe("blank");
  expect(
    sends.some((message) => JSON.stringify(message).includes('"format":"png"')),
  ).toBe(false);
});
it("rejects XML changes arriving via autosave during rendering", async () => {
  await boot();
  holdPng = true;
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Layout" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await waitFor(() =>
    expect(
      sends.some((message) =>
        JSON.stringify(message).includes('"format":"png"'),
      ),
    ).toBe(true),
  );
  live = candidate;
  await emit({ event: "autosave", xml: candidate });
  await emit({ event: "export", format: "png", xml: base, data: png.dataUrl });
  await screen.findAllByText(/changed during.*capture/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(frame.style.pointerEvents).toBe("auto");
});
it("does not substitute a blank snapshot when nonempty XML reports zero bounds", async () => {
  bounds = { width: 0, height: 0 };
  await boot();
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Layout" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await screen.findAllByText(/could not capture.*nonempty/i);
  expect(fetch).not.toHaveBeenCalled();
});
it("reschedules a pending manual draft save when visual capture is canceled", async () => {
  await boot();
  vi.useFakeTimers();
  live = candidate;
  await emit({ event: "autosave" });
  holdPng = true;
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Layout" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Suggest changes" }));
  await act(async () => {});
  expect(
    sends.some((message) => JSON.stringify(message).includes('"format":"png"')),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await emit({
    event: "export",
    format: "png",
    xml: candidate,
    data: png.dataUrl,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(751);
  });
  expect(
    JSON.parse(sessionStorage.getItem("diagram-studio:recovery")!).current,
  ).toBe(candidate);
  expect(fetch).not.toHaveBeenCalled();
});

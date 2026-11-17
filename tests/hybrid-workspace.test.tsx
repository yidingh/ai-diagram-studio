import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DiagramWorkspace from "../components/DiagramWorkspace";
import { createEmptyDocument } from "../lib/diagram/document";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
it("opens key settings without remounting the editor and collapses the AI panel", async () => {
  render(<DiagramWorkspace initialXml={createEmptyDocument()} />);
  const frame = await screen.findByTitle("draw.io editor");
  fireEvent.click(screen.getByRole("button", { name: "API key settings" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "visitor-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use key" }));
  expect(sessionStorage.getItem("diagram-studio:key")).toBe("visitor-test");
  fireEvent.click(screen.getByRole("button", { name: "Minimize AI panel" }));
  expect(screen.getByTitle("draw.io editor")).toBe(frame);
  expect(screen.getByRole("button", { name: "Ask AI" })).toBeTruthy();
});
it("restores the saved tab document before the initial load", async () => {
  const xml = createEmptyDocument().replace("Page 1", "Recovered");
  sessionStorage.setItem(
    "diagram-studio:recovery",
    JSON.stringify({ version: 1, current: xml, backup: null, undo: null }),
  );
  render(<DiagramWorkspace initialXml={createEmptyDocument()} />);
  const frame = (await screen.findByTitle(
    "draw.io editor",
  )) as HTMLIFrameElement;
  const send = vi.spyOn(frame.contentWindow!, "postMessage");
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://embed.diagrams.net",
        source: frame.contentWindow,
        data: JSON.stringify({ event: "init" }),
      }),
    ),
  );
  expect(
    send.mock.calls.some((call) => String(call[0]).includes("Recovered")),
  ).toBe(true);
});

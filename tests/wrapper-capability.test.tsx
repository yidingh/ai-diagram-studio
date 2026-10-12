import { readFileSync } from "node:fs";
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { DrawIoEmbed, type DrawIoEmbedRef } from "react-drawio";
import { afterEach, expect, it, vi } from "vitest";

const xml = readFileSync("tests/fixtures/three-node.drawio", "utf8");
afterEach(cleanup);

// Characterization of the pinned upstream package, NOT passing application
// protection tests. These demonstrate why the application uses a direct iframe bridge.
it("characterizes wrapper 1.0.7: a foreign init loads the fixture to wildcard origin", () => {
  const { container } = render(<DrawIoEmbed xml={xml} />);
  const frame = container.querySelector("iframe")!;
  const send = vi.spyOn(frame.contentWindow!, "postMessage");
  expect(send).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new MessageEvent("message", {
    origin: "https://unrelated.example", source: window,
    data: JSON.stringify({ event: "init" }),
  })));
  expect(send).toHaveBeenCalledWith(JSON.stringify({ action: "load", xml, autosave: false }), "*");
});

it("characterizes wrapper 1.0.7: same-origin wrong-window load reaches its callback", () => {
  const loaded = vi.fn();
  render(<DrawIoEmbed xml={xml} baseUrl="https://embed.diagrams.net" onLoad={loaded} />);
  act(() => window.dispatchEvent(new MessageEvent("message", {
    origin: "https://embed.diagrams.net", source: window,
    data: JSON.stringify({ event: "load" }),
  })));
  expect(loaded).toHaveBeenCalledTimes(1);
});

it("characterizes wrapper export passthrough and listener disposal", () => {
  const ref = createRef<DrawIoEmbedRef>();
  const exported = vi.fn();
  const { container, unmount } = render(<DrawIoEmbed ref={ref} xml={xml} onExport={exported} />);
  const send = vi.spyOn(container.querySelector("iframe")!.contentWindow!, "postMessage");
  // Upstream types omit the documented plain XML format; JS passes it through.
  // @ts-expect-error capability probe of underlying protocol support
  ref.current!.exportDiagram({ format: "xml" });
  expect(send).toHaveBeenCalledWith(JSON.stringify({ action: "export", format: "xml" }), "*");
  const event = new MessageEvent("message", {
    origin: "https://embed.diagrams.net", source: window,
    data: JSON.stringify({ event: "export", format: "xml", xml, message: {} }),
  });
  act(() => window.dispatchEvent(event));
  expect(exported).toHaveBeenCalledTimes(1);
  unmount();
  act(() => window.dispatchEvent(event));
  expect(exported).toHaveBeenCalledTimes(1);
});

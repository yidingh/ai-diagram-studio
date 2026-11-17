// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { POST } from "../app/api/propose/route";
import { createEmptyDocument } from "../lib/diagram/document";
const canvasImage = {
  name: "canvas.png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
};
const call = (
  key = "visitor-key",
  body: unknown = { prompt: "Draw a service", xml: createEmptyDocument() },
) =>
  POST(
    new Request("http://localhost/api/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        canvasImage,
        referenceImages: [],
        ...(body as object),
      }),
    }),
  );
const response = (output: unknown) =>
  Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(output) }],
      },
    ],
  });
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("requires visitor credentials even when a server key exists", async () => {
  vi.stubEnv("OPENAI_API_KEY", "owner-key");
  expect((await call("")).status).toBe(401);
  vi.unstubAllEnvs();
});
it("returns clarification without modifying the document", async () => {
  const fetch = vi.fn(async () =>
    response({ kind: "clarification", message: "Which service?", changes: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await call();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    ok: true,
    kind: "clarification",
    message: "Which service?",
  });
  expect(JSON.stringify(fetch.mock.calls)).not.toContain("owner-key");
});
it("isolates caller credentials and does not expose upstream errors", async () => {
  const keys: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      keys.push(new Headers(init.headers).get("authorization") ?? "");
      return Response.json(
        { error: { message: "private upstream body" } },
        { status: 401 },
      );
    }),
  );
  const first = await call("first-key");
  await call("second-key");
  expect(keys).toEqual(["Bearer first-key", "Bearer second-key"]);
  expect(await first.text()).not.toContain("private upstream");
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
    /first-key|second-key/,
  );
});
it("rejects cross-origin requests and oversize bodies before calling OpenAI", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await POST(
        new Request("http://localhost/api/propose", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            authorization: "Bearer key",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await call("key", { prompt: "x", xml: " ".repeat(4 * 1024 * 1024) }))
      .status,
  ).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});
it("validates model changes and derives the actual summary", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        kind: "proposal",
        message: "misleading narrative",
        changes: [
          {
            type: "addCell",
            xml: '<mxCell id="service" parent="1" vertex="1" value="Service" style="html=0;"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell>',
            beforeId: null,
          },
        ],
      }),
    ),
  );
  const result = await (await call()).json();
  expect(result).toMatchObject({ ok: true, kind: "proposal" });
  expect(result.summary).toEqual(["Add “Service” (service)"]);
  expect(result.xml).toContain('id="service"');
});
it("does not inherit owner organization/project routing and sends a supported schema", async () => {
  vi.stubEnv("OPENAI_ORG_ID", "owner-org");
  vi.stubEnv("OPENAI_PROJECT_ID", "owner-project");
  let sent: RequestInit | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      sent = init;
      return response({
        kind: "clarification",
        message: "Which one?",
        changes: [],
      });
    }),
  );
  expect((await call()).status).toBe(200);
  expect(new Headers(sent?.headers).has("openai-organization")).toBe(false);
  expect(new Headers(sent?.headers).has("openai-project")).toBe(false);
  expect(String(sent?.body)).not.toContain('"oneOf"');
  vi.unstubAllEnvs();
});
it("maps invalid UTF-8 to a client error", async () => {
  const request = new Request("http://localhost/api/propose", {
    method: "POST",
    headers: { authorization: "Bearer key" },
    body: new Uint8Array([0xff]),
  });
  expect((await POST(request)).status).toBe(400);
});
it("aborts one provider call at the deadline without retrying", async () => {
  vi.useFakeTimers();
  let upstreamSignal: AbortSignal | undefined;
  const fetch = vi.fn((_url, init) => {
    upstreamSignal = init.signal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetch);
  const pending = call();
  await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
  await vi.advanceTimersByTimeAsync(45_001);
  const result = await pending;
  expect(result.status).toBe(504);
  expect(upstreamSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("cancels provider work when the browser disconnects", async () => {
  let upstreamSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      upstreamSignal = init.signal;
      return new Promise<Response>(() => {});
    }),
  );
  const controller = new AbortController();
  const request = new Request("http://localhost/api/propose", {
    method: "POST",
    headers: { authorization: "Bearer key" },
    body: JSON.stringify({
      prompt: "Change",
      xml: createEmptyDocument(),
      canvasImage,
      referenceImages: [],
    }),
    signal: controller.signal,
  });
  const pending = POST(request);
  await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
  controller.abort();
  expect((await pending).status).toBe(499);
  expect(upstreamSignal?.aborted).toBe(true);
});
it("bounds summaries for long existing labels and rejects partial model batches", async () => {
  const xml = createEmptyDocument().replace(
    "</root>",
    '<mxCell id="long" parent="1" value="' + "a".repeat(13000) + '"/></root>',
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        kind: "proposal",
        message: "",
        changes: [{ type: "removeCell", cellId: "long" }],
      }),
    ),
  );
  const result = await (await call("key", { prompt: "Remove", xml })).json();
  expect(result.ok).toBe(true);
  expect(result.summary[0].length).toBeLessThan(200);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        kind: "proposal",
        message: "",
        changes: [
          { type: "removeCell", cellId: "long" },
          { type: "removeCell", cellId: "missing" },
        ],
      }),
    ),
  );
  expect((await call("key", { prompt: "Remove", xml })).status).toBe(422);
});

it("uses the incoming Host when Next.js normalizes the internal URL", async () => {
  const result = await POST(
    new Request("http://localhost:3000/api/propose", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      body: "{}",
    }),
  );
  expect(result.status).toBe(401);
  expect(await result.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
});

it.each([
  "http://localhost:3000",
  "http://127.0.0.1:4000",
  "https://evil.example",
  "null",
])("rejects an origin not matching the incoming host: %s", async (origin) => {
  const result = await POST(
    new Request("http://localhost:3000/api/propose", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin,
        "x-forwarded-host": "evil.example",
      },
      body: "{}",
    }),
  );
  expect(result.status).toBe(403);
});

it("sends labeled canvas and references as actual image content in one Responses call", async () => {
  let sent: Record<string, any> | undefined;
  const fetch = vi.fn(async (_url, init) => {
    sent = JSON.parse(String(init.body));
    return response({
      kind: "clarification",
      message: "Which layout?",
      changes: [],
    });
  });
  vi.stubGlobal("fetch", fetch);
  const image = {
    name: "ref.png",
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  };
  const result = await call("key", {
    prompt: "Match reference",
    xml: createEmptyDocument(),
    canvasImage: image,
    referenceImages: [image],
  });
  expect(result.status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    sent?.input[0].content.filter((part: any) => part.type === "input_image"),
  ).toEqual([
    { type: "input_image", image_url: image.dataUrl, detail: "auto" },
    { type: "input_image", image_url: image.dataUrl, detail: "auto" },
  ]);
  expect(
    sent?.input[0].content.map((part: any) => part.text).join(" "),
  ).toMatch(/Current canvas.*Reference 1/s);
});
it("rejects image MIME spoofing and missing canvas before provider work", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const body of [
    { prompt: "x", xml: createEmptyDocument(), canvasImage: undefined },
    {
      prompt: "x",
      xml: createEmptyDocument(),
      canvasImage: {
        name: "bad.png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
      referenceImages: [],
    },
  ]) {
    expect((await call("key", body)).status).toBe(400);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a truncated raster with a valid PNG header before OpenAI", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const bytes = Buffer.from(canvasImage.dataUrl.split(",")[1], "base64");
  const malformed = {
    ...canvasImage,
    dataUrl:
      "data:image/png;base64," + bytes.subarray(0, 35).toString("base64"),
  };
  expect(
    (
      await call("key", {
        prompt: "x",
        xml: createEmptyDocument(),
        canvasImage: malformed,
        referenceImages: [],
      })
    ).status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

import { expect, test } from "@playwright/test";
import { documentsMatch } from "../../lib/diagram/document";

test("hosted PNG protocol captures offscreen wide/tall content and an empty page", async ({
  page,
}) => {
  test.skip(
    process.env.TEST_HOSTED_EDITOR !== "1",
    "Opt in: real hosted image protocol, no AI call.",
  );
  await page.route("**/hosted-visual-smoke", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/hosted-visual-smoke");
  const results = await page.evaluate(async () => {
    const origin = "https://embed.diagrams.net";
    const frame = document.createElement("iframe");
    frame.style.width = "400px";
    frame.style.height = "300px";
    let pending:
      | {
          event: string;
          format?: string;
          resolve: (data: any) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    const wait = (event: string, format?: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Hosted ${format ?? event} timeout`)),
          20000,
        );
        pending = { event, format, resolve, reject, timer };
      });
    window.addEventListener("message", (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== origin ||
        typeof event.data !== "string"
      )
        return;
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        !pending ||
        data.event !== pending.event ||
        (pending.format && data.format !== pending.format)
      )
        return;
      const current = pending;
      pending = undefined;
      clearTimeout(current.timer);
      if (data.error)
        current.reject(new Error(`Hosted export error: ${data.error}`));
      else current.resolve(data);
    });
    const request = (action: object, event: string, format?: string) => {
      const response = wait(event, format);
      frame.contentWindow!.postMessage(JSON.stringify(action), origin);
      return response;
    };
    const ready = wait("init");
    frame.src = origin + "/?embed=1&proto=json&noExitBtn=1&drafts=0";
    document.body.append(frame);
    await ready;
    const output = [];
    for (const [name, x, y] of [
      ["wide", 4000, 0],
      ["tall", 0, 4000],
      ["empty", 0, 0],
    ] as const) {
      const cells =
        name === "empty"
          ? ""
          : `<mxCell id="start" value="Start" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell><mxCell id="offscreen" value="Offscreen" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry"/></mxCell>`;
      const xml = `<mxfile><diagram name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
      await request({ action: "load", xml }, "load");
      const before = await request(
        { action: "export", format: "xml" },
        "export",
        "xml",
      );
      const bounds = before.modelBounds;
      if (!bounds) throw new Error("Hosted XML export missing modelBounds");
      if (name === "empty") {
        expectEmpty(bounds);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        canvas.getContext("2d")!.fillRect(0, 0, 1, 1);
        output.push({
          name,
          before: before.xml,
          after: before.xml,
          width: 1,
          height: 1,
          blank: true,
        });
        continue;
      }
      const scale = Math.min(
        1,
        1600 / Math.max(bounds.width, bounds.height, 1),
      );
      const png = await request(
        {
          action: "export",
          format: "png",
          xml: before.xml,
          scale,
          currentPage: true,
          size: "diagram",
          border: 0,
          grid: false,
          background: "#ffffff",
          transparent: false,
        },
        "export",
        "png",
      );
      const image = new Image();
      image.src = png.data;
      await image.decode();
      output.push({
        name,
        before: before.xml,
        after: png.xml,
        width: image.naturalWidth,
        height: image.naturalHeight,
        blank: false,
      });
    }
    return output;
    function expectEmpty(bounds: any) {
      if (bounds.width !== 0 || bounds.height !== 0)
        throw new Error("Expected zero empty diagram bounds");
    }
  });
  for (const result of results) {
    expect(documentsMatch(result.before, result.after)).toBe(true);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1602);
    if (!result.blank) {
      expect(result.before).toContain('id="offscreen"');
      expect(Math.max(result.width, result.height)).toBeGreaterThan(1500);
    }
  }
  console.info(
    "Hosted visual captures",
    results.map(({ name, width, height, blank }) => ({
      name,
      width,
      height,
      blank,
    })),
  );
});

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const initialXml = readFileSync("tests/fixtures/three-node.drawio", "utf8");
// A controlled external iframe exercises browser message origins, downloads and refresh.
// It is deliberately separate from the opt-in real hosted editor smoke test.
const editorFixture = `<!doctype html><html><body>
<button id="manual">Make manual edit</button><pre id="label"></pre>
<script>
let xml='';
const send = data => parent.postMessage(JSON.stringify(data),'http://127.0.0.1:3000');
const render = () => document.querySelector('#label').textContent=xml;
const startup=setInterval(() => send({event:'init'}),50);
window.addEventListener('message',event => {
  if(event.source!==parent) return;
  const message=JSON.parse(event.data);
  if(message.action==='load') {clearInterval(startup);xml=message.xml;render();send({event:'load'});}
  if(message.action==='export') {
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;
    const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,600,400);
    context.fillStyle='black';context.fillText('Complete current diagram',10,30);
    send({event:'export',format:message.format,xml:message.xml||xml,data:message.format==='png'?canvas.toDataURL('image/png'):undefined,modelBounds:{width:600,height:400}});
  }
});
document.querySelector('#manual').onclick=()=>{xml=xml.replace('value="API"','value="Manual"').replace('value="Backend"','value="Manual"');render();send({event:'autosave',xml:'ignored unsolicited XML'});};
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route("https://embed.diagrams.net/**", (route) =>
    route.fulfill({ contentType: "text/html", body: editorFixture }),
  );
  await page.route("**/api/propose", async (route) => {
    const input = route.request().postDataJSON();
    expect(route.request().headers().authorization).toBe("Bearer test-key");
    expect(input.canvasImage.dataUrl).toMatch(
      /^data:image\/(png|jpeg);base64,/,
    );
    expect(input.referenceImages).toEqual([]);
    await route.fulfill({
      json: {
        ok: true,
        kind: "proposal",
        xml: input.xml.replace('value="API"', 'value="Backend"'),
        summary: ["Change “API” (api): label"],
        requestId: "browser-test",
        durationMs: 1,
      },
    });
  });
  await page.addInitScript((xml) => {
    if (!sessionStorage.getItem("diagram-studio:recovery"))
      sessionStorage.setItem(
        "diagram-studio:recovery",
        JSON.stringify({ version: 1, current: xml, backup: null, undo: null }),
      );
  }, initialXml);
  await page.goto("/");
  await expect(page.getByText("Editor ready")).toBeAttached();
});
async function suggest(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "API key settings" }).click();
  await page.getByLabel("OpenAI API key").fill("test-key");
  await page.getByRole("button", { name: "Use key" }).click();
  await page.getByLabel("What should change?").fill("Rename API to Backend");
  await page.getByRole("button", { name: "Suggest changes" }).click();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
}
test("review, Apply, minimize, refresh, download and Undo AI", async ({
  page,
}) => {
  await suggest(page);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#label")).toContainText('value="API"');
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Changes applied.")).toBeVisible();
  await expect(frame.locator("#label")).toContainText('value="Backend"');
  await page.getByRole("button", { name: "Minimize AI panel" }).click();
  await expect(frame.locator("#label")).toContainText('value="Backend"');
  await page.getByRole("button", { name: "Ask AI" }).click();
  await page.reload();
  await expect(page.getByText("Editor ready")).toBeAttached();
  await expect(frame.locator("#label")).toContainText('value="Backend"');
  await page.getByText("Files and recovery", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download .drawio", exact: true })
    .click();
  const downloaded = await downloading;
  expect(readFileSync((await downloaded.path())!, "utf8")).toContain(
    'value="Backend"',
  );
  await page.getByRole("button", { name: "Undo AI change" }).click();
  await expect(
    page.getByText(/Restored the diagram from before AI/),
  ).toBeVisible();
  await expect(frame.locator("#label")).toContainText('value="API"');
});
test("stale Apply leaves manual edits untouched and key can be cleared", async ({
  page,
}) => {
  await suggest(page);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Make manual edit" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/The diagram changed/)).toBeVisible();
  await expect(frame.locator("#label")).toContainText('value="Manual"');
  await page.getByRole("button", { name: "API key settings" }).click();
  await page.getByRole("button", { name: "Clear key" }).click();
  expect(
    await page.evaluate(() => sessionStorage.getItem("diagram-studio:key")),
  ).toBeNull();
});

async function referenceFile(
  page: import("@playwright/test").Page,
  name: string,
  width = 100,
  height = 80,
) {
  const dataUrl = await page.evaluate(
    ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "black";
      context.font = "24px sans-serif";
      context.fillText("Reference layout", 5, 30);
      return canvas.toDataURL("image/png");
    },
    { width, height },
  );
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(dataUrl.split(",")[1], "base64"),
  };
}
test("ten real raster references, rejection, removal, memory lifetime and automatic snapshot", async ({
  page,
}) => {
  const file = await referenceFile(page, "layout.png", 2400, 1200);
  await page.getByLabel("Attach images").setInputFiles(
    Array.from({ length: 10 }, (_, i) => ({
      ...file,
      name: `layout-${i}.png`,
    })),
  );
  await expect(page.getByText("10/10 reference images")).toBeVisible();
  const thumbnail = page.getByRole("img", {
    name: "Reference 1: layout-0.png",
  });
  expect(
    await thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBe(1600);
  await page
    .getByLabel("Attach images")
    .setInputFiles({ ...file, name: "eleventh.png" });
  await expect(page.getByText(/Attach up to 10 reference/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Remove layout-/ }),
  ).toHaveCount(10);
  let sent: any;
  await page.route("**/api/propose", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        kind: "clarification",
        message: "Captured visual context",
        requestId: "visual",
        durationMs: 1,
      },
    });
  });
  await page.getByRole("button", { name: "API key settings" }).click();
  await page.getByLabel("OpenAI API key").fill("test-key");
  await page.getByRole("button", { name: "Use key" }).click();
  await page.getByLabel("What should change?").fill("Use reference spacing");
  await page.getByRole("button", { name: "Suggest changes" }).click();
  await expect(page.getByText("Captured visual context")).toBeVisible();
  expect(sent.referenceImages).toHaveLength(10);
  expect(sent.canvasImage.dataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(
    4 * 1024 * 1024,
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("diagram-studio:recovery"),
    ),
  ).not.toContain("base64");
  await page.getByRole("button", { name: "Remove layout-0.png" }).click();
  await expect(page.getByText("9/10 reference images")).toBeVisible();
  await page.reload();
  await expect(page.getByText("0/10 reference images")).toBeVisible();
});
test("rejects invalid reference types and oversized source files without losing attachments", async ({
  page,
}) => {
  await page
    .getByLabel("Attach images")
    .setInputFiles(await referenceFile(page, "keep.png"));
  await expect(page.getByText("1/10 reference images")).toBeVisible();
  await page.getByLabel("Attach images").setInputFiles({
    name: "vector.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg/>"),
  });
  await expect(page.getByText(/Use PNG, JPEG or WebP reference/)).toBeVisible();
  await page.getByLabel("Attach images").setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/at most 5 MiB/)).toBeVisible();
  await expect(page.getByText("1/10 reference images")).toBeVisible();
});

test("fits eleven noisy images under the aggregate JSON budget with all references retained", async ({
  page,
}) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1200;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(1200, 1200);
    let seed = 17;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  });
  const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
  await page.getByLabel("Attach images").setInputFiles(
    Array.from({ length: 10 }, (_, i) => ({
      name: `noise-${i}.jpg`,
      mimeType: "image/jpeg",
      buffer,
    })),
  );
  await expect(page.getByText("10/10 reference images")).toBeVisible();
  const preparedSize = await page
    .locator(".reference-images img")
    .evaluateAll((images) =>
      images.reduce(
        (sum, image) => sum + (image as HTMLImageElement).src.length,
        0,
      ),
    );
  expect(preparedSize).toBeGreaterThan(4 * 1024 * 1024);
  let sent: any;
  await page.route("**/api/propose", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        kind: "clarification",
        message: "Budget fit",
        requestId: "budget",
        durationMs: 1,
      },
    });
  });
  await page.getByRole("button", { name: "API key settings" }).click();
  await page.getByLabel("OpenAI API key").fill("test-key");
  await page.getByRole("button", { name: "Use key" }).click();
  await page.getByLabel("What should change?").fill("Match the references");
  await page.getByRole("button", { name: "Suggest changes" }).click();
  await expect(page.getByText("Budget fit")).toBeVisible();
  expect(sent.referenceImages).toHaveLength(10);
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(
    4 * 1024 * 1024,
  );
  for (const image of [sent.canvasImage, ...sent.referenceImages])
    expect(
      Buffer.from(image.dataUrl.split(",")[1], "base64").length,
    ).toBeLessThanOrEqual(512 * 1024);
});

test("compresses a dense full-canvas PNG above the final request ceiling", async ({
  page,
}) => {
  const denseFixture = editorFixture
    .replace(
      "canvas.width=600;canvas.height=400;",
      "canvas.width=1200;canvas.height=1200;",
    )
    .replace(
      "context.fillStyle='black';context.fillText('Complete current diagram',10,30);",
      `const pixels=context.createImageData(1200,1200);let seed=17;for(let i=0;i<pixels.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;}context.putImageData(pixels,0,0);`,
    )
    .replace(
      "modelBounds:{width:600,height:400}",
      "modelBounds:{width:1200,height:1200}",
    );
  await page.route("https://embed.diagrams.net/**", (route) =>
    route.fulfill({ contentType: "text/html", body: denseFixture }),
  );
  await page.reload();
  await expect(page.getByText("Editor ready")).toBeAttached();
  await page.evaluate(() => {
    (window as any).largestExport = 0;
    window.addEventListener("message", (event) => {
      if (
        event.origin === "https://embed.diagrams.net" &&
        typeof event.data === "string"
      )
        (window as any).largestExport = Math.max(
          (window as any).largestExport,
          event.data.length,
        );
    });
  });
  let sent: any;
  await page.route("**/api/propose", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        kind: "clarification",
        message: "Dense capture fit",
        requestId: "dense",
        durationMs: 1,
      },
    });
  });
  await page.getByRole("button", { name: "API key settings" }).click();
  await page.getByLabel("OpenAI API key").fill("test-key");
  await page.getByRole("button", { name: "Use key" }).click();
  await page.getByLabel("What should change?").fill("Align cells");
  await page.getByRole("button", { name: "Suggest changes" }).click();
  await expect(page.getByText("Dense capture fit")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).largestExport),
  ).toBeGreaterThan(4 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(
    4 * 1024 * 1024,
  );
  expect(
    Buffer.from(sent.canvasImage.dataUrl.split(",")[1], "base64").length,
  ).toBeLessThanOrEqual(512 * 1024);
});

test("refuses a reference that cannot fit the readability floor without dropping existing images", async ({
  page,
}) => {
  await page
    .getByLabel("Attach images")
    .setInputFiles(await referenceFile(page, "keep.png"));
  await expect(page.getByText("1/10 reference images")).toBeVisible();
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1600;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(1600, 1600);
    let seed = 33;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.95);
  });
  await page.getByLabel("Attach images").setInputFiles({
    name: "too-detailed.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(dataUrl.split(",")[1], "base64"),
  });
  await expect(page.getByText(/cannot fit.*readable detail/)).toBeVisible();
  await expect(page.getByText("1/10 reference images")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove keep.png" }),
  ).toBeEnabled();
});

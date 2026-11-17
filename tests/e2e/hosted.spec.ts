import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("hosted editor retains a recovered diagram and downloads editable XML", async ({
  page,
}) => {
  test.skip(
    process.env.TEST_HOSTED_EDITOR !== "1",
    "Opt in: external hosted editor smoke test.",
  );
  const fixture = readFileSync("tests/fixtures/three-node.drawio", "utf8");
  await page.addInitScript((xml) => {
    if (!sessionStorage.getItem("diagram-studio:recovery"))
      sessionStorage.setItem(
        "diagram-studio:recovery",
        JSON.stringify({ version: 1, current: xml, backup: null, undo: null }),
      );
  }, fixture);
  await page.goto("/");
  await expect(page.getByText("Editor ready")).toBeAttached({ timeout: 30000 });
  await page.getByRole("button", { name: "Minimize AI panel" }).click();
  await page.getByRole("button", { name: "Ask AI" }).click();
  await page.reload();
  await expect(page.getByText("Editor ready")).toBeAttached({ timeout: 30000 });
  await page.getByText("Files and recovery", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download .drawio", exact: true })
    .click();
  const downloaded = await downloading;
  const xml = readFileSync((await downloaded.path())!, "utf8");
  expect(xml).toContain('value="API"');
  expect(xml).toContain('id="client-api"');
});

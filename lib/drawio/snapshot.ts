import { canonical, elements, parseXml } from "../diagram/document";

/** Snapshot inspection accepts multiple pages for intact download, never for AI editing. */
export function inspectSnapshot(xml: string): {
  xml: string;
  pageCount: number;
} {
  const tree = parseXml(xml);
  if (tree.name !== "mxfile") throw new Error("Expected complete mxfile XML.");
  const pages = elements(tree);
  if (!pages.length || pages.some((page) => page.name !== "diagram"))
    throw new Error("Invalid diagram envelope.");
  for (const page of pages) {
    const models = elements(page);
    if (models.length !== 1 || models[0].name !== "mxGraphModel")
      throw new Error("Compressed or unsupported editor XML.");
    const roots = elements(models[0]);
    if (roots.length !== 1 || roots[0].name !== "root")
      throw new Error("Missing model root.");
  }
  return { xml, pageCount: pages.length };
}
export function assertReloadMatches(
  expected: string,
  actual: string,
  initialFixture = false,
): void {
  if (
    inspectSnapshot(expected).pageCount !== 1 ||
    inspectSnapshot(actual).pageCount !== 1
  ) {
    throw new Error("Multi-page reload/recovery is unsupported.");
  }
  const before = parseXml(expected);
  const after = parseXml(actual);
  // The editor adds default view settings to a newly opened empty document.
  if (initialFixture) {
    const expectedModel = elements(elements(before)[0])[0];
    const actualModel = elements(elements(after)[0])[0];
    for (const key of Object.keys(actualModel.attributes)) {
      if (!(key in expectedModel.attributes))
        delete actualModel.attributes[key];
    }
  }
  if (canonical(before, true) !== canonical(after, true)) {
    function difference(a: unknown, b: unknown, path = "document"): string {
      if (JSON.stringify(a) === JSON.stringify(b)) return "";
      if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const found = difference(a[i], b[i], `${path}[${i}]`);
          if (found) return found;
        }
      }
      return `${path}: ${JSON.stringify(a)?.slice(0, 100)} → ${JSON.stringify(b)?.slice(0, 100)}`;
    }
    throw new Error(
      "Reloaded document does not match the captured document. Retry to recover the retained version. " +
        difference(
          JSON.parse(canonical(before, true)),
          JSON.parse(canonical(after, true)),
        ),
    );
  }
}

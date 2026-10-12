import { SaxesParser } from "saxes";
import { MAX_XML_BYTES, MAX_XML_DEPTH, MAX_XML_ELEMENTS } from "./limits";

type Tree = { name: string; attributes: Record<string, string>; children: (Tree | string)[] };
const structural = new Set(["mxfile", "diagram", "mxGraphModel", "root", "mxCell", "mxGeometry", "Array"]);
// EditorUi.createFileData removes/sets these serialization metadata attributes.
// Ignore them only in comparisons; original XML is always retained unchanged.
const envelopeMetadata = new Set(["host", "userAgent", "modified", "version", "editor", "pages", "type", "etag"]);

/** Bounded snapshot inspection and comparison, not a graph validator,
 * assembler, generated-content policy, or import pipeline. */
function readSnapshot(xml: string): { root: Tree; pageCount: number } {
  if (!xml || new TextEncoder().encode(xml).length > MAX_XML_BYTES) {
    throw new Error("Snapshot is empty or exceeds 512 KiB. Use the editor's File > Save as path.");
  }
  let root: Tree | undefined;
  let count = 0;
  const stack: Tree[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", () => { throw new Error("Snapshot DTDs/entities are unsupported."); });
  parser.on("error", () => { throw new Error("Editor returned malformed XML. The last capture is retained."); });
  parser.on("opentag", (tag) => {
    if (++count > MAX_XML_ELEMENTS) throw new Error("Snapshot exceeds 2,000 XML elements. Use the editor's File > Save as path.");
    if (stack.length >= MAX_XML_DEPTH) throw new Error("Snapshot exceeds XML depth 32. Use the editor's File > Save as path.");
    const node: Tree = { name: tag.name, attributes: tag.attributes, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    stack.push(node);
  });
  // Merge parser text chunks so callback boundaries do not affect content comparison.
  const text = (value: string) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      const previous = parent.children[parent.children.length - 1];
      if (typeof previous === "string") parent.children[parent.children.length - 1] = previous + value;
      else parent.children.push(value);
    }
  };
  parser.on("text", text);
  parser.on("cdata", text);
  // Include opaque comments and processing instructions in comparison as well.
  parser.on("comment", (value) => { stack.at(-1)?.children.push({ name: "#comment", attributes: {}, children: [value] }); });
  parser.on("processinginstruction", (value) => { stack.at(-1)?.children.push({ name: "#pi", attributes: { target: value.target }, children: [value.body] }); });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  if (!root || root.name !== "mxfile") throw new Error("Expected complete editor mxfile XML, not an image or partial model.");
  const pages = root.children.filter((child): child is Tree => typeof child !== "string" && child.name === "diagram");
  if (!pages.length) throw new Error("Snapshot has no diagram page.");
  for (const page of pages) {
    const models = page.children.filter((child): child is Tree => typeof child !== "string" && child.name === "mxGraphModel");
    if (models.length !== 1) throw new Error("Compressed or unsupported editor XML. Use the editor's File > Save as path; the last capture is retained.");
    const roots = models[0].children.filter((child) => typeof child !== "string" && child.name === "root");
    if (roots.length !== 1) throw new Error("Snapshot is missing its complete model root.");
  }
  return { root, pageCount: pages.length };
}

/** Checks snapshot bounds and envelope, returning the untouched XML and page count or throwing. */
export function inspectSnapshot(xml: string): { xml: string; pageCount: number } {
  const { pageCount } = readSnapshot(xml);
  return { xml, pageCount };
}

/** Builds comparison data without rewriting XML; optional modelKeys ignores additional model attributes. */
function comparable(node: Tree, modelKeys?: Set<string>): unknown {
  const attributes = Object.entries(node.attributes)
    .filter(([key]) => !(node.name === "mxfile" && envelopeMetadata.has(key)))
    .filter(([key]) => !(node.name === "mxGraphModel" && modelKeys && !modelKeys.has(key)))
    .sort(([a], [b]) => a.localeCompare(b));
  // Ignore indentation in known structural elements, but retain text inside opaque manual content.
  const children = node.children.filter((child) => !(typeof child === "string" && !child.trim() && structural.has(node.name)))
    .map((child) => typeof child === "string" ? child : comparable(child, modelKeys));
  return [node.name, attributes, children];
}

/** Throws if single-page snapshots differ beyond allowed serialization changes.
 * initialFixture permits added model attributes for startup or generated targets, not manual reloads. */
export function assertReloadMatches(expected: string, actual: string, initialFixture = false): void {
  const first = readSnapshot(expected);
  const second = readSnapshot(actual);
  if (first.pageCount !== 1 || second.pageCount !== 1) throw new Error("Multi-page reload/recovery is unsupported.");
  const before = first.root;
  const after = second.root;
  // Startup and generated targets may omit editor default view settings. Their
  // callers enable this flag; manual reload/restore compares every model key.
  let keys: Set<string> | undefined;
  if (initialFixture) {
    const page = before.children.find((c): c is Tree => typeof c !== "string" && c.name === "diagram")!;
    const model = page.children.find((c): c is Tree => typeof c !== "string" && c.name === "mxGraphModel")!;
    keys = new Set(Object.keys(model.attributes));
  }
  if (JSON.stringify(comparable(before, keys)) !== JSON.stringify(comparable(after, keys))) {
    throw new Error("Reloaded document does not match the captured document. Download the retained capture, then Retry editor.");
  }
}

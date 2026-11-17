import { SaxesParser } from "saxes";
import { create } from "xmlbuilder2";
import type { XMLBuilder } from "xmlbuilder2/lib/interfaces";
import { AppError, byteLength } from "../contracts";
import {
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
} from "../drawio/limits";

export type Element = {
  name: string;
  attributes: Record<string, string>;
  children: Content[];
  before?: Content[];
  after?: Content[];
};
export type Content = Element | string;
const structural = new Set([
  "mxfile",
  "diagram",
  "mxGraphModel",
  "root",
  "mxCell",
  "mxGeometry",
  "Array",
]);
const metadata = new Set([
  "host",
  "userAgent",
  "modified",
  "version",
  "editor",
  "pages",
  "type",
  "etag",
]);
export function invalid(message: string): never {
  throw new AppError("INVALID_XML", message);
}
export function elements(node: Element): Element[] {
  return node.children.filter(
    (child): child is Element =>
      typeof child !== "string" && !child.name.startsWith("#"),
  );
}

/** A portable tree keeps comments, opaque text and attributes, including content we cannot edit. */
export function parseXml(xml: string): Element {
  if (!xml.trim() || byteLength(xml) > MAX_XML_BYTES)
    invalid("XML is empty or exceeds 512 KiB.");
  const parser = new SaxesParser({ xmlns: false });
  const stack: Element[] = [];
  let root: Element | undefined;
  let count = 0;
  const before: Content[] = [];
  const after: Content[] = [];
  const appendMetadata = (node: Element) => {
    if (stack.length) stack.at(-1)!.children.push(node);
    else (root ? after : before).push(node);
  };
  parser.on("error", () => invalid("Malformed XML."));
  parser.on("doctype", () =>
    invalid("DTD and entity declarations are forbidden."),
  );
  parser.on("opentag", (tag) => {
    if (++count > MAX_XML_ELEMENTS || stack.length >= MAX_XML_DEPTH)
      invalid("XML exceeds 2,000 elements or depth 32.");
    const node: Element = {
      name: tag.name,
      attributes: { ...tag.attributes },
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => {
    const parent = stack.at(-1);
    if (!parent) return;
    const last = parent.children.at(-1);
    if (typeof last === "string")
      parent.children[parent.children.length - 1] = last + value;
    else parent.children.push(value);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("comment", (value) => {
    appendMetadata({ name: "#comment", attributes: {}, children: [value] });
  });
  parser.on("processinginstruction", (value) => {
    appendMetadata({
      name: "#pi",
      attributes: { target: value.target },
      children: [value.body],
    });
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (!root) invalid("Missing document root.");
  if (before.length) root.before = before;
  if (after.length) root.after = after;
  return root;
}

function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}
export function serializeXml(root: Element): string {
  const doc = create();
  function append(parent: XMLBuilder, node: Content) {
    if (typeof node === "string") {
      parent.txt(node);
      return;
    }
    if (node.name === "#comment") {
      parent.com(node.children.join(""));
      return;
    }
    if (node.name === "#pi") {
      parent.ins(node.attributes.target, node.children.join(""));
      return;
    }
    const attributes = Object.fromEntries(
      Object.entries(node.attributes).map(([key, value]) => [
        key,
        encodeAttribute(value),
      ]),
    );
    const child = parent.ele(node.name, attributes);
    for (const item of node.children) append(child, item);
  }
  for (const node of root.before ?? []) append(doc, node);
  append(doc, root);
  for (const node of root.after ?? []) append(doc, node);
  return doc.end({ headless: true, wellFormed: true });
}

export function canonical(node: Content, ignoreMetadata = false): string {
  function value(item: Content): unknown {
    if (typeof item === "string") return item;
    const attrs = Object.entries(item.attributes)
      .filter(
        ([key]) =>
          !(
            ignoreMetadata &&
            ((item.name === "mxfile" && metadata.has(key)) ||
              (item.name === "mxGraphModel" && ["dx", "dy"].includes(key)))
          ),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    const children = item.children
      .filter(
        (child) =>
          !(
            typeof child === "string" &&
            !child.trim() &&
            structural.has(item.name)
          ),
      )
      .map(value);
    return [
      item.name,
      attrs,
      children,
      (item.before ?? []).map(value),
      (item.after ?? []).map(value),
    ];
  }
  return JSON.stringify(value(node));
}
export function documentsMatch(a: string, b: string): boolean {
  return canonical(parseXml(a), true) === canonical(parseXml(b), true);
}

export function documentRoot(tree: Element): Element {
  if (tree.name !== "mxfile") invalid("Expected a complete mxfile document.");
  const pages = elements(tree);
  if (pages.length !== 1 || pages[0].name !== "diagram")
    throw new AppError(
      "UNSUPPORTED_DOCUMENT",
      "AI editing and recovery support one page. Download multi-page documents using draw.io.",
    );
  const models = elements(pages[0]);
  if (models.length !== 1 || models[0].name !== "mxGraphModel")
    invalid("Expected uncompressed editor XML.");
  const roots = elements(models[0]);
  if (roots.length !== 1 || roots[0].name !== "root")
    invalid("Missing graph root.");
  return roots[0];
}
export function innerCell(record: Element): Element | undefined {
  if (record.name === "mxCell") return record;
  if (record.name === "object" || record.name === "UserObject")
    return elements(record).find((child) => child.name === "mxCell");
}
export function recordId(record: Element): string | undefined {
  return record.attributes.id ?? innerCell(record)?.attributes.id;
}
export function indexCells(root: Element): Map<string, Element> {
  const cells = new Map<string, Element>();
  for (const record of elements(root)) {
    const cell = innerCell(record);
    if (!cell) continue;
    const id = recordId(record);
    if (
      !id ||
      cells.has(id) ||
      (record !== cell && cell.attributes.id && cell.attributes.id !== id)
    )
      invalid("Missing, duplicate or inconsistent cell ID.");
    cells.set(id, record);
  }
  return cells;
}
export function validateDocument(xml: string): Element {
  const tree = parseXml(xml);
  const cells = indexCells(documentRoot(tree));
  if (
    !cells.has("0") ||
    innerCell(cells.get("0")!)!.attributes.parent !== undefined
  )
    invalid("Missing or invalid root cell.");
  for (const [id, record] of cells) {
    const cell = innerCell(record)!;
    if (
      id !== "0" &&
      (!cell.attributes.parent || !cells.has(cell.attributes.parent))
    )
      invalid("Unresolved cell parent.");
    if (cell.attributes.vertex === "1" && cell.attributes.edge === "1")
      invalid("A cell cannot be both vertex and edge.");
    for (const key of ["source", "target"])
      if (
        cell.attributes[key] !== undefined &&
        !cells.has(cell.attributes[key])
      )
        invalid("Unresolved connector reference.");
    const seen = new Set<string>();
    let ancestor: string | undefined = id;
    while (ancestor !== undefined) {
      if (seen.has(ancestor)) invalid("Cyclic parent hierarchy.");
      seen.add(ancestor);
      ancestor = innerCell(cells.get(ancestor)!)!.attributes.parent;
    }
  }
  function validateGeometry(node: Element) {
    if (["mxGeometry", "mxPoint", "mxRectangle"].includes(node.name)) {
      for (const key of ["x", "y", "width", "height"]) {
        const value = node.attributes[key];
        if (value === undefined) continue;
        const numeric = Number(value);
        if (
          !value.trim() ||
          !Number.isFinite(numeric) ||
          Math.abs(numeric) > 1_000_000 ||
          (["width", "height"].includes(key) && numeric < 0)
        )
          invalid("Invalid geometry.");
      }
    }
    for (const child of elements(node)) validateGeometry(child);
  }
  validateGeometry(tree);
  return tree;
}
export function createEmptyDocument(): string {
  return '<mxfile><diagram id="page-1" name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
}

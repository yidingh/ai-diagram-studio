import sanitizeHtml from "sanitize-html";
import {
  canonical,
  elements,
  innerCell,
  invalid,
  type Element,
} from "./document";

const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function styleParts(style = ""): string[] {
  return style.split(";").filter(Boolean);
}
function htmlEnabled(style = ""): boolean {
  let html = "0";
  for (const part of styleParts(style)) {
    if (part.startsWith("html=")) html = part.slice(5);
  }
  // draw.io interprets this flag numerically, including values such as "1.0".
  return Number(html) === 1;
}
function validateStyle(style: string, oldStyle = "") {
  const existing = new Set(styleParts(oldStyle));
  for (const part of styleParts(style)) {
    if (existing.has(part)) continue;
    const separator = part.indexOf("=");
    const key = separator < 0 ? "" : part.slice(0, separator);
    const value = separator < 0 ? part : part.slice(separator + 1);
    // Native formatting is open-ended. Only resource/executable content is
    // restricted here; unfamiliar keys, named styles and values pass through.
    const resourceKey =
      /^(?:image|indicatorImage|backgroundImage|fillImage|stencil|link|href|src)$/i;
    const executableKey = /^on[a-z]/i;
    const resourceValue =
      /(?:https?:|data:|javascript:|vbscript:|file:|blob:|\/\/|url\s*\(|stencil\s*\()/i;
    if (
      resourceKey.test(key) ||
      executableKey.test(key) ||
      resourceValue.test(value.replace(/[\x00-\x20]/g, ""))
    )
      invalid(
        "New styles cannot introduce external resources or executable content.",
      );
  }
}
const tags = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "br",
  "p",
  "div",
  "span",
  "ul",
  "ol",
  "li",
];
export function validateLabel(value: string, html: boolean) {
  if (value.length > 4000) invalid("Label exceeds 4,000 characters.");
  if (html) {
    const clean = sanitizeHtml(value, {
      allowedTags: tags,
      allowedAttributes: {},
      allowedSchemes: [],
    });
    // Allow the harmless HTML serialization of void tags, but never removed content.
    if (
      clean.replace(/<br\s*\/>/g, "<br>") !==
      value.replace(/<br\s*\/>/g, "<br>")
    )
      invalid(
        "New rich labels support basic formatting only, without attributes or resources.",
      );
  } else if (/<\/?[a-z][^>]*>/i.test(value))
    invalid("Use plain text or supported rich formatting for labels.");
}
const attributes: Record<string, string[]> = {
  mxCell: [
    "id",
    "value",
    "style",
    "parent",
    "source",
    "target",
    "vertex",
    "edge",
    "connectable",
    "visible",
    "collapsed",
  ],
  mxGeometry: ["x", "y", "width", "height", "relative", "as"],
  mxPoint: ["x", "y", "as"],
  mxRectangle: ["x", "y", "width", "height", "as"],
  Array: ["as"],
};
/** Compare each value/subtree with its old counterpart before applying new-content restrictions. */
export function validateChangedRecord(record: Element, previous?: Element) {
  function visit(node: Element, old?: Element) {
    if (old && canonical(node) === canonical(old)) return;
    if (node.name.startsWith("#"))
      invalid("AI cannot introduce comments or processing instructions.");
    const wrapper = node.name === "object" || node.name === "UserObject";
    if (!wrapper && !Object.hasOwn(attributes, node.name))
      invalid(`Unsupported new XML element: ${node.name}.`);
    for (const [key, value] of Object.entries(node.attributes)) {
      if (old?.attributes[key] === value) continue;
      if (key === "style") {
        validateStyle(value, old?.attributes.style);
        continue;
      }
      if (key === "label" || key === "value") {
        const cell = innerCell(record);
        validateLabel(value, htmlEnabled(cell?.attributes.style));
        continue;
      }
      if (wrapper) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ||
          /^(?:on|link|href|src|xmlns)/i.test(key) ||
          /(?:javascript:|data:|https?:|\/\/)/i.test(value)
        )
          invalid("Unsupported new wrapper attribute.");
      } else if (!attributes[node.name].includes(key))
        invalid(`Unsupported new ${node.name} attribute: ${key}.`);
      if (["x", "y", "width", "height"].includes(key)) {
        if (
          !number.test(value) ||
          !Number.isFinite(Number(value)) ||
          Math.abs(Number(value)) > 1_000_000 ||
          (["width", "height"].includes(key) && Number(value) < 0)
        )
          invalid("Invalid geometry.");
      }
    }
    for (const child of node.children) {
      if (typeof child !== "string" && child.name.startsWith("#")) {
        const unchanged = old?.children.some(
          (item) =>
            typeof item !== "string" && canonical(item) === canonical(child),
        );
        if (!unchanged)
          invalid("AI cannot introduce comments or processing instructions.");
      }
    }
    const childElements = elements(node);
    if (
      wrapper &&
      (childElements.length !== 1 || childElements[0].name !== "mxCell")
    )
      invalid("A wrapper must contain one mxCell.");
    const childrenAllowed: Record<string, string[]> = {
      mxCell: ["mxGeometry"],
      mxGeometry: ["mxPoint", "mxRectangle", "Array"],
      Array: ["mxPoint"],
      mxPoint: [],
      mxRectangle: [],
    };
    const oldChildren = old ? elements(old) : [];
    for (const child of childElements) {
      const previousChild = oldChildren.find(
        (candidate) =>
          candidate.name === child.name &&
          candidate.attributes.as === child.attributes.as,
      );
      if (previousChild && canonical(previousChild) === canonical(child))
        continue;
      if (!wrapper && !childrenAllowed[node.name]?.includes(child.name))
        invalid("Unsupported XML nesting.");
      visit(child, previousChild);
    }
    const text = node.children.filter(
      (child) => typeof child === "string" && child.trim(),
    );
    const oldText =
      old?.children.filter(
        (child) => typeof child === "string" && child.trim(),
      ) ?? [];
    if (JSON.stringify(text) !== JSON.stringify(oldText))
      invalid("AI cannot introduce opaque cell text.");
  }
  if (record.before?.length || record.after?.length)
    invalid("Cell fragments cannot contain document-level metadata.");
  const html = htmlEnabled(innerCell(record)?.attributes.style);
  const oldHtml = htmlEnabled(
    previous ? innerCell(previous)?.attributes.style : "",
  );
  if (html !== oldHtml) {
    validateLabel(
      record.attributes.label ?? innerCell(record)?.attributes.value ?? "",
      html,
    );
  }
  visit(record, previous);
}

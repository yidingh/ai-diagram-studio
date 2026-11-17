import { changesSchema, type Change } from "./change-schema";
import {
  canonical,
  documentRoot,
  elements,
  indexCells,
  innerCell,
  invalid,
  parseXml,
  recordId,
  serializeXml,
  validateDocument,
  type Element,
} from "./document";
import { styleParts, validateChangedRecord } from "./content-policy";

function label(record: Element): string {
  const value =
    record.attributes.label ??
    innerCell(record)?.attributes.value ??
    recordId(record) ??
    "";
  return value.length > 120 ? value.slice(0, 117) + "…" : value;
}
function details(before: Element, after: Element): string[] {
  const old = innerCell(before)!;
  const next = innerCell(after)!;
  const changes: string[] = [];
  if (
    (before.attributes.label ?? old.attributes.value) !==
    (after.attributes.label ?? next.attributes.value)
  )
    changes.push(`label → “${label(after)}”`);
  const display = (value: string | undefined) =>
    value === undefined
      ? "(unset)"
      : JSON.stringify(value.length > 80 ? value.slice(0, 77) + "…" : value);
  const difference = (
    key: string,
    previous: string | undefined,
    current: string | undefined,
  ) => `${key} ${display(previous)} → ${display(current)}`;
  if (old.attributes.style !== next.attributes.style) {
    const styleValues = (style: string | undefined) =>
      new Map(
        styleParts(style).map((part) => {
          const split = part.indexOf("=");
          return split < 0
            ? [part, "(named style)"]
            : [part.slice(0, split), part.slice(split + 1)];
        }),
      );
    const previous = styleValues(old.attributes.style);
    const current = styleValues(next.attributes.style);
    const keys = [...new Set([...previous.keys(), ...current.keys()])].filter(
      (key) => previous.get(key) !== current.get(key),
    );
    const entries = keys
      .slice(0, 10)
      .map((key) =>
        difference(key.slice(0, 80), previous.get(key), current.get(key)),
      );
    if (keys.length > 10)
      entries.push(`and ${keys.length - 10} more style properties`);
    changes.push(
      `style: ${entries.length ? entries.join("; ") : "entry order or duplicate entries"}`,
    );
  }
  const geometry = (cell: Element) =>
    elements(cell).find((node) => node.name === "mxGeometry");
  const previousGeometry = geometry(old);
  const currentGeometry = geometry(next);
  if (canonical(previousGeometry ?? "") !== canonical(currentGeometry ?? "")) {
    const entries: string[] = [];
    for (const key of ["x", "y", "width", "height"]) {
      const previous = previousGeometry?.attributes[key];
      const current = currentGeometry?.attributes[key];
      if (previous !== current)
        entries.push(difference(key, previous, current));
    }
    const extra = (node: Element | undefined) => {
      if (!node) return "";
      const copy = structuredClone(node);
      for (const key of ["x", "y", "width", "height"])
        delete copy.attributes[key];
      return canonical(copy);
    };
    if (extra(previousGeometry) !== extra(currentGeometry))
      entries.push("waypoints/geometry details");
    changes.push(`geometry: ${entries.join("; ")}`);
  }
  for (const key of ["source", "target"]) {
    if (old.attributes[key] !== next.attributes[key])
      changes.push(
        `connections: ${difference(key, old.attributes[key], next.attributes[key])}`,
      );
  }
  if (old.attributes.parent !== next.attributes.parent)
    changes.push(
      `grouping: ${difference("parent", old.attributes.parent, next.attributes.parent)}`,
    );
  const metadata = (record: Element) => {
    const copy = structuredClone(record);
    delete copy.attributes.label;
    const cell = innerCell(copy)!;
    for (const key of ["value", "style", "source", "target", "parent"])
      delete cell.attributes[key];
    cell.children = cell.children.filter(
      (child) => typeof child === "string" || child.name !== "mxGeometry",
    );
    return canonical(copy);
  };
  if (metadata(before) !== metadata(after)) changes.push("metadata");
  return changes;
}
/** Work on a newly parsed copy. Only the final, completely validated XML leaves this function. */
export function applyChanges(
  xml: string,
  input: Change[] | unknown,
): { xml: string; summary: string[] } {
  const parsed = changesSchema.safeParse(input);
  if (!parsed.success)
    invalid("Invalid change batch. Use 1–50 supported changes.");
  const tree = validateDocument(xml);
  const root = documentRoot(tree);
  const before = indexCells(root);
  const cells = new Map(before);
  const changed = new Set<string>();
  const positions: { id: string; beforeId: string }[] = [];
  for (const change of parsed.data) {
    const record =
      change.type === "addCell" || change.type === "replaceCell"
        ? parseXml(change.xml)
        : undefined;
    const id = change.type === "addCell" ? recordId(record!) : change.cellId;
    if (!id || id.length > 256 || id === "0" || changed.has(id))
      invalid("Each change needs a unique non-root target.");
    changed.add(id);
    const current = cells.get(id);
    if (change.type === "addCell") {
      if (current || !innerCell(record!))
        invalid("New cells require a unique ID and supported record.");
      validateChangedRecord(record!);
      cells.set(id, record!);
      root.children.push(record!);
    } else {
      if (!current) invalid(`Unknown cell: ${id}.`);
      const position = root.children.indexOf(current);
      if (change.type === "removeCell") {
        root.children.splice(position, 1);
        cells.delete(id);
      } else {
        let replacement: Element;
        if (change.type === "replaceCell") {
          if (recordId(record!) !== id || !innerCell(record!))
            invalid("Replacement must retain the target identity.");
          replacement = record!;
        } else {
          replacement = structuredClone(current);
          const cell = innerCell(replacement)!;
          if (change.label !== undefined) {
            if (replacement !== cell)
              replacement.attributes.label = change.label;
            else cell.attributes.value = change.label;
          }
          if (change.style) {
            let parts = styleParts(cell.attributes.style);
            for (const [key, value] of Object.entries(change.style)) {
              if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
                invalid("Invalid style key.");
              parts = parts.filter((part) => part.split("=")[0] !== key);
              if (value !== null) {
                if (/[;\x00-\x1f]/.test(value))
                  invalid("A style update must contain one literal value.");
                parts.push(`${key}=${value}`);
              }
            }
            cell.attributes.style = parts.length ? parts.join(";") + ";" : "";
          }
          if (change.geometry) {
            const geometry = elements(cell).find(
              (node) => node.name === "mxGeometry",
            );
            if (!geometry) invalid("Cell has no editable geometry.");
            for (const [key, value] of Object.entries(change.geometry))
              geometry.attributes[key] = String(value);
          }
        }
        validateChangedRecord(replacement, current);
        root.children[position] = replacement;
        cells.set(id, replacement);
      }
    }
    if ("beforeId" in change && change.beforeId)
      positions.push({ id, beforeId: change.beforeId });
  }
  for (const { id, beforeId } of positions) {
    const record = cells.get(id);
    const anchor = cells.get(beforeId);
    if (!record || !anchor || id === beforeId || beforeId === "0")
      invalid("Invalid drawing-order anchor.");
    root.children.splice(root.children.indexOf(record), 1);
    root.children.splice(root.children.indexOf(anchor), 0, record);
  }
  const result = serializeXml(tree);
  const serialized = validateDocument(result);
  if (canonical(tree) !== canonical(serialized))
    invalid("Serialization changed meaningful XML content.");
  const summary: string[] = [];
  for (const id of changed) {
    const old = before.get(id);
    const next = cells.get(id);
    if (!old) summary.push(`Add “${label(next!)}” (${id})`);
    else if (!next) summary.push(`Remove “${label(old)}” (${id})`);
    else {
      const fields = details(old, next);
      if (positions.some((position) => position.id === id))
        fields.push("drawing order");
      if (fields.length)
        summary.push(`Change “${label(old)}” (${id}): ${fields.join(", ")}`);
    }
  }
  return { xml: result, summary };
}

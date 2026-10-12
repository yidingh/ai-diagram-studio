import { AppError } from '../contracts';
import { MAX_EDGES, MAX_HEIGHT, MAX_ID_CHARS, MAX_LABEL_CHARS, MAX_NODES, MAX_POSITION, MAX_WIDTH, MIN_HEIGHT, MIN_NODES, MIN_WIDTH } from '../drawio/limits';

export type XmlElement = { name: string; attributes: Record<string, string>; children: (XmlElement | string)[] };
export type GeneratedCell = { attributes: Record<string, string>; geometry: Record<string, string> };
export const NODE_STYLES: Record<string, RegExp> = {
  shape: /^cylinder3$/, rounded: /^[01]$/, whiteSpace: /^wrap$/, html: /^0$/,
  fillColor: /^#[\da-fA-F]{6}$/, strokeColor: /^#[\da-fA-F]{6}$/, fontColor: /^#[\da-fA-F]{6}$/,
  fontSize: /^(1[0-9]|2[0-4])$/,
};
export const EDGE_STYLES: Record<string, RegExp> = {
  edgeStyle: /^orthogonalEdgeStyle$/, endArrow: /^classic$/, html: /^0$/, strokeColor: /^#[\da-fA-F]{6}$/,
};
export function invalid(message: string): never { throw new AppError('INVALID_XML', message); }

/** Extracts child elements, rejecting non-whitespace text between them. The predicate narrows the union. */
export function elementChildren(node: XmlElement): XmlElement[] {
  if (node.children.some(child => typeof child === 'string' && !/^[\x20\t\r\n]*$/.test(child))) {
    invalid('Unexpected text in generated XML.');
  }
  return node.children.filter((child): child is XmlElement => typeof child !== 'string');
}

/** Rejects extra attributes instead of silently dropping model content. */
function allowed(attributes: Record<string, string>, keys: string[]) {
  if (Object.keys(attributes).some(key => !keys.includes(key))) invalid('Unsupported generated XML attribute.');
}

/** Accepts finite decimal/scientific numbers within bounds, without coercing blank strings or hex. */
function numeric(value: string | undefined, min: number, max: number) {
  if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    invalid('Geometry requires finite numeric values.');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) invalid('Generated geometry is outside supported bounds.');
}

/** Checks the literal style syntax the editor will receive, including required plain text and arrows. */
function validateStyle(value: string, role: 'node' | 'edge') {
  const style = new Map<string, string>();
  const policy = role === 'node' ? NODE_STYLES : EDGE_STYLES;
  for (const entry of value.split(';')) {
    if (!entry.trim()) continue;
    const parts = entry.split('=');
    const key = parts[0].trim();
    const setting = parts[1]?.trim();
    // Trimming for acceptance but emitting the original string would validate different editor semantics.
    if (parts.length !== 2 || key !== parts[0] || setting !== parts[1] || style.has(key) ||
        !Object.hasOwn(policy, key) || !policy[key].test(setting ?? '')) {
      invalid('Unknown, duplicate, or invalid generated style.');
    }
    style.set(key, setting!);
  }
  if (style.get('html') !== '0' || (role === 'edge' && style.get('endArrow') !== 'classic')) {
    invalid('Plain-text style and directed edge arrows are required.');
  }
}

/** Requires one simple geometry child; nodes have bounded dimensions, edges have relative geometry. */
function validateGeometry(cell: XmlElement, role: 'node' | 'edge'): Record<string, string> {
  const children = elementChildren(cell);
  if (children.length !== 1 || children[0].name !== 'mxGeometry') invalid('Each cell requires exactly one mxGeometry.');
  const geometry = children[0];
  const attributes = geometry.attributes;
  if (elementChildren(geometry).length) invalid('Generated geometry cannot contain waypoints or children.');
  allowed(attributes, role === 'node' ? ['x', 'y', 'width', 'height', 'as'] : ['relative', 'as']);
  if (attributes.as !== 'geometry') invalid('Invalid geometry role.');
  if (role === 'node') {
    numeric(attributes.x, 0, MAX_POSITION);
    numeric(attributes.y, 0, MAX_POSITION);
    numeric(attributes.width, MIN_WIDTH, MAX_WIDTH);
    numeric(attributes.height, MIN_HEIGHT, MAX_HEIGHT);
  } else if (attributes.relative !== '1') {
    invalid('Edges require relative geometry.');
  }
  return { ...attributes };
}

/** Validates one cell's identity, role, label, style, and geometry, returning serializable copies. */
export function validateGeneratedCell(cell: XmlElement): GeneratedCell {
  if (cell.name !== 'mxCell') invalid('Only mxCell fragments are permitted.');
  const attributes = cell.attributes;
  allowed(attributes, ['id', 'value', 'style', 'vertex', 'edge', 'parent', 'source', 'target']);
  if (!attributes.id || attributes.id.length > MAX_ID_CHARS ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(attributes.id) || attributes.parent !== '1') {
    invalid('Invalid generated cell ID or parent.');
  }
  const vertex = attributes.vertex === '1' && attributes.edge === undefined;
  const edge = attributes.edge === '1' && attributes.vertex === undefined;
  if (!vertex && !edge) invalid('Each cell must be exactly one vertex or edge.');
  if (vertex && (attributes.source !== undefined || attributes.target !== undefined)) invalid('Vertices cannot have endpoints.');
  if (edge && (!attributes.source || !attributes.target)) invalid('Edges require both endpoints.');
  const value = attributes.value ?? '';
  // Inspect decoded text: "x < 5" is plain text, while tag-shaped markup is forbidden.
  if (value.length > MAX_LABEL_CHARS || /<\/?[A-Za-z][^<>]*>|<!--|<!DOCTYPE/i.test(value)) {
    invalid('Generated labels must be short plain text, without HTML markup.');
  }
  if (vertex && !value.trim()) invalid('Generated nodes require a label.');
  const role = vertex ? 'node' : 'edge';
  validateStyle(attributes.style ?? '', role);
  return { attributes: { ...attributes }, geometry: validateGeometry(cell, role) };
}

/** Checks relationships after all cells are known; edges may appear before their endpoints in XML. */
export function validateGeneratedGraph(cells: GeneratedCell[]): GeneratedCell[] {
  const ids = new Set<string>();
  const vertices = new Set<string>();
  let edges = 0;
  for (const { attributes } of cells) {
    if (ids.has(attributes.id)) invalid('Duplicate generated cell ID.');
    ids.add(attributes.id);
    if (attributes.vertex === '1') vertices.add(attributes.id);
    else edges++;
  }
  if (vertices.size < MIN_NODES || vertices.size > MAX_NODES || edges > MAX_EDGES) {
    invalid('Generate 3–12 nodes and at most 24 edges.');
  }
  for (const { attributes } of cells) {
    if (attributes.edge === '1' && (!vertices.has(attributes.source) || !vertices.has(attributes.target))) {
      invalid('Every edge endpoint must identify an output vertex.');
    }
  }
  return cells;
}

import { SaxesParser } from 'saxes';
import { create } from 'xmlbuilder2';
import { AppError, byteLength } from '../contracts';
import { MAX_FRAGMENT_BYTES, MAX_XML_BYTES, MAX_XML_DEPTH, MAX_XML_ELEMENTS } from '../drawio/limits';
import { elementChildren, invalid, validateGeneratedCell, validateGeneratedGraph, type GeneratedCell, type XmlElement } from './generated-policy';

/** Builds a bounded tree or throws. Fragments use a temporary root; strict documents reject comments/PI.
 * Manual preservation and generated validation deliberately remain separate policies. */
function parse(xml: string, generated = false, strict = false): XmlElement {
  if (byteLength(xml) > (generated ? MAX_FRAGMENT_BYTES : MAX_XML_BYTES)) {
    throw new AppError('LIMIT_EXCEEDED', 'XML byte limit exceeded.');
  }
  if (!xml.trim()) invalid('XML is empty.');
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let count = 0;
  parser.on('error', () => invalid('Malformed XML. No partial document was accepted.'));
  parser.on('doctype', () => invalid('DTD and entity declarations are forbidden.'));
  parser.on('xmldecl', () => {
    if (generated) invalid('Generated fragments cannot include an XML declaration.');
  });
  for (const event of ['comment', 'processinginstruction'] as const) {
    parser.on(event, () => {
      if (generated || strict) invalid('Comments and processing instructions are forbidden in generated XML.');
    });
  }
  parser.on('opentag', tag => {
    if (++count > MAX_XML_ELEMENTS + (generated ? 1 : 0) || stack.length >= MAX_XML_DEPTH) {
      throw new AppError('LIMIT_EXCEEDED', 'XML element or depth limit exceeded.');
    }
    const node: XmlElement = { name: tag.name, attributes: { ...tag.attributes }, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => { stack.at(-1)?.children.push(value); };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  // This fixed temporary root is parsing scaffolding, never final-document assembly.
  if (generated) parser.write('<fragments>');
  parser.write(xml);
  if (generated) parser.write('</fragments>');
  parser.close();
  if (!root) invalid('XML has no document root.');
  return root;
}

/** Validates individual fragments and their graph relationships before any serialization. */
function parseGeneratedFragments(xml: string): GeneratedCell[] {
  return validateGeneratedGraph(elementChildren(parse(xml, true)).map(validateGeneratedCell));
}

/** Preserves decoded attribute text across xmlbuilder2's entity/newline behavior.
 * Structure, quotes, and angle brackets are still escaped by the library. */
function attributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}
function attributes(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, attributeValue(value)]));
}

/** Creates the application-owned envelope and reserved cells, returning the builder at root. */
function shell() {
  const root = create().ele('mxfile').ele('diagram', { id: 'prototype-page', name: 'Prototype' })
    .ele('mxGraphModel', { grid: '1', gridSize: '10', page: '1', pageWidth: '850', pageHeight: '1100' }).ele('root');
  root.ele('mxCell', { id: '0' });
  root.ele('mxCell', { id: '1', parent: '0' });
  return root;
}

/** An empty startup shell is valid editor content; only generated candidates require 3–12 nodes. */
export function createEmptyDocument(): string {
  return shell().end({ headless: true, wellFormed: true });
}

/** Takes untrusted fragments and returns a validated full document, or throws.
 * Serialization is private to this pipeline: no caller can inject arbitrary cell objects between stages. */
export function assembleGeneratedDocument(fragments: string): string {
  const cells = parseGeneratedFragments(fragments);
  const root = shell();
  for (const cell of cells) {
    root.ele('mxCell', attributes(cell.attributes)).ele('mxGeometry', attributes(cell.geometry));
  }
  const xml = root.end({ headless: true, wellFormed: true });
  validateGeneratedDocument(xml); // Check the serialized result, not just the pre-serialization objects.
  return xml;
}

/** Extracts each page's model root, rejecting compressed XML or unsupported envelopes. */
function documentRoots(tree: XmlElement): XmlElement[] {
  if (tree.name !== 'mxfile') invalid('Expected a complete uncompressed mxfile document.');
  const pages = elementChildren(tree);
  if (!pages.length || pages.some(page => page.name !== 'diagram')) invalid('Invalid diagram envelope.');
  return pages.map(page => {
    const models = elementChildren(page);
    if (models.length !== 1 || models[0].name !== 'mxGraphModel') {
      invalid('Compressed or unsupported editor XML. Use the editor File > Save as path.');
    }
    const roots = elementChildren(models[0]);
    if (roots.length !== 1 || roots[0].name !== 'root') invalid('Invalid model envelope.');
    return roots[0];
  });
}

/** Enforces the generated-content allowlist; returns counts for the candidate summary or throws. */
export function validateGeneratedDocument(xml: string): { nodeCount: number; edgeCount: number } {
  const tree = parse(xml, false, true);
  const roots = documentRoots(tree);
  if (roots.length !== 1) invalid('Generated diagrams must have one page.');
  const page = elementChildren(tree)[0];
  const model = elementChildren(page)[0];
  const wrappers: [XmlElement, string[]][] = [
    [tree, []], [page, ['id', 'name']],
    [model, ['grid', 'gridSize', 'page', 'pageWidth', 'pageHeight']], [roots[0], []],
  ];
  for (const [element, keys] of wrappers) {
    if (Object.keys(element.attributes).some(key => !keys.includes(key))) invalid('Unsupported generated document wrapper attribute.');
  }
  const cells = elementChildren(roots[0]);
  if (cells.length < 2) invalid('Missing reserved root and layer.');
  const same = (actual: Record<string, string>, expected: Record<string, string>) =>
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
  if (cells[0].name !== 'mxCell' || !same(cells[0].attributes, { id: '0' }) || elementChildren(cells[0]).length ||
      cells[1].name !== 'mxCell' || !same(cells[1].attributes, { id: '1', parent: '0' }) || elementChildren(cells[1]).length) {
    invalid('Invalid reserved root/layer cells.');
  }
  const validated = validateGeneratedGraph(cells.slice(2).map(validateGeneratedCell));
  const nodeCount = validated.filter(cell => cell.attributes.vertex === '1').length;
  return { nodeCount, edgeCount: validated.length - nodeCount };
}

/** Checks recovery eligibility without rewriting rich manual XML. Unsafe/unbounded input throws;
 * safe but unsupported graph structures return recoverable=false with the original XML for download. */
export function inspectEditorDocument(xml: string): { xml: string; recoverable: boolean; reason?: string } {
  const tree = parse(xml);
  const roots = documentRoots(tree);
  const unsupported = (reason: string) => ({ xml, recoverable: false, reason });
  if (roots.length !== 1) return unsupported('Multi-page reload/recovery is unsupported. Download intact XML or use File > Save as.');
  const cells = new Map<string, Record<string, string>>();
  let bad = false;

  /** Collects graph identities without reconstructing or restricting opaque manual elements. */
  function visit(node: XmlElement, parent?: XmlElement) {
    if (node.name === 'mxCell') {
      // Object wrappers can carry a cell's identity instead of the nested mxCell itself.
      const wrapper = parent && parent.name !== 'root' && parent.name !== 'mxCell' ? parent.attributes.id : undefined;
      const id = node.attributes.id ?? wrapper;
      if (!id || cells.has(id) || (wrapper && node.attributes.id && wrapper !== node.attributes.id)) {
        bad = true;
        return;
      }
      cells.set(id, node.attributes);
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child, node);
    }
  }
  visit(roots[0]);
  if (bad || !cells.has('0') || cells.get('0')!.parent !== undefined) {
    return unsupported('Duplicate, missing, or unsupported graph identities. Download intact XML.');
  }
  for (const [id, cell] of cells) {
    if (id !== '0' && (!cell.parent || !cells.has(cell.parent))) return unsupported('Unresolved cell parent. Download intact XML.');
    for (const reference of ['source', 'target']) {
      if (cell[reference] !== undefined && !cells.has(cell[reference])) return unsupported('Unresolved cell reference. Download intact XML.');
    }
    // Every parent may exist yet still form a cycle; walk ancestors to rule that out.
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (seen.has(current)) return unsupported('Cyclic parent hierarchy. Download intact XML.');
      seen.add(current);
      current = cells.get(current)?.parent;
    }
  }
  return { xml, recoverable: true };
}

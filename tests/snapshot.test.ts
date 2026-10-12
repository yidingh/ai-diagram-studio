import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { inspectSnapshot, assertReloadMatches } from "../lib/drawio/snapshot";

const fixture = readFileSync("tests/fixtures/three-node.drawio", "utf8");
const rich = fixture.replace('x="290"', 'x="333"').replace('value="API"', 'value="API &amp; more"')
  .replace('</root>', '<object id="001" label="Manual" custom="001"><mxCell vertex="1" parent="1" style="shape=cloud;html=1;"><mxGeometry x="80" y="300" width="90" height="60" as="geometry"/></mxCell></object><mxCell id="manual-edge" edge="1" parent="1" source="api" target="001"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="80" y="200"/></Array></mxGeometry></mxCell></root>');

it("retains full rich XML bytes, including metadata and manual geometry", () => {
  const snapshot = inspectSnapshot(rich);
  expect(snapshot.xml).toBe(rich);
  expect(snapshot.xml).toContain('custom="001"');
  expect(snapshot.xml).toContain('shape=cloud;html=1;');
  expect(snapshot.xml).toContain('<mxPoint x="80" y="200"/>');
});

it("accepts only formatting/attribute-order differences without rewriting either document", () => {
  const reordered = rich.replace('x="333" y="100"', 'y="100" x="333"').replace(/>\s+</g, "><");
  expect(() => assertReloadMatches(rich, reordered)).not.toThrow();
  expect(inspectSnapshot(reordered).xml).toBe(reordered);
});

it.each([
  ['label', rich.replace('API &amp; more', 'Wrong')],
  ['geometry', rich.replace('x="333"', 'x="334"')],
  ['style', rich.replace('shape=cloud', 'shape=ellipse')],
  ['metadata', rich.replace('custom="001"', 'custom="1"')],
  ['connector', rich.replace('target="001"', 'target="db"')],
  ['old document', fixture],
])("rejects a reload that changes %s", (_, changed) => {
  expect(() => assertReloadMatches(rich, changed)).toThrow(/match/i);
});

it.each([
  ['empty', ''], ['image', 'data:image/png;base64,abc'],
  ['truncated', fixture.slice(0, -30)],
  ['DTD', '<!DOCTYPE mxfile [<!ENTITY x "hello">]>' + fixture],
  ['external entity', '<!DOCTYPE mxfile SYSTEM "https://example.com/x">' + fixture],
  ['compressed', '<mxfile><diagram>abc123</diagram></mxfile>'],
  ['missing model root', '<mxfile><diagram><mxGraphModel/></diagram></mxfile>'],
])("fails safely for %s without salvaging partial XML", (_, xml) => {
  expect(() => inspectSnapshot(xml)).toThrow();
});

it("permits intact bounded multi-page downloads but rejects their reload", () => {
  const multiple = fixture.replace('</mxfile>', '<diagram id="two"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>');
  expect(inspectSnapshot(multiple)).toMatchObject({ xml: multiple, pageCount: 2 });
  expect(() => assertReloadMatches(multiple, multiple)).toThrow(/multi-page/i);
});

it("enforces the UTF-8 byte boundary", () => {
  const base = '<mxfile><diagram><mxGraphModel><root><mxCell value="TEXT"/></root></mxGraphModel></diagram></mxfile>';
  const max = base.replace('TEXT', 'a'.repeat(512 * 1024 - (base.length - 4)));
  expect(inspectSnapshot(max).xml).toBe(max);
  expect(() => inspectSnapshot(max.replace('aaa', '😀'))).toThrow(/512 KiB/i);
});

it("enforces element and nesting boundaries while streaming", () => {
  const wrap = (body: string) => `<mxfile><diagram><mxGraphModel><root>${body}</root></mxGraphModel></diagram></mxfile>`;
  expect(() => inspectSnapshot(wrap('<x/>'.repeat(1996)))).not.toThrow();
  expect(() => inspectSnapshot(wrap('<x/>'.repeat(1997)))).toThrow(/2,000/);
  expect(() => inspectSnapshot(wrap('<x>'.repeat(28) + '</x>'.repeat(28)))).not.toThrow();
  expect(() => inspectSnapshot(wrap('<x>'.repeat(29) + '</x>'.repeat(29)))).toThrow(/32/);
});

it("keeps meaningful whitespace in opaque manual text", () => {
  const a = fixture.replace('</root>', '<metadata> </metadata></root>');
  const b = a.replace('<metadata> </metadata>', '<metadata>  </metadata>');
  expect(() => assertReloadMatches(a, b)).toThrow(/match/i);
});

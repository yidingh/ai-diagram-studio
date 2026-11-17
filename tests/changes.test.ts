import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../lib/diagram/changes";
import { documentsMatch } from "../lib/diagram/document";
const base = readFileSync("tests/fixtures/three-node.drawio", "utf8");
const rich = base.replace(
  "</root>",
  '<object id="wrapped" label="Rich" custom="001"><mxCell vertex="1" parent="1" style="shape=image;image=https://example.com/a.png;html=1;"><mxGeometry x="20" y="300" width="100" height="60" as="geometry"/></mxCell></object><!--keep--></root>',
);
describe("hybrid changes", () => {
  it("updates only selected fields and preserves opaque content", () => {
    const result = applyChanges(rich, [
      {
        type: "updateCell",
        cellId: "api",
        label: "Backend",
        style: { fillColor: "#336699" },
        geometry: { x: 320 },
      },
    ]);
    expect(result.xml).toContain('custom="001"');
    expect(result.xml).toContain("image=https://example.com/a.png");
    expect(result.xml).toContain("<!--keep-->");
    expect(result.summary.join(" ")).toMatch(/label.*style.*geometry/);
  });
  it("accepts forward references and creates an arbitrary native shape", () => {
    const result = applyChanges(base, [
      {
        type: "addCell",
        xml: '<mxCell id="link2" edge="1" parent="1" source="api" target="cache"><mxGeometry relative="1" as="geometry"/></mxCell>',
      },
      {
        type: "addCell",
        xml: '<mxCell id="cache" vertex="1" parent="1" style="shape=hexagon;html=0;" value="Cache"><mxGeometry x="100" y="300" width="100" height="60" as="geometry"/></mxCell>',
      },
    ]);
    expect(result.summary).toHaveLength(2);
  });
  it("preserves an unchanged image inside a replacement", () => {
    const xml =
      '<object id="wrapped" label="Rich" custom="001"><mxCell vertex="1" parent="1" style="shape=image;image=https://example.com/a.png;html=1;"><mxGeometry x="60" y="300" width="100" height="60" as="geometry"/></mxCell></object>';
    expect(
      applyChanges(rich, [{ type: "replaceCell", cellId: "wrapped", xml }]).xml,
    ).toContain('x="60"');
  });
  it("rejects dependency loss atomically", () => {
    expect(() =>
      applyChanges(base, [
        { type: "updateCell", cellId: "api", label: "Changed" },
        { type: "removeCell", cellId: "api" },
      ]),
    ).toThrow();
    expect(base).not.toContain("Changed");
  });
  it("rejects newly introduced resources and unsafe HTML", () => {
    expect(() =>
      applyChanges(base, [
        {
          type: "updateCell",
          cellId: "api",
          style: { image: "https://evil.example" },
        },
      ]),
    ).toThrow();
    expect(() =>
      applyChanges(base, [
        {
          type: "updateCell",
          cellId: "api",
          label: "<script>alert(1)</script>",
        },
      ]),
    ).toThrow();
  });
  it("rejects root mutation, duplicate IDs, broken references and parent cycles", () => {
    expect(() =>
      applyChanges(base, [{ type: "removeCell", cellId: "0" }]),
    ).toThrow();
    expect(() =>
      applyChanges(base, [
        { type: "addCell", xml: '<mxCell id="api" parent="1"/>' },
      ]),
    ).toThrow();
    expect(() =>
      applyChanges(base, [
        { type: "addCell", xml: '<mxCell id="x" parent="missing"/>' },
      ]),
    ).toThrow();
    expect(() =>
      applyChanges(base, [
        { type: "addCell", xml: '<mxCell id="x" parent="y"/>' },
        { type: "addCell", xml: '<mxCell id="y" parent="x"/>' },
      ]),
    ).toThrow();
  });
  it("compares formatting semantically but retains opaque whitespace", () => {
    expect(documentsMatch(base, base.replace(/>\s+</g, "><"))).toBe(true);
    expect(
      documentsMatch(rich, rich.replace('custom="001"', 'custom="1"')),
    ).toBe(false);
  });
});

it("does not activate existing plain text when html mode changes", () => {
  const source = base.replace(
    'value="API"',
    'value="&lt;img src=&quot;https://evil.example/a&quot;&gt;"',
  );
  expect(() =>
    applyChanges(source, [
      { type: "updateCell", cellId: "api", style: { html: "1" } },
    ]),
  ).toThrow();
});
it("rejects injected style delimiters and new processing instructions", () => {
  expect(() =>
    applyChanges(base, [
      {
        type: "updateCell",
        cellId: "api",
        style: { fillColor: "#fff;html=1" },
      },
    ]),
  ).toThrow();
  expect(() =>
    applyChanges(base, [
      {
        type: "addCell",
        xml: '<mxCell id="new" parent="1"><?bad test?></mxCell>',
      },
    ]),
  ).toThrow();
});
it("preserves document-level comments and opaque wrapper text", () => {
  const source =
    "<!--release metadata-->" +
    rich.replace('custom="001">', 'custom="001"> opaque ');
  const record =
    '<object id="wrapped" label="Rich" custom="001"> opaque <mxCell vertex="1" parent="1" style="shape=image;image=https://example.com/a.png;html=1;"><mxGeometry x="60" y="300" width="100" height="60" as="geometry"/></mxCell></object>';
  const result = applyChanges(source, [
    { type: "replaceCell", cellId: "wrapped", xml: record },
  ]);
  expect(result.xml).toContain("<!--release metadata-->");
  expect(result.xml).toContain(" opaque ");
  expect(
    documentsMatch(source, source.replace("release metadata", "different")),
  ).toBe(false);
});
it("checks the last html style value before activating a label", () => {
  const source = base
    .replace(
      'value="API"',
      'value="&lt;img src=&quot;https://evil.example/a&quot;&gt;"',
    )
    .replaceAll("html=0;", "html=1;html=0;");
  expect(() =>
    applyChanges(source, [
      { type: "updateCell", cellId: "api", style: { html: "1" } },
    ]),
  ).toThrow();
});
it("edits groups, wrapped metadata and connector waypoints through XML records", () => {
  const grouped = applyChanges(base, [
    {
      type: "addCell",
      xml: '<mxCell id="group" parent="1" vertex="1" style="group;"><mxGeometry x="20" y="250" width="400" height="200" as="geometry"/></mxCell>',
    },
    {
      type: "addCell",
      xml: '<UserObject id="worker" label="Worker" owner="team-a"><mxCell parent="group" vertex="1" style="shape=hexagon;"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell></UserObject>',
    },
    {
      type: "addCell",
      xml: '<mxCell id="route" parent="1" edge="1" source="api" target="worker"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="150" y="230"/><mxPoint x="160" y="240"/></Array></mxGeometry></mxCell>',
    },
  ]);
  const rerouted = applyChanges(grouped.xml, [
    {
      type: "replaceCell",
      cellId: "route",
      xml: '<mxCell id="route" parent="1" edge="1" source="api" target="worker"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="170" y="230"/><mxPoint x="190" y="240"/></Array></mxGeometry></mxCell>',
    },
  ]);
  expect(rerouted.xml).toContain('owner="team-a"');
  expect(rerouted.xml).toContain('x="190"');
  expect(rerouted.summary[0]).toContain("geometry");
  expect(() =>
    applyChanges(grouped.xml, [{ type: "removeCell", cellId: "group" }]),
  ).toThrow(/parent/);
  expect(() =>
    applyChanges(grouped.xml, [
      { type: "removeCell", cellId: "group" },
      { type: "removeCell", cellId: "worker" },
      { type: "removeCell", cellId: "route" },
    ]),
  ).not.toThrow();
});
it("retains escaped text, unknown root content and untouched XML records", () => {
  const source = rich.replace(
    "</root>",
    "<metadata> original &amp; opaque </metadata></root>",
  );
  const result = applyChanges(source, [
    {
      type: "updateCell",
      cellId: "api",
      label: 'A & B "quotes"\nline',
      geometry: { width: 200, height: 90 },
    },
  ]);
  expect(result.xml).toContain("<metadata> original &amp; opaque </metadata>");
  expect(result.xml).toContain('custom="001"');
  expect(result.xml).toContain("&#10;");
});
it("supports rich labels, retains ordering and rejects malformed or oversized changes", () => {
  const result = applyChanges(base, [
    {
      type: "updateCell",
      cellId: "api",
      label: "<b>Backend</b><br>API",
      style: { html: "1" },
    },
  ]);
  expect(result.xml).toContain("&lt;b&gt;Backend");
  const ordered = applyChanges(base, [
    {
      type: "addCell",
      xml: '<mxCell id="extra" parent="1"/>',
      beforeId: "api",
    },
  ]);
  expect(ordered.xml.indexOf('id="extra"')).toBeLessThan(
    ordered.xml.indexOf('id="api"'),
  );
  expect(() =>
    applyChanges(base, [{ type: "addCell", xml: '<mxCell id="bad"' }]),
  ).toThrow();
  expect(() =>
    applyChanges(
      base,
      Array.from({ length: 51 }, (_, i) => ({
        type: "addCell",
        xml: `<mxCell id="new${i}" parent="1"/>`,
      })),
    ),
  ).toThrow();
});

it("does not treat viewport changes as manual content edits", () => {
  const before = base.replace(
    "<mxGraphModel ",
    '<mxGraphModel dx="1686" dy="900" ',
  );
  const after = before.replace('dx="1686"', 'dx="1326"');
  expect(documentsMatch(before, after)).toBe(true);
  expect(documentsMatch(before, after.replace('x="290"', 'x="300"'))).toBe(
    false,
  );
});

it("rejects non-finite geometry anywhere in the resulting document", () => {
  expect(() =>
    applyChanges(base.replace('x="290"', 'x="NaN"'), [
      { type: "updateCell", cellId: "client", label: "New" },
    ]),
  ).toThrow(/geometry/);
});

it("summarizes actual color, geometry and endpoint values without model prose", () => {
  const result = applyChanges(base, [
    {
      type: "updateCell",
      cellId: "api",
      style: { fillColor: "#336699" },
      geometry: { x: 330, width: 180 },
    },
    {
      type: "replaceCell",
      cellId: "api-db",
      xml: '<mxCell id="api-db" edge="1" parent="1" source="client" target="db" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;html=0;"><mxGeometry relative="1" as="geometry"/></mxCell>',
    },
  ]);
  expect(result.summary[0]).toContain('fillColor "#dae8fc" → "#336699"');
  expect(result.summary[0]).toContain('x "290" → "330"');
  expect(result.summary[0]).toContain('width "140" → "180"');
  expect(result.summary[1]).toContain('source "api" → "client"');
});

it("accepts unfamiliar native formatting through updates and XML records", () => {
  const nativeStyle =
    "customNamedStyle;shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;fillColor=lightblue;perimeter=ellipsePerimeter;customFutureOption=auto;";
  const added = applyChanges(base, [
    {
      type: "addCell",
      xml: `<mxCell id="cache" parent="1" vertex="1" value="Cache" style="${nativeStyle}"><mxGeometry x="50" y="200" width="120" height="80" as="geometry"/></mxCell>`,
    },
  ]);
  expect(added.xml).toContain(nativeStyle);
  const replaced = applyChanges(added.xml, [
    {
      type: "replaceCell",
      cellId: "cache",
      xml: `<mxCell id="cache" parent="1" vertex="1" value="Cache" style="${nativeStyle}labelPosition=right;verticalLabelPosition=top;"><mxGeometry x="50" y="200" width="120" height="80" as="geometry"/></mxCell>`,
    },
  ]);
  const updated = applyChanges(replaced.xml, [
    {
      type: "updateCell",
      cellId: "cache",
      style: {
        boundedLbl: "0",
        customFutureOption: "fit-content",
        fillColor: "rgb(12, 34, 56)",
      },
    },
  ]);
  expect(updated.xml).toContain("boundedLbl=0;");
  expect(updated.xml).toContain("customFutureOption=fit-content;");
  expect(updated.xml).toContain("labelPosition=right;");
  expect(updated.summary.join(" ")).toContain('boundedLbl "1" → "0"');
});

it.each([
  "image=/private/image.png;",
  "image=data:image/svg+xml,evil;",
  "customFutureOption=https://example.com/resource;",
  "customFutureOption=javascript:alert(1);",
  "shape=stencil(encoded-payload);",
])("still rejects new resource or executable styles: %s", (style) => {
  expect(() =>
    applyChanges(base, [
      {
        type: "addCell",
        xml: `<mxCell id="unsafe" parent="1" style="${style}"/>`,
      },
    ]),
  ).toThrow();
});

it.each(["01", "1.0", " 1 ", "1e0"])(
  "rechecks labels when a numeric html flag enables rendering: %s",
  (html) => {
    const source = base.replace(
      'value="API"',
      'value="&lt;img src=&quot;https://example.com/a&quot;&gt;"',
    );
    expect(() =>
      applyChanges(source, [
        { type: "updateCell", cellId: "api", style: { html } },
      ]),
    ).toThrow();
  },
);

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { SaxesParser } from 'saxes';
import { expect, it } from 'vitest';
import { parseModelEnvelope } from '../lib/contracts';
import { assembleGeneratedDocument, createEmptyDocument, inspectEditorDocument, validateGeneratedDocument } from '../lib/diagram/xml';

export const node = (id: string, value = 'API') => `<mxCell id="${id}" value="${value}" vertex="1" parent="1" style="html=0;"><mxGeometry x="0" y="0" width="100" height="60" as="geometry"/></mxCell>`;
export const fragments = node('client','Client') + node('api') + node('db','PostgreSQL') + '<mxCell id="link" edge="1" parent="1" source="client" target="api" style="html=0;endArrow=classic;"><mxGeometry relative="1" as="geometry"/></mxCell>';
const build = assembleGeneratedDocument;
function values(xml: string) { const result: string[]=[]; const p=new SaxesParser(); p.on('opentag',t=>{if(t.attributes.value!==undefined)result.push(t.attributes.value);}); p.write(xml).close(); return result; }
it('assembles the flat graph with one shell and reserved cells',()=>{
 const xml=build(fragments); expect(validateGeneratedDocument(xml)).toEqual({nodeCount:3,edgeCount:1});
 expect(xml.match(/ id="0"/g)).toHaveLength(1); expect(xml.match(/ id="1"/g)).toHaveLength(1);
 expect(inspectEditorDocument(xml).recoverable).toBe(true);
});
it('accepts structural XML whitespace but never non-whitespace character data',()=>{
 expect(()=>build(' \t\r\n'+fragments+'\n')).not.toThrow();
 for(const text of ['oops','&#160;','<![CDATA[no]]>'])expect(()=>build(fragments+text)).toThrow();
 expect(()=>build(fragments.replace('<mxGeometry','text<mxGeometry'))).toThrow();
});
it.each([
 ['ampersands','A &amp; B','A & B'], ['quotes','&quot;A&quot; &apos;B&apos;','"A" \'B\''],
 ['Unicode','雪 😀 café','雪 😀 café'], ['angle text','x &lt; 5 &amp; x &gt; 0','x < 5 & x > 0'],
 ['newlines','first&#10;second&#13;third&#9;tab','first\nsecond\rthird\ttab'],
 ['literal entities','&amp;amp; &amp;#10; &amp;#xA; &amp;unknown;','&amp; &#10; &#xA; &unknown;'],
 ['spaces','  spaced  ','  spaced  '],
])('round trips %s without changing decoded meaning',(_,encoded,decoded)=>{
 const xml=build(fragments.replace('value="API"',`value="${encoded}"`)); expect(values(xml)[1]).toBe(decoded);
});
it.each([
 ['duplicate ID',fragments.replace('id="db"','id="api"')], ['reserved ID',fragments.replace('id="db"','id="0"')],
 ['numeric ID',fragments.replace('id="db"','id="001"')], ['missing parent',fragments.replace(' parent="1"','')],
 ['wrong parent',fragments.replace('parent="1"','parent="api"')], ['bad endpoint',fragments.replace('target="api"','target="missing"')],
 ['edge to edge',fragments.replace('target="api"','target="link"')], ['both roles',fragments.replace('vertex="1"','vertex="1" edge="1"')],
 ['node endpoint',fragments.replace('vertex="1"','vertex="1" source="api"')], ['geometry missing',fragments.replace(/<mxGeometry[^>]*\/>/,'')],
 ['duplicate style',fragments.replace('html=0;','html=0;html=0;')], ['unknown style',fragments.replace('html=0;','html=0;image=https://example.com;')],
 ['missing html',fragments.replace('html=0;','')], ['HTML flag',fragments.replace('html=0;','html=1;')],
 ['HTML label',fragments.replace('value="API"','value="&lt;b&gt;API&lt;/b&gt;"')], ['link attr',fragments.replace('value="API"','link="https://example.com" value="API"')],
 ['wrapper',`<mxGraphModel>${fragments}</mxGraphModel>`], ['comment',fragments+'<!-- comment -->'], ['PI',fragments+'<?test x?>'],
 ['DTD','<!DOCTYPE x [<!ENTITY a "x">]>'+fragments], ['external entity','<!DOCTYPE x SYSTEM "https://example.com">'+fragments],
 ['declaration','<?xml version="1.0"?>'+fragments], ['extra tag',fragments+'<script/>'], ['truncated',fragments.slice(0,-5)],
 ['NaN',fragments.replace('x="0"','x="NaN"')], ['blank number',fragments.replace('x="0"','x=" "')], ['infinity',fragments.replace('x="0"','x="Infinity"')],
 ['negative',fragments.replace('x="0"','x="-1"')], ['width',fragments.replace('width="100"','width="401"')],
 ['undirected',fragments.replace('endArrow=classic;','')], ['edge geometry',fragments.replace('relative="1"','relative="0"')],
 ['waypoints',fragments.replace('relative="1" as="geometry"/>','relative="1" as="geometry"><mxPoint/></mxGeometry>')],
])('rejects %s, with no partial document',(_,xml)=>expect(()=>build(xml)).toThrow());
it('enforces counts, labels, IDs and geometry bounds',()=>{
 for(const n of [2,13])expect(()=>build(Array.from({length:n},(_,i)=>node('n'+i)).join(''))).toThrow();
 for(const n of [3,12])expect(()=>build(Array.from({length:n},(_,i)=>node('n'+i)).join(''))).not.toThrow();
 expect(()=>build(fragments.replace('value="API"',`value="${'a'.repeat(121)}"`))).toThrow();
 expect(()=>build(fragments.replace('id="db"',`id="${'a'.repeat(81)}"`))).toThrow();
 for(const [key,min,max] of [['x',0,4000],['y',0,4000],['width',40,400],['height',30,240]] as const){
  for(const v of [min,max])expect(()=>build(fragments.replace(new RegExp(` ${key}="[^"]*"`),` ${key}="${v}"`))).not.toThrow();
  for(const v of [min-1,max+1])expect(()=>build(fragments.replace(new RegExp(` ${key}="[^"]*"`),` ${key}="${v}"`))).toThrow();
 }
 const edge=fragments.slice(fragments.indexOf('<mxCell id="link"'));
 for(const n of [24,25]) { const xml=node('a')+node('b')+node('c')+Array.from({length:n},(_,i)=>edge.replace('id="link"',`id="e${i}"`).replace('source="client"','source="a"').replace('target="api"','target="b"')).join(''); if(n===24)expect(()=>build(xml)).not.toThrow(); else expect(()=>build(xml)).toThrow(); }
});
it('bounds bytes before parsing and checks final wrapper',()=>{
 expect(()=>build(' '.repeat(128*1024+1))).toThrow(/limit/i);
 expect(()=>validateGeneratedDocument(build(fragments).replace('parent="0"','parent="1"'))).toThrow();
 expect(()=>validateGeneratedDocument(createEmptyDocument())).toThrow();
 expect(inspectEditorDocument(createEmptyDocument()).recoverable).toBe(true);
});
it('validates strict JSON envelopes without fence stripping or coercion',()=>{
 expect(parseModelEnvelope(JSON.stringify({xml:fragments}))).toEqual({xml:fragments});
 for(const input of ['', '```json\n{}\n```','null','[]','{}','{"xml":1}','{"xml":"x","extra":true}'])expect(()=>parseModelEnvelope(input)).toThrow();
});
const fixture=readFileSync('tests/fixtures/three-node.drawio','utf8');
const rich=fixture.replace('</root>','<object id="001" label="Manual" custom="001"><mxCell vertex="1" parent="1" style="shape=cloud;html=1;"><mxGeometry x="80" y="300" width="90" height="60" as="geometry"/></mxCell></object><mxCell id="manual-edge" edge="1" parent="1" source="api" target="001"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="80" y="200"/></Array></mxGeometry></mxCell><metadata id="001"> opaque </metadata></root>');
it('preserves rich documents byte-for-byte without generation stripping',()=>{
 expect(inspectEditorDocument(rich)).toMatchObject({xml:rich,recoverable:true});
 expect(()=>validateGeneratedDocument(rich)).toThrow();
});
it.each([
 rich.replace('id="db"','id="api"'), rich.replace('target="001"','target="missing"'),
 rich.replace('id="1" parent="0"','id="1" parent="api"'),
 fixture.replace('</mxfile>','<diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>'),
])('keeps safe unsupported editor XML downloadable without recovery eligibility',xml=>{
 expect(inspectEditorDocument(xml)).toMatchObject({xml,recoverable:false});
});
it('enforces full XML byte, element and depth limits',()=>{
 expect(()=>inspectEditorDocument(' '.repeat(512*1024+1))).toThrow();
 expect(()=>inspectEditorDocument(fixture.replace('</root>','<x/>'.repeat(2000)+'</root>'))).toThrow();
 expect(()=>inspectEditorDocument(fixture.replace('</root>','<x>'.repeat(33)+'</x>'.repeat(33)+'</root>'))).toThrow();
 expect(()=>inspectEditorDocument('<!DOCTYPE mxfile>'+fixture)).toThrow();
});
it.each([' html = 0;','html= 0;','html=0 ;','html=0; shape=cylinder3;'])('rejects style syntax whose literal editor semantics differ: %s',style=>{
 expect(()=>build(fragments.replace('html=0;',style))).toThrow();
});

it('rejects padded directed-edge style keys and values',()=>{
 for(const style of ['endArrow =classic;','endArrow= classic;'])expect(()=>build(fragments.replace('endArrow=classic;',style))).toThrow();
});

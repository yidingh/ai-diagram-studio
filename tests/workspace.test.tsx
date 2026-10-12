import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DiagramWorkspace from '../components/DiagramWorkspace';
import { createEmptyDocument } from '../lib/diagram/xml';
const fixture=readFileSync('tests/fixtures/three-node.drawio','utf8');
const empty=createEmptyDocument();
const edited=empty.replace('</root>','<object id="001" label="Manual" custom="001"><mxCell vertex="1" parent="1" style="shape=cloud;html=1;"><mxGeometry x="80" y="300" width="90" height="60" as="geometry"/></mxCell></object></root>');
let frame:HTMLIFrameElement;let send:ReturnType<typeof vi.spyOn>;let fetchMock:ReturnType<typeof vi.fn>;
async function emit(data:object,source=frame.contentWindow){await act(async()=>{window.dispatchEvent(new MessageEvent('message',{origin:'https://embed.diagrams.net',source,data:JSON.stringify(data)}));});}
function commands():{action:string;xml?:string}[]{return send.mock.calls.map((args:unknown[])=>JSON.parse(args[0] as string));}
async function mount(){render(<DiagramWorkspace initialXml={empty}/>);frame=screen.getByTitle('draw.io editor') as HTMLIFrameElement;send=vi.spyOn(frame.contentWindow!,'postMessage');await emit({event:'init'});await emit({event:'load'});await emit({event:'export',format:'xml',xml:empty});}
async function generate(){fireEvent.change(screen.getByLabelText('Describe the diagram'),{target:{value:'Client API database'}});await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Generate'}));});}
async function replace(outgoing:string,target:string){await emit({event:'export',format:'xml',xml:outgoing});expect(commands().at(-1)).toMatchObject({action:'load',xml:target});await emit({event:'load'});await emit({event:'export',format:'xml',xml:target});}
beforeEach(()=>{vi.useFakeTimers();fetchMock=vi.fn(async()=>Response.json({ok:true,xml:fixture,requestId:'test-request',durationMs:5}));vi.stubGlobal('fetch',fetchMock);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
it('starts empty; generation and Discard never load the editor',async()=>{
 await mount();expect(commands()[0]).toMatchObject({xml:empty});await generate();expect(screen.getByText(/3 nodes, 2 edges/)).toBeTruthy();expect(commands().filter(c=>c.action==='load')).toHaveLength(1);
 expect((screen.getByRole('button',{name:'Generate'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Discard'}));expect(commands().filter(c=>c.action==='load')).toHaveLength(1);expect(screen.queryByRole('button',{name:/Apply new/})).toBeNull();
});
it('captures fresh rich manual edits on Apply, verifies, and restores reversibly',async()=>{
 await mount();await generate();frame.focus();fireEvent.click(screen.getByRole('button',{name:/Apply new/}));expect(frame.parentElement?.hasAttribute('inert')).toBe(true);expect(document.activeElement).not.toBe(frame);
 await emit({event:'export',format:'xml',xml:edited});expect(commands().at(-1)).toMatchObject({action:'load',xml:fixture});
 await emit({event:'load'});expect(screen.getByRole('button',{name:/Apply new/})).toBeTruthy();await emit({event:'export',format:'xml',xml:fixture});expect(screen.queryByRole('button',{name:/Apply new/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Restore previous'}));await replace(fixture,edited);fireEvent.click(screen.getByRole('button',{name:'Restore previous'}));await replace(edited,fixture);
});
it('retains candidate and outgoing XML after mismatch; retries outgoing in a new iframe',async()=>{
 await mount();await generate();fireEvent.click(screen.getByRole('button',{name:/Apply new/}));await emit({event:'export',format:'xml',xml:edited});await emit({event:'load'});await emit({event:'export',format:'xml',xml:empty});
 expect(screen.getByRole('button',{name:/Apply new/})).toBeTruthy();expect(screen.getByRole('button',{name:'Download candidate'})).toBeTruthy();expect(frame.parentElement?.hasAttribute('inert')).toBe(true);
 const old=frame.contentWindow;fireEvent.click(screen.getByRole('button',{name:/Retry editor/}));frame=screen.getByTitle('draw.io editor') as HTMLIFrameElement;send=vi.spyOn(frame.contentWindow!,'postMessage');await emit({event:'init'},old);expect(send).not.toHaveBeenCalled();await emit({event:'init'});expect(commands().at(-1)).toMatchObject({xml:edited});
});
it('keeps the previous slot through a failed Restore and preserves capture/reload history',async()=>{
 await mount();await generate();fireEvent.click(screen.getByRole('button',{name:/Apply new/}));await replace(edited,fixture);
 fireEvent.click(screen.getByRole('button',{name:'Capture'}));await emit({event:'export',format:'xml',xml:fixture});
 fireEvent.click(screen.getByRole('button',{name:'Protected reload'}));await replace(fixture,fixture);
 fireEvent.click(screen.getByRole('button',{name:'Restore previous'}));await emit({event:'export',format:'xml',xml:fixture});expect(commands().at(-1)).toMatchObject({xml:edited});
 await act(()=>vi.advanceTimersByTimeAsync(10_000));expect(screen.getByRole('button',{name:/Download previous/})).toBeTruthy();expect(screen.getByRole('button',{name:/Retry editor/})).toBeTruthy();
});
it('does not load after an unsupported fresh outgoing document or snapshot timeout',async()=>{
 await mount();await generate();fireEvent.click(screen.getByRole('button',{name:/Apply new/}));
 const multi=empty.replace('</mxfile>','<diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>');await emit({event:'export',format:'xml',xml:multi});expect(commands().filter(c=>c.action==='load')).toHaveLength(1);expect(screen.getByRole('button',{name:/Download unsupported/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/Apply new/}));await act(()=>vi.advanceTimersByTimeAsync(10_000));expect(commands().filter(c=>c.action==='load')).toHaveLength(1);expect(screen.getByRole('button',{name:/Download candidate/})).toBeTruthy();
});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const response=(requestId='new-request')=>Response.json({ok:true,xml:fixture,requestId,durationMs:1});
it('guards duplicate clicks synchronously, cancels upstream, and rejects a late success',async()=>{
 await mount();const old=deferred<Response>();fetchMock.mockReturnValue(old.promise);
 fireEvent.change(screen.getByLabelText('Describe the diagram'),{target:{value:'three nodes'}});
 act(()=>{const button=screen.getByRole('button',{name:'Generate'});fireEvent.click(button);fireEvent.click(button);});expect(fetchMock).toHaveBeenCalledTimes(1);
 expect(frame.parentElement?.hasAttribute('inert')).toBe(false);
 const signal=fetchMock.mock.calls[0][1].signal as AbortSignal;
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(signal.aborted).toBe(true);expect(screen.getByRole('alert').textContent).toMatch(/canceled.*Request:/i);
 await act(async()=>old.resolve(response('old')));expect(screen.queryByRole('region',{name:'Candidate'})).toBeNull();expect(screen.getByRole('button',{name:'Retry generation'})).toBeTruthy();
});
it.each(['success','error'] as const)('old %s and finally cannot modify a new attempt',async outcome=>{
 await mount();const old=deferred<Response>();const newer=deferred<Response>();fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
 await generate();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));fireEvent.click(screen.getByRole('button',{name:'Retry generation'}));
 expect(fetchMock).toHaveBeenCalledTimes(2);expect(fetchMock.mock.calls[0][1].signal).not.toBe(fetchMock.mock.calls[1][1].signal);
 await act(async()=>{if(outcome==='success')old.resolve(response('old'));else old.reject(new Error('secret old failure'));});
 expect(screen.getByRole('button',{name:'Cancel'})).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('region',{name:'Candidate'})).toBeNull();
 await act(async()=>newer.resolve(response('new')));expect(screen.getByRole('region',{name:'Candidate'}).textContent).toContain('Request: new');
});
it('uses a 50-second browser budget and explicit Retry with the original submitted prompt',async()=>{
 await mount();const old=deferred<Response>();fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response());await generate();
 await act(()=>vi.advanceTimersByTimeAsync(50_000));expect(screen.getByRole('alert').textContent).toMatch(/50 seconds.*Request:/);expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
 fireEvent.change(screen.getByLabelText('Describe the diagram'),{target:{value:'changed form'}});await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry generation'})));
 expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toBe('Client API database');await act(async()=>old.resolve(response('old')));expect(screen.getByRole('region',{name:'Candidate'}).textContent).not.toContain('Request: old');
});
it('checks the deadline even when the timer callback has not run',async()=>{
 await mount();const result=deferred<Response>();fetchMock.mockReturnValue(result.promise);await generate();vi.setSystemTime(Date.now()+50_001);
 await act(async()=>result.resolve(response()));expect(screen.queryByRole('region',{name:'Candidate'})).toBeNull();expect(screen.getByRole('alert').textContent).toMatch(/50 seconds/);
});
it('cancels while reading a delayed response body and prevents stale acceptance',async()=>{
 await mount();const canceled=vi.fn();const stream=new ReadableStream<Uint8Array>({cancel:canceled});fetchMock.mockResolvedValue(new Response(stream));await generate();
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await act(async()=>{});expect(canceled).toHaveBeenCalledTimes(1);expect(screen.queryByRole('region',{name:'Candidate'})).toBeNull();
});
it.each([
 ()=>Response.json({ok:false,code:'PROVIDER_ERROR',message:'Try again',requestId:'server-error'},{status:502}),
 ()=>Response.json({ok:true,xml:'<mxfile/>',requestId:'bad-xml',durationMs:1}),
 ()=>new Response('raw stack trace secret',{status:502}),
 ()=>new Response('x'.repeat(4*1024*1024)),
])('errors preserve current and previous, provide identity and never show raw output',async bad=>{
 await mount();await generate();fireEvent.click(screen.getByRole('button',{name:/Apply new/}));await replace(edited,fixture);fetchMock.mockResolvedValueOnce(bad());await generate();
 expect(screen.getByRole('alert').textContent).toMatch(/Request:/);expect(screen.getByRole('alert').textContent).not.toMatch(/<mxfile|stack trace|secret/);expect(screen.getByRole('button',{name:/Download previous/})).toBeTruthy();expect(commands().filter(c=>c.action==='load')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'Restore previous'}));await replace(fixture,edited);
});
it('unmount invalidates and aborts a pending attempt with no surviving timer',async()=>{
 await mount();const result=deferred<Response>();fetchMock.mockReturnValue(result.promise);await generate();const signal=fetchMock.mock.calls[0][1].signal;
 cleanup();expect(signal.aborted).toBe(true);// React act leaves immediate callbacks; flush only the current tick, not product deadlines.
 await act(()=>vi.advanceTimersByTimeAsync(0));expect(vi.getTimerCount()).toBe(0);await act(async()=>result.resolve(response()));
});
it('keeps editor interaction available during generation and captures those edits at Apply time',async()=>{
 await mount();const waiting=deferred<Response>();fetchMock.mockReturnValue(waiting.promise);await generate();
 expect(frame.parentElement?.hasAttribute('inert')).toBe(false);expect((screen.getByRole('button',{name:'Capture'}) as HTMLButtonElement).disabled).toBe(false);
 // The controlled editor's live XML is now edited, without a host capture.
 await act(async()=>waiting.resolve(response()));fireEvent.click(screen.getByRole('button',{name:/Apply new/}));await replace(edited,fixture);
 fireEvent.click(screen.getByRole('button',{name:'Restore previous'}));await replace(fixture,edited);
});
it('times out while reading the response body and cancels its reader',async()=>{
 await mount();const canceled=vi.fn();fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({cancel:canceled})));
 await generate();await act(()=>vi.advanceTimersByTimeAsync(50_000));expect(canceled).toHaveBeenCalledTimes(1);expect(screen.getByRole('alert').textContent).toMatch(/50 seconds/);expect(screen.queryByRole('region',{name:'Candidate'})).toBeNull();
});

// Candidate counts describe generated XML, not subsequent edits in the live iframe.
it('keeps the candidate summary through prompt changes and fresh manual captures', async () => {
 await mount(); await generate();
 fireEvent.change(screen.getByLabelText('Describe the diagram'), {target:{value:'another prompt'}});
 fireEvent.click(screen.getByRole('button', {name:'Capture'}));
 await emit({event:'export',format:'xml',xml:edited});
 expect(screen.getByRole('region', {name:'Candidate'}).textContent).toContain('3 nodes, 2 edges');
 expect(commands().filter(c=>c.action==='load')).toHaveLength(1);
});
it('serializes duplicate Apply and Restore clicks without losing outgoing edits', async () => {
 await mount(); await generate();
 const exportsBefore = commands().filter(c=>c.action==='export').length;
 act(() => {
  const apply=screen.getByRole('button', {name:/Apply new/});
  fireEvent.click(apply); fireEvent.click(apply);
 });
 expect(commands().filter(c=>c.action==='export')).toHaveLength(exportsBefore+1);
 await replace(edited,fixture);
 act(() => {
  const restore=screen.getByRole('button', {name:'Restore previous'});
  fireEvent.click(restore); fireEvent.click(restore);
 });
 expect(commands().filter(c=>c.action==='export')).toHaveLength(exportsBefore+3);
 await replace(fixture,edited);
 expect(commands().filter(c=>c.action==='load').map(c=>c.xml)).toEqual([empty,fixture,edited]);
});

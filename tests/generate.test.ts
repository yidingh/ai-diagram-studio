// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { generate } from '../lib/ai/generate';
const fixture=readFileSync('tests/fixtures/three-node.drawio','utf8');
// A fixture extraction used only in tests, never the production XML boundary.
const fragments=fixture.slice(fixture.indexOf('<mxCell id="client"'),fixture.indexOf('</root>'));
const good=JSON.stringify({xml:fragments});
const readInput=async()=>({prompt:'Client → API → PostgreSQL'});
const opts={readInput,requestId:'test-request',configured:true};
afterEach(()=>vi.useRealTimers());
it('validates input, makes one call and validates the complete output',async()=>{
 const call=vi.fn(async()=>({text:good})); const result=await generate({...opts,call});
 expect(result).toMatchObject({ok:true,requestId:'test-request'});expect(call).toHaveBeenCalledTimes(1);
 expect(call.mock.calls[0]).toHaveLength(2);
});
it.each([undefined,null,{}, {prompt:' '},{prompt:'x'.repeat(4001)},{prompt:'ok',extra:true}])('rejects invalid input without a call',async input=>{
 const call=vi.fn();expect(await generate({...opts,readInput:async()=>input,call})).toMatchObject({ok:false,code:'INVALID_REQUEST'});expect(call).not.toHaveBeenCalled();
});
it.each([['','EMPTY_OUTPUT'],['no json','INVALID_MODEL_OUTPUT'],['{"xml":"<mxCell>"}','INVALID_XML']])('rejects %s safely',async(text,code)=>{
 expect(await generate({...opts,call:async()=>({text})})).toMatchObject({ok:false,code});
});
it('sanitizes failures and does not call without configuration',async()=>{
 const call=vi.fn(async()=>{throw new Error('SECRET raw prompt upstream body');});const log=vi.fn();
 expect(await generate({...opts,call,log})).toMatchObject({ok:false,code:'PROVIDER_ERROR'});
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|prompt|body/);
 call.mockClear();expect(await generate({...opts,call,configured:false})).toMatchObject({ok:false,code:'CONFIG_MISSING'});expect(call).not.toHaveBeenCalled();
});
it('bounds the entire request, aborts once and ignores a late provider result',async()=>{
 vi.useFakeTimers();let resolve!:(r:{text:string})=>void;let signal!:AbortSignal;
 const call=vi.fn((_p:string,s:AbortSignal)=>{signal=s;return new Promise<{text:string}>(r=>resolve=r);});
 const pending=generate({...opts,call});await vi.advanceTimersByTimeAsync(45_000);
 expect(await pending).toMatchObject({ok:false,code:'TIMEOUT'});expect(signal.aborted).toBe(true);resolve({text:good});expect(call).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
it('cancels before and during work even if the dependency ignores abort',async()=>{
 const controller=new AbortController();const call=vi.fn(()=>new Promise<{text:string}>(()=>{}));
 const pending=generate({...opts,signal:controller.signal,call});await Promise.resolve();controller.abort();expect(await pending).toMatchObject({ok:false,code:'CANCELED'});
 call.mockClear();expect(await generate({...opts,signal:controller.signal,call})).toMatchObject({code:'CANCELED'});expect(call).not.toHaveBeenCalled();
});
it('includes slow body reading in the deadline and never starts the provider afterward',async()=>{
 vi.useFakeTimers();let resolve!:(r:unknown)=>void;const call=vi.fn();
 const pending=generate({...opts,call,readInput:()=>new Promise(r=>resolve=r)});
 await vi.advanceTimersByTimeAsync(45_000);expect(await pending).toMatchObject({code:'TIMEOUT'});resolve({prompt:'late'});await Promise.resolve();expect(call).not.toHaveBeenCalled();
});

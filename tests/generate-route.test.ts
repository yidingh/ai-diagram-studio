// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { POST } from '../app/api/generate/route';
const fixture=readFileSync('tests/fixtures/three-node.drawio','utf8');
const xml=fixture.slice(fixture.indexOf('<mxCell id="client"'),fixture.indexOf('</root>'));
const body=(text=JSON.stringify({xml}),extra={})=>({id:'resp_test',object:'response',status:'completed',output:[{type:'message',id:'msg_test',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}],...extra});
const request=(input:unknown={prompt:'Client → API → PostgreSQL'})=>new Request('http://localhost/api/generate',{method:'POST',body:JSON.stringify(input)});
let fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{vi.stubEnv('OPENAI_API_KEY','test-placeholder-not-a-secret');fetchMock=vi.fn(async()=>Response.json(body()));vi.stubGlobal('fetch',fetchMock);vi.spyOn(console,'info').mockImplementation(()=>{});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
it('uses the actual SDK with one nonstreaming Responses call and pinned settings',async()=>{
 const result=await POST(request());expect(result.status).toBe(200);expect(await result.json()).toMatchObject({ok:true});expect(fetchMock).toHaveBeenCalledTimes(1);
 const [url,init]=fetchMock.mock.calls[0];expect(String(url)).toContain('/responses');
 expect(JSON.parse(init.body)).toMatchObject({model:'gpt-6-luna',stream:false,store:false,max_output_tokens:8000,reasoning:{effort:'low'}});
 expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('test-placeholder');
});
it.each([429,500,503])('does not retry an SDK HTTP %s failure or leak its body',async status=>{
 fetchMock.mockResolvedValue(Response.json({error:{message:'sensitive provider body',type:'server_error'}},{status}));
 const response=await POST(request());expect(response.status).toBe(502);expect(await response.text()).not.toContain('sensitive');expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([
 [body('',{output:[{type:'message',content:[{type:'refusal',refusal:'private refusal'}]}]}),'PROVIDER_REFUSAL'],
 [body('',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),'TRUNCATED_OUTPUT'],
 [body('',{status:'incomplete',incomplete_details:{reason:'content_filter'}}),'PROVIDER_REFUSAL'],
 [body(''),'EMPTY_OUTPUT'],[body('not json'),'INVALID_MODEL_OUTPUT'],[body('{"xml":"<mxCell"}'),'INVALID_XML'],
])('normalizes upstream result safely',async(upstream,code)=>{
 fetchMock.mockResolvedValue(Response.json(upstream));const response=await POST(request());expect(await response.json()).toMatchObject({ok:false,code});expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('rejects missing config and malformed input before invoking the SDK',async()=>{
 vi.stubEnv('OPENAI_API_KEY','');expect((await POST(request())).status).toBe(503);
 expect((await POST(request({prompt:' ',extra:1}))).status).toBe(400);
 expect((await POST(new Request('http://localhost',{method:'POST',body:'{'}))).status).toBe(400);expect(fetchMock).not.toHaveBeenCalled();
});
it('bounds declared and streamed body bytes without trusting content-length',async()=>{
 expect((await POST(new Request('http://localhost',{method:'POST',headers:{'content-length':'40000'},body:'{}'}))).status).toBe(413);
 expect((await POST(request({prompt:'雪'.repeat(12000)}))).status).toBe(413);expect(fetchMock).not.toHaveBeenCalled();
});
it('aborts the actual SDK request at the server deadline without a retry',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 fetchMock.mockImplementation(async(_url,init)=>{signal=init.signal;return new Promise(()=>{});});
 const pending=POST(request());await vi.advanceTimersByTimeAsync(45_000);const response=await pending;
 expect(response.status).toBe(504);expect(signal?.aborted).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('propagates client cancellation into the SDK without retrying',async()=>{
 const controller=new AbortController();let upstream:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>fetchMock.mockImplementation(async(_url,init)=>{upstream=init.signal;resolve();return new Promise(()=>{});}));
 const pending=POST(new Request('http://localhost/api/generate',{method:'POST',body:JSON.stringify({prompt:'three nodes'}),signal:controller.signal}));
 await started;controller.abort();const response=await pending;
 expect(await response.json()).toMatchObject({ok:false,code:'CANCELED'});expect(upstream?.aborted).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('times out a slow request body, cancels its reader and never starts the provider',async()=>{
 vi.useFakeTimers();const canceled=vi.fn();
 const stream=new ReadableStream<Uint8Array>({cancel:canceled});
 const pending=POST(new Request('http://localhost/api/generate',{method:'POST',body:stream,duplex:'half'} as RequestInit));
 await vi.advanceTimersByTimeAsync(45_000);expect((await pending).status).toBe(504);expect(canceled).toHaveBeenCalledTimes(1);expect(fetchMock).not.toHaveBeenCalled();
});
it('logs only numeric usage metadata, never malformed upstream fields',async()=>{
 fetchMock.mockResolvedValue(Response.json(body(undefined,{usage:{input_tokens:'private upstream text',output_tokens:4}})));
 expect((await POST(request())).status).toBe(200);
 expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private upstream text');
});

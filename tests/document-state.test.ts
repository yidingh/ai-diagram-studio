// @vitest-environment node
import { expect, it } from 'vitest';
import { documentReducer, initialDocumentState } from '../lib/document-state';
const capture=(xml:string)=>({xml,capturedAt:'2026-10-01T00:00:00Z'});
it('keeps candidate separate and discard changes neither document slot',()=>{
 const s=documentReducer(initialDocumentState,{type:'capture',capture:capture('manual')});
 const ready=documentReducer(s,{type:'candidate',candidate:{xml:'generated',requestId:'r',nodeCount:3,edgeCount:2}});
 expect(ready.current).toBe(s.current);expect(ready.previous).toBeNull();
 expect(documentReducer(ready,{type:'discard'})).toEqual(s);
 expect(documentReducer(ready,{type:'candidate',candidate:{xml:'other',requestId:'r2',nodeCount:3,edgeCount:2}})).toBe(ready);
});
it('retains previous on failure, commits fresh outgoing on success, and reverses Restore',()=>{
 let s=documentReducer(initialDocumentState,{type:'capture',capture:capture('old')});
 s=documentReducer(s,{type:'candidate',candidate:{xml:'candidate',requestId:'r',nodeCount:3,edgeCount:2}});
 s=documentReducer(s,{type:'begin'});s=documentReducer(s,{type:'capture',capture:capture('edited during generation')});
 expect(s.previous).toBeNull();const failed=documentReducer(s,{type:'failed'});expect(failed.candidate?.xml).toBe('candidate');expect(failed.current?.xml).toBe('edited during generation');
 s=documentReducer(s,{type:'replaced',outgoing:capture('edited during generation'),current:capture('candidate'),appliedCandidate:true});
 expect(s.previous?.xml).toBe('edited during generation');expect(s.candidate).toBeNull();
 s=documentReducer(s,{type:'begin'});s=documentReducer(s,{type:'replaced',outgoing:capture('candidate'),current:capture('edited during generation'),appliedCandidate:false});
 expect(s.previous?.xml).toBe('candidate');expect(s.current?.xml).toBe('edited during generation');
});

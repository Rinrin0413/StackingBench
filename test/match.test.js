import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGame,legalMoves,applyMove} from '../src/engine.js';
import {DecisionError} from '../src/players.js';
const dir=await mkdtemp(join(tmpdir(),'stackingbench-test-'));
process.env.STACKINGBENCH_RUNS=dir;
const {Match,readRun,hashState}=await import('../src/match.js');
after(async()=>{await rm(dir,{recursive:true,force:true});delete process.env.STACKINGBENCH_RUNS;});

test('saved match replays each path to identical hashes and final summary',async()=>{
  const m=await Match.create({maxLocks:4,players:[{transitions:8},{transitions:8}]});await m.run();
  const records=await readRun(m.id);let state=records[0].initialState;
  assert.equal(records[0].sourceHash.length,64);
  for(const r of records.filter(r=>r.type==='decision')) {
    assert.equal(hashState(state),r.beforeHash);state=applyMove(state,r.move).state;
    assert.deepEqual(state,r.state);assert.equal(hashState(state),r.afterHash);
  }
  const end=records.at(-1);assert.equal(end.status,'finished');assert.equal(end.reason,'lock-limit');assert.deepEqual(state,end.state);assert.equal(end.summary[0].locks,4);
});
test('same position branching keeps exact state and resets memos',async()=>{
  const game=createGame();const state=applyMove(game,legalMoves(game)[0]).state;
  for(const type of ['search','llm','llm-preview']) {
    const m=await Match.create({initialState:state,players:[{type},{type}],parent:{id:'fixture',index:1}});
    assert.deepEqual(m.state,state);assert.deepEqual(m.memos,['','']);assert.equal(m.header.initialHash,hashState(state));await m.stop();
  }
});
test('HTTP failure is invalid, persists trace, preserves board, and is not a win',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}]});
  const record=await m.step({transport:async()=>{throw new DecisionError('http','HTTP 503','invalid',{body:'unavailable'});}});
  assert.equal(m.state.status,'invalid');assert.equal(m.state.winner,null);assert.equal(m.state.locks,0);assert(!record.move);
  const records=await readRun(m.id);assert.equal(records[1].error.code,'http');assert.equal(records[1].trace.requests.length,1);
  assert.equal(records.at(-1).summary[0].completionTokens,null);assert.equal(records.at(-1).summary[0].usageMissing,1);
});
test('second invalid response forfeits and never substitutes a search move',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}]});
  await m.step({transport:async()=>({choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})});
  assert.equal(m.state.status,'forfeit');assert.equal(m.state.winner,1);assert.equal(m.state.locks,0);
  const end=(await readRun(m.id)).at(-1);assert.equal(end.summary[0].invalidResponses,2);assert.equal(end.summary[0].calls,2);
});
test('in-flight decision lock rejects concurrent requests',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}]});let release;
  const pending=m.step({transport:()=>new Promise(r=>{release=r;})});
  await assert.rejects(()=>m.step(),/already running/);
  const id=legalMoves(m.state)[0].id;
  release({choices:[{message:{content:JSON.stringify({action:'choose',move:id})},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}});
  await pending;await m.stop();assert.equal(m.state.status,'aborted');
});
test('crash-truncated final JSONL fragment keeps previous records readable',async()=>{
  const m=await Match.create();await appendFile(m.path,'{"type":"decision"');
  assert.equal((await readRun(m.id)).length,1);
});

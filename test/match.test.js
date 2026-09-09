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

test('human waits without generating, validates input, persists HOLD path and exact replay',async()=>{
  const m=await Match.create({maxLocks:2,players:[{type:'human'},{type:'search'}]});
  await m.run();assert.equal(m.records.length,0);assert.equal(m.running,false);
  const before=hashState(m.state),move=legalMoves(m.state).find(m=>m.useHold);
  for(const input of [{},{moveId:move.id,stateHash:'stale'},{moveId:'missing',stateHash:before},
    {moveId:move.id,stateHash:before,path:['HD','HD']}, {moveId:move.id,stateHash:before,path:['L','HD']}]) {
    await assert.rejects(()=>m.step(input));assert.equal(hashState(m.state),before);assert.equal(m.records.length,0);assert.equal(m.busy,false);
  }
  const input={moveId:move.id,stateHash:before,path:move.path};
  const first=m.step(input);await assert.rejects(()=>m.step(input),/already running/);await first;
  await assert.rejects(()=>m.step(input),/Position changed/);
  const next=legalMoves(m.state).find(m=>!m.useHold);await m.step({moveId:next.id,stateHash:hashState(m.state),path:next.path});
  const records=await readRun(m.id);let state=records[0].initialState;
  assert.deepEqual(records[0].config.players[0],{type:'human',observation:'text',input:'srs-controls-v1'});
  assert.equal(records[0].config.connections[0],null);
  for(const r of records.filter(r=>r.type==='decision')) {
    state=applyMove(state,r.move).state;assert.equal(hashState(state),r.afterHash);
    assert.equal(r.metrics.calls,0);assert.equal(r.metrics.transitions,0);assert(r.metrics.elapsedMs>=0);
    assert.deepEqual(r.trace.input.path,r.move.path);
  }
  assert.equal(records.at(-1).status,'finished');assert.equal(records.at(-1).summary[0].locks,2);
});
test('automated play yields at the human turn and resumes after seven human locks',async()=>{
  const m=await Match.create({maxLocks:21,players:[{type:'search',transitions:8},{type:'human'}]});
  await m.run();assert.equal(m.state.locks,7);assert.equal(m.state.active,1);assert.equal(m.running,false);
  for(let i=0;i<7;i++) {
    const moves=legalMoves(m.state);
    // Test fixture placement minimizes landing height so the fixture survives the turn.
    const move=moves.filter(m=>!m.useHold).sort((a,b)=>Math.min(...b.cells.map(c=>c[1]))-Math.min(...a.cells.map(c=>c[1])))[0];
    await m.step({moveId:move.id,stateHash:hashState(m.state)});
  }
  assert.equal(m.state.active,0);assert.equal(m.state.locks,14);
  await m.run();assert.equal(m.state.locks,21);assert.equal(m.state.status,'finished');
});
test('human snapshots omit future streams and opponent pieces even during opponent turn',async()=>{
  const m=await Match.create({players:[{type:'search',transitions:8},{type:'human'}]});
  await m.step();const snapshot=m.snapshot();assert.equal(snapshot.viewer,1);assert.equal(snapshot.human,null);
  for(const state of [snapshot.state,snapshot.header.initialState,...snapshot.records.map(r=>r.state)]) {
    assert(!('seeds' in state));assert.equal(state.players[0].current,null);assert.deepEqual(state.players[0].queue,[]);
    assert.equal(state.players[1].queue.length,5);
    for(const p of state.players)for(const key of ['bag','pieceRng','garbageRng'])assert(!(key in p));
  }
  await m.run();const waiting=m.snapshot();assert.equal(waiting.human.stateHash,hashState(m.state));
  assert.deepEqual(waiting.human.moves.map(m=>m.id),legalMoves(m.state).map(m=>m.id));
  assert(!('path' in waiting.human.moves[0]));
  assert(m.state.players[0].pieceRng);assert(m.header.initialState.seeds);await m.stop();
});
test('manual injection into an LLM condition is rejected without a decision or fallback',async()=>{
  const m=await Match.create({players:[{type:'llm'},{type:'human'}]});const before=hashState(m.state);
  await assert.rejects(()=>m.step({moveId:'m0000',stateHash:before}),/requires a human/);
  assert.equal(m.records.length,0);assert.equal(hashState(m.state),before);await m.stop();
});

test('LLM opponent uses its configured protocol then yields to human input',async()=>{
  const initialState=createGame({first:1});initialState.remaining=1;
  const m=await Match.create({initialState,players:[{type:'human'},{type:'llm-preview',model:'preview/gemma-4-31B-it'}]});
  const move=legalMoves(m.state).find(m=>!m.useHold);
  await m.step({transport:async(endpoint,body)=>{
    assert.equal(endpoint,'https://api.ai.sakura.ad.jp');assert.equal(body.model,'preview/gemma-4-31B-it');
    const obs=JSON.parse(body.messages[1].content);assert.equal(obs.actor,1);assert(!('next' in obs.opponent));
    return {choices:[{message:{content:JSON.stringify({action:'choose',move:move.id})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10}};
  }});
  assert.equal(m.records[0].metrics.calls,1);assert.equal(m.state.active,0);assert(m.snapshot().human);
  await m.run();assert.equal(m.records.length,1);
  const human=legalMoves(m.state)[0];await m.step({moveId:human.id,stateHash:hashState(m.state)});
  assert.equal(m.records[1].metrics.calls,0);await m.stop();
});

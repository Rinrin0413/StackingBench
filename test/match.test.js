import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGame,legalMoves,applyMove} from '../src/engine.js';
import {DecisionError,playerConfig} from '../src/players.js';
const dir=await mkdtemp(join(tmpdir(),'stackingbench-test-'));
process.env.STACKINGBENCH_RUNS=dir;
const {Match,readRun,hashState,listRuns}=await import('../src/match.js');
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
    const m=await Match.create({initialState:state,players:[{type},{type}],parent:{id:'fixture',index:1},preflightCapabilities:false});
    assert.deepEqual(m.state,state);assert.deepEqual(m.memos,['','']);assert.equal(m.header.initialHash,hashState(state));await m.stop();
  }
});
test('unknown LLM conditions are probed before the run header is fixed',async()=>{
  let calls=0;
  const m=await Match.create({players:[{type:'llm'},{type:'human'}],capabilityCachePath:join(dir,'automatic-preflight.json'),probeTransport:async(base,request)=>{
    calls++;assert.equal(base,'http://localhost:8082');assert.equal(request.model,'Qwen3.6-35B-A3B_UD-Q4_K_XL_128K-ctx_fast');
    return {choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}};
  }});
  assert.equal(calls,3);
  const snapshot=m.header.config.connections[0].capabilitySnapshot;
  assert.equal(snapshot.source,'probe');assert.equal(snapshot.features.basicText.status,'supported');assert.equal(snapshot.features.usage.status,'supported');assert.equal(snapshot.features.jsonSchema.status,'supported');
  assert.equal(snapshot.requestPolicyFingerprint.length,64);await m.stop();
});
test('HTTP failure is invalid, persists trace, preserves board, and is not a win',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}],preflightCapabilities:false});
  const record=await m.step({transport:async()=>{throw new DecisionError('http','HTTP 503','invalid',{body:'unavailable'});}});
  assert.equal(m.state.status,'invalid');assert.equal(m.state.winner,null);assert.equal(m.state.locks,0);assert(!record.move);
  const records=await readRun(m.id);assert.equal(records[1].error.code,'http');assert.equal(records[1].trace.requests.length,1);
  assert.equal(records.at(-1).summary[0].completionTokens,null);assert.equal(records.at(-1).summary[0].usageMissing,1);
});
test('second invalid response forfeits and never substitutes a search move',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}],preflightCapabilities:false});
  await m.step({transport:async()=>({choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})});
  assert.equal(m.state.status,'forfeit');assert.equal(m.state.winner,1);assert.equal(m.state.locks,0);
  const end=(await readRun(m.id)).at(-1);assert.equal(end.summary[0].invalidResponses,2);assert.equal(end.summary[0].calls,2);
});
test('in-flight decision lock rejects concurrent requests',async()=>{
  const m=await Match.create({players:[{type:'llm'},{}],preflightCapabilities:false});let release;
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
  const m=await Match.create({players:[{type:'llm'},{type:'human'}],preflightCapabilities:false});const before=hashState(m.state);
  await assert.rejects(()=>m.step({moveId:'m0000',stateHash:before}),/requires a human/);
  assert.equal(m.records.length,0);assert.equal(hashState(m.state),before);await m.stop();
});

test('LLM opponent uses its configured protocol then yields to human input',async()=>{
  const initialState=createGame({first:1});initialState.remaining=1;
  const m=await Match.create({initialState,players:[{type:'human'},{type:'llm-preview',model:'preview/gemma-4-31B-it'}],preflightCapabilities:false});
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

test('Codex session waits, previews within a persistent budget, and logs reproducible moves',async()=>{
  const m=await Match.create({maxLocks:2,players:[{type:'codex',transitions:1},{type:'human'}]});
  await m.run();assert.equal(m.records.length,0);assert.equal(m.agentStatus().ready,true);
  await assert.rejects(()=>m.step(),/agent endpoint/);
  const before=hashState(m.state),root=await m.agentObserve();
  assert(root.prompt.includes('moveId'));assert(!root.prompt.includes('\"action\":\"choose\"'));
  assert.equal(root.preview.enabled,true);assert.equal(m.config.players[0].model,null);assert.equal(m.config.connections[0],null);
  const move=root.observation.legalMoves.find(m=>m.hold),preview={decisionId:root.decisionId,moveId:move.id,requestId:'one'};
  const first=await m.agentAction('preview',preview);
  assert.deepEqual(await m.agentAction('preview',preview),first);
  assert.equal((await m.agentObserve()).preview.used,1);
  assert.equal(hashState(m.state),before);
  await assert.rejects(()=>m.agentAction('preview',{...preview,requestId:'two'}),/budget/);
  await assert.rejects(()=>m.agentAction('preview',{...preview,moveId:'m9999'}),/different preview/);
  await assert.rejects(()=>m.agentAction('choose',{decisionId:'stale',moveId:move.id}),/Stale/);
  await assert.rejects(()=>m.agentAction('choose',{decisionId:root.decisionId,moveId:'missing'}),/Unknown root/);
  assert.equal(hashState(m.state),before);assert.equal(m.records.length,0);
  const response={decisionId:root.decisionId,moveId:move.id,memo:'Keep the center open.',reason:'Fixture response only',agentModel:'test-agent'};
  const accepted=await m.agentAction('choose',response);
  assert.equal(accepted.acceptedDecisionId,root.decisionId);assert.equal(m.state.locks,1);
  assert.equal(m.records[0].metrics.transitions,1);assert.equal(m.records[0].metrics.completionTokens,null);
  assert.equal(m.records[0].metrics.calls,0);assert.equal(m.records[0].trace.agentModel.value,'test-agent');
  const next=await m.agentObserve();assert.notEqual(next.decisionId,root.decisionId);assert.equal(next.observation.memo,response.memo);
  assert.equal(next.preview.used,0);
  await assert.rejects(()=>m.agentAction('choose',response),/Stale/);assert.equal(m.state.locks,1);
  await m.agentAction('choose',{decisionId:next.decisionId,moveId:next.observation.legalMoves[0].id});
  const records=await readRun(m.id);let state=records[0].initialState;
  for(const r of records.filter(r=>r.type==='decision')) {state=applyMove(state,r.move).state;assert.equal(hashState(state),r.afterHash);}
  assert.equal(records.at(-1).summary[0].completionTokens,null);
  assert.equal(records.at(-1).summary[0].estimatedCostJpy,null);
  assert.deepEqual(records.find(r=>r.type==='decision').trace.request.observation,root.observation);
  assert.equal(records.filter(r=>r.type==='agent-event'&&r.event==='observation').length,2);
  assert(records.some(r=>r.type==='agent-event'&&r.event==='rejected'));
  const ended=await m.agentObserve();assert.equal(ended.status,'finished');assert(!('observation' in ended));
});
test('Codex public observations and unknown-garbage previews do not disclose hidden state',async()=>{
  const game=createGame();game.players[0].pending=[1];
  const changed=structuredClone(game);changed.seeds=[123,456];
  for(const [i,p] of changed.players.entries()) {
    p.pieceRng.value=9876;p.garbageRng.value=54321;p.bag.reverse();
    if(i===0)p.queue[5]=p.queue[5]==='T'?'J':'T';else{p.queue.reverse();p.current='O';}
  }
  const roots=[],previews=[];
  for(const state of [game,changed]) {
    const m=await Match.create({initialState:state,players:[{type:'codex'},{type:'human'}]}),root=await m.agentObserve();
    roots.push(root.observation);
    const forbidden=new Set(['seeds','pieceRng','garbageRng','bag']);
    const walk=x=>{if(x&&typeof x==='object')for(const [k,v] of Object.entries(x)){assert(!forbidden.has(k));walk(v);}};walk(root);
    assert(!('current' in root.observation.opponent));assert(!('next' in root.observation.opponent));assert.equal(root.observation.self.next.length,5);
    const result=await m.agentAction('preview',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,requestId:'unknown'});
    assert.equal(result.boundary,'unknown-garbage');assert.equal(result.observation,null);
    const {decisionId,...rest}=result;previews.push(rest);await m.stop();
    assert((await readRun(m.id)).some(r=>r.event==='preview')); // Even without a chosen move.
  }
  assert.deepEqual(roots[0],roots[1]);assert.deepEqual(previews[0],previews[1]);
});
test('Codex without previews cannot simulate and cannot move during the human turn',async()=>{
  const game=createGame();game.remaining=1;
  const m=await Match.create({initialState:game,players:[{type:'codex',preview:false},{type:'human'}]});
  const root=await m.agentObserve();assert.equal(root.preview.enabled,false);assert.equal(root.preview.budget,0);
  await assert.rejects(()=>m.agentAction('preview',{decisionId:root.decisionId,moveId:'m0000',requestId:'x'}),/disabled/);
  await m.agentAction('choose',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id});
  assert.equal(m.state.active,1);await m.run();assert.equal(m.state.locks,1);
  const status=await m.agentObserve();assert.equal(status.ready,false);assert(!('observation' in status));
  await assert.rejects(()=>m.agentAction('choose',{decisionId:root.decisionId,moveId:'m0000'}),/Not an agent turn/);
  assert.equal(m.state.status,'playing');await m.stop();
});
test('Codex operations serialize and stopping during observation is honored',async()=>{
  const m=await Match.create({players:[{type:'codex'},{type:'human'}]});
  const pending=m.agentObserve();await assert.rejects(()=>m.agentObserve(),/already running/);
  await m.stop();await pending;assert.equal(m.state.status,'aborted');assert.equal(m.busy,false);
  assert.equal((await readRun(m.id)).at(-1).status,'aborted');
});


test('Codex model and reasoning metadata persist in headers, decisions, snapshots and run listing',async()=>{
  const config={type:'codex',preview:false,agentModel:'GPT-6 Astra',reasoningEffort:'High'};
  const m=await Match.create({maxLocks:2,players:[config,{type:'human'}]});
  assert.equal(m.header.config.players[0].agentModel,'GPT-6 Astra');assert.equal(m.header.config.players[0].reasoningEffort,'high');
  let root=await m.agentObserve();assert.equal(root.configuredExecution.model,'GPT-6 Astra');
  await m.agentAction('choose',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id});
  assert.deepEqual(m.records[0].execution,{model:'GPT-6 Astra',reasoningEffort:'high',provenance:{model:'user-configured',reasoningEffort:'user-configured'}});
  root=await m.agentObserve();
  await m.agentAction('choose',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,agentModel:'test-model',reasoningEffort:'medium'});
  const saved=await readRun(m.id),decisions=saved.filter(r=>r.type==='decision');
  assert.equal(decisions[1].execution.model,'test-model');assert.equal(decisions[1].execution.reasoningEffort,'medium');
  assert.equal(decisions[1].execution.provenance.reasoningEffort,'agent-reported');
  assert.equal(saved[0].config.players[0].agentModel,'GPT-6 Astra');
  assert.deepEqual(m.snapshot().records.map(r=>r.execution),decisions.map(r=>r.execution));
  const listed=(await listRuns()).find(r=>r.id===m.id);assert.deepEqual(listed.executions[0],decisions.map(r=>r.execution));
});
test('Codex identity stays unknown without metadata and rejects invalid reasoning levels',async()=>{
  assert.equal(playerConfig({type:'codex',model:'unrelated-api-model'}).agentModel,null);
  assert.equal(playerConfig({type:'codex'}).reasoningEffort,null);
  assert.throws(()=>playerConfig({type:'codex',reasoningEffort:'invented'}),/reasoningEffort/);
  const m=await Match.create({maxLocks:1,players:[{type:'codex'},{type:'human'}]});const root=await m.agentObserve();
  await assert.rejects(()=>m.agentAction('choose',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,reasoningEffort:123}),/reasoningEffort/);
  assert.equal(m.state.locks,0);
  await m.agentAction('choose',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,agentModel:null,reasoningEffort:null});
  assert.deepEqual(m.records[0].execution,{model:null,reasoningEffort:null,provenance:{model:'unknown',reasoningEffort:'unknown'}});
});

test('Antigravity bridge records a single model identity and replays the selected path',async()=>{
  assert.equal(playerConfig({type:'agy'}).agentModel,'Gemini');
  assert.equal(playerConfig({type:'agy',agentModel:''}).agentModel,null);
  const m=await Match.create({maxLocks:2,players:[{type:'agy',transitions:1},{type:'human'}]});
  await m.run();assert(m.isAgentTurn());assert(m.snapshot().hasAgent);
  assert.equal(m.config.connections[0],null);
  const root=await m.agentObserve(),move=root.observation.legalMoves[0];
  assert.equal(root.protocol,'stackingbench.agy-session.v1');
  assert.match(root.prompt,/Antigravity CLI/);
  assert.equal(root.configuredExecution.model,'Gemini');
  const serialized=JSON.stringify(root);
  for(const secret of ['"seed"','"rng"','"queue"'])assert(!serialized.includes(secret));
  const input={decisionId:root.decisionId,moveId:move.id,requestId:'agy-preview'};
  const preview=await m.agentAction('preview',input);
  assert.deepEqual(await m.agentAction('preview',input),preview);
  await m.agentAction('choose',{decisionId:root.decisionId,moveId:move.id});
  assert.equal(m.records[0].execution.model,'Gemini');
  assert.equal(m.records[0].execution.reasoningEffort,null);
  assert.equal(m.records[0].trace.source,'agy-session');
  assert.equal(m.records[0].metrics.calls,0);
  assert.deepEqual(applyMove(m.header.initialState,m.records[0].move).state,m.state);
  const next=await m.agentObserve();
  await m.agentAction('choose',{decisionId:next.decisionId,moveId:next.observation.legalMoves[0].id,agentModel:'Gemini custom'});
  const saved=await readRun(m.id),listing=(await listRuns()).find(r=>r.id===m.id);
  assert.equal(saved[0].config.players[0].type,'agy');
  assert.equal(listing.executions[0][1].model,'Gemini custom');
  assert.equal(saved.at(-1).status,'finished');
});

test('Antigravity without previews rejects simulation and waits during the human turn',async()=>{
  const m=await Match.create({players:[{type:'agy',preview:false},{type:'human'}]});
  const root=await m.agentObserve();
  await assert.rejects(()=>m.agentAction('preview',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,requestId:'disabled'}),/disabled/);
  await assert.rejects(()=>m.step(),/agent endpoint/);
  await m.stop();
  const human=await Match.create({players:[{type:'human'},{type:'agy'}]});
  assert.equal((await human.agentObserve()).ready,false);
  assert(!('observation' in await human.agentObserve()));await human.stop();
});

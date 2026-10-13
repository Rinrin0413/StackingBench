import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalMoves} from '../src/engine.js';
import {llmDecision,playerConfig,searchDecision,systemPrompt,DecisionError,traceRequest,evaluate} from '../src/players.js';
const reply=(value,{finish='stop',usage={prompt_tokens:100,completion_tokens:20}}={})=>({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:finish}],usage});
test('baseline deterministic selection, fixed budget and no live mutation',async()=>{
  const g=createGame(),config=playerConfig({transitions:12});const a=await searchDecision(g,config),b=await searchDecision(g,config);
  assert.equal(a.move.id,b.move.id);assert.equal(a.metrics.transitions,12);assert.deepEqual(g,createGame());assert.equal(a.metrics.calls,0);
});
test('search scores certain garbage losses as terminal while v1 keeps its unknown penalty',async()=>{
  for(const version of [1,2]) {
    const game=createGame();game.rules.version=version;game.players[0].pending=[24];
    const decision=await searchDecision(game,playerConfig({transitions:8}));
    assert.equal(decision.metrics.transitions,4);
    assert(decision.trace.evaluations.every(e=>e.score===(version===2?-100000:-50000)));
    assert(decision.trace.previews.every(p=>p.response.boundary===(version===2?'terminal':'unknown-garbage')));
  }
  assert.equal(evaluate(null,1,{status:'finished',winner:0}),-100000);
  assert.equal(evaluate(null,0,{status:'finished',winner:0}),100000);
  assert.equal(evaluate(null,0,{received:1}),-50000);
});
test('LLM direct has no preview and sends public root candidates without outcomes',async()=>{
  const g=createGame(),id=legalMoves(g)[0].id;
  const d=await llmDecision(g,playerConfig({type:'llm'}),{memo:'keep well',transport:async(base,body)=>{
    const obs=JSON.parse(body.messages[1].content);assert.equal(obs.memo,'keep well');assert.equal(obs.legalMoves[0].id,id);
    assert(!body.messages[1].content.includes('pieceRng'));assert(!Object.hasOwn(obs.legalMoves[0],'attack'));
    return reply({action:'choose',move:id,reason:'test',memo:'next plan'});
  }});assert.equal(d.memo,'next plan');assert.equal(d.metrics.transitions,0);assert.equal(d.metrics.completionTokens,20);
});
test('preview protocol returns exact node and accepts only root selection',async()=>{
  const g=createGame(),id=legalMoves(g)[0].id;let calls=0;
  const d=await llmDecision(g,playerConfig({type:'llm-preview'}),{transport:async(base,body)=>{
    calls++;if(calls===1)return reply({action:'preview',node:'root',move:id});
    const result=JSON.parse(body.messages.at(-1).content);assert.equal(result.tool,'preview');assert.equal(result.used,1);assert.equal(result.observation.totalLocks,1);
    return reply({action:'choose',move:id});
  }});assert.equal(d.metrics.calls,2);assert.equal(d.metrics.transitions,1);assert.equal(d.trace.previews.length,1);
});
test('strict schema preview prompt requires node root on final choose',()=>{
  const config=playerConfig({type:'llm-preview',connectionId:'openrouter',modelId:'model-x',responseFormat:'schema'}),prompt=systemPrompt(config,createGame().rules);
  assert(prompt.includes('{"action":"choose","move":"root move ID","node":"root"}'));assert(prompt.includes('required node value for a final choose is always "root"'));
});
test('one repair for malformed JSON, then forfeit with full trace',async()=>{
  let calls=0;const g=createGame();
  await assert.rejects(()=>llmDecision(g,playerConfig({type:'llm'}),{transport:async()=>{calls++;return reply('bad');}}),e=>{
    assert.equal(e.outcome,'forfeit');assert.equal(e.code,'invalid-json');assert.equal(e.detail.trace.requests.length,2);assert.equal(e.detail.metrics.calls,2);return true;
  });assert.equal(calls,2);
});
test('repair allowance is shared across tool errors and final choice',async()=>{
  let calls=0;const g=createGame();
  await assert.rejects(()=>llmDecision(g,playerConfig({type:'llm'}),{transport:async()=>{calls++;return reply(calls===1?{action:'preview',move:'m0000'}:{action:'choose',move:'invalid'});}}),e=>e.outcome==='forfeit');assert.equal(calls,2);
});
test('truncated response is retried once even with parseable content',async()=>{
  const g=createGame(),id=legalMoves(g)[0].id;let calls=0;
  const d=await llmDecision(g,playerConfig({type:'llm'}),{transport:async()=>reply({action:'choose',move:id},{finish:++calls===1?'length':'stop'})});assert.equal(d.metrics.calls,2);
});
test('connection failure makes match invalid without substitute decision',async()=>{
  await assert.rejects(()=>llmDecision(createGame(),playerConfig({type:'llm'}),{transport:async()=>{throw new DecisionError('timeout','timeout');}}),e=>{
    assert.equal(e.outcome,'invalid');assert.equal(e.code,'timeout');assert.equal(e.detail.trace.requests.length,1);return true;
  });
});
test('missing usage stays unknown and reserves requested token budget',async()=>{
  const g=createGame(),id=legalMoves(g)[0].id;
  const d=await llmDecision(g,playerConfig({type:'llm'}),{transport:async()=>reply({action:'choose',move:id},{usage:null})});assert.equal(d.metrics.completionTokens,null);assert.equal(d.metrics.usageMissing,1);
  let calls=0;
  await assert.rejects(()=>llmDecision(g,playerConfig({type:'llm-preview',decisionTokens:64,maxTokens:64}),{transport:async()=>{calls++;return reply({action:'preview',move:id},{usage:null});}}),e=>e.code==='token-budget');assert.equal(calls,1);
});
test('unsupported encodings and invalid numerical budgets are rejected',()=>{
  assert.throws(()=>playerConfig({type:'llm',observation:'image'}),/Only text/);assert.throws(()=>playerConfig({transitions:0}),/transitions/);
  assert.doesNotThrow(()=>playerConfig({type:'search',observation:'image'}));
  assert.throws(()=>playerConfig({temperature:NaN}),/temperature/);
});
test('request pacing applies to correction calls and is recorded separately',async()=>{
  const g=createGame(),id=legalMoves(g)[0].id;let calls=0;
  const d=await llmDecision(g,playerConfig({type:'llm',requestIntervalMs:100}),{baseUrl:'http://localhost:9999',transport:async()=>{
    calls++;return reply({action:'choose',move:calls===1?'invalid-id':id});
  }});
  assert.equal(calls,2);assert.equal(d.trace.requests[0].pacingMs,0);
  assert(d.trace.requests[1].pacingMs>0);assert(d.metrics.pacingMs>0);
  assert.equal(d.metrics.pacingMs,d.trace.requests[1].pacingMs);
  assert.throws(()=>playerConfig({requestIntervalMs:-1}),/requestIntervalMs/);
});
test('preview transcripts grow linearly and reconstruct every wire request exactly',async()=>{
  const game=createGame(),move=legalMoves(game)[0].id,wire=[];
  const decision=await llmDecision(game,playerConfig({type:'llm-preview'}),{transport:async(base,body)=>{
    wire.push(structuredClone(body));
    return reply(wire.length<=32?{action:'preview',node:'root',move}:{action:'choose',move});
  }});
  assert.equal(decision.metrics.transitions,32);
  assert.equal(decision.trace.requests.length,33);
  for(let i=0;i<wire.length;i++)assert.deepEqual(traceRequest(decision.trace,i),wire[i]);
  assert.equal(decision.trace.requests.reduce((sum,r)=>sum+r.request.messages.length,0),wire.at(-1).messages.length);
  assert(JSON.stringify(decision.trace).length<JSON.stringify(wire).length/4);
  const legacy={requests:[{request:wire[0]},{request:wire[1]}]};
  assert.deepEqual(traceRequest(legacy,1),wire[1]);
});
test('repair prompts are included once and can reconstruct the corrected request',async()=>{
  const game=createGame(),move=legalMoves(game)[0].id,wire=[];
  const decision=await llmDecision(game,playerConfig({type:'llm'}),{transport:async(base,body)=>{
    wire.push(structuredClone(body));return reply(wire.length===1?'invalid':{action:'choose',move});
  }});
  assert.deepEqual(traceRequest(decision.trace,1),wire[1]);
  assert.equal(decision.trace.requests[1].request.messages.length,2);
});

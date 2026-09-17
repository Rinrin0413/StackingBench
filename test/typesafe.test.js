import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalMoves} from '../src/engine.js';
import {observe} from '../src/observation.js';
import {decide,playerConfig,completion} from '../src/players.js';
import {TYPESAFE_BASE,authHeaders} from '../src/providers.js';
const config=()=>playerConfig({type:'llm',model:'jev-latest'});
function answer(ids,index=0){return {model:'jev-latest',answers:{move:{type:'choice',choice:ids[index],confidence:1,probabilities:Object.fromEntries(ids.map((id,i)=>[id,i===index?1:0]))}},usage:{input_tokens:100,output_tokens:20}};}
function key(t,value='typesafe-test-secret') {
  const old=process.env.TYPESAFE_API_KEY;
  if(value===null)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=value;
  t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
}
test('Jev config round trips and rejects preview and image',()=>{
  assert.deepEqual(playerConfig(config()),config());
  assert.equal(config().provider,'typesafe');assert.equal(config().maxTokens,null);
  assert.throws(()=>playerConfig({type:'llm-preview',model:'jev-latest'}),/no preview/);
  assert.throws(()=>playerConfig({type:'llm',model:'jev-latest',observation:'image'}),/Only text/);
});
test('Jev uses native Choice over every public legal move, logs raw usage, and preserves engine state',async t=>{
  key(t);const game=createGame(),before=structuredClone(game),moves=legalMoves(game),ids=moves.map(m=>m.id);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,`${TYPESAFE_BASE}/v1/systemone`);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer typesafe-test-secret');
    const body=JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
    assert.deepEqual(body.state.observation,observe(game,moves));assert.deepEqual(Object.keys(body.questions.move.criteria),ids);
    assert(!JSON.stringify(body).match(/pieceRng|garbageRng|seeds|"queue"|"bag"/));
    return new Response(JSON.stringify(answer(ids,ids.length-1)));
  });
  const result=await decide(game,config());
  assert.equal(result.move.id,ids.at(-1));assert.deepEqual(game,before);
  assert.equal(result.metrics.promptTokens,100);assert.equal(result.metrics.completionTokens,20);assert.equal(result.metrics.transitions,0);
  assert.deepEqual(result.trace.requests[0].response.usage,{input_tokens:100,output_tokens:20});assert(!JSON.stringify(result).includes('typesafe-test-secret'));
});
test('Jev invalid choice gets one correction, repeated failure forfeits without bot fallback',async()=>{
  const game=createGame(),ids=legalMoves(game).map(m=>m.id);let calls=0;
  const result=await decide(game,config(),{transport:async()=>{calls++;const data=answer(ids);if(calls===1)data.answers.move.choice='bad';return data;}});
  assert.equal(calls,2);assert.equal(result.metrics.invalidResponses,1);
  await assert.rejects(()=>decide(game,config(),{transport:async()=>({answers:{}})}),e=>e.outcome==='forfeit'&&e.detail.trace.requests.length===2);
});
test('Jev missing usage remains unknown and service failures persist redacted diagnostics',async t=>{
  key(t);const game=createGame(),ids=legalMoves(game).map(m=>m.id);
  const result=await decide(game,config(),{transport:async()=>{const data=answer(ids);delete data.usage;return data;}});
  assert.equal(result.metrics.promptTokens,null);assert.equal(result.metrics.usageMissing,1);
  t.mock.method(globalThis,'fetch',async()=>new Response('typesafe-test-secret',{status:429}));
  await assert.rejects(()=>decide(game,config()),e=>e.code==='http'&&e.outcome==='invalid'&&e.detail.trace.requests.length===1&&!JSON.stringify(e.detail).includes('typesafe-test-secret'));
});
test('Jev credentials are confined to the official origin and missing key prevents requests',async t=>{
  key(t);assert.equal(authHeaders(TYPESAFE_BASE).Authorization,'Bearer typesafe-test-secret');
  for(const url of ['http://localhost:8082','https://api.typesafe.ai.evil.test','https://api.typesafe.ai/other','http://api.typesafe.ai'])assert.equal(authHeaders(url).Authorization,undefined);
  delete process.env.TYPESAFE_API_KEY;t.mock.method(globalThis,'fetch',async()=>{assert.fail('must not fetch');});
  await assert.rejects(()=>completion(TYPESAFE_BASE,{},100),e=>e.code==='missing-api-key');
});
test('Jev malformed distributions are recorded and never executed',async()=>{
  const game=createGame(),ids=legalMoves(game).map(m=>m.id);
  await assert.rejects(()=>decide(game,config(),{transport:async()=>{const data=answer(ids);data.answers.move.probabilities[ids[0]]=-1;return data;}}),e=>e.code==='invalid-response'&&e.outcome==='forfeit'&&e.detail.metrics.invalidResponses===2);
});
test('Jev probe uses native API and records the response separately',async t=>{
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {probeModel}=await import('../src/probe.js');
  const dir=await mkdtemp('/tmp/stackingbench-jev-probe-'),old=process.env.STACKINGBENCH_RUNS;
  process.env.STACKINGBENCH_RUNS=dir;
  t.after(async()=>{if(old===undefined)delete process.env.STACKINGBENCH_RUNS;else process.env.STACKINGBENCH_RUNS=old;await rm(dir,{recursive:true,force:true});});
  const result=await probeModel('jev-latest',{transport:async(base,request)=>{
    assert.equal(base,TYPESAFE_BASE);assert.equal(request.questions.move.type,'choice');assert.equal(request.messages,undefined);return answer(['ok']);
  }});
  assert.equal(result.ok,true);const record=JSON.parse(await readFile(`${dir}/${result.file}`,'utf8'));
  assert.equal(record.response.answers.move.choice,'ok');
});
test('environment.d loads each provider key by its own name without replacing process credentials',async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
  const {execFileSync}=await import('node:child_process');
  const dir=await mkdtemp('/tmp/stackingbench-env-');
  try {
    await mkdir(`${dir}/.config/environment.d`,{recursive:true});
    await writeFile(`${dir}/.config/environment.d/envvars.conf`,'SAKURA_AI_API_KEY=sakura-fixture\nTYPESAFE_API_KEY=jev-fixture\n');
    const env={...process.env,HOME:dir};delete env.TYPESAFE_API_KEY;delete env.SAKURA_AI_API_KEY;
    const script=`await import(${JSON.stringify(new URL('../src/providers.js',import.meta.url).href)});console.log(JSON.stringify([process.env.SAKURA_AI_API_KEY,process.env.TYPESAFE_API_KEY]));`;
    const run=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,env,encoding:'utf8'}));
    assert.deepEqual(run(),['sakura-fixture','jev-fixture']);
    env.TYPESAFE_API_KEY='process-fixture';assert.deepEqual(run(),['sakura-fixture','process-fixture']);
  } finally {await rm(dir,{recursive:true,force:true});}
});

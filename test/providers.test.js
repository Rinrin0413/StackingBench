import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalMoves} from '../src/engine.js';
import {completion,llmDecision,playerConfig,parseAction} from '../src/players.js';
import {SAKURA_BASE,SAKURA_MODELS,authHeaders,endpointFor,estimatedCost,accountKeyFromConfig,thinkingParameters} from '../src/providers.js';

const fakeKey='test-account:fake-secret-for-tests-only';
test('thinking controls use the model template key and preserve server defaults',()=>{
  assert.deepEqual(thinkingParameters(playerConfig({model:SAKURA_MODELS[0],thinking:'off'})),{chat_template_kwargs:{thinking:false}});
  assert.deepEqual(thinkingParameters(playerConfig({model:SAKURA_MODELS[1],thinking:'off'})),{chat_template_kwargs:{enable_thinking:false}});
  assert.deepEqual(thinkingParameters(playerConfig({thinking:'off'})),{chat_template_kwargs:{enable_thinking:false}});
  assert.deepEqual(thinkingParameters(playerConfig({model:SAKURA_MODELS[0]})),{});
  assert.throws(()=>playerConfig({model:SAKURA_MODELS[0],thinking:'low'}),/not supported/);
});
test('environment.d extraction reads only the exact named variable without expansion',()=>{
  assert.equal(accountKeyFromConfig(`OTHER_KEY=unrelated\nSAKURA_AI_API_KEY="${fakeKey}"\nPATH=/ignore`),fakeKey);
  assert.equal(accountKeyFromConfig('# SAKURA_AI_API_KEY=commented\nOTHER=unused'),null);
  assert.throws(()=>accountKeyFromConfig('SAKURA_AI_API_KEY=${OTHER_SECRET}'),/literal/);
});
function keyForTest(t,value=fakeKey) {
  const previous=process.env.SAKURA_AI_API_KEY;
  if(value===null)delete process.env.SAKURA_AI_API_KEY;else process.env.SAKURA_AI_API_KEY=value;
  t.after(()=>{if(previous===undefined)delete process.env.SAKURA_AI_API_KEY;else process.env.SAKURA_AI_API_KEY=previous;});
}
test('known remote models select Sakura and plain JSON without changing local defaults',()=>{
  for(const model of SAKURA_MODELS) {
    const config=playerConfig({type:'llm',model});assert.equal(config.provider,'sakura');assert.equal(config.responseFormat,'plain');assert.equal(endpointFor(config),SAKURA_BASE);
    assert.throws(()=>playerConfig({model,responseFormat:'schema'}),/unverified/);
  }
  assert.equal(playerConfig().provider,'llamacpp');assert.equal(playerConfig().responseFormat,'schema');
});
test('fence parser only unwraps a complete JSON document and leaves content intact',()=>{
  const text='```json\n{"action":"choose","move":"m0008"}\n```';
  assert.deepEqual(parseAction(text,'json-fence-v1'),{value:{action:'choose',move:'m0008'},normalization:'json-fence'});
  assert.throws(()=>parseAction(text,'strict'),/JSON/);
  assert.throws(()=>parseAction('Here is my answer:\n'+text,'json-fence-v1'),/JSON/);
  assert.throws(()=>parseAction(text+'\nMore text','json-fence-v1'),/JSON/);
  assert.throws(()=>parseAction('```json\n{"move":\n```','json-fence-v1'),/JSON/);
});
test('credentials attach only to the exact official endpoint and never to local or lookalike hosts',t=>{
  keyForTest(t);
  assert.equal(authHeaders(SAKURA_BASE).Authorization,`Bearer ${fakeKey}`);
  assert.equal(authHeaders(`${SAKURA_BASE}/v1`).Authorization,`Bearer ${fakeKey}`);
  for(const base of ['http://localhost:8082','https://api.ai.sakura.ad.jp.example.org','http://api.ai.sakura.ad.jp','https://api.ai.sakura.ad.jp/other'])assert.equal(authHeaders(base).Authorization,undefined);
  assert.throws(()=>endpointFor({provider:'llamacpp'},'https://name:secret@example.org'),/credentials/);
});
test('remote request is authenticated, excludes unsupported output flags, and logs no key',async t=>{
  keyForTest(t);const game=createGame(),id=legalMoves(game)[0].id;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,`${SAKURA_BASE}/v1/chat/completions`);assert.equal(options.headers.Authorization,`Bearer ${fakeKey}`);assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert(!Object.hasOwn(body,'response_format'));assert(!Object.hasOwn(body,'chat_template_kwargs'));assert(!options.body.includes(fakeKey));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({action:'choose',move:id})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}}));
  });
  const decision=await llmDecision(game,playerConfig({type:'llm',model:SAKURA_MODELS[0]}),{baseUrl:'http://localhost:8082'});
  assert.equal(decision.move.id,id);assert.equal(decision.trace.requests[0].endpoint,SAKURA_BASE);assert(!JSON.stringify(decision).includes(fakeKey));assert.equal(decision.metrics.estimatedCostJpy,0.012);
});
test('missing credential fails before any outbound request',async t=>{
  keyForTest(t,null);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected network request');});
  await assert.rejects(()=>completion(SAKURA_BASE,{},100),e=>e.code==='missing-api-key');assert.equal(calls,0);
});
test('provider error bodies redact full account tokens and secret portions',async t=>{
  keyForTest(t);
  t.mock.method(globalThis,'fetch',async()=>new Response(`rejected ${fakeKey} and fake-secret-for-tests-only`,{status:401}));
  await assert.rejects(()=>completion(SAKURA_BASE,{},100),e=>{
    assert.equal(e.code,'http');assert(!JSON.stringify(e.detail).includes(fakeKey));assert(!e.detail.body.includes('fake-secret-for-tests-only'));assert(e.detail.body.includes('[REDACTED]'));return true;
  });
});
test('endpoint normalization does not duplicate the API version',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'http://localhost:8082/v1/chat/completions');assert.equal(options.headers.Authorization,undefined);return new Response('{}');});
  await completion('http://localhost:8082/v1',{},100);
});
test('unknown usage keeps cost unknown instead of reporting free inference',()=>{
  assert.equal(estimatedCost(SAKURA_MODELS[0],null,12),null);assert.equal(estimatedCost('local',100,20),null);
  assert.equal(estimatedCost(SAKURA_MODELS[1],10000,10000),1.2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionProfile,endpointIdentity,loadConnectionProfiles,redactConnectionSecrets,validateBaseUrl} from '../src/connections.js';
import {requestJson,requestUrl} from '../src/transport.js';
import {llmDecision,playerConfig} from '../src/players.js';
import {endpointFor} from '../src/providers.js';
import {portableActionSchema,responseFormatPolicy} from '../src/protocols.js';
import {createGame,legalMoves} from '../src/engine.js';

test('generic connection profiles validate URL, separate credentials, and expose only safe projection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-connections-')),file=join(dir,'connections.json');
  await writeFile(file,JSON.stringify({connections:[{id:'gateway',label:'Test gateway',baseUrl:'http://127.0.0.1:9000/api/v1',credential:{type:'header-env',header:'X-Gateway-Key',env:'GATEWAY_TEST_KEY'},staticHeaders:{'X-Client':'stackingbench'},requestDefaults:{provider:{order:['test'],allow_fallbacks:false}},capabilities:{basicText:true}}]}));
  try {
    const profile=loadConnectionProfiles({path:file}).find(item=>item.id==='gateway');assert(profile);
    process.env.GATEWAY_TEST_KEY='gateway-secret';
    const publicView=(await import('../src/connections.js')).publicConnection(profile);
    assert.deepEqual(publicView,{id:'gateway',label:'Test gateway',protocol:'openai-chat-completions',configured:true,publicPreset:false,models:[],capabilities:{basicText:true}});
    assert(!JSON.stringify(publicView).includes('9000'));assert(!JSON.stringify(publicView).includes('GATEWAY_TEST_KEY'));
    assert.equal(endpointIdentity(profile).value.length,64);assert(!JSON.stringify(endpointIdentity(profile)).includes('127.0.0.1'));
    assert.equal(redactConnectionSecrets('failure gateway-secret',[profile]),'failure [REDACTED]');
    let seen;
    const data=await requestJson(profile,{model:'test',messages:[],temperature:0,max_tokens:1,stream:false},1000,{fetchImpl:async(url,options)=>{seen={url,options};return new Response('{"ok":true}');}});
    assert.deepEqual(data,{ok:true});assert.equal(seen.url,'http://127.0.0.1:9000/api/v1/chat/completions');assert.equal(seen.options.headers['X-Gateway-Key'],'gateway-secret');assert.equal(seen.options.headers['X-Client'],'stackingbench');
    assert.equal(requestUrl(profile),'http://127.0.0.1:9000/api/v1/chat/completions');
  } finally {delete process.env.GATEWAY_TEST_KEY;await rm(dir,{recursive:true,force:true});}
});

test('URL validation rejects credentials, unsupported schemes, fragments, and queries',()=>{
  for(const value of ['ftp://example.test/v1','https://name:secret@example.test/v1','https://example.test/v1?tenant=x','https://example.test/v1#fragment'])assert.throws(()=>validateBaseUrl(value));
  assert.equal(validateBaseUrl('http://localhost:8082/v1'),'http://localhost:8082/v1');
});

test('connection config rejects literal credentials, secret static headers, and standard-field overrides',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-invalid-connections-')),file=join(dir,'connections.json');
  try {
    for(const connection of [
      {id:'literal',baseUrl:'http://localhost:1/v1',credential:{type:'bearer-env',env:'KEY',value:'secret'}},
      {id:'header',baseUrl:'http://localhost:1/v1',staticHeaders:{Authorization:'secret'}},
      {id:'named-header',baseUrl:'http://localhost:1/v1',staticHeaders:{'X-Gateway-Key':'literal-secret'}},
      {id:'defaults',baseUrl:'http://localhost:1/v1',requestDefaults:{messages:'override'}}
    ]) {await writeFile(file,JSON.stringify({connections:[connection]}));assert.throws(()=>loadConnectionProfiles({path:file}));}
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('generic OpenAI-compatible request keeps connection/model identity and observed routing separate',async()=>{
  const game=createGame(),move=legalMoves(game)[0].id,config=playerConfig({type:'llm',connectionId:'openrouter',modelId:'same-model',routingPolicy:{order:['configured'],allow_fallbacks:false}});
  const observed=await llmDecision(game,config,{transport:async(base,body)=>{assert.equal(base,'https://openrouter.ai/api/v1');assert.deepEqual(body.provider,{order:['configured'],allow_fallbacks:false});return {choices:[{message:{content:JSON.stringify({action:'choose',move})},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3},provider:'downstream-observed',openrouter_metadata:{endpoints:{available:[{provider:'Downstream',model:'same-model',selected:true}]},summary:'available=1, selected=Downstream'}};}});
  const request=observed.trace.requests[0];assert.equal(request.connectionId,'openrouter');assert.equal(request.modelId,'same-model');assert.deepEqual(request.routingPolicy,{order:['configured'],allow_fallbacks:false});assert.equal(request.observedRouting.status,'observed');assert.equal(request.observedRouting.metadata.provider,'downstream-observed');assert.equal(request.observedRouting.metadata.openrouter_metadata.endpoints.available[0].provider,'Downstream');assert.equal(request.observedRouting.metadata.openrouter_metadata.endpoints.available[0].selected,true);
  const unknown=await llmDecision(game,config,{transport:async()=>({choices:[{message:{content:JSON.stringify({action:'choose',move})},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}})});assert.equal(unknown.trace.requests[0].observedRouting.status,'unknown');
});

test('OpenRouter preset uses its canonical prefix and non-secret metadata opt-in header',async t=>{
  const previous=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='openrouter-test-secret';t.after(()=>{if(previous===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previous;});
  const profile=connectionProfile('openrouter');let seen;
  await requestJson(profile,{model:'model-x',messages:[],temperature:0,max_tokens:1,stream:false},1000,{fetchImpl:async(url,options)=>{seen={url,options};return new Response('{"ok":true}');}});
  assert.equal(seen.url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(seen.options.headers.Authorization,'Bearer openrouter-test-secret');assert.equal(seen.options.headers['X-OpenRouter-Metadata'],'enabled');assert(!seen.options.body.includes('openrouter-test-secret'));
});

test('generic endpointFor keeps the configured API prefix while legacy Sakura keeps its old facade',()=>{
  assert.equal(endpointFor({connectionId:'openrouter'}),'https://openrouter.ai/api/v1');
  assert.equal(endpointFor({connectionId:'groq'}),'https://api.groq.com/openai/v1');
  assert.equal(endpointFor({connectionId:'sakura-ai'}),'https://api.ai.sakura.ad.jp');
});

test('portable strict schema preserves optional parser fields without empty-string normalization',()=>{
  const schema=portableActionSchema({preview:true});
  assert(schema.properties.node);assert(!schema.required.includes('node'));assert(!schema.properties.memo);assert(!schema.properties.reason);
  assert.deepEqual(responseFormatPolicy({responseFormat:'schema',type:'llm-preview',connection:connectionProfile('openrouter'),modelId:'model-x'}),{mode:'json-schema',schema:'portable-action-v1',strict:true,preview:true});
});

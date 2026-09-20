import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionProfile,loadConnectionProfiles,publicConnection} from '../src/connections.js';
import {CAPABILITY_TARGETS,assertCapabilitySelection,cachedCapability,ensureCapabilitySnapshot,modelMetadataSummary,probeConnectionModel} from '../src/capabilities.js';

const response=target=>target==='reasoning'?{choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}:{choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}};

test('capability probes are independent, cached by connection/model/endpoint, and separated from run metrics',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-capability-')),cache=join(dir,'capabilities.json'),profile=connectionProfile('openrouter');let calls=0;
  try {
    const result=await probeConnectionModel(profile,'model-x',{targets:['basicText','usage'],cachePath:cache,transport:async(base,request)=>{calls++;assert.equal(base,profile.baseUrl);assert.equal(request.model,'model-x');assert.deepEqual(request.provider,{allow_fallbacks:false});return response('basicText');}});
    assert.equal(calls,2);assert.equal(result.snapshot.features.basicText.status,'supported');assert.equal(result.snapshot.features.usage.status,'supported');assert.equal(result.snapshot.endpointFingerprint.length,64);
    const cached=await cachedCapability(profile,'model-x',{cachePath:cache,ttlMs:86400000});assert.equal(cached.key,result.snapshot.key);
    assert.equal(await cachedCapability(profile,'model-x',{cachePath:cache,ttlMs:86400000,routingPolicy:{only:['Other'],allow_fallbacks:false}}),null);
    const before=calls;const reused=await ensureCapabilitySnapshot(profile,'model-x',{cachePath:cache,transport:async()=>{throw Error('must use cache');},targets:CAPABILITY_TARGETS});assert.equal(calls,before);assert.equal(reused.key,result.snapshot.key);
    const record=JSON.parse(await readFile(join(process.env.STACKINGBENCH_RUNS??'runs',result.recordFile),'utf8'));assert.equal(record.kind,'connection-capability-probe');assert(!JSON.stringify(record).includes('OPENROUTER_API_KEY'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('expired capability entries are not reused and profile defaults are policy data',async()=>{
  const profile=connectionProfile('groq'),dir=await mkdtemp(join(tmpdir(),'stackingbench-expired-'));let calls=0;
  try {
    const snapshot=await ensureCapabilitySnapshot(profile,'model-y',{cachePath:join(dir,'cache.json'),ttlMs:0,transport:async()=>{calls++;return response('basicText');},targets:['basicText']});
    assert.equal(snapshot.source,'probe');assert.equal(calls,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('probe requests and cache identity include request defaults and routing policy',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-request-policy-')),file=join(dir,'connections.json'),cache=join(dir,'cache.json');
  try {
    await writeFile(file,JSON.stringify({connections:[{id:'policy-gateway',baseUrl:'https://gateway.example/v1',requestDefaults:{service_tier:'flex'},routingPolicy:{only:['ProviderA'],allow_fallbacks:false}}]}));
    const first=loadConnectionProfiles({path:file}).find(item=>item.id==='policy-gateway');
    const result=await probeConnectionModel(first,'model-a',{targets:['basicText'],cachePath:cache,transport:async(base,request)=>{
      assert.equal(base,'https://gateway.example/v1');assert.equal(request.service_tier,'flex');assert.deepEqual(request.provider,{only:['ProviderA'],allow_fallbacks:false});return response('basicText');
    }});
    assert.equal((await cachedCapability(first,'model-a',{cachePath:cache})).key,result.snapshot.key);
    await writeFile(file,JSON.stringify({connections:[{id:'policy-gateway',baseUrl:'https://gateway.example/v1',requestDefaults:{service_tier:'default'},routingPolicy:{only:['ProviderA'],allow_fallbacks:false}}]}));
    const changed=loadConnectionProfiles({path:file}).find(item=>item.id==='policy-gateway');
    assert.equal(await cachedCapability(changed,'model-a',{cachePath:cache}),null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('cache identity includes model capability overrides and wire configuration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-wire-policy-')),file=join(dir,'connections.json'),cache=join(dir,'cache.json');
  const profileConfig=({jsonSchemaWire='json_schema',jsonObject=true,reasoningWire='reasoning_effort',reasoningOffValue='none'}={})=>({connections:[{id:'wire-gateway',baseUrl:'https://wire.example/v1',capabilityDefaults:{jsonSchemaWire,reasoningWire,reasoningOffValue},capabilityOverrides:{'model-a':{jsonObject}}}]});
  try {
    await writeFile(file,JSON.stringify(profileConfig()));
    const first=loadConnectionProfiles({path:file}).find(item=>item.id==='wire-gateway');
    await probeConnectionModel(first,'model-a',{targets:['basicText'],cachePath:cache,transport:async()=>response('basicText')});
    assert(await cachedCapability(first,'model-a',{cachePath:cache}));
    await writeFile(file,JSON.stringify(profileConfig({jsonSchemaWire:'json_object-schema'})));
    const changedWire=loadConnectionProfiles({path:file}).find(item=>item.id==='wire-gateway');
    assert.equal(await cachedCapability(changedWire,'model-a',{cachePath:cache}),null);
    await writeFile(file,JSON.stringify(profileConfig({reasoningWire:'chat_template_kwargs',reasoningOffValue:false})));
    const changedReasoning=loadConnectionProfiles({path:file}).find(item=>item.id==='wire-gateway');
    assert.equal(await cachedCapability(changedReasoning,'model-a',{cachePath:cache}),null);
    await writeFile(file,JSON.stringify(profileConfig({jsonObject:false})));
    const changedOverride=loadConnectionProfiles({path:file}).find(item=>item.id==='wire-gateway');
    assert.equal(await cachedCapability(changedOverride,'model-a',{cachePath:cache}),null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('model capability overrides stay server-side and snapshots cannot cross connection identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-capability-overrides-')),file=join(dir,'connections.json');
  try {
    await writeFile(file,JSON.stringify({connections:[{id:'override-gateway',baseUrl:'http://localhost:9010/v1',models:['model-a'],capabilityDefaults:{basicText:true},capabilityOverrides:{'model-a':{jsonObject:true}}}]}));
    const profile=loadConnectionProfiles({path:file}).find(item=>item.id==='override-gateway');assert(profile);
    assert.deepEqual(publicConnection(profile).capabilities,{basicText:true});
    const result=await probeConnectionModel(profile,'model-a',{targets:['basicText'],cachePath:join(dir,'cache.json'),writeCache:false,transport:async()=>response('basicText')});
    assert.equal(result.snapshot.features.jsonObject.status,'supported');assert.equal(result.snapshot.features.jsonObject.source,'explicit-override');
    assert.doesNotThrow(()=>assertCapabilitySelection({modelId:'model-a',responseFormat:'plain',thinking:'server-default'},profile,result.snapshot,{requireSupported:true}));
    const other=connectionProfile('groq');assert.throws(()=>assertCapabilitySelection({modelId:'model-a',responseFormat:'plain',thinking:'server-default'},other,result.snapshot),/identity/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('model metadata remains advisory and TypeSafe probes only protocol-applicable targets',async()=>{
  const metadata=modelMetadataSummary({id:'model-meta',supported_parameters:['response_format','reasoning_effort']});
  const openrouter=connectionProfile('openrouter'),dir=await mkdtemp(join(tmpdir(),'stackingbench-metadata-'));let openAiCalls=0,typeSafeCalls=0;
  try {
    const hinted=await probeConnectionModel(openrouter,'model-meta',{targets:['basicText'],modelMetadata:{status:'available',model:metadata},cachePath:join(dir,'openrouter.json'),writeCache:false,transport:async()=>{openAiCalls++;return response('basicText');}});
    assert.equal(openAiCalls,1);assert.equal(hinted.snapshot.features.jsonSchema.status,'metadata-reported');assert.equal(hinted.snapshot.features.reasoning.status,'metadata-reported');
    const typesafe=connectionProfile('typesafe-jev');
    const result=await probeConnectionModel(typesafe,'jev-latest',{targets:CAPABILITY_TARGETS,cachePath:join(dir,'typesafe.json'),writeCache:false,transport:async()=>{typeSafeCalls++;return {answers:{move:{type:'choice',choice:'ok',probabilities:{ok:1},confidence:1}},usage:{input_tokens:2,output_tokens:1}};}});
    assert.equal(typeSafeCalls,2);assert.deepEqual(result.record.applicableTargets,['usage','choice']);assert.equal(result.snapshot.features.choice.status,'supported');
    for(const target of ['basicText','jsonObject','jsonSchema','reasoning'])assert.equal(result.snapshot.features[target].status,'not-applicable');
    assert.doesNotThrow(()=>assertCapabilitySelection({modelId:'jev-latest',protocol:typesafe.protocol,responseFormat:'choice',thinking:'server-default',routingPolicy:null},typesafe,result.snapshot,{requireSupported:true}));
  } finally {await rm(dir,{recursive:true,force:true});}
});

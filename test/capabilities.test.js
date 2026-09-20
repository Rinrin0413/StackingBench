import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionProfile,loadConnectionProfiles,publicConnection} from '../src/connections.js';
import {CAPABILITY_TARGETS,assertCapabilitySelection,cachedCapability,ensureCapabilitySnapshot,probeConnectionModel} from '../src/capabilities.js';

const response=target=>target==='reasoning'?{choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}:{choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}};

test('capability probes are independent, cached by connection/model/endpoint, and separated from run metrics',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-capability-')),cache=join(dir,'capabilities.json'),profile=connectionProfile('openrouter');let calls=0;
  try {
    const result=await probeConnectionModel(profile,'model-x',{targets:['basicText','usage'],cachePath:cache,transport:async(base,request)=>{calls++;assert.equal(base,profile.baseUrl);assert.equal(request.model,'model-x');return response('basicText');}});
    assert.equal(calls,2);assert.equal(result.snapshot.features.basicText.status,'supported');assert.equal(result.snapshot.features.usage.status,'supported');assert.equal(result.snapshot.endpointFingerprint.length,64);
    const cached=await cachedCapability(profile,'model-x',{cachePath:cache,ttlMs:86400000});assert.equal(cached.key,result.snapshot.key);
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

test('model capability overrides stay server-side and snapshots cannot cross connection identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-capability-overrides-')),file=join(dir,'connections.json');
  try {
    await writeFile(file,JSON.stringify({connections:[{id:'override-gateway',baseUrl:'http://localhost:9010/v1',models:['model-a'],capabilityDefaults:{basicText:true},capabilityOverrides:{'model-a':{jsonObject:true}}}]}));
    const profile=loadConnectionProfiles({path:file}).find(item=>item.id==='override-gateway');assert(profile);
    assert.deepEqual(publicConnection(profile).capabilities,{basicText:true});
    const result=await probeConnectionModel(profile,'model-a',{targets:['basicText'],cachePath:join(dir,'cache.json'),writeCache:false,transport:async()=>response('basicText')});
    assert.doesNotThrow(()=>assertCapabilitySelection({modelId:'model-a',responseFormat:'plain',thinking:'server-default'},profile,result.snapshot,{requireSupported:true}));
    const other=connectionProfile('groq');assert.throws(()=>assertCapabilitySelection({modelId:'model-a',responseFormat:'plain',thinking:'server-default'},other,result.snapshot),/identity/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {connectionProfile,endpointFingerprint,endpointIdentity,redactConnectionSecrets,capabilityDefaultsForModel,TYPESAFE_PROTOCOL} from './connections.js';
import {requestJson} from './transport.js';
import {extractContent,extractUsage,reasoningParameters} from './protocols.js';

export const CAPABILITY_TARGETS=['basicText','usage','jsonObject','jsonSchema','reasoning'];
export const DEFAULT_PROBE_TTL_MS=24*60*60*1000;
export const DEFAULT_CAPABILITY_CACHE=resolve(process.env.STACKINGBENCH_CAPABILITIES??'runs/capabilities.json');

function status(value,detail={}) {return {status:value,...detail};}
function nowIso(now=Date.now()) {return new Date(now).toISOString();}
function capabilityKey(connection,modelId) {
  return createHash('sha256').update(JSON.stringify([connection.id,modelId,endpointFingerprint(connection)])).digest('hex');
}
function validateModelId(modelId) {
  if(typeof modelId!=='string'||!modelId.trim()||modelId.length>300)throw Error('Invalid modelId');
  return modelId;
}
function fresh(snapshot,now,ttlMs) {
  const checked=Date.parse(snapshot.checkedAt??'');
  return Number.isFinite(checked)&&now<Math.min(Date.parse(snapshot.expiresAt??'')||0,checked+ttlMs);
}
function policy(options={}) {
  const ttlMs=options.ttlMs??(Number.isFinite(Number(process.env.STACKINGBENCH_PROBE_TTL_MS))?Number(process.env.STACKINGBENCH_PROBE_TTL_MS):DEFAULT_PROBE_TTL_MS);
  if(!Number.isInteger(ttlMs)||ttlMs<0)throw Error('Invalid capability probe TTL');
  return {ttlMs,cachePath:options.cachePath??DEFAULT_CAPABILITY_CACHE,version:options.version??1};
}

export function capabilityPolicy(options={}) {return policy(options);}

export function createCapabilitySnapshot(connection,modelId,{features={},source='profile-default',checkedAt=null,ttlMs=DEFAULT_PROBE_TTL_MS,metadata={}}={}) {
  validateModelId(modelId);
  const checked=checkedAt??nowIso();
  const normalized=Object.fromEntries(CAPABILITY_TARGETS.map(target=>{
    const value=features[target];
    return [target,value===true?status('supported'):value===false?status('unsupported'):value??status('unknown')];
  }));
  return {version:1,key:capabilityKey(connection,modelId),connectionId:connection.id,modelId,protocol:connection.protocol,
    endpointFingerprint:endpointFingerprint(connection),checkedAt:checked,expiresAt:new Date(Date.parse(checked)+ttlMs).toISOString(),source,features:normalized,metadata};
}

export async function readCapabilityCache({cachePath=DEFAULT_CAPABILITY_CACHE}={}) {
  try {
    const value=JSON.parse(await readFile(cachePath,'utf8'));
    return Array.isArray(value)?value:Array.isArray(value.entries)?value.entries:[];
  } catch(e) {if(e.code==='ENOENT')return [];throw Error(`Unable to read capability cache: ${e.message}`);}
}

export async function writeCapabilityCache(snapshot,{cachePath=DEFAULT_CAPABILITY_CACHE}={}) {
  await mkdir(resolve(cachePath,'..'),{recursive:true});
  const entries=await readCapabilityCache({cachePath});
  const next=entries.filter(entry=>entry.key!==snapshot.key);next.push(snapshot);
  await writeFile(cachePath,JSON.stringify(next,null,2));
  return snapshot;
}

export async function cachedCapability(connection,modelId,{cachePath=DEFAULT_CAPABILITY_CACHE,now=Date.now(),ttlMs=DEFAULT_PROBE_TTL_MS}={}) {
  const key=capabilityKey(connection,modelId),entries=await readCapabilityCache({cachePath});
  return entries.find(entry=>entry.key===key&&entry.connectionId===connection.id&&entry.modelId===modelId&&entry.endpointFingerprint===endpointFingerprint(connection)&&fresh(entry,now,ttlMs))??null;
}

export async function ensureCapabilitySnapshot(connection,modelId,{refresh=false,transport=requestJson,timeoutMs=120000,targets=CAPABILITY_TARGETS,...options}={}) {
  const configured=policy(options);
  if(!refresh) {
    const cached=await cachedCapability(connection,modelId,{cachePath:configured.cachePath,ttlMs:configured.ttlMs});
    if(cached)return cached;
  }
  const result=await probeConnectionModel(connection,modelId,{targets,timeoutMs,transport,ttlMs:configured.ttlMs,cachePath:configured.cachePath,now:Date.now()});
  return result.snapshot;
}

function probeRequest(connection,modelId,target) {
  if(connection.protocol===TYPESAFE_PROTOCOL) return {model:modelId,state:'Connection capability probe',questions:{move:{type:'choice',instructions:'Select ok to confirm the connection probe.',criteria:{ok:'The connection is available.'}}}};
  const request={model:modelId,messages:[{role:'user',content:'Return only the JSON object {"ok":true}.'}],max_tokens:64,temperature:0,stream:false};
  if(target==='jsonObject')request.response_format={type:'json_object'};
  if(target==='jsonSchema')request.response_format=connection.id==='local-llamacpp'
    ?{type:'json_object',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}
    :capabilityDefaultsForModel(connection,modelId).jsonSchemaWire==='json_object-schema'
    ?{type:'json_object',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}
    :{type:'json_schema',json_schema:{name:'stackingbench_probe',strict:true,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}};
  if(target==='reasoning') {
    const capabilities=capabilityDefaultsForModel(connection,modelId);
    const parameters=reasoningParameters({model:modelId,modelId,thinking:capabilities.reasoningWire==='chat_template_kwargs'?'off':'low',connection});
    Object.assign(request,Object.keys(parameters).length?parameters:{reasoning_effort:'low'});
  }
  return request;
}

function probeTransport(transport,connection,request,timeoutMs) {
  return transport===requestJson?requestJson(connection,request,timeoutMs):transport(connection.legacyBaseUrl,request,timeoutMs);
}

function validateProbeResponse(connection,target,data) {
  if(connection.protocol===TYPESAFE_PROTOCOL)return Boolean(data?.answers?.move?.choice);
  const content=extractContent(data);
  if(typeof content!=='string')return false;
  if(['jsonObject','jsonSchema'].includes(target)) {
    try {return JSON.parse(content)?.ok===true;} catch {return false;}
  }
  return content.length>0;
}

export async function probeConnectionModel(connectionOrId,modelId,{targets=CAPABILITY_TARGETS,timeoutMs=120000,transport=requestJson,ttlMs=DEFAULT_PROBE_TTL_MS,cachePath=DEFAULT_CAPABILITY_CACHE,now=Date.now(),writeCache=true}={}) {
  const connection=typeof connectionOrId==='string'?connectionProfile(connectionOrId):connectionOrId;
  validateModelId(modelId);
  const selected=[...new Set(targets)].filter(target=>CAPABILITY_TARGETS.includes(target));
  if(!selected.length)throw Error('At least one capability probe target is required');
  const features=Object.fromEntries(CAPABILITY_TARGETS.map(target=>[target,status('unknown')]));
  const record={kind:'connection-capability-probe',at:nowIso(now),connectionId:connection.id,modelId,protocol:connection.protocol,
    endpointIdentity:endpointIdentity(connection),targets:selected,probes:[]};
  for(const target of selected) {
    const request=probeRequest(connection,modelId,target),started=Date.now(),entry={target,request};
    try {
      const response=await probeTransport(transport,connection,request,timeoutMs);
      const valid=validateProbeResponse(connection,target,response),usage=extractUsage(response),targetValid=valid&&(!['usage'].includes(target)||!!usage);
      entry.ok=targetValid;entry.elapsedMs=Date.now()-started;entry.usage=usage;
      features[target]=targetValid?status('supported',{usage:usage?{promptTokens:usage.prompt_tokens,completionTokens:usage.completion_tokens}:null}):status('unsupported',{reason:valid?'usage-not-reported':'response-validation'});
      entry.response=JSON.parse(redactConnectionSecrets(JSON.stringify(response),[connection]));
    } catch(e) {
      entry.ok=false;entry.elapsedMs=Date.now()-started;entry.error={code:e.code??'probe-error',message:redactConnectionSecrets(e.message??String(e)),detail:e.detail};
      features[target]=status(e.code==='http'||e.code==='unsupported'?'unsupported':'error',{code:e.code??'probe-error'});
    }
    record.probes.push(entry);
  }
  const snapshot=createCapabilitySnapshot(connection,modelId,{features,source:'probe',checkedAt:nowIso(now),ttlMs,metadata:{recordedAt:record.at}});
  record.snapshot=snapshot;
  if(writeCache)await writeCapabilityCache(snapshot,{cachePath});
  const runs=resolve(process.env.STACKINGBENCH_RUNS??'runs');await mkdir(runs,{recursive:true});
  const file=`probe-${connection.id}-${modelId.replace(/[^a-zA-Z0-9_-]/g,'_')}-${randomUUID().slice(0,8)}.json`;
  await writeFile(join(runs,file),JSON.stringify(record,null,2));
  return {snapshot,recordFile:file,record};
}

export function capabilityForConfig(config,connection) {
  if(config.capabilitySnapshot)return config.capabilitySnapshot;
  const modelId=config.modelId??config.model;
  return createCapabilitySnapshot(connection,modelId,{features:capabilityDefaultsForModel(connection,modelId),source:'profile-default',ttlMs:policy().ttlMs});
}

export function assertCapabilitySelection(config,connection,snapshot=capabilityForConfig(config,connection),{requireSupported=false}={}) {
  const modelId=config.modelId??config.model;
  if(!snapshot||snapshot.version!==1||snapshot.connectionId!==connection.id||snapshot.modelId!==modelId||snapshot.protocol!==connection.protocol||snapshot.endpointFingerprint!==endpointFingerprint(connection)||snapshot.key!==capabilityKey(connection,modelId))
    throw Error(`Capability snapshot identity does not match ${connection.id}/${modelId}`);
  const selected=config.responseFormat==='schema'?'jsonSchema':config.responseFormat==='json'?'jsonObject':null;
  const reasoning=config.thinking!=='server-default';
  const basic=snapshot.features.basicText?.status;
  if(basic==='unsupported'||basic==='error'||requireSupported&&basic!=='supported')throw Error(`Basic text generation is not verified for ${connection.id}/${modelId}`);
  if(selected&&(snapshot.features[selected]?.status==='unsupported'||requireSupported&&snapshot.features[selected]?.status!=='supported'))throw Error(`${selected} is not verified for ${connection.id}/${modelId}`);
  if(reasoning&&(snapshot.features.reasoning?.status==='unsupported'||requireSupported&&snapshot.features.reasoning?.status!=='supported'))throw Error(`Reasoning policy is not verified for ${connection.id}/${modelId}`);
  return snapshot;
}

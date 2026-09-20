import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {connectionProfile,endpointFingerprint,endpointIdentity,redactConnectionSecrets,capabilityDefaultsForModel,TYPESAFE_PROTOCOL} from './connections.js';
import {getModels,requestJson} from './transport.js';
import {applyRequestExtensions,extractContent,extractUsage,reasoningParameters} from './protocols.js';

export const OPENAI_CAPABILITY_TARGETS=['basicText','usage','jsonObject','jsonSchema','reasoning'];
export const TYPESAFE_CAPABILITY_TARGETS=['choice','usage'];
export const CAPABILITY_TARGETS=[...OPENAI_CAPABILITY_TARGETS,'choice'];
export const DEFAULT_PROBE_TTL_MS=24*60*60*1000;
export const DEFAULT_CAPABILITY_CACHE=resolve(process.env.STACKINGBENCH_CAPABILITIES??'runs/capabilities.json');

function status(value,detail={}) {return {status:value,...detail};}
function nowIso(now=Date.now()) {return new Date(now).toISOString();}
function stableValue(value) {
  if(Array.isArray(value))return value.map(stableValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));
  return value;
}
function effectiveRoutingPolicy(connection,routingPolicy) {return routingPolicy===undefined?(connection.routingPolicy??null):(routingPolicy??null);}
export function capabilityConditionFingerprint(connection,modelId,{routingPolicy}={}) {
  return createHash('sha256').update(JSON.stringify(stableValue({connectionId:connection.id,modelId,protocol:connection.protocol,
    endpointFingerprint:endpointFingerprint(connection),staticHeaders:connection.staticHeaders,requestDefaults:connection.requestDefaults,
    routingPolicy:effectiveRoutingPolicy(connection,routingPolicy)}))).digest('hex');
}
function capabilityKey(connection,modelId,{routingPolicy}={}) {
  return createHash('sha256').update(JSON.stringify([connection.id,modelId,capabilityConditionFingerprint(connection,modelId,{routingPolicy})])).digest('hex');
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

export function applicableCapabilityTargets(connectionOrProtocol) {
  const protocol=typeof connectionOrProtocol==='string'?connectionOrProtocol:connectionOrProtocol.protocol;
  return protocol===TYPESAFE_PROTOCOL?[...TYPESAFE_CAPABILITY_TARGETS]:[...OPENAI_CAPABILITY_TARGETS];
}

export function capabilityTargetsForConfig(config) {
  const protocol=config.protocol??config.connection?.protocol;
  if(protocol===TYPESAFE_PROTOCOL||config.responseFormat==='choice')return [...TYPESAFE_CAPABILITY_TARGETS];
  const targets=['basicText','usage'];
  if(config.responseFormat==='json')targets.push('jsonObject');
  if(config.responseFormat==='schema')targets.push('jsonSchema');
  if(config.thinking&&config.thinking!=='server-default')targets.push('reasoning');
  return targets;
}

export function modelMetadataSummary(model) {
  if(!model||typeof model!=='object'||typeof model.id!=='string')return null;
  const supportedParameters=Array.isArray(model.supported_parameters)?[...new Set(model.supported_parameters.filter(value=>typeof value==='string'&&value.length<=100))].sort():[];
  const parameterSet=new Set(supportedParameters.map(value=>value.toLowerCase()));
  const capabilityHints={};
  if(parameterSet.has('response_format')||parameterSet.has('structured_outputs')) {
    capabilityHints.jsonObject={reportedBy:'supported_parameters',parameter:'response_format'};
    capabilityHints.jsonSchema={reportedBy:'supported_parameters',parameter:'response_format'};
  }
  const reasoning=[...parameterSet].find(value=>['reasoning','reasoning_effort','include_reasoning'].includes(value));
  if(reasoning)capabilityHints.reasoning={reportedBy:'supported_parameters',parameter:reasoning};
  return {id:model.id,supportedParameters,capabilityHints};
}

async function discoverModelMetadata(connection,modelId,timeoutMs) {
  if(connection.protocol===TYPESAFE_PROTOCOL)return {status:'not-applicable'};
  try {
    const data=await getModels(connection,Math.min(timeoutMs,10000));
    const model=Array.isArray(data?.data)?data.data.find(item=>item?.id===modelId):null;
    return model?{status:'available',model:modelMetadataSummary(model)}:{status:'model-not-listed'};
  } catch(e) {return {status:'unavailable',code:e.code??'model-discovery'};}
}

export function createCapabilitySnapshot(connection,modelId,{features={},source='profile-default',checkedAt=null,ttlMs=DEFAULT_PROBE_TTL_MS,metadata={},routingPolicy}={}) {
  validateModelId(modelId);
  const checked=checkedAt??nowIso();
  const normalized=Object.fromEntries(CAPABILITY_TARGETS.map(target=>{
    const value=features[target];
    return [target,value===true?status('supported'):value===false?status('unsupported'):value??status('unknown')];
  }));
  const requestPolicyFingerprint=capabilityConditionFingerprint(connection,modelId,{routingPolicy});
  return {version:1,key:capabilityKey(connection,modelId,{routingPolicy}),connectionId:connection.id,modelId,protocol:connection.protocol,
    endpointFingerprint:endpointFingerprint(connection),requestPolicyFingerprint,checkedAt:checked,expiresAt:new Date(Date.parse(checked)+ttlMs).toISOString(),source,features:normalized,metadata};
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

export async function cachedCapability(connection,modelId,{cachePath=DEFAULT_CAPABILITY_CACHE,now=Date.now(),ttlMs=DEFAULT_PROBE_TTL_MS,routingPolicy}={}) {
  const requestPolicyFingerprint=capabilityConditionFingerprint(connection,modelId,{routingPolicy}),key=capabilityKey(connection,modelId,{routingPolicy}),entries=await readCapabilityCache({cachePath});
  return entries.find(entry=>entry.key===key&&entry.connectionId===connection.id&&entry.modelId===modelId&&entry.endpointFingerprint===endpointFingerprint(connection)&&entry.requestPolicyFingerprint===requestPolicyFingerprint&&fresh(entry,now,ttlMs))??null;
}

export async function ensureCapabilitySnapshot(connection,modelId,{refresh=false,transport=requestJson,timeoutMs=120000,targets=CAPABILITY_TARGETS,routingPolicy,...options}={}) {
  const configured=policy(options);
  if(!refresh) {
    const cached=await cachedCapability(connection,modelId,{cachePath:configured.cachePath,ttlMs:configured.ttlMs,routingPolicy});
    if(cached)return cached;
  }
  const result=await probeConnectionModel(connection,modelId,{targets,timeoutMs,transport,ttlMs:configured.ttlMs,cachePath:configured.cachePath,now:Date.now(),routingPolicy});
  return result.snapshot;
}

function probeRequest(connection,modelId,target,routingPolicy) {
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
    if(capabilities.reasoningWire)Object.assign(request,reasoningParameters({model:modelId,modelId,thinking:capabilities.reasoningWire==='chat_template_kwargs'?'off':'low',connection}));
    else request.reasoning_effort='low';
  }
  return applyRequestExtensions(request,{connection,routingPolicy:effectiveRoutingPolicy(connection,routingPolicy)});
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

export async function probeConnectionModel(connectionOrId,modelId,{targets=CAPABILITY_TARGETS,timeoutMs=120000,transport=requestJson,ttlMs=DEFAULT_PROBE_TTL_MS,cachePath=DEFAULT_CAPABILITY_CACHE,now=Date.now(),writeCache=true,routingPolicy,modelMetadata}={}) {
  const connection=typeof connectionOrId==='string'?connectionProfile(connectionOrId):connectionOrId;
  validateModelId(modelId);
  const selected=[...new Set(targets)].filter(target=>CAPABILITY_TARGETS.includes(target));
  if(!selected.length)throw Error('At least one capability probe target is required');
  const features=Object.fromEntries(CAPABILITY_TARGETS.map(target=>[target,status('unknown')]));
  const applicable=new Set(applicableCapabilityTargets(connection)),active=selected.filter(target=>applicable.has(target));
  for(const target of selected)if(!applicable.has(target))features[target]=status('not-applicable',{protocol:connection.protocol});
  const discovery=modelMetadata??(transport===requestJson?await discoverModelMetadata(connection,modelId,timeoutMs):{status:'not-requested'});
  for(const [target,hint] of Object.entries(discovery?.model?.capabilityHints??{}))if(features[target]?.status==='unknown')features[target]=status('metadata-reported',hint);
  const requestPolicyFingerprint=capabilityConditionFingerprint(connection,modelId,{routingPolicy});
  const record={kind:'connection-capability-probe',at:nowIso(now),connectionId:connection.id,modelId,protocol:connection.protocol,
    endpointIdentity:endpointIdentity(connection),requestPolicyFingerprint,requestPolicy:{requestDefaults:connection.requestDefaults,routingPolicy:effectiveRoutingPolicy(connection,routingPolicy)},
    targets:selected,applicableTargets:active,modelDiscovery:discovery,probes:[]};
  for(const target of active) {
    const request=probeRequest(connection,modelId,target,routingPolicy),started=Date.now(),entry={target,request};
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
  for(const [target,value] of Object.entries(connection.capabilityOverrides?.[modelId]??{}))if(CAPABILITY_TARGETS.includes(target)&&typeof value==='boolean')features[target]=status(value?'supported':'unsupported',{source:'explicit-override'});
  const snapshot=createCapabilitySnapshot(connection,modelId,{features,source:'probe',checkedAt:nowIso(now),ttlMs,routingPolicy,metadata:{recordedAt:record.at,modelDiscovery:discovery}});
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
  return createCapabilitySnapshot(connection,modelId,{features:capabilityDefaultsForModel(connection,modelId),source:'profile-default',ttlMs:policy().ttlMs,routingPolicy:config.routingPolicy});
}

export function assertCapabilitySelection(config,connection,snapshot=capabilityForConfig(config,connection),{requireSupported=false}={}) {
  const modelId=config.modelId??config.model;
  const requestPolicyFingerprint=capabilityConditionFingerprint(connection,modelId,{routingPolicy:config.routingPolicy});
  if(!snapshot||snapshot.version!==1||snapshot.connectionId!==connection.id||snapshot.modelId!==modelId||snapshot.protocol!==connection.protocol||snapshot.endpointFingerprint!==endpointFingerprint(connection)||snapshot.requestPolicyFingerprint!==requestPolicyFingerprint||snapshot.key!==capabilityKey(connection,modelId,{routingPolicy:config.routingPolicy}))
    throw Error(`Capability snapshot identity does not match ${connection.id}/${modelId}`);
  const selected=config.responseFormat==='schema'?'jsonSchema':config.responseFormat==='json'?'jsonObject':null;
  const reasoning=config.thinking!=='server-default';
  const primaryTarget=connection.protocol===TYPESAFE_PROTOCOL?'choice':'basicText',primary=snapshot.features[primaryTarget]?.status;
  if(primary==='unsupported'||primary==='error'||requireSupported&&primary!=='supported')throw Error(`${primaryTarget} is not verified for ${connection.id}/${modelId}`);
  if(selected&&(snapshot.features[selected]?.status==='unsupported'||requireSupported&&snapshot.features[selected]?.status!=='supported'))throw Error(`${selected} is not verified for ${connection.id}/${modelId}`);
  if(reasoning&&(snapshot.features.reasoning?.status==='unsupported'||requireSupported&&snapshot.features.reasoning?.status!=='supported'))throw Error(`Reasoning policy is not verified for ${connection.id}/${modelId}`);
  return snapshot;
}

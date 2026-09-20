import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

try {process.loadEnvFile();} catch(e) {if(e.code!=='ENOENT')throw e;}

export const OPENAI_CHAT_PROTOCOL='openai-chat-completions';
export const TYPESAFE_PROTOCOL='typesafe-jev-choice';

// These values are kept here so the compatibility facade in providers.js and the
// new connection registry share one source of truth.
export const SAKURA_BASE='https://api.ai.sakura.ad.jp';
export const SAKURA_MODELS=['preview/Kimi-K2.6','preview/gemma-4-31B-it'];
export const TYPESAFE_BASE='https://api.typesafe.ai';
export const TYPESAFE_MODEL='jev-latest';

const ENV_NAME=/^[A-Z][A-Z0-9_]*$/;
const HEADER_NAME=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_STATIC_HEADERS=new Set(['authorization','proxy-authorization','cookie','set-cookie','x-api-key','api-key']);
const BLOCKED_REQUEST_KEYS=new Set(['model','modelid','messages','temperature','maxtokens','maxcompletiontokens','tokenlimit','stream','responseformat','n','stop','tools','toolchoice','seed','logprobs','toplogprobs']);
const CAPABILITY_FEATURES=new Set(['basicText','usage','jsonObject','jsonSchema','reasoning']);
const REASONING_WIRES=new Set(['chat_template_kwargs','reasoning_effort']);
const JSON_SCHEMA_WIRES=new Set(['json_schema','json_object-schema']);
const DEFAULT_CONFIG_PATH=resolve(process.env.STACKINGBENCH_CONNECTIONS??'config/connections.json');

function fail(message,code='configuration') { throw Object.assign(new Error(message),{code}); }
function string(value,name,max=300) {
  if(typeof value!=='string'||!value.length||value.length>max)fail(`Invalid ${name}`);
  return value;
}
function publicClone(value,depth=0) {
  if(depth>8)fail('Connection metadata is too deeply nested');
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(v=>publicClone(v,depth+1));
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[string(k,'metadata key',80),publicClone(v,depth+1)]));
  fail('Connection metadata must be JSON-compatible');
}

export function validateBaseUrl(value,{legacy=false}={}) {
  string(value,'baseUrl',2000);
  let url;
  try {url=new URL(value);} catch {fail('baseUrl must be an absolute URL');}
  if(!['http:','https:'].includes(url.protocol))fail('baseUrl must use http or https');
  if(url.username||url.password)fail('baseUrl must not contain credentials');
  if(url.hash)fail('baseUrl must not contain fragments');
  if(url.search)fail('baseUrl must not contain query parameters');
  const pathname=url.pathname.replace(/\/+/g,'/').replace(/\/$/,'');
  if(!pathname&&!url.hostname)fail('baseUrl must include a host');
  const normalized=`${url.protocol}//${url.host}${pathname}`;
  if(legacy&&/\/chat\/completions$|\/models$/.test(pathname))fail('baseUrl must be an API prefix, not an endpoint path');
  return normalized;
}

export function normalizeLegacyBaseUrl(value) {
  const base=validateBaseUrl(value,{legacy:true});
  return /\/v1$/.test(base)?base:`${base}/v1`;
}

function normalizeCredential(input,id) {
  if(input===undefined||input===null)return {type:'none'};
  if(typeof input!=='object'||Array.isArray(input))fail(`Invalid credential for ${id}`);
  if(Object.hasOwn(input,'value')||Object.hasOwn(input,'secret')||Object.hasOwn(input,'apiKey'))fail(`Literal secrets are not allowed in connection ${id}`,'secret-config');
  if(input.apiKeyEnv!==undefined)input={type:'bearer-env',env:input.apiKeyEnv};
  const type=input.type??'none';
  if(type==='none')return {type:'none'};
  if(type==='bearer-env') {
    if(!ENV_NAME.test(input.env??''))fail(`Invalid credential environment variable for ${id}`);
    return {type,env:input.env};
  }
  if(type==='header-env') {
    if(!HEADER_NAME.test(input.header??'')||!ENV_NAME.test(input.env??''))fail(`Invalid credential header for ${id}`);
    const lower=input.header.toLowerCase();
    if(BLOCKED_STATIC_HEADERS.has(lower))fail(`Credential header must not be a blocked header for ${id}`);
    return {type,header:input.header,env:input.env};
  }
  fail(`Unknown credential type for ${id}`);
}

function normalizeStaticHeaders(input,id) {
  if(input===undefined)return {};
  if(!input||typeof input!=='object'||Array.isArray(input))fail(`Invalid staticHeaders for ${id}`);
  const result={};
  for(const [name,value] of Object.entries(input)) {
    if(!HEADER_NAME.test(name)||BLOCKED_STATIC_HEADERS.has(name.toLowerCase())||/(auth|token|key|secret|password|credential|api[-_]?key)/i.test(name))fail(`Static headers must be non-secret for ${id}`,'secret-config');
    string(value,`static header ${name}`,1000);
    if(/[\r\n]/.test(value))fail(`Invalid static header ${name}`);
    result[name]=value;
  }
  return result;
}

function validateRequestExtensions(value,id,depth=0) {
  if(value===undefined)return {};
  if(depth>5)fail(`requestDefaults are too deeply nested for ${id}`);
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(v=>validateRequestExtensions(v,id,depth+1));
  if(typeof value!=='object')fail(`requestDefaults must be JSON-compatible for ${id}`);
  const result={};
  for(const [key,item] of Object.entries(value)) {
    const normalizedKey=key.toLowerCase().replace(/[-_]/g,'');
    if(BLOCKED_REQUEST_KEYS.has(normalizedKey)||/(authorization|auth|token|secret|password|credential|api[-_]?key|headers?)/i.test(key))fail(`requestDefaults cannot contain standard or secret field ${key}`,'request-config');
    result[key]=validateRequestExtensions(item,id,depth+1);
  }
  return result;
}

export function validateRoutingPolicy(value,id='connection') {
  if(value===undefined||value===null)return null;
  const normalized=validateRequestExtensions(value,id);
  if(!normalized||typeof normalized!=='object'||Array.isArray(normalized))fail(`routingPolicy must be an object for ${id}`,'request-config');
  return normalized;
}

function normalizeCapabilityDefaults(value) {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail('capabilityDefaults must be an object');
  const result={};
  for(const [key,item] of Object.entries(value)) {
    if(CAPABILITY_FEATURES.has(key)) {
      if(typeof item!=='boolean')fail(`Capability ${key} must be boolean`,'capability-config');
      result[key]=item;
    } else if(key==='reasoningWire') {
      if(!REASONING_WIRES.has(item))fail(`Unknown reasoning wire ${item}`,'capability-config');
      result[key]=item;
    } else if(key==='reasoningOffValue') {
      if(!['string','number','boolean'].includes(typeof item)||item===null)fail('Invalid reasoningOffValue','capability-config');
      result[key]=item;
    } else if(key==='jsonSchemaWire') {
      if(!JSON_SCHEMA_WIRES.has(item))fail(`Unknown JSON schema wire ${item}`,'capability-config');
      result[key]=item;
    } else fail(`Unknown capability default ${key}`,'capability-config');
  }
  return result;
}

function normalizeCapabilityOverrides(value,id) {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`capabilityOverrides must be an object for ${id}`,'capability-config');
  const result={};
  for(const [model,defaults] of Object.entries(value)) {
    string(model,`capability override model for ${id}`,300);
    result[model]=normalizeCapabilityDefaults(defaults);
  }
  return result;
}

function normalizeProfile(input,{builtin=false}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Connection profile must be an object');
  const id=string(input.id,'connection id',80);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))fail(`Invalid connection id ${id}`);
  const protocol=input.protocol??OPENAI_CHAT_PROTOCOL;
  if(![OPENAI_CHAT_PROTOCOL,TYPESAFE_PROTOCOL].includes(protocol))fail(`Unknown protocol for ${id}`);
  const baseUrl=validateBaseUrl(input.baseUrl,{legacy:protocol===OPENAI_CHAT_PROTOCOL});
  const credential=normalizeCredential(input.credential??(input.apiKeyEnv?{apiKeyEnv:input.apiKeyEnv}:undefined),id);
  const staticHeaders=normalizeStaticHeaders(input.staticHeaders,id);
  const requestDefaults=validateRequestExtensions(input.requestDefaults,id);
  if(!requestDefaults||typeof requestDefaults!=='object'||Array.isArray(requestDefaults))fail(`requestDefaults must be an object for ${id}`,'request-config');
  const routingPolicy=validateRoutingPolicy(input.routingPolicy,id);
  if(routingPolicy!==null&&Object.keys(requestDefaults).some(key=>key.toLowerCase()==='provider'))fail(`Use either routingPolicy or requestDefaults.provider for ${id}`,'request-config');
  const models=input.models===undefined?[]:input.models;
  if(!Array.isArray(models)||models.some(model=>typeof model!=='string'||!model||model.length>300))fail(`Invalid models for ${id}`);
  const profile={
    id,label:string(input.label??id,'connection label',200),protocol,baseUrl,credential,staticHeaders,requestDefaults,routingPolicy,
    models:[...new Set(models)],capabilityDefaults:normalizeCapabilityDefaults(input.capabilityDefaults??input.capabilities),capabilityOverrides:normalizeCapabilityOverrides(input.capabilityOverrides,id),
    legacyProvider:input.legacyProvider??(protocol===TYPESAFE_PROTOCOL?'typesafe':'openai-compatible'),
    legacyBaseUrl:input.legacyBaseUrl?validateBaseUrl(input.legacyBaseUrl):baseUrl,
    publicEndpoint:builtin?(input.publicEndpoint??(protocol!==TYPESAFE_PROTOCOL)):false,
    publicPreset:builtin?(input.publicPreset??true):false,
    pricing:input.pricing?publicClone(input.pricing):null,
    source:builtin?'builtin':'config'
  };
  if(profile.legacyProvider==='sakura'&&profile.legacyBaseUrl!==SAKURA_BASE)profile.legacyBaseUrl=SAKURA_BASE;
  return Object.freeze(profile);
}

function builtinProfiles() {
  const local=normalizeLegacyBaseUrl(process.env.LLM_BASE_URL??'http://localhost:8082');
  return [
    normalizeProfile({id:'local-llamacpp',label:'Local OpenAI-compatible',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:local,legacyBaseUrl:local.replace(/\/v1$/,''),legacyProvider:'llamacpp',publicEndpoint:false,publicPreset:true,capabilityDefaults:{basicText:true,reasoningWire:'chat_template_kwargs'}}, {builtin:true}),
    normalizeProfile({id:'sakura-ai',label:'Sakura AI Engine',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:`${SAKURA_BASE}/v1`,legacyBaseUrl:SAKURA_BASE,legacyProvider:'sakura',models:SAKURA_MODELS,publicEndpoint:true,publicPreset:true,credential:{type:'bearer-env',env:'SAKURA_AI_API_KEY'},capabilityDefaults:{basicText:true,jsonObject:false,jsonSchema:false,reasoningWire:'chat_template_kwargs'},pricing:{currency:'JPY'}},{builtin:true}),
    normalizeProfile({id:'openrouter',label:'OpenRouter',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:'https://openrouter.ai/api/v1',legacyProvider:'openai-compatible',publicEndpoint:true,publicPreset:true,credential:{type:'bearer-env',env:'OPENROUTER_API_KEY'},staticHeaders:{'X-OpenRouter-Metadata':'enabled'},capabilityDefaults:{basicText:true},models:[]},{builtin:true}),
    normalizeProfile({id:'groq',label:'Groq',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:'https://api.groq.com/openai/v1',legacyProvider:'openai-compatible',publicEndpoint:true,publicPreset:true,credential:{type:'bearer-env',env:'GROQ_API_KEY'},capabilityDefaults:{basicText:true},models:[]},{builtin:true}),
    normalizeProfile({id:'cerebras',label:'Cerebras',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:'https://api.cerebras.ai/v1',legacyProvider:'openai-compatible',publicEndpoint:true,publicPreset:true,credential:{type:'bearer-env',env:'CEREBRAS_API_KEY'},capabilityDefaults:{basicText:true},models:[]},{builtin:true}),
    normalizeProfile({id:'typesafe-jev',label:'TypeSafe · Jev',protocol:TYPESAFE_PROTOCOL,baseUrl:TYPESAFE_BASE,legacyBaseUrl:TYPESAFE_BASE,legacyProvider:'typesafe',models:[TYPESAFE_MODEL],publicEndpoint:false,publicPreset:true,credential:{type:'bearer-env',env:'TYPESAFE_API_KEY'},capabilityDefaults:{basicText:true,usage:true},},{builtin:true})
  ];
}

function configuredProfiles(path=DEFAULT_CONFIG_PATH) {
  let parsed;
  try {parsed=JSON.parse(readFileSync(path,'utf8'));}
  catch(e) {if(e.code==='ENOENT')return [];throw Error(`Unable to read connection configuration: ${e.message}`);}
  const list=Array.isArray(parsed)?parsed:parsed?.connections;
  if(!Array.isArray(list))fail('Connection configuration must contain a connections array');
  return list.map(input=>normalizeProfile(input));
}

export function loadConnectionProfiles({path=DEFAULT_CONFIG_PATH}={}) {
  const merged=new Map(builtinProfiles().map(profile=>[profile.id,profile]));
  for(const profile of configuredProfiles(path))merged.set(profile.id,profile);
  return [...merged.values()];
}

export function connectionProfile(id,{path}={}) {
  const profile=loadConnectionProfiles({path}).find(item=>item.id===id);
  if(!profile)fail(`Unknown connection: ${id}`,'unknown-connection');
  return profile;
}

export function configuredConnection(profile) {
  if(profile.credential.type==='none')return true;
  return Boolean(process.env[profile.credential.env]?.trim());
}

export function credentialEnvNames(profiles=loadConnectionProfiles()) {
  return [...new Set(profiles.map(profile=>profile.credential.type==='none'?null:profile.credential.env).filter(Boolean))];
}

export function credentialHeaders(profile) {
  const credential=profile.credential;
  if(credential.type==='none')return {};
  const value=process.env[credential.env]?.trim();
  if(!value)fail(`${credential.env} is not configured. Set the process environment or .env and restart.`,'missing-api-key');
  if(/[\r\n]/.test(value))fail('Credential contains invalid header characters','configuration');
  return credential.type==='bearer-env'?{Authorization:`Bearer ${value}`}: {[credential.header]:value};
}

export function endpointFingerprint(profileOrUrl) {
  const value=typeof profileOrUrl==='string'?validateBaseUrl(profileOrUrl):profileOrUrl.baseUrl;
  return createHash('sha256').update(value).digest('hex');
}

export function endpointIdentity(profile) {
  if(profile.publicEndpoint) return {kind:'public-preset',value:profile.baseUrl};
  // This is only a stable same-endpoint identifier. It is not an anonymity or
  // confidentiality mechanism; raw internal URLs are deliberately not stored.
  return {kind:'endpoint-fingerprint',algorithm:'sha-256-v1',value:endpointFingerprint(profile),purpose:'same-endpoint-identification-only'};
}

export function publicConnection(profile) {
  const capabilities=Object.fromEntries(Object.entries(profile.capabilityDefaults).filter(([key,value])=>CAPABILITY_FEATURES.has(key)&&typeof value==='boolean'));
  return {id:profile.id,label:profile.label,protocol:profile.protocol,configured:configuredConnection(profile),publicPreset:profile.publicPreset,
    models:profile.models,capabilities};
}

export function capabilityDefaultsForModel(profile,modelId) {
  return {...profile.capabilityDefaults,...(profile.capabilityOverrides?.[modelId]??{})};
}

export function connectionForPlayer(config={},fallbackBase) {
  if(config.connectionId)return connectionProfile(config.connectionId);
  const provider=config.provider;
  if(provider==='typesafe')return connectionProfile('typesafe-jev');
  if(provider==='sakura')return connectionProfile('sakura-ai');
  if(provider==='llamacpp'||provider===undefined) {
    if(fallbackBase&&fallbackBase!==process.env.LLM_BASE_URL&&fallbackBase!=='http://localhost:8082') {
      const base=normalizeLegacyBaseUrl(fallbackBase),fingerprint=endpointFingerprint(base);
      return normalizeProfile({id:`legacy-${fingerprint.slice(0,16)}`,label:'Legacy OpenAI-compatible endpoint',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:base,legacyBaseUrl:base.replace(/\/v1$/,''),legacyProvider:'openai-compatible',publicEndpoint:false,publicPreset:false},{builtin:false});
    }
    return connectionProfile('local-llamacpp');
  }
  fail(`Unknown provider: ${provider}`,'unknown-provider');
}

export function connectionForLegacyEndpoint(value) {
  const normalized=validateBaseUrl(value).replace(/\/$/,'').replace(/\/v1$/,'');
  if(normalized===SAKURA_BASE)return connectionProfile('sakura-ai');
  if(normalized===TYPESAFE_BASE)return connectionProfile('typesafe-jev');
  if(normalized===connectionProfile('local-llamacpp').legacyBaseUrl)return connectionProfile('local-llamacpp');
  const base=normalizeLegacyBaseUrl(value),fingerprint=endpointFingerprint(base);
  return normalizeProfile({id:`legacy-${fingerprint.slice(0,16)}`,label:'Legacy OpenAI-compatible endpoint',protocol:OPENAI_CHAT_PROTOCOL,baseUrl:base,legacyBaseUrl:base.replace(/\/v1$/,''),legacyProvider:'openai-compatible',publicEndpoint:false,publicPreset:false},{builtin:false});
}

export function redactConnectionSecrets(text,profiles=loadConnectionProfiles()) {
  if(typeof text!=='string')return text;
  const values=[];
  for(const env of credentialEnvNames(profiles)) {
    const value=process.env[env]?.trim();
    if(value) {
      values.push(value);
      if(value.includes(':'))values.push(value.slice(value.indexOf(':')+1));
    }
  }
  // Keep the old compatibility behavior even if a profile is temporarily
  // removed from a custom configuration file.
  for(const env of ['SAKURA_AI_API_KEY','TYPESAFE_API_KEY']) {
    const value=process.env[env]?.trim();if(value) {values.push(value);if(value.includes(':'))values.push(value.slice(value.indexOf(':')+1));}
  }
  return [...new Set(values)].filter(value=>value.length>=1).sort((a,b)=>b.length-a.length).reduce((result,value)=>result.replaceAll(value,'[REDACTED]'),text);
}

export function legacyProviderForConnection(profile) { return profile.legacyProvider; }

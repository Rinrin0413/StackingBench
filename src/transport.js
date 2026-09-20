import {connectionProfile,credentialHeaders,redactConnectionSecrets,OPENAI_CHAT_PROTOCOL,TYPESAFE_PROTOCOL} from './connections.js';

export class TransportError extends Error {
  constructor(code,message,detail={}) { super(message);this.name='TransportError';this.code=code;this.detail=detail; }
}

function endpoint(profile,kind) {
  const suffix=profile.protocol===TYPESAFE_PROTOCOL?'/v1/systemone':kind==='models'?'/models':'/chat/completions';
  return `${profile.baseUrl.replace(/\/$/,'')}${suffix}`;
}

function mergeHeaders(profile) {
  const headers={'Content-Type':'application/json'};
  for(const [name,value] of Object.entries(profile.staticHeaders)) {
    if(Object.keys(headers).some(existing=>existing.toLowerCase()===name.toLowerCase()))throw new TransportError('configuration',`Static header conflicts with a transport header: ${name}`);
    headers[name]=value;
  }
  const credential=credentialHeaders(profile);
  for(const [name,value] of Object.entries(credential)) {
    const existing=Object.keys(headers).find(key=>key.toLowerCase()===name.toLowerCase());
    if(existing&&headers[existing]!==value)throw new TransportError('configuration',`Credential header conflicts with a static header: ${name}`);
    headers[existing??name]=value;
  }
  return headers;
}

export function requestUrl(profileOrId,kind='completion') {
  const profile=typeof profileOrId==='string'?connectionProfile(profileOrId):profileOrId;
  if(![OPENAI_CHAT_PROTOCOL,TYPESAFE_PROTOCOL].includes(profile.protocol))throw new TransportError('configuration','Unsupported connection protocol');
  return endpoint(profile,kind);
}

export async function requestJson(profileOrId,body,timeoutMs,{fetchImpl=globalThis.fetch,kind='completion'}={}) {
  const profile=typeof profileOrId==='string'?connectionProfile(profileOrId):profileOrId;
  let response,raw;
  let signal;
  try {signal=AbortSignal.timeout(timeoutMs);} catch {throw new TransportError('configuration','Invalid request timeout');}
  let headers;
  try {headers=mergeHeaders(profile);} catch(e) {if(e instanceof TransportError)throw e;throw new TransportError(e.code??'configuration',e.message);}
  try {
    response=await fetchImpl(requestUrl(profile,kind),{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
    raw=redactConnectionSecrets(await response.text(),[profile]);
  } catch(e) {
    if(e instanceof TransportError)throw e;
    throw new TransportError(signal.aborted?'timeout':'connection',redactConnectionSecrets(e.message??String(e),[profile]));
  }
  if(!response.ok)throw new TransportError('http',`HTTP ${response.status}`,{status:response.status,body:raw});
  try {
    const parsed=JSON.parse(raw),metadata={headers:{}};
    for(const [name,value] of response.headers?.entries?.()??[])if(/^(x-)?(openrouter|provider|route|routing)/i.test(name))metadata.headers[name]=redactConnectionSecrets(value,[profile]);
    if(parsed&&typeof parsed==='object')Object.defineProperty(parsed,'__transportMeta',{value:metadata,enumerable:false});
    return parsed;
  } catch {throw new TransportError('api-json','Server returned invalid JSON',{body:raw});}
}

export async function getModels(profileOrId,timeoutMs=10000,{fetchImpl=globalThis.fetch}={}) {
  const profile=typeof profileOrId==='string'?connectionProfile(profileOrId):profileOrId;
  if(profile.protocol!==OPENAI_CHAT_PROTOCOL)throw new TransportError('unsupported','Model discovery is not available for this protocol');
  let response,raw;
  const signal=AbortSignal.timeout(timeoutMs);
  let headers;
  try {headers=mergeHeaders(profile);} catch(e) {if(e instanceof TransportError)throw e;throw new TransportError(e.code??'configuration',e.message);}
  try {
    response=await fetchImpl(requestUrl(profile,'models'),{method:'GET',headers,signal,redirect:'error'});
    raw=redactConnectionSecrets(await response.text(),[profile]);
  } catch(e) {throw new TransportError(signal.aborted?'timeout':'connection',redactConnectionSecrets(e.message??String(e),[profile]));}
  if(!response.ok)throw new TransportError('http',`HTTP ${response.status}`,{status:response.status,body:raw});
  try {return JSON.parse(raw);} catch {throw new TransportError('api-json','Server returned invalid JSON',{body:raw});}
}

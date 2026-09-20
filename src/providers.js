// Compatibility facade for the pre-connection API. New request code resolves a
// connection profile and uses transport.js; these exports remain for old runs,
// scripts, and callers that still pass a model/provider pair.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {
  SAKURA_BASE,SAKURA_MODELS,TYPESAFE_BASE,TYPESAFE_MODEL,connectionProfile,connectionForPlayer,
  credentialHeaders,redactConnectionSecrets,validateBaseUrl
} from './connections.js';
import {reasoningParameters} from './protocols.js';

try {process.loadEnvFile();} catch(e) {if(e.code!=='ENOENT')throw e;}

export {SAKURA_BASE,SAKURA_MODELS,TYPESAFE_BASE,TYPESAFE_MODEL};

export function accountKeyFromConfig(contents,name='SAKURA_AI_API_KEY') {
  if(!['SAKURA_AI_API_KEY','TYPESAFE_API_KEY'].includes(name))throw Error('Unsupported credential name');
  const line=contents.split(/\r?\n/).find(line=>new RegExp(`^\\s*${name}\\s*=`).test(line));
  const value=line?parseEnv(line)[name]?.trim():null;
  if(value?.includes('$'))throw Error(`${name} in environment.d must be a literal value; variable expansion is not supported`);
  return value??null;
}

for(const name of ['SAKURA_AI_API_KEY','TYPESAFE_API_KEY']) if(!process.env[name]?.trim()) {
  try {
    const key=accountKeyFromConfig(readFileSync(join(homedir(),'.config/environment.d/envvars.conf'),'utf8'),name);
    if(key)process.env[name]=key;
  } catch(e) {if(e.code!=='ENOENT')throw e;}
}

export const providerFor=model=>model===TYPESAFE_MODEL?'typesafe':SAKURA_MODELS.includes(model)?'sakura':'llamacpp';

// Old callers expect the endpoint without the /v1 suffix. The new connection
// contract keeps the suffix in profile.baseUrl and never normalizes it in the
// native transport.
export function endpointFor(config={},localBase=process.env.LLM_BASE_URL??'http://localhost:8082') {
  let value,preserveApiPrefix=false;
  if(config.connectionId) {
    const profile=connectionProfile(config.connectionId);
    preserveApiPrefix=profile.legacyProvider==='openai-compatible';
    value=preserveApiPrefix?profile.baseUrl:profile.legacyBaseUrl;
  }
  else if(config.provider==='typesafe')value=TYPESAFE_BASE;
  else if(config.provider==='sakura')value=SAKURA_BASE;
  else value=localBase;
  const url=validateBaseUrl(value);
  return preserveApiPrefix?url.replace(/\/$/,''):url.replace(/\/$/,'').replace(/\/v1$/,'');
}

export function authHeaders(base) {
  const headers={'Content-Type':'application/json'};
  const normalized=validateBaseUrl(base).replace(/\/$/,'').replace(/\/v1$/,'');
  if(normalized===SAKURA_BASE)Object.assign(headers,credentialHeaders(connectionProfile('sakura-ai')));
  if(normalized===TYPESAFE_BASE)Object.assign(headers,credentialHeaders(connectionProfile('typesafe-jev')));
  return headers;
}

export function redactSecret(text) {return redactConnectionSecrets(text);}

export function pricingFor(model) {
  const rates={'preview/Kimi-K2.6':[0.6,3],'preview/gemma-4-31B-it':[0.24,0.96]}[model];
  return rates?{currency:'JPY',inputPer10k:rates[0],outputPer10k:rates[1],asOf:'2026-09-08',source:'https://ai.sakura.ad.jp/sakura-ai/ai-engine/',basis:'Published token rates before account free quota and billing adjustments; not an invoice'}:null;
}

export function estimatedCost(model,prompt,completion) {
  const p=pricingFor(model);
  return p&&Number.isFinite(prompt)&&Number.isFinite(completion)?(prompt*p.inputPer10k+completion*p.outputPer10k)/10000:null;
}

export function thinkingParameters(config) {
  if(config.thinking==='server-default')return {};
  let profile;
  try {profile=config.connection??connectionForPlayer(config);} catch {return {};}
  return reasoningParameters({...config,connection:profile});
}

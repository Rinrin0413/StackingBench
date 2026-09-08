// Credentials are transport-only. Never include headers or environment values in logs.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
try {process.loadEnvFile();} catch(e) {if(e.code!=='ENOENT')throw e;}
export function accountKeyFromConfig(contents) {
  const line=contents.split(/\r?\n/).find(line=>/^\s*SAKURA_AI_API_KEY\s*=/.test(line));
  const value=line?parseEnv(line).SAKURA_AI_API_KEY?.trim():null;
  if(value?.includes('$'))throw Error('SAKURA_AI_API_KEY in environment.d must be a literal value; variable expansion is not supported');
  return value??null;
}
if(!process.env.SAKURA_AI_API_KEY?.trim()) {
  try {
    const key=accountKeyFromConfig(readFileSync(join(homedir(),'.config/environment.d/envvars.conf'),'utf8'));
    if(key)process.env.SAKURA_AI_API_KEY=key;
  } catch(e) {if(e.code!=='ENOENT')throw e;}
}

export const SAKURA_BASE='https://api.ai.sakura.ad.jp';
export const SAKURA_MODELS=['preview/Kimi-K2.6','preview/gemma-4-31B-it'];
export const providerFor=model=>SAKURA_MODELS.includes(model)?'sakura':'llamacpp';
export function endpointFor(config,localBase=process.env.LLM_BASE_URL??'http://localhost:8082') {
  const value=config.provider==='sakura'?SAKURA_BASE:localBase;
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw Error('Endpoint must not contain credentials, query parameters or fragments');
  return url.href.replace(/\/$/,'').replace(/\/v1$/,'');
}
export function authHeaders(base) {
  const headers={'Content-Type':'application/json'};
  if(endpointFor({provider:'llamacpp'},base)===SAKURA_BASE) {
    const key=process.env.SAKURA_AI_API_KEY?.trim();
    if(!key)throw Object.assign(new Error('SAKURA_AI_API_KEY is not configured. Set the process environment, .env, or ~/.config/environment.d/envvars.conf and restart.'),{code:'missing-api-key'});
    headers.Authorization=`Bearer ${key}`;
  }
  return headers;
}
export function redactSecret(text) {
  const key=process.env.SAKURA_AI_API_KEY?.trim();
  if(!key)return text;
  let clean=text.replaceAll(key,'[REDACTED]');
  // Providers may echo only the secret portion of an account token.
  const secret=key.includes(':')?key.slice(key.indexOf(':')+1):null;
  if(secret&&secret.length>=8)clean=clean.replaceAll(secret,'[REDACTED]');
  return clean;
}
export function pricingFor(model) {
  const rates={'preview/Kimi-K2.6':[0.6,3],'preview/gemma-4-31B-it':[0.24,0.96]}[model];
  return rates?{currency:'JPY',inputPer10k:rates[0],outputPer10k:rates[1],asOf:'2026-09-08',source:'https://ai.sakura.ad.jp/sakura-ai/ai-engine/',basis:'Published token rates before account free quota and billing adjustments; not an invoice'}:null;
}
export function estimatedCost(model,prompt,completion) {
  const p=pricingFor(model);
  return p&&Number.isFinite(prompt)&&Number.isFinite(completion)?(prompt*p.inputPer10k+completion*p.outputPer10k)/10000:null;
}

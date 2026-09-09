import {isAgentPlayer,agentModel,reasoningEffort} from './agent-identity.js';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {legalMoves,pendingCount} from './engine.js';
import {observe,PreviewSession} from './observation.js';
import {providerFor,endpointFor,authHeaders,redactSecret,estimatedCost,thinkingParameters} from './providers.js';

export const DEFAULT_MODEL='Qwen3.6-35B-A3B_UD-Q4_K_XL_128K-ctx_fast';
export const QUICK_MODEL='Gemma-4-E2B_UD_Q4_K_XL_fast';
export const DEFAULT_PLAYER={type:'search',observation:'text',model:DEFAULT_MODEL,transitions:32,temperature:0.2,maxTokens:2048,
  timeoutMs:120000,decisionTokens:8192,maxCalls:34,requestIntervalMs:0,responseFormat:'schema',responseParsing:'strict',thinking:'server-default'};
export function playerConfig(value={}) {
  if(value.type==='human') {
    if(value.observation!==undefined&&value.observation!=='text') throw Error('Only text observation encoding is supported');
    return {type:'human',observation:'text',input:'srs-controls-v1'};
  }
  if(isAgentPlayer(value.type)) {
    const preview=value.preview??true,transitions=value.transitions??32;
    if(value.observation!==undefined&&value.observation!=='text')throw Error('Only text observations are implemented');
    if(typeof preview!=='boolean'||!Number.isInteger(transitions)||transitions<1||transitions>2048)throw Error('Invalid agent preview settings');
    return {type:value.type,observation:'text',input:`${value.type}-session-v1`,preview,transitions,model:null,agentModel:agentModel(value.agentModel===undefined&&value.type==='agy'?'Gemini':value.agentModel),reasoningEffort:value.type==='agy'?null:reasoningEffort(value.reasoningEffort),metadataSource:'user-configured'};
  }
  const provider=value.provider??providerFor(value.model??DEFAULT_MODEL);
  const p={...DEFAULT_PLAYER,...(provider==='sakura'?{responseFormat:'plain',responseParsing:'json-fence-v1'}:{}),...value,provider};
  if(!['llamacpp','sakura'].includes(provider))throw Error('Unknown provider');
  if(provider==='sakura'&&p.responseFormat!=='plain')throw Error('Sakura structured output is unverified; use responseFormat=plain');
  if(!['strict','json-fence-v1'].includes(p.responseParsing))throw Error('Unknown response parser');
  if(!['search','llm','llm-preview'].includes(p.type)) throw Error('Unknown player type');
  if(!['text','image','both'].includes(p.observation)) throw Error('Unknown observation encoding');
  if(p.type!=='search'&&p.observation!=='text') throw Error('Only text observations are implemented; image/both are reserved');
  for(const [key,min,max] of [['transitions',1,2048],['maxTokens',32,32768],['timeoutMs',100,600000],['decisionTokens',32,131072],['maxCalls',1,100],['requestIntervalMs',0,60000]])
    if(!Number.isInteger(p[key])||p[key]<min||p[key]>max) throw Error(`Invalid ${key}`);
  if(typeof p.model!=='string'||!p.model.length||p.model.length>300) throw Error('Invalid model');
  if(!Number.isFinite(p.temperature)||p.temperature<0||p.temperature>2) throw Error('Invalid temperature');
  if(!['schema','json','plain'].includes(p.responseFormat)||!['server-default','off'].includes(p.thinking)) throw Error('Invalid generation setting');
  return p;
}
export function evaluate(state,actor,result) {
  if(!state) return -50000;
  if(state.status==='finished'&&state.winner!==null) return state.winner===actor?100000:-100000;
  const p=state.players[actor],heights=[],board=p.board;let holes=0;
  for(let x=0;x<10;x++) {
    let top=24;
    for(let y=0;y<24;y++) if(board[y][x]!=='.') {top=y;break;}
    heights.push(24-top);
    for(let y=top+1;y<24;y++) if(board[y][x]==='.') holes++;
  }
  const roughness=heights.slice(1).reduce((sum,h,i)=>sum+Math.abs(h-heights[i]),0);
  return -8*holes-0.45*heights.reduce((a,b)=>a+b,0)-0.8*Math.max(...heights)-0.25*roughness-pendingCount(p)+2*(result?.sent??0)+(result?.lines??0);
}
function evenly(moves,count) { return Array.from({length:Math.min(count,moves.length)},(_,i)=>moves[Math.floor(i*moves.length/Math.min(count,moves.length))]); }
export async function searchDecision(game,config) {
  const start=performance.now(),session=new PreviewSession(game,config.transitions),root=session.nodes.get('root');
  if(!root.moves.length) throw new DecisionError('no-moves','No legal moves','forfeit');
  const scored=[];
  function visit(node,move) {
    const preview=session.run(node,move.id),child=session.nodes.get(preview.node);
    const entry={node:preview.node,rootMove:preview.rootMove,score:evaluate(child.state,session.actor,child.result),
      remaining:child.boundary?[]:evenly(child.moves,4)};
    scored.push(entry);
  }
  for(const m of evenly(root.moves,Math.max(1,Math.ceil(config.transitions/2)))) visit('root',m);
  while(session.used<session.budget) {
    const frontier=scored.filter(n=>n.remaining.length).sort((a,b)=>b.score-a.score||a.node.localeCompare(b.node));
    if(!frontier.length) break;
    const parent=frontier[0];visit(parent.node,parent.remaining.shift());
  }
  scored.sort((a,b)=>b.score-a.score||a.rootMove.localeCompare(b.rootMove));
  const selected=scored[0];
  return {move:root.moves.find(m=>m.id===selected.rootMove),memo:'',reason:`Fixed evaluation ${selected.score.toFixed(2)}; ${session.used} transitions`,
    metrics:{elapsedMs:performance.now()-start,transitions:session.used,calls:0,promptTokens:0,completionTokens:0,usageMissing:0,cost:null},
    trace:{algorithm:'best-first-v1',evaluations:scored.map(({remaining,...rest})=>rest),previews:session.history}};
}
export class DecisionError extends Error {
  constructor(code,message,outcome='invalid',detail={}) { super(message);this.code=code;this.outcome=outcome;this.detail=detail; }
}
function responseError(code,message) {return Object.assign(new Error(message),{code});}
export function parseAction(content,mode='strict') {
  let text=content,normalization=null;
  if(mode==='json-fence-v1') {
    const match=content.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    if(match){text=match[1];normalization='json-fence';}
  }
  try {return {value:JSON.parse(text),normalization};}
  catch {throw responseError('invalid-json','message.content must contain one JSON object without surrounding prose');}
}
export const ACTION_SCHEMA={type:'object',properties:{action:{type:'string',enum:['choose','preview']},move:{type:'string'},node:{type:'string'},memo:{type:'string'},reason:{type:'string'}},required:['action','move'],additionalProperties:false};
export function systemPrompt(config,rules) {
  const session=isAgentPlayer(config.type),preview=config.type==='llm-preview'||session&&config.preview;
  const chooseContract=session
    ? 'Use the agent choose command with a JSON file: {"decisionId":"current decisionId","moveId":"root move ID","memo":"optional short plan for next decision (max 240 characters)","reason":"optional brief explanation (max 400 characters)"}.'
    : 'Return one JSON object: {"action":"choose","move":"root move ID","memo":"optional short plan for next decision (max 240 characters)","reason":"optional brief explanation (max 400 characters)"}.';
  const previewContract=session
    ? 'Use the agent preview command with {"decisionId":"current decisionId","node":"root or prior node ID","moveId":"ID from that node","requestId":"unique preview ID"}.'
    : 'You may first request the preview tool using {"action":"preview","node":"root or prior node ID","move":"ID from that node"}.';
  return `You are a player in StackingBench, a turn-based falling-block duel. Win by making the opponent top out. Each player locks ${rules.locksPerTurn} pieces then yields. One decision locks one piece. HOLD does not consume a lock. SRS paths and game outcomes are computed by the engine. Coordinates and every board row are supplied in the observation. Opponent NEXT and all future garbage holes are private.\nRules: ${JSON.stringify(rules)}\nAttack arrays are indexed by cleared lines. A difficult clear is four lines or a line-clearing T-spin; repeated difficult clears add b2bBonus. A zero-line lock preserves B2B; a normal 1-3 line clear breaks it. REN starts at -1, increments on clear and resets on zero lines. Perfect clear adds perfectClear. Attack cancels your pending garbage FIFO, then sends the remainder. A zero-line lock raises all remaining pending garbage with unknown holes. After clearing and raising, cells in the first hiddenRows=4 rows lose. A blocked spawn also loses. At maxLocks the game draws.\nChoose only an ID from root legalMoves. Candidate spin is the engine's pre-clear classification; no candidate is ranked. ${chooseContract} Explanations are self-reports, not proof of internal reasoning. Your previous memo and last outcome appear in each fresh decision.\n${preview?`${previewContract} Tool replies contain a hypothetical observation and local legalMoves. A boundary stops expansion. Preview budget: ${config.transitions} state transitions. Final choose must name a ROOT move, never a deeper node's move. You need not use all previews.`:'No preview tools are available. Select directly from root legalMoves.'}`;
}
export async function completion(baseUrl,body,timeoutMs) {
  let response,raw;
  const signal=AbortSignal.timeout(timeoutMs);
  let headers;
  try {headers=authHeaders(baseUrl);} catch(e) {throw new DecisionError(e.code??'configuration',e.message);}
  try {
    response=await fetch(`${endpointFor({provider:'llamacpp'},baseUrl)}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
    raw=redactSecret(await response.text());
  }
  catch(e) {throw new DecisionError(signal.aborted?'timeout':'connection',redactSecret(e.message));}
  if(!response.ok) throw new DecisionError('http',`HTTP ${response.status}`, 'invalid',{status:response.status,body:raw});
  try { return JSON.parse(raw); } catch { throw new DecisionError('api-json','Server returned invalid JSON','invalid',{body:raw}); }
}
const nextRequestAt=new Map();
async function paceRequest(endpoint,interval) {
  if(!interval)return 0;
  const now=performance.now(),wait=Math.max(0,(nextRequestAt.get(endpoint)??now)-now);
  nextRequestAt.set(endpoint,now+wait+interval);
  if(wait)await delay(wait);
  return wait;
}
export async function llmDecision(game,config,{baseUrl='http://localhost:8082',memo='',transport=completion}={}) {
  baseUrl=endpointFor(config,baseUrl);
  const start=performance.now(),moves=legalMoves(game),session=config.type==='llm-preview'?new PreviewSession(game,config.transitions):null;
  const messages=[{role:'system',content:systemPrompt(config,game.rules)},{role:'user',content:JSON.stringify(observe(game,moves,memo))}];
  const trace={requests:[],previews:[]};
  const metrics={elapsedMs:0,pacingMs:0,transitions:0,calls:0,promptTokens:0,completionTokens:0,usageMissing:0,invalidResponses:0,cost:null};
  let spent=0,errors=0;
  const finish=()=>{metrics.elapsedMs=performance.now()-start;metrics.transitions=session?.used??0;metrics.estimatedCostJpy=config.provider==='sakura'?estimatedCost(config.model,metrics.promptTokens,metrics.completionTokens):null;trace.previews=session?.history??[];};
  try {
    for(let call=0;call<config.maxCalls;call++) {
      const available=config.decisionTokens-spent;
      if(available<32) throw new DecisionError('token-budget','Decision generation budget exhausted','forfeit');
      const body={model:config.model,messages:structuredClone(messages),temperature:config.temperature,max_tokens:Math.min(config.maxTokens,available),stream:false};
      if(config.responseFormat!=='plain') body.response_format=config.responseFormat==='json'?{type:'json_object'}:{type:'json_object',schema:ACTION_SCHEMA};
      Object.assign(body,thinkingParameters(config));
      const pacingMs=await paceRequest(baseUrl,config.requestIntervalMs);
      metrics.pacingMs+=pacingMs;
      const record={request:body,provider:config.provider??'llamacpp',endpoint:baseUrl,pacingMs,startedAt:new Date().toISOString()}; trace.requests.push(record);metrics.calls++;
      const callStart=performance.now(); let data;
      try { data=await transport(baseUrl,body,config.timeoutMs);record.response=data; }
      catch(e) {record.error={code:e.code??'connection',message:e.message,detail:e.detail};metrics.usageMissing++;metrics.promptTokens=null;metrics.completionTokens=null;throw e;}
      finally {record.elapsedMs=performance.now()-callStart;}
      const usage=data.usage,knownUsage=Number.isFinite(usage?.completion_tokens)&&Number.isFinite(usage?.prompt_tokens);
      if(knownUsage) {
        if(metrics.completionTokens!==null) metrics.completionTokens+=usage.completion_tokens;
        if(metrics.promptTokens!==null) metrics.promptTokens+=usage.prompt_tokens;
      } else {metrics.usageMissing++;metrics.promptTokens=null;metrics.completionTokens=null;}
      spent+=Number.isFinite(usage?.completion_tokens)?usage.completion_tokens:body.max_tokens;
      const choice=data.choices?.[0],content=choice?.message?.content;
      messages.push({role:'assistant',content:typeof content==='string'?content:''});
      try {
        if(choice?.finish_reason==='length') throw responseError('output-truncated','Output was truncated; produce a shorter valid JSON response');
        if(typeof content!=='string') throw Error('Missing message.content');
        const parsed=parseAction(content,config.responseParsing);
        const a=parsed.value;
        if(parsed.normalization)record.responseNormalization=parsed.normalization;
        if(!a||typeof a!=='object'||Array.isArray(a)||typeof a.move!=='string') throw Error('Expected action and move strings');
        if(Object.keys(a).some(k=>!['action','move','node','memo','reason'].includes(k))) throw Error('Unexpected response property');
        for(const [key,max] of [['memo',240],['reason',400]]) if(a[key]!==undefined&&(typeof a[key]!=='string'||a[key].length>max)) throw Error(`${key} must be a string of at most ${max} characters`);
        if(a.action==='choose') {
          const move=moves.find(m=>m.id===a.move);if(!move) throw responseError('illegal-move','Unknown root move ID');
          finish();return {move,memo:a.memo??'',reason:a.reason??'',metrics,trace};
        }
        if(a.action!=='preview'||!session) throw responseError('invalid-tool','This action is not available');
        if(session.used>=session.budget) throw Error('Preview budget exhausted; choose a root move now');
        const result=session.run(a.node??'root',a.move);
        messages.push({role:'user',content:JSON.stringify({tool:'preview',...result})});
      } catch(e) {
        record.validationError=e.message;record.validationCode=e.code??'invalid-response';errors++;metrics.invalidResponses++;
        if(errors>1) throw new DecisionError(record.validationCode,e.message,'forfeit');
        messages.push({role:'user',content:`Invalid response: ${e.message}. One correction is allowed for this decision. Return valid JSON.`});
      }
    }
    throw new DecisionError('call-budget','Decision API call budget exhausted','forfeit');
  } catch(e) {
    finish();
    if(!(e instanceof DecisionError)) e=new DecisionError('internal',e.message);
    e.detail={...e.detail,trace,metrics};throw e;
  }
}
export async function decide(game,config,options={}) {
  if(['human','codex','agy'].includes(config.type)) throw Error('External player input required');
  return config.type==='search'?searchDecision(game,config):llmDecision(game,config,options);
}

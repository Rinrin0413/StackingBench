import {readMetadata} from './run-metadata.js';
import {isAgentPlayer} from './agent-identity.js';
import {mkdir,appendFile,readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {RULES,createGame,clone,legalMoves,applyMove,publicMove,replayPath,pendingCount} from './engine.js';
import {playerConfig,decide,DecisionError} from './players.js';
import {endpointFor,pricingFor} from './providers.js';
import {connectionProfile,capabilityDefaultsForModel,endpointIdentity,endpointFingerprint} from './connections.js';
import {capabilityForConfig,assertCapabilitySelection,capabilityTargetsForConfig,ensureCapabilitySnapshot} from './capabilities.js';
import {responseFormatPolicy} from './protocols.js';
import {AgentTurn} from './agent.js';

export const RUNS=resolve(process.env.STACKINGBENCH_RUNS??'runs');
export const RUN_FORMAT=Number.isInteger(Number(process.env.STACKINGBENCH_RUN_FORMAT))&&Number(process.env.STACKINGBENCH_RUN_FORMAT)>=3?Number(process.env.STACKINGBENCH_RUN_FORMAT):3;
export const hashState=state=>createHash('sha256').update(JSON.stringify(state)).digest('hex');
export async function* streamRun(id) {
  if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid run ID');
  let parts=[];
  for await(const chunk of createReadStream(join(RUNS,`${id}.jsonl`),{encoding:'utf8'})) {
    let start=0,end;
    while((end=chunk.indexOf('\n',start))!==-1) {
      const line=parts.length?parts.join('')+chunk.slice(start,end):chunk.slice(start,end);
      parts=[];start=end+1;
      if(line.trim())yield JSON.parse(line);
    }
    if(start<chunk.length)parts.push(chunk.slice(start));
  }
  // An interrupted append may leave an incomplete final record.
  const tail=parts.join('');
  if(tail.trim()) {let record;try {record=JSON.parse(tail);} catch {return;}yield record;}
}
export function compactRecord(record) {const {trace,...rest}=record;return rest;}
export async function readRun(id,{compact=false}={}) {
  const records=[];
  for await(const record of streamRun(id))records.push(compact?compactRecord(record):record);
  return records;
}
export async function readRunHeader(id) {for await(const record of streamRun(id))return record;throw Error('Missing run header');}
export async function readRunPosition(id,index) {
  if(!Number.isInteger(index)||index<0)throw Error('Invalid replay position');
  let count=0;
  for await(const record of streamRun(id)) {
    if(record.type==='header'&&index===0)return record.initialState;
    if(record.type==='decision'&&++count===index)return record.state;
  }
  throw Error('Invalid replay position');
}
export async function listRuns({trash='active',onError=()=>{}}={}) {
  await mkdir(RUNS,{recursive:true});
  const entries=(await readdir(RUNS)).filter(n=>n.endsWith('.jsonl')).sort().reverse();
  const result=[];
  for(const name of entries) {
    try {
      let header,end,locks=0;const executions=[[],[]];
      for await(const record of streamRun(name.slice(0,-6))) {
        if(!header)header=record;
        if(record.type==='end')end=record;
        if(record.type==='decision') {
          if(record.move)locks++;
          if(record.execution&&!executions[record.actor].some(e=>JSON.stringify(e)===JSON.stringify(record.execution)))executions[record.actor].push(record.execution);
        }
      }
      if(!Array.isArray(header?.config?.players)||header.config.players.length!==2||!header.config.players.every(p=>p&&typeof p.type==='string')||!Number.isFinite(Date.parse(header.createdAt))||header.id!==name.slice(0,-6)) throw Error('Invalid run header');
      const metadata=await readMetadata(header.id);
      if(trash!=='all'&&metadata.trashed!==(trash==='trash'))continue;
      result.push({metadata,id:header.id,createdAt:header.createdAt,players:header.config.players,executions,status:end?.status??'incomplete',winner:end?.winner,locks});
    } catch {onError({id:name.slice(0,-6),error:'対局または管理情報を読み込めませんでした'});}
  }
  return result;
}
export function summarize(state,records) {
  return state.players.map((p,actor)=>{
    const decisions=records.filter(r=>r.actor===actor),sum=k=>decisions.reduce((a,r)=>a+(r.metrics?.[k]??0),0);
    const missing=decisions.some(r=>r.metrics?.completionTokens===null);
    return {...p.stats,attackPerLock:p.stats.locks?p.stats.attack/p.stats.locks:null,
      digEfficiency:p.stats.received?p.stats.garbageRowsCleared/p.stats.received:null,
      elapsedMs:sum('elapsedMs'),pacingMs:sum('pacingMs'),meanDecisionMs:decisions.length?sum('elapsedMs')/decisions.length:null,
      transitions:sum('transitions'),calls:sum('calls'),promptTokens:missing?null:sum('promptTokens'),completionTokens:missing?null:sum('completionTokens'),
      usageMissing:sum('usageMissing'),invalidResponses:sum('invalidResponses'),cost:null,
      estimatedCostJpy:decisions.length&&decisions.every(r=>Number.isFinite(r.metrics?.estimatedCostJpy))?sum('estimatedCostJpy'):null,
      errors:decisions.filter(r=>r.error).map(r=>r.error.code)};
  });
}
export class Match {
  static async savedSnapshot(id) {
    let header,end;const decisions=[];
    for await(const record of streamRun(id)) {
      if(record.type==='header')header=record;
      else if(record.type==='decision')decisions.push(compactRecord(record));
      else if(record.type==='end')end=record;
    }
    const match=Object.assign(new Match(),{id,header,config:header.config,records:decisions,state:end?.state??decisions.at(-1)?.state??header.initialState,busy:false,running:false,stopRequested:end?.status==='aborted'});
    return {...match.snapshot(),archived:true};
  }
  static async create(options={}) {
    let players=(options.players??[{},{}]).map((value,index)=>playerConfig({...value,...(options.capabilitySnapshots?.[index]?{capabilitySnapshot:options.capabilitySnapshots[index]}:{})}));
    if(players.length!==2) throw Error('Two player configurations required');
    const initial=options.initialState?clone(options.initialState):createGame(options);
    if(![1,RULES.version].includes(initial.rules.version)||initial.status!=='playing') throw Error('Only active v1/v2 positions can be resumed');
    const preflightCapabilities=options.preflightCapabilities!==false;
    if(preflightCapabilities) {
      for(const [index,player] of players.entries()) {
        if(['search','human'].includes(player.type)||isAgentPlayer(player.type))continue;
        if(player.capabilitySnapshot)continue;
        const profile=player.connection??connectionProfile(player.connectionId),snapshot=await ensureCapabilitySnapshot(profile,player.modelId??player.model,{refresh:options.refreshCapabilities===true||options.useCapabilityCache===false,
          targets:options.probeTargets??capabilityTargetsForConfig(player),timeoutMs:player.timeoutMs,transport:options.probeTransport??undefined,
          cachePath:options.capabilityCachePath,routingPolicy:player.routingPolicy});
        players[index]=playerConfig({...player,capabilitySnapshot:snapshot});
      }
    }
    const connections=players.map(p=>{
      if(['search','human'].includes(p.type)||isAgentPlayer(p.type))return null;
      const profile=p.connection??connectionProfile(p.connectionId),snapshot=capabilityForConfig(p,profile);
      if(preflightCapabilities||p.capabilitySnapshot)assertCapabilitySelection(p,profile,snapshot,{requireSupported:true});
      const modelId=p.modelId??p.model,capabilities=capabilityDefaultsForModel(profile,modelId);
      return {connectionId:profile.id,modelId,protocol:profile.protocol,endpointFingerprint:endpointFingerprint(profile),endpointIdentity:endpointIdentity(profile),
        capabilitySnapshot:snapshot,structuredOutput:{requested:p.responseFormat,parser:p.responseParsing,wire:responseFormatPolicy({...p,connection:profile})},reasoning:{policy:p.thinking,wire:capabilities.reasoningWire??null},
        requestExtensions:{requestDefaults:profile.requestDefaults,routingPolicy:p.routingPolicy??profile.routingPolicy??null,staticHeaders:profile.staticHeaders},pricing:p.provider==='sakura'?pricingFor(p.model):profile.pricing};
    });
    const config={players,connections,parent:options.parent??null};
    const m=new Match();
    m.id=`${new Date().toISOString().replace(/[:.]/g,'-')}_${randomUUID().slice(0,8)}`;
    m.state=initial;m.config=config;m.records=[];m.memos=['',''];m.running=false;m.busy=false;m.stopRequested=false;m.ended=false;
    let sourceRevision=null,sourceDirty=null;
    try {sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();sourceDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();} catch { /* Initial uncommitted workspace. */ }
    const sourceFiles=['engine.js','observation.js','players.js','match.js','providers.js','connections.js','protocols.js','transport.js','capabilities.js','agent.js','agent-identity.js'];
    const sourceHash=createHash('sha256');for(const file of sourceFiles)sourceHash.update(await readFile(new URL(file,import.meta.url)));
    m.header={type:'header',format:RUN_FORMAT,id:m.id,createdAt:new Date().toISOString(),config,initialState:clone(initial),initialHash:hashState(initial),
      runtime:process.version,engineVersion:'0.1.0',sourceRevision,sourceDirty,sourceHash:sourceHash.digest('hex')};
    m.baseUrl=endpointFor({provider:'llamacpp'});
    await mkdir(RUNS,{recursive:true});m.path=join(RUNS,`${m.id}.jsonl`);await m.write(m.header);
    m.inputSince=performance.now();
    return m;
  }
  async write(record) { await appendFile(this.path,JSON.stringify(record)+'\n'); }
  async end() {
    if(this.ended) return;
    const end={type:'end',at:new Date().toISOString(),status:this.state.status,winner:this.state.winner,reason:this.state.reason,
      stateHash:hashState(this.state),state:clone(this.state),summary:summarize(this.state,this.records)};
    await this.write(end);this.ended=true;this.running=false;
  }
  isHumanTurn() { return this.state.status==='playing'&&this.config.players[this.state.active].type==='human'; }
  isAgentTurn() { return this.state.status==='playing'&&isAgentPlayer(this.config.players[this.state.active].type); }
  agentStatus() {
    return {id:this.id,status:this.state.status,winner:this.state.winner,reason:this.state.reason??null,active:this.state.active,
      locks:this.state.locks,remaining:this.state.remaining,busy:this.busy||this.running,
      ready:this.isAgentTurn()&&!this.busy&&!this.running,
      decisionId:this.isAgentTurn()?`${this.id}:${this.records.length}`:null};
  }
  async agentOperation(fn) {
    if(this.busy||this.running)throw Error('A decision is already running');
    if(!this.isAgentTurn())throw Error('Not an agent turn');
    this.busy=true;
    try {return await fn();}
    finally {this.busy=false;if(this.stopRequested&&this.state.status==='playing')await this.stop();}
  }
  async agentObserve() {
    if(!this.isAgentTurn())return this.agentStatus();
    return this.agentOperation(async()=>{
      if(!this.agentTurn) {
        const turn=new AgentTurn(this.state,this.config.players[this.state.active],this.memos[this.state.active],`${this.id}:${this.records.length}`);
        await this.write({type:'agent-event',event:'observation',at:new Date().toISOString(),actor:this.state.active,request:turn.request});
        this.agentTurn=turn;
      }
      return {id:this.id,status:this.state.status,ready:true,...clone(this.agentTurn.request),
        preview:{...this.agentTurn.request.preview,used:this.agentTurn.session?.used??0}};
    });
  }
  async agentAction(action,input) {
    return this.agentOperation(async()=>{
      if(!this.agentTurn)throw Error('Observe the position before submitting an action');
      let result;
      try {
        if(action==='preview')result=this.agentTurn.preview(input);
        else if(action==='choose')result=this.agentTurn.decision(input);
        else throw Error('Unknown agent action');
      } catch(e) {
        this.agentTurn.errors++;
        await this.write({type:'agent-event',event:'rejected',at:new Date().toISOString(),decisionId:this.agentTurn.id,
          action,input,error:{code:'agent-input',message:e.message}});
        throw e;
      }
      await this.write({type:'agent-event',event:action,at:new Date().toISOString(),decisionId:this.agentTurn.id,input,
        ...(action==='preview'?{response:result}:{})});
      if(action==='preview')return result;
      const record=await this.finishDecision(result);
      this.agentTurn=null;
      return {accepted:true,acceptedDecisionId:input.decisionId,moveId:record.move?.id??null,result:this.state.last,error:record.error??null,...this.agentStatus()};
    });
  }
  async step({moveId,stateHash,path,transport}={}) {
    if(this.busy) throw Error('A decision is already running');
    if(this.state.status!=='playing') throw Error('Match is not playing');
    if(this.isAgentTurn())throw Error('Use the agent endpoint to submit a decision');
    let humanDecision;
    if(this.isHumanTurn()) {
      if(stateHash!==hashState(this.state)) throw Error('Position changed; refresh before submitting');
      const move=legalMoves(this.state).find(m=>m.id===moveId);
      if(!move) throw Error('Legal human move required');
      const selected=clone(move);
      if(path!==undefined) {
        if(!Array.isArray(path)||path.length>4096||path.some(op=>!['L','R','D','CW','CCW','HD'].includes(op))) throw Error('Invalid input path');
        selected.path=[...path];selected.position=replayPath(this.state.players[this.state.active].board,move.piece,path);
      }
      // Validate before accepting input: stale or malformed submissions never end a match.
      applyMove(this.state,selected);
      humanDecision={move:selected,memo:'',reason:'人間による操作',trace:{input:{moveId,stateHash,path:selected.path}},
        metrics:{elapsedMs:performance.now()-this.inputSince,pacingMs:0,transitions:0,calls:0,promptTokens:0,completionTokens:0,usageMissing:0,invalidResponses:0,cost:null}};
    } else if(moveId!==undefined||stateHash!==undefined||path!==undefined) throw Error('Manual input requires a human player');
    this.busy=true;
    return this.finishDecision(humanDecision,transport);
  }
  async finishDecision(supplied,transport) {
    const actor=this.state.active,record={type:'decision',index:this.records.length,actor,beforeHash:hashState(this.state)};
    this.decisionController=new AbortController();
    try {
      if(!legalMoves(this.state).length) throw new DecisionError('no-moves','No legal placements','forfeit');
      const decision=supplied??await decide(this.state,this.config.players[actor],{baseUrl:this.baseUrl,memo:this.memos[actor],transport,signal:this.decisionController.signal});
      if(this.stopRequested)throw new DecisionError('user-stop','Decision cancelled by user','aborted',{trace:decision.trace,metrics:decision.metrics});
      Object.assign(record,decision);
      this.state=applyMove(this.state,decision.move).state;
      this.memos[actor]=decision.memo;
    } catch(e) {
      record.error={code:e.code??'internal',message:e.message,outcome:e.outcome??'invalid'};
      if(e.detail) {record.trace=e.detail.trace;record.metrics=e.detail.metrics;record.error.detail=e.detail.body??null;}
      if(this.stopRequested)record.error={...record.error,code:'user-stop',outcome:'aborted'};
      this.state.status=record.error.outcome==='aborted'?'aborted':e.outcome==='forfeit'?'forfeit':'invalid';this.state.winner=e.outcome==='forfeit'&&!this.stopRequested?1-actor:null;this.state.reason=record.error.code;
    }
    if(this.stopRequested&&this.state.status==='playing') {this.state.status='aborted';this.state.winner=null;this.state.reason='user-stop';}
    record.state=clone(this.state);record.afterHash=hashState(this.state);
    try {await this.write(record);this.records.push(compactRecord(record));if(this.state.status!=='playing') await this.end();}
    finally {this.decisionController=null;this.busy=false;this.inputSince=performance.now();if(this.stopRequested&&this.state.status==='playing')await this.stop();}
    return record;
  }
  async run() {
    if(this.running||this.busy) throw Error('Match is already running');
    this.running=true;
    try {
      while(this.state.status==='playing'&&!this.stopRequested&&!this.isHumanTurn()&&!this.isAgentTurn()) {await this.step();await new Promise(r=>setImmediate(r));}
      if(this.stopRequested&&this.state.status==='playing') {this.state.status='aborted';this.state.reason='user-stop';await this.end();}
    } finally {this.running=false;}
  }
  async stop() {
    this.stopRequested=true;
    this.decisionController?.abort();
    if(!this.busy&&this.state.status==='playing') {this.state.status='aborted';this.state.reason='user-stop';await this.end();}
  }
  snapshot() {
    const compact=r=>{const {trace,...rest}=r;return rest;};
    const result={id:this.id,header:this.header,state:this.state,records:this.records.map(compact),busy:this.busy,running:this.running,stopRequested:this.stopRequested,
      runtimeError:this.runtimeError??null,agentWaiting:this.isAgentTurn(),hasAgent:this.config.players.some(p=>isAgentPlayer(p.type)),summary:summarize(this.state,this.records)};
    const humans=this.config.players.flatMap((p,i)=>p.type==='human'?[i]:[]);
    if(!humans.length) return result;
    const viewer=humans.length===1?humans[0]:this.state.active;
    const visible=state=>{
      const s=clone(state);delete s.seeds;
      for(const [i,p] of s.players.entries()) {
        delete p.bag;delete p.pieceRng;delete p.garbageRng;
        p.queue=i===viewer?p.queue.slice(0,s.rules.nextCount):[];
        if(i!==viewer)p.current=null;
        p.pending=pendingCount(p)?[pendingCount(p)]:[];
      }
      return s;
    };
    return {...result,viewer,header:{...this.header,initialState:visible(this.header.initialState)},state:visible(this.state),
      records:result.records.map(r=>({...r,state:visible(r.state)})),
      human:this.isHumanTurn()&&!this.busy?{stateHash:hashState(this.state),moves:legalMoves(this.state).map(publicMove)}:null};
  }
}

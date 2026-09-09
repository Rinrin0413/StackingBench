import {mkdir,appendFile,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createGame,clone,legalMoves,applyMove,publicMove,replayPath,pendingCount} from './engine.js';
import {playerConfig,decide,DecisionError} from './players.js';
import {endpointFor,pricingFor} from './providers.js';
import {AgentTurn} from './agent.js';

export const RUNS=resolve(process.env.STACKINGBENCH_RUNS??'runs');
export const hashState=state=>createHash('sha256').update(JSON.stringify(state)).digest('hex');
export async function readRun(id) {
  if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid run ID');
  const content=await readFile(join(RUNS,`${id}.jsonl`),'utf8'),lines=content.split('\n'),records=[];
  for(let i=0;i<lines.length;i++) {
    if(!lines[i].trim()) continue;
    try {records.push(JSON.parse(lines[i]));}
    catch(e) {if(i===lines.length-1) break;throw e;}
  }
  return records;
}
export async function listRuns() {
  await mkdir(RUNS,{recursive:true});
  const entries=(await readdir(RUNS)).filter(n=>n.endsWith('.jsonl')).sort().reverse();
  const result=[];
  for(const name of entries.slice(0,100)) {
    const records=await readRun(name.slice(0,-6));
    if(!records[0]) continue;
    const end=records.findLast(r=>r.type==='end');
    result.push({id:records[0].id,createdAt:records[0].createdAt,players:records[0].config.players,status:end?.status??'incomplete',
      winner:end?.winner,locks:records.filter(r=>r.type==='decision'&&r.move).length});
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
  static async create(options={}) {
    const players=(options.players??[{},{}]).map(playerConfig);
    if(players.length!==2) throw Error('Two player configurations required');
    const initial=options.initialState?clone(options.initialState):createGame(options);
    if(initial.rules.version!==1||initial.status!=='playing') throw Error('Only active v1 positions can be resumed');
    const config={players,baseUrl:endpointFor({provider:'llamacpp'}),connections:players.map(p=>['search','human','codex'].includes(p.type)?null:{provider:p.provider,baseUrl:endpointFor(p),pricing:p.provider==='sakura'?pricingFor(p.model):null}),parent:options.parent??null};
    const m=new Match();
    m.id=`${new Date().toISOString().replace(/[:.]/g,'-')}_${randomUUID().slice(0,8)}`;
    m.state=initial;m.config=config;m.records=[];m.memos=['',''];m.running=false;m.busy=false;m.stopRequested=false;m.ended=false;
    let sourceRevision=null,sourceDirty=null;
    try {sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();sourceDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();} catch { /* Initial uncommitted workspace. */ }
    const sourceFiles=['engine.js','observation.js','players.js','match.js','providers.js','agent.js'];
    const sourceHash=createHash('sha256');for(const file of sourceFiles)sourceHash.update(await readFile(new URL(file,import.meta.url)));
    m.header={type:'header',format:1,id:m.id,createdAt:new Date().toISOString(),config,initialState:clone(initial),initialHash:hashState(initial),
      runtime:process.version,engineVersion:'0.1.0',sourceRevision,sourceDirty,sourceHash:sourceHash.digest('hex')};
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
  isAgentTurn() { return this.state.status==='playing'&&this.config.players[this.state.active].type==='codex'; }
  agentStatus() {
    return {id:this.id,status:this.state.status,winner:this.state.winner,reason:this.state.reason??null,active:this.state.active,
      locks:this.state.locks,remaining:this.state.remaining,busy:this.busy||this.running,
      ready:this.isAgentTurn()&&!this.busy&&!this.running,
      decisionId:this.isAgentTurn()?`${this.id}:${this.records.length}`:null};
  }
  async agentOperation(fn) {
    if(this.busy||this.running)throw Error('A decision is already running');
    if(!this.isAgentTurn())throw Error('Not a Codex turn');
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
    if(this.isAgentTurn())throw Error('Use the Codex agent endpoint to submit a decision');
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
    try {
      if(!legalMoves(this.state).length) throw new DecisionError('no-moves','No legal placements','forfeit');
      const decision=supplied??await decide(this.state,this.config.players[actor],{baseUrl:this.config.baseUrl,memo:this.memos[actor],transport});
      Object.assign(record,decision);
      this.state=applyMove(this.state,decision.move).state;
      this.memos[actor]=decision.memo;
    } catch(e) {
      record.error={code:e.code??'internal',message:e.message,outcome:e.outcome??'invalid'};
      if(e.detail) {record.trace=e.detail.trace;record.metrics=e.detail.metrics;record.error.detail=e.detail.body??null;}
      this.state.status=e.outcome==='forfeit'?'forfeit':'invalid';this.state.winner=e.outcome==='forfeit'?1-actor:null;this.state.reason=record.error.code;
    }
    if(this.stopRequested&&this.state.status==='playing') {this.state.status='aborted';this.state.winner=null;this.state.reason='user-stop';}
    record.state=clone(this.state);record.afterHash=hashState(this.state);
    this.records.push(record);
    try {await this.write(record);if(this.state.status!=='playing') await this.end();}
    finally {this.busy=false;this.inputSince=performance.now();}
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
    if(!this.busy&&this.state.status==='playing') {this.state.status='aborted';this.state.reason='user-stop';await this.end();}
  }
  snapshot() {
    const compact=r=>{const {trace,...rest}=r;return rest;};
    const result={id:this.id,header:this.header,state:this.state,records:this.records.map(compact),busy:this.busy,running:this.running,stopRequested:this.stopRequested,
      runtimeError:this.runtimeError??null,agentWaiting:this.isAgentTurn(),hasAgent:this.config.players.some(p=>p.type==='codex'),summary:summarize(this.state,this.records)};
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

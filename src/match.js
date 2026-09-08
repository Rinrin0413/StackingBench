import {mkdir,appendFile,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createGame,clone,legalMoves,applyMove} from './engine.js';
import {playerConfig,decide,DecisionError} from './players.js';
import {endpointFor,pricingFor} from './providers.js';

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
    const config={players,baseUrl:endpointFor({provider:'llamacpp'}),connections:players.map(p=>p.type==='search'?null:{provider:p.provider,baseUrl:endpointFor(p),pricing:p.provider==='sakura'?pricingFor(p.model):null}),parent:options.parent??null};
    const m=new Match();
    m.id=`${new Date().toISOString().replace(/[:.]/g,'-')}_${randomUUID().slice(0,8)}`;
    m.state=initial;m.config=config;m.records=[];m.memos=['',''];m.running=false;m.busy=false;m.stopRequested=false;m.ended=false;
    let sourceRevision=null,sourceDirty=null;
    try {sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();sourceDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();} catch { /* Initial uncommitted workspace. */ }
    const sourceFiles=['engine.js','observation.js','players.js','match.js','providers.js'];
    const sourceHash=createHash('sha256');for(const file of sourceFiles)sourceHash.update(await readFile(new URL(file,import.meta.url)));
    m.header={type:'header',format:1,id:m.id,createdAt:new Date().toISOString(),config,initialState:clone(initial),initialHash:hashState(initial),
      runtime:process.version,engineVersion:'0.1.0',sourceRevision,sourceDirty,sourceHash:sourceHash.digest('hex')};
    await mkdir(RUNS,{recursive:true});m.path=join(RUNS,`${m.id}.jsonl`);await m.write(m.header);
    return m;
  }
  async write(record) { await appendFile(this.path,JSON.stringify(record)+'\n'); }
  async end() {
    if(this.ended) return;
    const end={type:'end',at:new Date().toISOString(),status:this.state.status,winner:this.state.winner,reason:this.state.reason,
      stateHash:hashState(this.state),state:clone(this.state),summary:summarize(this.state,this.records)};
    await this.write(end);this.ended=true;this.running=false;
  }
  async step({moveId,transport}={}) {
    if(this.busy) throw Error('A decision is already running');
    if(this.state.status!=='playing') throw Error('Match is not playing');
    if(moveId!==undefined) throw Error('Manual moves are not part of benchmark conditions');
    this.busy=true;
    const actor=this.state.active,record={type:'decision',index:this.records.length,actor,beforeHash:hashState(this.state)};
    try {
      if(!legalMoves(this.state).length) throw new DecisionError('no-moves','No legal placements','forfeit');
      const decision=await decide(this.state,this.config.players[actor],{baseUrl:this.config.baseUrl,memo:this.memos[actor],transport});
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
    finally {this.busy=false;}
    return record;
  }
  async run() {
    if(this.running||this.busy) throw Error('Match is already running');
    this.running=true;
    try {
      while(this.state.status==='playing'&&!this.stopRequested) {await this.step();await new Promise(r=>setImmediate(r));}
      if(this.stopRequested&&this.state.status==='playing') {this.state.status='aborted';this.state.reason='user-stop';await this.end();}
    } finally {this.running=false;}
  }
  async stop() {
    this.stopRequested=true;
    if(!this.busy&&this.state.status==='playing') {this.state.status='aborted';this.state.reason='user-stop';await this.end();}
  }
  snapshot() {
    const compact=r=>{const {trace,...rest}=r;return rest;};
    return {id:this.id,header:this.header,state:this.state,records:this.records.map(compact),busy:this.busy,running:this.running,stopRequested:this.stopRequested,
      runtimeError:this.runtimeError??null,summary:summarize(this.state,this.records)};
  }
}

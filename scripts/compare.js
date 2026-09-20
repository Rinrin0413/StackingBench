import {writeFile,mkdir} from 'node:fs/promises';
import {readRun,RUNS,hashState} from '../src/match.js';
import {decide,playerConfig,DEFAULT_MODEL} from '../src/players.js';
import {assertCapabilitySelection,capabilityTargetsForConfig,ensureCapabilitySnapshot} from '../src/capabilities.js';
import {applyMove,createGame} from '../src/engine.js';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const run=option('run',null),index=Number(option('index','0'));
const connection=option('connection',null),connectionA=option('connection-a',connection);
let state=createGame({seeds:[101,202]});
if(run) {const records=await readRun(run);state=index===0?records[0].initialState:records.filter(r=>r.type==='decision')[index-1]?.state;}
if(!state||state.status!=='playing')throw Error('Select an active replay position');
const report={kind:'single-position-comparison',at:new Date().toISOString(),parent:run?{id:run,index}:null,
  initialState:state,initialHash:hashState(state),memo:'',results:[],note:'One decision per condition; not a match or strength estimate.'};
await mkdir(RUNS,{recursive:true});
for(const type of ['llm','llm-preview','search']) {
  let config=playerConfig({type,...(connectionA?{connectionId:connectionA}:{}),modelId:option('model',DEFAULT_MODEL),requestIntervalMs:Number(option('request-interval-ms','0')),thinking:option('thinking','server-default'),transitions:Number(option('transitions','32')),
    maxTokens:Number(option('max-tokens','2048')),decisionTokens:Number(option('decision-tokens','8192')),timeoutMs:Number(option('timeout-ms','120000')),maxCalls:Number(option('max-calls','34'))});
  console.log(`Comparing ${type} from ${report.initialHash}`);
  try {
    if(['llm','llm-preview'].includes(config.type)) {
      const snapshot=await ensureCapabilitySnapshot(config.connection,config.modelId,{refresh:args.includes('--probe')||args.includes('--preflight'),targets:capabilityTargetsForConfig(config),timeoutMs:config.timeoutMs,routingPolicy:config.routingPolicy});
      config=playerConfig({...config,capabilitySnapshot:snapshot});assertCapabilitySelection(config,config.connection,snapshot,{requireSupported:true});
    }
    const decision=await decide(state,config,{baseUrl:process.env.LLM_BASE_URL??'http://localhost:8082'});report.results.push({config,...decision,afterState:applyMove(state,decision.move).state});
  }
  catch(e) {report.results.push({config,error:{code:e.code,message:e.message,outcome:e.outcome,detail:e.detail}});}
  const path=`${RUNS}/position-${report.at.replace(/[:.]/g,'-')}.json`;await writeFile(path,JSON.stringify(report,null,2));console.log(path);
}

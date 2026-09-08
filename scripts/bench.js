import {writeFile,mkdir} from 'node:fs/promises';
import {Match,RUNS} from '../src/match.js';
import {DEFAULT_MODEL,playerConfig} from '../src/players.js';

const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const seeds=option('seeds','101').split(',').map(Number),swap=args.includes('--swap');
const model=option('model',DEFAULT_MODEL),maxLocks=Number(option('max-locks','280'));
const settings={model,requestIntervalMs:Number(option('request-interval-ms','0')),transitions:Number(option('transitions','32')),maxTokens:Number(option('max-tokens','2048')),thinking:option('thinking','server-default'),
  decisionTokens:Number(option('decision-tokens','8192')),timeoutMs:Number(option('timeout-ms','120000')),maxCalls:Number(option('max-calls','34'))};
const players=[{...settings,model:option('model-a',model),type:option('a','search')},{...settings,model:option('model-b',model),type:option('b','search')}].map(playerConfig);
const results=[];
for(const seed of seeds) for(const first of swap?[0,1]:[0]) {
  const match=await Match.create({seeds:[seed,((seed^0x6c078965)>>>0)||1],first,maxLocks,players});
  console.log(`Starting ${match.id}: ${players[0].type} vs ${players[1].type}, seed=${seed}, first=${first}`);
  while(match.state.status==='playing') {
    const r=await match.step();console.log(JSON.stringify({lock:match.state.locks,actor:r.actor,move:r.move?.id,ms:Math.round(r.metrics?.elapsedMs??0),sent:match.state.last?.sent,error:r.error?.code}));
  }
  const end=match.snapshot();
  results.push({id:match.id,seed,first,status:end.state.status,winner:end.state.winner,reason:end.state.reason,summary:end.summary});
  console.log(JSON.stringify(results.at(-1)));
}
const valid=results.filter(r=>['finished','forfeit'].includes(r.status));
const report={at:new Date().toISOString(),players,seeds,swap,maxLocks,results,aggregate:{matches:results.length,valid:valid.length,
  invalid:results.filter(r=>r.status==='invalid').length,wins:[0,1].map(i=>valid.filter(r=>r.winner===i).length),
  draws:valid.filter(r=>r.winner===null).length,winRate:[0,1].map(i=>valid.length?valid.filter(r=>r.winner===i).length/valid.length:null),
  note:'Smoke tests and small samples do not establish relative strength. Transition counts are not equal compute.'}};
await mkdir(RUNS,{recursive:true});const path=`${RUNS}/batch-${Date.now()}.json`;await writeFile(path,JSON.stringify(report,null,2));console.log(`Report: ${path}`);

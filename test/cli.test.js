import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,appendFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGame} from '../src/engine.js';

const execute=promisify(execFile);
async function pnpm(script,args,env,input='') {
  const result=execute('pnpm',['--silent','run',script,...args],{env:{...process.env,...env},timeout:10000});
  result.child.stdin.end(input);
  return (await result).stdout;
}

test('agent CLI accepts pnpm separators for every command and preserves stdin options',async t=>{
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({status:'finished',url:req.url,method:req.method,input:raw?JSON.parse(raw):null}));
  });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={STACKINGBENCH_URL:`http://127.0.0.1:${server.address().port}`};
  const input={decisionId:'fixture-decision',moveId:'m0000',requestId:'fixture-preview'};
  for(const prefix of [[],['--']]) {
    for(const command of ['list','observe','wait','preview','choose']) {
      const post=['preview','choose'].includes(command);
      const args=[...prefix,command,...(command==='list'?[]:['fixture']),
        ...(command==='wait'?['--after','previous','--timeout-ms','1000']:[]),...(post?['--file','-']:[])];
      const value=JSON.parse(await pnpm('agent',args,env,post?JSON.stringify(input):''));
      const suffix={list:'',observe:'/fixture',wait:'/fixture/status',preview:'/fixture/preview',choose:'/fixture/choose'}[command];
      assert.equal(value.url,`/api/agent/matches${suffix}`);
      assert.equal(value.method,post?'POST':'GET');assert.deepEqual(value.input,post?input:null);
    }
  }
});

test('probe CLI preserves the positional model after a pnpm separator',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-cli-probe-')),models=[];
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    models.push(JSON.parse(raw).model);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
  });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={STACKINGBENCH_RUNS:dir,LLM_BASE_URL:`http://127.0.0.1:${server.address().port}`};
  for(const prefix of [[],['--']]) {
    const value=JSON.parse(await pnpm('probe',[...prefix,'cli-fixture-model','--max-tokens','32'],env));
    assert.equal(value.ok,true);assert.equal(value.model,'cli-fixture-model');
  }
  assert.deepEqual(models,['cli-fixture-model','cli-fixture-model']);
});

test('replay CLI accepts a run ID with and without a pnpm separator',async t=>{
  const {hashState}=await import('../src/match.js');
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-cli-replay-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const initialState=createGame(),initialHash=hashState(initialState);
  await writeFile(join(dir,'fixture.jsonl'),JSON.stringify({type:'header',initialState,initialHash})+'\n');
  for(const prefix of [[],['--']])assert.match(await pnpm('replay',[...prefix,'fixture'],{STACKINGBENCH_RUNS:dir}),/Verified 0 decisions: fixture/);
});
test('large logs remain listable, verifiable and branchable within a 32 MB heap',async t=>{
  const {hashState}=await import('../src/match.js');
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-large-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const initialState=createGame(),header={type:'header',format:2,id:'large',createdAt:new Date().toISOString(),config:{players:[{type:'search'},{type:'search'}]},initialState,initialHash:hashState(initialState)};
  const path=join(dir,'large.jsonl');await writeFile(path,JSON.stringify(header)+'\n');
  const event=JSON.stringify({type:'agent-event',trace:{padding:'x'.repeat(256*1024)}})+'\n';
  for(let i=0;i<192;i++)await appendFile(path,event);
  const options={env:{...process.env,STACKINGBENCH_RUNS:dir},timeout:15000};
  const verification=await execute(process.execPath,['--max-old-space-size=32','scripts/replay.js','large'],options);
  assert.match(verification.stdout,/Verified 0 decisions/);
  const inspection=await execute(process.execPath,['--max-old-space-size=32','--input-type=module','-e',
    "import assert from 'node:assert/strict';import {listRuns,readRun,readRunPosition} from './src/match.js';assert.equal((await listRuns())[0].id,'large');assert.equal((await readRun('large',{compact:true})).length,193);assert.equal((await readRunPosition('large',0)).locks,0);"],options);
  assert.equal(inspection.stderr,'');
});
test('replay CLI verifies the saved v1 garbage fixture using the current engine',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-v1-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await copyFile(new URL('./fixtures/rules-v1-garbage.jsonl',import.meta.url),join(dir,'rules-v1-garbage.jsonl'));
  assert.match(await pnpm('replay',['--','rules-v1-garbage'],{STACKINGBENCH_RUNS:dir}),/Verified 1 decisions/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
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
  const dir=await mkdtemp(join(tmpdir(),'stackingbench-cli-replay-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const initialState=createGame(),initialHash=createHash('sha256').update(JSON.stringify(initialState)).digest('hex');
  await writeFile(join(dir,'fixture.jsonl'),JSON.stringify({type:'header',initialState,initialHash})+'\n');
  for(const prefix of [[],['--']])assert.match(await pnpm('replay',[...prefix,'fixture'],{STACKINGBENCH_RUNS:dir}),/Verified 0 decisions: fixture/);
});

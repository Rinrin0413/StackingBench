import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createPortListener} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

test('HTTP stop aborts the provider request, frees the match and releases server exclusivity',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'stackingbench-server-'));
  let started,closed,decisionCalls=0,app;
  const ready=new Promise(resolve=>{started=resolve;}),cancelled=new Promise(resolve=>{closed=resolve;});
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(req.method==='GET') {res.setHeader('Content-Type','application/json');res.end('{"data":[]}');return;}
    const body=JSON.parse(raw);let observation;
    try {observation=JSON.parse(body.messages?.[1]?.content);} catch { /* Capability probe. */ }
    if(observation?.schema==='stackingbench.observation.v1') {
      decisionCalls++;res.once('close',closed);started();return;
    }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  t.after(async()=>{
    if(app?.exitCode===null) {const exited=once(app,'exit');app.kill();await exited;}
    provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(root,{recursive:true,force:true});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const listener=createPortListener();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  app=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),STACKINGBENCH_RUNS:root,STACKINGBENCH_CAPABILITIES:join(root,'capabilities.json'),LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}`},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(app.stdout,'data'),once(app,'exit').then(()=>{throw Error('Server exited');})]);
  const request=async(path,method='GET',data)=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,value:await response.json()};
  };
  const created=await request('/api/matches','POST',{players:[{type:'llm'},{type:'human'}]});assert.equal(created.status,201);
  const id=created.value.id;
  assert.equal((await request(`/api/matches/${id}/run`,'POST',{})).status,202);
  await ready;
  assert.equal((await request('/api/probe','POST',{model:'fixture'})).status,409);
  assert.equal((await request('/api/matches','POST',{players:[{type:'human'},{type:'human'}]})).status,409);
  assert.equal((await request(`/api/matches/${id}/stop`,'POST',{})).status,202);
  await cancelled;
  let saved;
  for(let attempt=0;attempt<100;attempt++) {
    saved=(await request(`/api/matches/${id}`)).value;
    if(saved.archived)break;
    await delay(10);
  }
  assert.equal(saved.archived,true);assert.equal(saved.state.status,'aborted');assert.equal(saved.state.locks,0);assert.equal(saved.busy,false);
  assert.equal(decisionCalls,1);
  const records=(await readFile(join(root,`${id}.jsonl`),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records[1].error.code,'user-stop');assert.equal(records[1].trace.requests[0].error.code,'user-stop');assert.equal(records.at(-1).status,'aborted');
  const replay=(await request(`/api/runs/${id}`)).value;
  assert(!Object.hasOwn(replay[1],'trace'));assert.equal(replay.at(-1).status,'aborted');
  assert.equal((await request('/api/probe','POST',{model:'fixture'})).status,200);
  const next=await request('/api/matches','POST',{players:[{type:'human'},{type:'human'}]});assert.equal(next.status,201);
  await request(`/api/matches/${next.value.id}/stop`,'POST',{});
  for(let i=0;i<3;i++) {
    const match=(await request('/api/matches','POST',{maxLocks:1,players:[{type:'search',transitions:1},{type:'search',transitions:1}]})).value;
    await request(`/api/matches/${match.id}/run`,'POST',{});
    for(let attempt=0;attempt<100;attempt++) {
      saved=(await request(`/api/matches/${match.id}`)).value;if(saved.archived)break;await delay(10);
    }
    assert.equal(saved.archived,true);assert.equal(saved.state.status,'finished');assert.equal(saved.records.length,1);
  }
});

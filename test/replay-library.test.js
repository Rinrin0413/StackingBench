import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {identityLabel,playerLabels,selectRuns,formatDate,runTitle} from '../web/replay-display.js';

const players=[{type:'codex',agentModel:'Original',reasoningEffort:'high'},{type:'human'}];
test('display overrides distinguish unknown from original and preserve mixed execution identities',()=>{
  const run={players,executions:[[{model:'First',reasoningEffort:'low'},{model:'Second',reasoningEffort:'high'}],[]],metadata:{players:[{model:'Corrected',reasoningEffort:null},{}]}};
  assert.deepEqual(playerLabels(run),['Codex · Corrected（表示訂正）','人間']);
  assert.equal(playerLabels(run,true)[0],'Codex · First（申告情報） → Codex · Second（申告情報）');
  assert.equal(identityLabel(players[0],undefined,{model:null}),'Codex · モデル未記録（表示訂正）');
  assert.equal(identityLabel({type:'llm',model:'API',thinking:'off'}),'LLM · API');
  assert.equal(identityLabel(players[0],undefined,{reasoningEffort:'low'}),'Codex · Original（申告情報）');
  assert.match(runTitle(run),/Corrected/);run.metadata.title='My replay';assert.equal(runTitle(run),'My replay');
});
test('library searches all runs and sorts, filters trash, results and favorites',()=>{
  const runs=Array.from({length:120},(_,i)=>({id:`run-${i}`,createdAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),players,metadata:{title:`Title ${i}`,favorite:i===0,trashed:i===1},status:i===0?'invalid':'finished'}));
  assert.equal(selectRuns(runs).length,119);assert.equal(selectRuns(runs)[0].id,'run-119');
  assert.equal(selectRuns(runs,{query:'title 0'})[0].id,'run-0');
  assert.equal(selectRuns(runs,{query:'ORIGINAL'}).length,119);
  assert.equal(selectRuns(runs,{query:'run-119'})[0].id,'run-119');
  assert.equal(selectRuns(runs,{trash:true})[0].id,'run-1');
  assert.equal(selectRuns(runs,{favorite:true,result:'invalid'})[0].id,'run-0');
  assert.equal(selectRuns(runs,{sort:'oldest'})[0].id,'run-0');
  assert.equal(selectRuns(runs,{sort:'title'})[0].metadata.title,'Title 0');
});
test('dates use locale and timezone, including midnight and year boundaries',()=>{
  const value='2026-12-31T23:30:00Z';
  assert.match(formatDate(value,{locale:'ja-JP',timeZone:'Asia/Tokyo'}),/2027\/01\/01.*08:30/);
  assert.match(formatDate(value,{locale:'en-US',timeZone:'America/Los_Angeles'}),/12\/31\/2026.*03:30 PM/);
  assert.match(formatDate(value,{locale:'en-US',timeZone:'UTC',detail:true}),/UTC/);
  assert.equal(formatDate('invalid'),'日時不明');
});

test('metadata HTTP lifecycle preserves logs, compatibility and public information boundaries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stackingbench-library-'));
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  let server;
  const start=async()=>{server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),STACKINGBENCH_RUNS:root},stdio:['ignore','pipe','pipe']});await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);};
  const stop=async()=>{const exited=once(server,'exit');server.kill();await exited;};
  t.after(async()=>{if(server?.exitCode===null)await stop();await rm(root,{recursive:true,force:true});});
  const request=async(path,method='GET',data,extra={})=>{const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json',...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,value:await response.json()};};
  await start();
  const created=await request('/api/matches','POST',{players:[{type:'codex'},{type:'human'}],maxLocks:1});assert.equal(created.status,201);
  const id=created.value.id,url=`/api/runs/${id}/metadata`;
  const observe=(await request(`/api/agent/matches/${id}`)).value;
  assert.equal((await request(url,'PATCH',{trashed:true})).status,409);
  const patch={title:'訂正した対局',favorite:true,players:[{model:'Corrected Ultra'},{}]};
  assert.equal((await request(url,'PATCH',patch)).status,200);
  assert.deepEqual((await request(`/api/agent/matches/${id}`)).value,observe);
  assert(!JSON.stringify((await request(`/api/agent/matches/${id}/status`)).value).includes('Corrected'));
  const before=await readFile(join(root,`${id}.jsonl`),'utf8');
  for(const invalid of [{players:[{model:3},{}]},{players:[{}, {model:'human-model'}]},{title:'x'.repeat(161)},{players:[{model:'x'.repeat(301)},{}]},{players:[{reasoningEffort:'high'},{}]},{favorite:'true'},{seed:5},{players:[]},{players:[null,{}]}])assert.equal((await request(url,'PATCH',invalid)).status,400);
  assert.equal((await request(url,'PATCH',{title:'bad'},{Origin:'https://example.com'})).status,403);
  assert.equal((await request(url,'PATCH',patch,{'Content-Type':'text/plain'})).status,415);
  assert.equal(await readFile(join(root,`${id}.jsonl`),'utf8'),before);
  await request(`/api/matches/${id}/stop`,'POST',{});
  const archived=await request(`/api/matches/${id}`);
  assert.equal(archived.status,200);assert.equal(archived.value.archived,true);assert.equal(archived.value.state.status,'aborted');
  const completedAgent=(await request(`/api/agent/matches/${id}/status`)).value;
  assert.equal(completedAgent.status,'aborted');assert.equal(completedAgent.ready,false);
  assert(!(await request('/api/agent/matches')).value.some(m=>m.id===id));
  assert(!(await request(`/api/runs/${id}`)).value.some(r=>r.type==='agent-event'));
  const forks=await Promise.all(Array.from({length:2},()=>request('/api/matches','POST',{parent:{id,index:0},players:[{type:'human'},{type:'human'}]})));
  assert.deepEqual(forks.map(r=>r.status).sort(),[201,409]);
  const fork=forks.find(r=>r.status===201).value;
  await request(`/api/matches/${fork.id}/stop`,'POST',{});
  await rm(join(root,`${fork.id}.jsonl`));
  const invalidFork=await request('/api/matches','POST',{parent:{id,index:999}});assert.equal(invalidFork.status,400);
  const afterError=await request('/api/matches','POST',{players:[{type:'human'},{type:'human'}]});assert.equal(afterError.status,201);
  await request(`/api/matches/${afterError.value.id}/stop`,'POST',{});await rm(join(root,`${afterError.value.id}.jsonl`));
  const original=await readFile(join(root,`${id}.jsonl`),'utf8');
  const metadataFile=join(root,'metadata',`${id}.json`);
  for(const reasoningEffort of ['high','unlimited',null,123,{old:'value'}]) {
    const legacyMetadata={title:'Legacy',favorite:true,trashed:false,players:[{model:'Legacy model',reasoningEffort},{}]},legacySource=JSON.stringify(legacyMetadata)+'\n';
    await writeFile(metadataFile,legacySource);
    const read=await request(url);assert.equal(read.status,200);
    assert.deepEqual(read.value,{...legacyMetadata,players:[{model:'Legacy model'},{}]});
    assert.equal(await readFile(metadataFile,'utf8'),legacySource);
    const library=(await request('/api/runs?library=1')).value;
    assert.equal(library.errors.length,0);assert(library.runs.some(run=>run.id===id));
    assert.equal((await request(url,'PATCH',{favorite:false})).status,200);
    assert.deepEqual(JSON.parse(await readFile(metadataFile,'utf8')),{...legacyMetadata,favorite:false,players:[{model:'Legacy model'},{}]});
  }
  await request(url,'PATCH',{players:[{model:null},{}]});
  assert.deepEqual((await request(url)).value.players[0],{model:null});
  await request(url,'PATCH',{players:[{},{}]});assert.deepEqual((await request(url)).value.players,[{},{}]);
  await Promise.all([request(url,'PATCH',{favorite:false}),request(url,'PATCH',{title:'Concurrent'})]);
  assert.equal((await request(url)).value.title,'Concurrent');assert.equal((await request(url)).value.favorite,false);
  assert.equal((await request(url,'PATCH',{trashed:true})).status,200);
  assert.equal((await request('/api/runs')).value.length,0);
  assert.equal((await request('/api/runs?trash=trash')).value[0].id,id);
  assert.equal((await request(`/api/runs/${id}`)).value[0].id,id);
  await stop();await start();
  assert.equal((await request(url)).value.trashed,true);
  assert.equal((await request(url)).value.title,'Concurrent');
  await request(url,'PATCH',{trashed:false});assert.equal((await request('/api/runs')).value[0].id,id);
  assert.equal(await readFile(join(root,`${id}.jsonl`),'utf8'),original);
  const verification=spawn(process.execPath,['scripts/replay.js',id],{env:{...process.env,STACKINGBENCH_RUNS:root},stdio:'ignore'});assert.equal((await once(verification,'exit'))[0],0);
  const header=JSON.parse(original.split('\n')[0]);
  for(let i=0;i<110;i++)await writeFile(join(root,`fixture-${i}.jsonl`),JSON.stringify({...header,id:`fixture-${i}`})+'\n');
  await writeFile(join(root,'corrupt.jsonl'),'not JSON\n');
  const catalog=(await request('/api/runs?library=1&trash=all')).value;
  assert.equal(catalog.runs.length,111);assert.equal(catalog.errors[0].id,'corrupt');
  assert(catalog.runs.some(r=>r.id==='fixture-0'));
  await writeFile(join(root,'metadata',`${id}.json`),'{bad');
  const corruptMetadata=(await request('/api/runs?library=1')).value;
  assert.equal(corruptMetadata.runs.length,110);assert.equal(corruptMetadata.errors.length,2);
  assert.equal((await request('/api/runs/missing/metadata','PATCH',{title:'missing'})).status,404);
  assert.equal((await request('/api/runs?trash=invalid')).status,400);
  for(const type of ['codex','agy','opencode','claude']) {
    for(const reasoningEffort of ['high',null,123]) {
      const rejected=await request('/api/matches','POST',{players:[{type,reasoningEffort},{type:'human'}],maxLocks:1});
      assert.equal(rejected.status,400);assert.match(rejected.value.error,/reasoningEffort.*agentModel.*に含めてください/);
    }
    const configured=await request('/api/matches','POST',{players:[{type,agentModel:'Custom session model High'},{type:'human'}],maxLocks:1});
    assert.equal(configured.status,201);
    assert.equal(configured.value.header.config.players[0].agentModel,'Custom session model High');
    assert(!Object.hasOwn(configured.value.header.config.players[0],'reasoningEffort'));
    assert.equal(configured.value.header.config.players[0].input,`${type}-session-v2`);
    const root=(await request(`/api/agent/matches/${configured.value.id}`)).value;
    assert.equal(root.protocol,`stackingbench.${type}-session.v2`);
    const rejected=await request(`/api/agent/matches/${configured.value.id}/choose`,'POST',{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,reasoningEffort:'high'});
    assert.equal(rejected.status,400);assert.match(rejected.value.error,/reasoningEffort.*agentModel.*に含めてください/);
    assert.equal((await request(`/api/agent/matches/${configured.value.id}/status`)).value.locks,0);
    await request(`/api/matches/${configured.value.id}/stop`,'POST',{});
  }
});

for(const [type,label,model] of [['opencode','OpenCode','Model'],['claude','Claude Code','Claude']]) {
test(`${label} replay labels use recorded identities without filling missing historical values`,()=>{
  assert.match(identityLabel({type,agentModel:model}),new RegExp(`^${label} · ${model}.*申告情報`));
  assert.match(identityLabel({type}),new RegExp(`^${label} · モデル未記録`));
  const run={players:[{type,agentModel:'Configured'},{type:'human'}],executions:[[{model:'Reported',reasoningEffort:null}],[]]};
  assert.match(playerLabels(run)[0],new RegExp(`^${label} · Reported.*申告情報`));
  assert.match(identityLabel(run.players[0],{model:null}),/モデル未記録/);
});
}

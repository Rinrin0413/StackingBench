// Browser regression check using Chrome's DevTools protocol; no package dependency.
// Run: CHROME_PATH=/usr/bin/google-chrome node scripts/library-smoke.js
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createGame} from '../src/engine.js';
const temp=await mkdtemp(join(tmpdir(),'stackingbench-browser-')),runDir=join(temp,'runs');
await mkdir(runDir);await mkdir(join(runDir,'metadata'));await mkdir('runs',{recursive:true});
const initialState=createGame({maxLocks:1}),players=[{type:'codex',agentModel:'Original model',reasoningEffort:'high'},{type:'search'}];
for(let i=0;i<115;i++) {
  const header={type:'header',id:`fixture-${i}`,createdAt:new Date(Date.UTC(2026,0,i+1,23,30)).toISOString(),config:{players},initialState};
  await writeFile(join(runDir,`${header.id}.jsonl`),JSON.stringify(header)+'\n');
}
await writeFile(join(runDir,'metadata','fixture-0.json'),JSON.stringify({title:'年始の対局',favorite:true,players:[{},{}],trashed:false}));
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),STACKINGBENCH_RUNS:runDir},stdio:['ignore','pipe','pipe']});
let chrome,socket;
try {
  await once(server.stdout,'data');
  chrome=spawn(process.env.CHROME_PATH??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(temp,'chrome')}`,'about:blank'],{stdio:'ignore'});
  let debugPort;
  for(let i=0;i<100;i++){try{debugPort=(await readFile(join(temp,'chrome','DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await delay(100);}}
  assert(debugPort,'Chrome did not start');
  const targets=await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let serial=0;const pending=new Map(),errors=[];
  socket.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.id){const task=pending.get(result.id);pending.delete(result.id);if(result.error)task.reject(Error(JSON.stringify(result.error)));else task.resolve(result.result);}else if(result.method==='Runtime.exceptionThrown')errors.push(result.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50);}throw Error(`Timed out: ${expression}`);};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button=text=>evaluate(`Array.from(document.querySelectorAll('#replay-library button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setLocaleOverride',{locale:'ja-JP'});await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}`});
  await wait("document.querySelector('#library-total')?.textContent==='115件の保存対局'");
  await click('#show-library');await wait("document.querySelectorAll('.run-card').length===50");
  await click('#library-more');assert.equal(await evaluate("document.querySelectorAll('.run-card').length"),100);
  await fill('#library-search','fixture-0');await wait("document.querySelectorAll('.run-card').length===1");await click('.run-card');assert.match(await evaluate("document.querySelector('#library-detail').textContent"),/2026\/01\/02.*08:30/);
  await button('情報を編集');await fill('#replay-title','Edited title');
  await fill('#override-0-model','custom');await fill('#value-0-model','Corrected model');await fill('#override-0-reasoningEffort','unknown');
  await button('保存する');await wait("document.querySelector('#library-status').textContent==='保存しました'");
  assert.match(await evaluate("document.querySelector('.run-card').textContent"),/Corrected model.*推論レベル未記録/);
  await writeFile('runs/ui-library-desktop.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await button('リプレイを開く');await wait("!document.querySelector('#replay-library').open");
  assert.match(await evaluate("document.querySelector('#recorded-model-a').textContent"),/Corrected model.*推論レベル未記録/);
  assert.equal(await evaluate("document.querySelector('#match-label').textContent"),'Edited title');
  assert.equal(await evaluate('document.activeElement.id'),'show-library');
  await click('#show-library');await wait("document.querySelector('#library-status').textContent===''");
  await button('★ お気に入り解除');await wait("document.querySelector('#library-detail').textContent.includes('☆ お気に入り')");await button('☆ お気に入り');await wait("document.querySelector('#library-detail').textContent.includes('★ お気に入り解除')");
  await button('情報を編集');await fill('#replay-title','Unsaved draft');
  // Fail only the management write; the editor must preserve the user's input.
  await evaluate("window.realFetch=window.fetch;window.fetch=(url,options)=>options?.method==='PATCH'?Promise.reject(new Error('fixture offline')):window.realFetch(url,options)");
  await button('保存する');await wait("document.querySelector('#library-status').textContent.includes('入力は保持されています')");
  assert.equal(await evaluate("document.querySelector('#replay-title').value"),'Unsaved draft');
  await evaluate('window.fetch=window.realFetch');await button('保存する');await wait("document.querySelector('#library-status').textContent==='保存しました'");
  await button('ゴミ箱へ移動');await wait("document.querySelectorAll('.run-card').length===0");
  await click('#library-trash');await click('.run-card');await button('復元する');await wait("document.querySelectorAll('.run-card').length===0");
  await click('#library-active');await click('.run-card');
  await button('情報を編集');await fill('#override-0-model','original');await fill('#override-0-reasoningEffort','original');await button('保存する');await wait("document.querySelector('#library-status').textContent==='保存しました'");
  assert.match(await evaluate("document.querySelector('.run-card').textContent"),/Original model.*high/);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await evaluate("document.querySelector('#replay-library').scrollWidth<=document.querySelector('#replay-library').clientWidth"),'Mobile dialog overflow');
  await writeFile('runs/ui-library-mobile.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await wait("!document.querySelector('#replay-library').open");assert.equal(await evaluate('document.activeElement.id'),'show-library');
  await send('Emulation.setLocaleOverride',{locale:'en-US'});await send('Emulation.setTimezoneOverride',{timezoneId:'America/Los_Angeles'});
  const loaded=new Promise(resolve=>{const handler=event=>{if(JSON.parse(event.data).method==='Page.loadEventFired'){socket.removeEventListener('message',handler);resolve();}};socket.addEventListener('message',handler);});await send('Page.reload');await loaded;await wait("document.querySelector('#library-total')?.textContent==='115件の保存対局'");await click('#show-library');await fill('#library-search','fixture-0');await wait("document.querySelectorAll('.run-card').length===1");await click('.run-card');
  assert.match(await evaluate("document.querySelector('#library-detail').textContent"),/01\/01\/2026.*03:30 PM/);
  assert.deepEqual(errors,[]);
  console.log('Replay library browser check passed: pagination, edit, unknown/reset, persistence, failure retention, trash/restore, locale/timezone, mobile, keyboard and focus.');
} finally {
  socket?.close();
  for(const child of [chrome,server])if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  await rm(temp,{recursive:true,force:true});
}

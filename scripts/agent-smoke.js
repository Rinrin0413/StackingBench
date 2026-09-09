// Isolated bridge integration fixture. Never starts a model or selects real session moves.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const url=process.env.APP_URL??'http://127.0.0.1:3211';
const cli=(args,input)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/agent.js',...args],{env:{...process.env,STACKINGBENCH_URL:url},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);
  child.on('exit',code=>{if(code)reject(Error(err));else{try{resolve(JSON.parse(out));}catch(e){reject(e);}}});
  child.stdin.end(input===undefined?'':JSON.stringify(input));
});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1150}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#model-a').options.length>=3);
  await page.selectOption('#type-a','codex');await page.selectOption('#type-b','human');await page.fill('#max-locks','15');
  await page.click('#create');await page.waitForFunction(()=>document.querySelector('#badge').textContent==='CODEX WAIT');
  const id=await page.inputValue('#agent-match-id');assert((await cli(['list'])).some(m=>m.id===id&&m.ready));
  assert(await page.isDisabled('#step'));assert(await page.isDisabled('#run'));assert(await page.isDisabled('[data-input="HD"]'));
  assert(await page.isDisabled('#model-a'));assert.match(await page.textContent('#recorded-model-a'),/Codex.*GPT-6 Astra.*High/);
  let last;
  for(let i=0;i<7;i++) {
    const root=await cli(['observe',id]);
    // Geometric fixture only: keep the board alive to test the handoff.
    const move=root.observation.legalMoves.filter(m=>!m.hold).sort((a,b)=>Math.min(...b.cells.map(c=>c[1]))-Math.min(...a.cells.map(c=>c[1])))[0];
    if(i===0) {
      const preview={decisionId:root.decisionId,moveId:move.id,requestId:'retry-check'};
      const result=await cli(['preview',id,'--file','-'],preview);
      assert.deepEqual(await cli(['preview',id,'--file','-'],preview),result);
      const waiting=await cli(['wait',id,'--after',root.decisionId,'--timeout-ms','30']);assert.equal(waiting.waiting,true);
    }
    last=await cli(['choose',id,'--file','-'],{decisionId:root.decisionId,moveId:move.id,reason:'Integration fixture only',agentModel:'test-fixture'});
    assert.equal(last.accepted,true);assert.equal(last.locks,i+1);
  }
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='YOUR TURN');
  assert.equal(await page.textContent('#frame'),'7 / 7');
  const waiting=await cli(['observe',id]);assert.equal(waiting.ready,false);assert(!('observation' in waiting));
  await page.click('#prev');assert(await page.isDisabled('[data-input="HD"]'));await page.click('#human-latest');
  for(let i=0;i<7;i++) {
    await page.locator('#board-b').focus();
    const offset=[-3,4,0,-3,4,0,2][i];
    for(let j=0;j<Math.abs(offset);j++)await page.keyboard.press(offset<0?'ArrowLeft':'ArrowRight');
    await page.keyboard.press('Space');await page.waitForFunction(n=>Number(document.querySelector('#frame').textContent.split(' / ')[1])>=n,8+i);
  }
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='CODEX WAIT');
  const root=await cli(['wait',id,'--after',last.acceptedDecisionId,'--timeout-ms','2000']);assert.equal(root.ready,true);
  await page.setViewportSize({width:390,height:844});await mkdir('runs',{recursive:true});
  await page.screenshot({path:'runs/ui-agent-mobile.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');
  await page.setViewportSize({width:1440,height:1150});await page.screenshot({path:'runs/ui-agent-desktop.png',fullPage:true});
  await cli(['choose',id,'--file','-'],{decisionId:root.decisionId,moveId:root.observation.legalMoves[0].id,agentModel:'test-fixture'});
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='FINISHED');
  const final=await cli(['wait',id,'--timeout-ms','100']);assert.equal(final.status,'finished');
  await page.click('#refresh');await page.selectOption('#saved-runs',id);await page.click('#open-run');
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='REPLAY');assert.match(await page.textContent('#saved-models'),/Codex/);
  assert.deepEqual(errors,[]);console.log(`Codex bridge fixture OK: ${id}; CLI, preview retry, wait, handoff, polling, replay, mobile`);
} finally {await browser.close();}

// Optional browser integration check; uses an installed Playwright module and no LLM calls.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1150}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.APP_URL??'http://127.0.0.1:3210');
  await page.waitForFunction(()=>document.querySelector('#model-a').options.length>=3);
  await page.selectOption('#type-a','human');await page.fill('#max-locks','15');
  await page.click('#create');await page.waitForFunction(()=>document.querySelector('#badge').textContent==='YOUR TURN');
  const id=await page.evaluate(()=>sessionStorage.getItem('stackingbench-live'));
  assert.equal(await page.textContent('#recorded-model-a'),'ブラウザ操作');
  assert(await page.isDisabled('#model-a'));
  const snapshot=await page.evaluate(id=>fetch(`/api/matches/${id}`).then(r=>r.json()),id);
  assert.deepEqual(snapshot.state.players[1].queue,[]);assert(!('seeds' in snapshot.state));
  // Exercise HOLD, SRS rotation and translation through keyboard input.
  await page.locator('#board-a').focus();
  await page.keyboard.press('c');assert.match(await page.textContent('#human-status'),/HOLD 使用/);
  await page.keyboard.press('x');await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#frame').textContent==='1 / 1');
  const first=await page.evaluate(id=>fetch(`/api/runs/${id}`).then(r=>r.json()),id);
  assert.equal(first[1].move.useHold,true);assert.deepEqual(first[1].move.path,['CW','D','L','L','HD']);
  assert.equal(first[1].metrics.calls,0);
  const stale=await page.evaluate(async({id,hash})=>{
    const r=await fetch(`/api/matches/${id}/step`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({moveId:'m0000',stateHash:hash})});return r.status;
  },{id,hash:snapshot.human.stateHash});assert.equal(stale,400);
  // Reload retains the live match; a replay frame cannot accept input.
  await page.reload();await page.waitForFunction(()=>document.querySelector('#badge').textContent==='YOUR TURN');
  await page.click('#prev');assert(await page.isDisabled('[data-input="HD"]'));
  await page.click('#human-latest');assert(!(await page.isDisabled('[data-input="HD"]')));
  for(let i=1;i<7;i++) {
    await page.locator('#board-a').focus();
    const offset=[0,4,-3,1,4,-3,1][i];
    for(let j=0;j<Math.abs(offset);j++)await page.keyboard.press(offset<0?'ArrowLeft':'ArrowRight');
    await page.keyboard.press('Space');
    await page.waitForFunction(n=>Number(document.querySelector('#frame').textContent.split(' / ')[1])>=n,i+1);
  }
  await page.waitForFunction(()=>document.querySelector('#frame').textContent==='14 / 14'&&document.querySelector('#badge').textContent==='YOUR TURN',{},{timeout:30000});
  await page.locator('#board-a').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='FINISHED');
  const records=await page.evaluate(id=>fetch(`/api/runs/${id}`).then(r=>r.json()),id);
  assert.equal(records.at(-1).summary[0].locks,8);assert.equal(records.at(-1).summary[1].locks,7);
  assert.equal(records.at(-1).reason,'lock-limit');
  await page.click('#refresh');await page.selectOption('#saved-runs',id);await page.click('#open-run');
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='REPLAY');
  assert.match(await page.textContent('#saved-models'),/人間/);assert(await page.isHidden('#human-controls'));
  await page.click('#path');await page.waitForTimeout(1000);
  // Check touch controls on a small screen with a second human at Player B.
  await page.selectOption('#type-a','search');await page.selectOption('#type-b','human');await page.selectOption('#first','1');
  await page.click('#create');await page.waitForFunction(()=>document.querySelector('#badge').textContent==='YOUR TURN');
  await page.setViewportSize({width:390,height:844});
  await page.click('[data-input="HOLD"]');await page.click('[data-input="CCW"]');await page.click('[data-input="R"]');
  await page.screenshot({path:'runs/ui-human-mobile.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');
  await page.click('[data-input="HD"]');await page.waitForFunction(()=>document.querySelector('#frame').textContent==='1 / 1');
  await page.setViewportSize({width:1440,height:1150});await page.screenshot({path:'runs/ui-human-desktop.png',fullPage:true});
  await page.click('#stop');assert.deepEqual(errors,[]);
  console.log(`Human browser check OK: ${id}; keyboard, HOLD, stale input, reload, replay, 7-lock handoff, bot response, final result, touch controls`);
} finally {await browser.close();}

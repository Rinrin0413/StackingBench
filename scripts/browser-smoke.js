// Optional browser check. Supply an installed Playwright module; no runtime dependency.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
await mkdir('runs',{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1150}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.APP_URL??'http://127.0.0.1:3210');
  await page.waitForFunction(()=>document.querySelector('#model-a').options.length>=3);
  const assertPlayerFields=async(key,type,{connection=false,model=false,codex=false,agy=false}={})=>{
    await page.selectOption(`#type-${key}`,type);
    assert.equal(await page.isVisible(`#connection-${key}`),connection,`${type}: connection visibility`);
    assert.equal(await page.isVisible(`#model-${key}`),model,`${type}: model visibility`);
    assert.equal(await page.isVisible(`#codex-identity-${key}`),codex,`${type}: Codex identity visibility`);
    assert.equal(await page.isVisible(`#agy-identity-${key}`),agy,`${type}: agy identity visibility`);
  };
  for(const key of ['a','b']) {
    await assertPlayerFields(key,'search');
    await assertPlayerFields(key,'human');
    await assertPlayerFields(key,'codex',{codex:true});
    await assertPlayerFields(key,'agy',{agy:true});
    await assertPlayerFields(key,'llm',{connection:true,model:true});
    await assertPlayerFields(key,'llm-preview',{connection:true,model:true});
    await page.selectOption(`#type-${key}`,'search');
  }
  await page.fill('#max-locks','28');await page.click('#create');await page.waitForFunction(()=>!document.querySelector('#step').disabled);
  await page.click('#step');await page.waitForFunction(()=>document.querySelector('#frame').textContent==='1 / 1');
  await page.click('#run');await page.waitForFunction(()=>document.querySelector('#badge').textContent==='FINISHED',{},{timeout:60000});
  assert.match(await page.textContent('#frame'),/28 \/ 28/);
  await page.locator('#timeline').evaluate(e=>{e.value='14';e.dispatchEvent(new Event('input'));});
  assert.equal(await page.textContent('#frame'),'14 / 28');
  await page.click('#path');await page.waitForTimeout(2500);
  await page.screenshot({path:'runs/ui-desktop.png',fullPage:true});
  await page.click('#fork');await page.waitForFunction(()=>document.querySelector('#frame').textContent==='0 / 0');
  assert.match(await page.textContent('#lock-label'),/^14 \/ 28/);
  await page.click('#step');await page.waitForFunction(()=>document.querySelector('#frame').textContent==='1 / 1');
  await page.click('#stop');await page.waitForFunction(()=>document.querySelector('#badge').textContent==='ABORTED');
  await page.click('#refresh');await page.selectOption('#saved-runs',{index:1});await page.click('#open-run');
  await page.waitForFunction(()=>document.querySelector('#badge').textContent==='REPLAY');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'runs/ui-mobile.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');
  assert.deepEqual(errors,[]);console.log('Browser: player fields, create, step, run, timeline, path, fork, stop, saved replay, mobile OK');
} finally {await browser.close();}

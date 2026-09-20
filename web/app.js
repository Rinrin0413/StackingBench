import {SHAPES,cells,spawn,motion,fits,spinType} from '/engine.js';
const $=id=>document.getElementById(id),colors={I:'#72cfdb',J:'#7498ec',L:'#e6b570',O:'#ded479',S:'#85c39a',T:'#b699d5',Z:'#dd8e91',G:'#6c8580'};
const isAgentPlayer=type=>['codex','agy'].includes(type);
const agentName=type=>type==='agy'?'Antigravity CLI (agy)':'Codex';
const labels={agy:'Antigravity CLI (agy)',codex:'Codex · このセッション',human:'人間（あなた）',search:'探索 bot',llm:'LLM · 試し読みなし','llm-preview':'LLM · 試し読みあり'};
let current=null,liveId=null,frame=0,follow=true,animation=0,noticeTimer,savedRuns=[],draft=null,submitting=false;
let connectionProfiles=[];
function connectionFor(config) {return connectionProfiles.find(connection=>connection.id===config?.connectionId);}
function selectedModel(key) {return $(`model-id-${key}`).value.trim()||$(`model-${key}`).value;}
function selectedConnection(key) {return $(`connection-${key}`).value;}
function modelLabel(config,execution) {
  if(isAgentPlayer(config.type)) {
    const model=execution?execution.model:config.agentModel,effort=execution?execution.reasoningEffort:config.reasoningEffort;
    if(config.type==='agy')return `Antigravity CLI (agy) · ${model??'モデル未記録'}（申告情報）`;
    return `Codex · ${model??'モデル未記録'} / ${effort?effort[0].toUpperCase()+effort.slice(1):'推論レベル未記録'}（申告情報）`;
  }
  if(config.type==='human')return 'ブラウザ操作';
  if(config.type==='search')return 'モデル不使用（固定評価）';
  const connection=connectionFor(config),label=connection?.label??(config.provider==='typesafe'?'TypeSafe · Jev':config.provider==='sakura'?'さくらのAI Engine':'接続不明');
  return `${label} · ${config.modelId??config.model??'モデル名の記録なし'}`;}
function savedIdentity() {
  const run=savedRuns.find(r=>r.id===$('saved-runs').value),container=$('saved-models');
  container.replaceChildren();container.hidden=!run;
  for(const [i,p] of (run?.players??[]).entries()) {
    const line=document.createElement('p');line.textContent=`${i===0?'A':'B'} · ${labels[p.type]} — ${(run.executions?.[i]?.length?run.executions[i].map(e=>modelLabel(p,e)):[modelLabel(p)]).join(' / ')}`;container.append(line);
  }
}
const empty=()=>Array.from({length:24},()=>Array(10).fill('.'));
function notice(message) { $('notice').textContent=message;$('notice').style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').style.display='none',9000); }
async function api(path,data) {const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok) throw Error(v.error??`HTTP ${r.status}`);return v;}
function catchErrors(fn) {return async(...args)=>{try{await fn(...args);}catch(e){notice(e.message);}};}
function tile(ctx,x,y,size,color,ghost=false) {ctx.globalAlpha=ghost?.7:1;ctx.fillStyle=color;ctx.fillRect(x*size+1,y*size+1,size-2,size-2);ctx.fillStyle='#ffffff27';ctx.fillRect(x*size+2,y*size+2,size-4,3);ctx.globalAlpha=1;}
function drawBoard(id,board,ghost=null) {
  const ctx=$(id).getContext('2d'),s=30;ctx.fillStyle='#14231e';ctx.fillRect(0,0,300,720);
  ctx.fillStyle='#0f1b17';ctx.fillRect(0,0,300,120);
  for(let y=0;y<24;y++)for(let x=0;x<10;x++){ctx.strokeStyle='#263830';ctx.lineWidth=.6;ctx.strokeRect(x*s,y*s,s,s);if(board[y][x]!=='.')tile(ctx,x,y,s,colors[board[y][x]]??'#aaa');}
  if(ghost)for(const [x,y] of ghost.cells)tile(ctx,x,y,s,colors[ghost.piece],true);
  ctx.strokeStyle='#59725b';ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(0,120);ctx.lineTo(300,120);ctx.stroke();ctx.setLineDash([]);
}
function piece(container,type) {const canvas=document.createElement('canvas');canvas.width=96;canvas.height=72;canvas.setAttribute('aria-label',type??'empty');const ctx=canvas.getContext('2d');if(type)for(const [x,y]of SHAPES[type][0])tile(ctx,x,y+0.5,20,colors[type]);container.append(canvas);}
function render() {
  const records=current?.records??[],initial=current?.header.initialState;
  frame=Math.min(frame,records.length);
  const state=frame===0?initial:records[frame-1].state,record=records[frame-1];
  for(const [i,key] of ['a','b'].entries()) {
    const p=state?.players[i];drawBoard(`board-${key}`,p?.board??empty());
    for(const kind of ['hold','current','next']) $(`${kind}-${key}`).replaceChildren();
    piece($(`hold-${key}`),p?.hold);piece($(`current-${key}`),(current?.viewer??state?.active)===i?p?.current:null);
    // The viewer follows the same NEXT visibility as the current actor.
    if((current?.viewer??state?.active)===i)for(const t of p.queue.slice(0,5))piece($(`next-${key}`),t);
    else if(p){const text=document.createElement('span');text.textContent='非公開';text.style.fontSize='8px';$(`next-${key}`).append(text);}
    $(`attack-${key}`).textContent=p?.stats.attack??0;$(`pending-${key}`).textContent=p?.pending.reduce((a,b)=>a+b,0)??0;
    $(`chain-${key}`).textContent=`${p?.b2b?'ON':'—'} / ${p&&p.combo>=0?p.combo:'—'}`;
    const active=state?.status==='playing'&&state.active===i;$(`panel-${key}`).classList.toggle('active',active);
    $(`turn-${key}`).textContent=active?`残り ${state.remaining} 固定`:'待機';
    $(`name-${key}`).textContent=labels[current?.header.config.players[i].type??$(`type-${key}`).value];
    const config=current?.header.config.players[i];
    $(`recorded-model-${key}`).textContent=config?modelLabel(config,records.slice(0,frame).findLast(r=>r.actor===i&&r.execution)?.execution):'対局作成後に使用モデルを表示';
  }
  $('lock-label').textContent=`${state?.locks??0} / ${state?.rules.maxLocks??280} LOCKS`;
  $('timeline').max=records.length;$('timeline').value=frame;$('frame').textContent=`${frame} / ${records.length}`;
  const playable=liveId&&current?.state.status==='playing';
  $('step').disabled=!playable||current.busy||current.running||!!current.human||!!current.agentWaiting;$('run').disabled=!playable||current.busy||current.running||!!current.human||!!current.agentWaiting;
  $('run').textContent=current?.header.config.players.some(p=>p.type==='human')?'▶ 相手の番を進める':'▶ 自動対戦';
  $('stop').disabled=!playable||current.stopRequested;$('create').disabled=!!(current?.busy||current?.running);
  $('fork').disabled=!state||state.status!=='playing'||current?.busy||current?.running;$('path').disabled=!record?.move||!!(liveId&&current?.human&&frame===records.length);
  $('prev').disabled=frame===0;$('next').disabled=frame===records.length;
  $('badge').textContent=!current?'READY':current.busy?'THINKING':!liveId||frame<records.length?'REPLAY':current.state.status==='playing'?(current.human?'YOUR TURN':current.agentWaiting?(current.header.config.players[current.state.active].type==='agy'?'AGY WAIT':'CODEX WAIT'):'LIVE'):current.state.status.toUpperCase();
  $('match-label').textContent=current?`${current.header.config.players.map(p=>labels[p.type]).join(' vs ')}${frame<records.length?' · REPLAY':''}`:'対局を作成して開始';
  const end=current?.state;
  $('progress').textContent=current?.runtimeError?`保存/実行エラー: ${current.runtimeError}`:current?.stopRequested&&current.busy?'現在の判断後に停止します':current?.busy?'判断中 · 応答を待っています':end&&end.status!=='playing'?`${end.winner===null?'勝者なし':`Player ${end.winner===0?'A':'B'} 勝利`} / ${end.reason}`:current?.agentWaiting?`${agentName(current.header.config.players[current.state.active].type)} の入力を待っています`:current?.human?'あなたの番です · 7固定で交代':liveId?'次の判断を開始できます':'リプレイ操作 / 局面から比較';
  $('decision-label').textContent=record?`#${frame} · PLAYER ${record.actor===0?'A':'B'} · ${record.move?.id??record.error?.code}`:'';
  $('reason').textContent=record?.error?`${record.error.code}: ${record.error.message}`:record?.reason??'選択理由、作戦メモ、実際の結果をここに表示します。';
  $('memo').textContent=record?.memo?`作戦メモ: ${record.memo}`:'';
  const m=record?.metrics;
  $('decision-metrics').replaceChildren();
  if(m)for(const text of [`${(m.elapsedMs/1000).toFixed(2)} 秒`,`${m.transitions} 遷移`,`${m.calls} API`,`${m.completionTokens??'不明'} 出力 tokens`]){const span=document.createElement('span');span.textContent=text;$('decision-metrics').append(span);}
  if(Number.isFinite(m?.estimatedCostJpy)){const span=document.createElement('span');span.textContent=`約 ${m.estimatedCostJpy.toFixed(3)} 円（公開レート）`;$('decision-metrics').append(span);}
  $('json-view').textContent=JSON.stringify(record?{execution:record.execution,move:record.move,result:state.last,metrics:m,summary:current.summary}:initial??{},null,2);
  renderHuman();renderAgent();
}
function renderAgent() {
  const configs=current?.header.config.players??[];
  $('agent-controls').hidden=!configs.some(p=>isAgentPlayer(p.type));
  if($('agent-controls').hidden)return;
  $('agent-match-id').value=current.id;
  $('copy-agent-request').disabled=!liveId||current.state.status!=='playing';
  $('agent-status').textContent=!liveId?'保存されたセッション対局':current.state.status!=='playing'?'対局は終了しました':current.agentWaiting?`${agentName(current.header.config.players[current.state.active].type)} の入力待ちです`:'人間または相手プレイヤーの番です';
  $('agent-config').textContent=configs.filter(p=>isAgentPlayer(p.type)).map(p=>p.preview?`試し読みあり · ${p.transitions} 遷移 / 判断`:'試し読みなし').join(' / ');
}
$('copy-agent-request').onclick=catchErrors(async()=>{
  const players=current.header.config.players,active=players[current.state.active];
  const type=(isAgentPlayer(active.type)?active:players.find(p=>isAgentPlayer(p.type))).type;
  await navigator.clipboard.writeText(`StackingBench の対局 ${current.id} で ${agentName(type)} として対戦開始してください。docs/${type==='agy'?'agy':'codex'}-player.md の手順に従い、専用の agent コマンドだけで公開盤面を読み、手を選んでください。`);
  notice('対戦依頼をコピーしました。対戦相手のセッションに貼り付けてください。');
});
function canInput() {
  return !!(liveId&&current?.human&&!current.busy&&!current.running&&!submitting&&frame===current.records.length);
}
function focusBoard() {if(canInput())$(`board-${current.state.active===0?'a':'b'}`).focus({preventScroll:true});}
function resetDraft(hold=false) {
  const p=current.state.players[current.state.active];
  draft={hash:current.human.stateHash,hold,piece:hold?(p.hold??p.queue[0]):p.current,position:spawn(),path:[]};
}
function landingMove() {
  if(!draft)return null;
  const board=current.state.players[current.state.active].board;
  if(!fits(board,draft.piece,draft.position))return null;
  const position=motion(board,draft.piece,draft.position,'HD');
  const occupied=cells(draft.piece,position).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  const spin=spinType(board,draft.piece,position);
  return current.human.moves.find(m=>m.hold===draft.hold&&m.piece===draft.piece&&m.spin===spin&&JSON.stringify(m.cells)===JSON.stringify(occupied));
}
function renderHuman() {
  const available=canInput();
  $('human-controls').hidden=!current?.header.config.players.some(p=>p.type==='human')||!liveId||current.state.status!=='playing';
  $('human-latest').hidden=!current?.human||frame===current.records.length;
  for(const button of document.querySelectorAll('[data-input]'))button.disabled=!available;
  if(!available){$('human-status').textContent=submitting?'配置を保存しています…':current?.human?'最新の局面に戻ると操作できます':current?.agentWaiting?`${agentName(current.header.config.players[current.state.active].type)} の入力を待っています`:'相手の判断を待っています';return;}
  if(draft?.hash!==current.human.stateHash)resetDraft();
  const move=landingMove(),actor=current.state.active,key=actor===0?'a':'b',p=current.state.players[actor];
  drawBoard(`board-${key}`,p.board);
  for(const kind of ['hold','current','next'])$(`${kind}-${key}`).replaceChildren();
  piece($(`hold-${key}`),draft.hold?p.current:p.hold);piece($(`current-${key}`),draft.piece);
  for(const t of p.queue.slice(draft.hold&&!p.hold?1:0,5))piece($(`next-${key}`),t);
  const ctx=$(`board-${key}`).getContext('2d');
  if(move)for(const [x,y] of move.cells){ctx.strokeStyle=colors[move.piece];ctx.lineWidth=2;ctx.strokeRect(x*30+3,y*30+3,24,24);}
  for(const [x,y] of cells(draft.piece,draft.position))tile(ctx,x,y,30,colors[draft.piece]);
  $('human-status').textContent=`Player ${key.toUpperCase()} · 残り ${current.state.remaining} 固定 · ${draft.hold?'HOLD 使用 · ':''}${move?(move.spin==='none'?'枠が着地点です':`T-spin ${move.spin}`):'このミノは配置できません。HOLD またはやり直しを選んでください'}`;
  document.querySelector('[data-input="HD"]').disabled=!move;
}
async function humanInput(op) {
  if(!canInput())return;
  animation++;
  if(op==='RESET'){resetDraft();renderHuman();return;}
  if(op==='HOLD'){resetDraft(!draft.hold);renderHuman();return;}
  if(op==='HD') {
    const move=landingMove();if(!move)return;
    const id=liveId,input={moveId:move.id,stateHash:current.human.stateHash,path:[...draft.path,'HD']};
    submitting=true;renderHuman();
    try {
      current=await api(`/api/matches/${id}/step`,input);draft=null;follow=true;frame=current.records.length;
    } catch(e) {
      // Re-fetch after an uncertain response rather than submitting the next piece twice.
      current=await api(`/api/matches/${id}`);frame=current.records.length;draft=null;throw e;
    } finally {submitting=false;render();focusBoard();}
    return;
  }
  if(!fits(current.state.players[current.state.active].board,draft.piece,draft.position))return;
  if(draft.path.length>=4095){notice('操作が多すぎます。「やり直し」で配置を選び直してください');return;}
  const next=motion(current.state.players[current.state.active].board,draft.piece,draft.position,op);
  if(next){draft.position=next;draft.path.push(op);}renderHuman();
}
for(const button of document.querySelectorAll('[data-input]'))button.onclick=catchErrors(async()=>{await humanInput(button.dataset.input);focusBoard();});
$('human-latest').onclick=()=>{frame=current.records.length;follow=true;animation++;render();focusBoard();};
document.addEventListener('keydown',catchErrors(async e=>{
  if(!canInput()||e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,select,textarea,summary')||e.target.closest('button')&&!e.target.closest('#human-controls'))return;
  const op={ArrowLeft:'L',ArrowRight:'R',ArrowDown:'D',ArrowUp:'CW',KeyX:'CW',KeyZ:'CCW',KeyC:'HOLD',Space:'HD',KeyR:'RESET'}[e.code];
  if(!op)return;e.preventDefault();
  if(e.repeat&&!['L','R','D'].includes(op))return;
  await humanInput(op);
}));
function player(key) {const type=$(`type-${key}`).value;return {type,...(['llm','llm-preview'].includes(type)?{connectionId:selectedConnection(key),modelId:selectedModel(key),model:selectedModel(key)}:{}),... (type==='codex'?{agentModel:$(`codex-model-${key}`).value,reasoningEffort:$(`codex-effort-${key}`).value}:{}),... (type==='agy'?{agentModel:$(`agy-model-${key}`).value}:{}),preview:$('codex-preview').value==='true',observation:$('observation').value,transitions:Number($('transitions').value),maxTokens:Number($('tokens').value),
  timeoutMs:Number($('timeout').value)*1000,temperature:Number($('temperature').value),thinking:$('thinking').value,decisionTokens:Number($('decision-tokens').value),maxCalls:Number($('max-calls').value),requestIntervalMs:Number($('request-interval').value)*1000};}
async function create(parent) {
  current=await api('/api/matches',{players:[player('a'),player('b')],seeds:[Number($('seed-a').value),Number($('seed-b').value)],first:Number($('first').value),maxLocks:Number($('max-locks').value),...(parent?{parent}:{})});
  liveId=current.id;frame=0;follow=true;animation++;draft=null;sessionStorage.setItem('stackingbench-live',liveId);
  if(current.header.config.players.some(p=>['human','codex','agy'].includes(p.type)))current=await api(`/api/matches/${liveId}/run`,{});
  render();focusBoard();await refresh();
}
$('setup').addEventListener('submit',catchErrors(async e=>{e.preventDefault();await create();}));
for(const action of ['step','run','stop'])$(action).onclick=catchErrors(async()=>{current=await api(`/api/matches/${liveId}/${action}`,{});follow=true;frame=current.records.length;render();});
$('timeline').oninput=()=>{animation++;frame=Number($('timeline').value);follow=frame===current?.records.length;render();};
$('prev').onclick=()=>{animation++;frame=Math.max(0,frame-1);follow=false;render();};
$('next').onclick=()=>{animation++;frame=Math.min(current?.records.length??0,frame+1);follow=frame===current?.records.length;render();};
$('fork').onclick=catchErrors(async()=>{const parent={id:current.id,index:frame};await create(parent);notice('同じ局面で新しい対局を作成しました。プレイヤー設定を適用し、作戦メモはリセットしています。');});
$('path').onclick=catchErrors(async()=>{
  const token=++animation,record=current.records[frame-1],before=frame===1?current.header.initialState:current.records[frame-2].state;
  const board=before.players[record.actor].board,key=record.actor===0?'a':'b';let pos=spawn();
  for(const op of record.move.path){if(token!==animation)return;pos=motion(board,record.move.piece,pos,op);drawBoard(`board-${key}`,board,{piece:record.move.piece,cells:cells(record.move.piece,pos)});await new Promise(r=>setTimeout(r,100));}
  if(token===animation)render();
});
async function refresh(){savedRuns=await api('/api/runs');const selected=$('saved-runs').value;$('saved-runs').replaceChildren(new Option('リプレイを選択',''));for(const r of savedRuns){const matchup=r.players.map((p,i)=>isAgentPlayer(p.type)?(r.executions?.[i]?.length?r.executions[i].map(e=>modelLabel(p,e)).join(' / '):modelLabel(p)):['search','human'].includes(p.type)?labels[p.type]:`${p.model??'モデル不明'} (${labels[p.type]})`).join(' vs ');$('saved-runs').append(new Option(`${r.createdAt.slice(5,16).replace('T',' ')} · ${matchup} · ${r.locks}手 · ${r.status}`,r.id));}$('saved-runs').value=selected;savedIdentity();}
$('saved-runs').onchange=savedIdentity;
$('refresh').onclick=catchErrors(refresh);
$('open-run').onclick=catchErrors(async()=>{
  if(current?.busy||current?.running)throw Error('現在の判断を停止してからリプレイを開いてください');
  const id=$('saved-runs').value;if(!id)return;
  const all=await api(`/api/runs/${id}`),records=all.filter(r=>r.type==='decision'),end=all.findLast(r=>r.type==='end');
  current={id,header:all[0],records,state:end?.state??records.at(-1)?.state??all[0].initialState,summary:end?.summary};liveId=null;sessionStorage.removeItem('stackingbench-live');frame=records.length;follow=false;animation++;render();
});
$('probe').onclick=catchErrors(async()=>{
  $('probe').disabled=true;$('connection').textContent='生成の疎通確認中…';
  try {const key=['a','b'].find(k=>$(`type-${k}`).value.startsWith('llm'));if(!key)throw Error('接続確認する LLM を選択してください');const model=$(`model-${key}`).value;
    const result=await api('/api/probe',{connectionId:selectedConnection(key),modelId:selectedModel(key)});$('connection').textContent=result.ok?'生成の疎通確認成功':'疎通確認失敗';$('connection-dot').classList.toggle('online',result.ok);
    notice(result.ok?`${result.modelId??result.model}: 生成能力を確認しました。`:result.error??'生成能力を確認できませんでした');
  } finally {$('probe').disabled=false;}
});
function populateModels(key,models=[]) {
  const select=$(`model-${key}`),previous=selectedModel(key);select.replaceChildren();
  const unique=[...new Set(models.filter(Boolean))];
  if(!unique.length)select.append(new Option('モデル ID を入力…',''));
  else for(const id of unique)select.append(new Option(id,id));
  const input=$(`model-id-${key}`);input.value=previous&&!unique.includes(previous)?previous:'';if(unique.includes(previous))select.value=previous;
}
async function loadConnectionModels(key) {
  const profile=connectionFor({connectionId:selectedConnection(key)});populateModels(key,profile?.models??(selectedConnection(key)==='local-llamacpp'?['Qwen3.6-35B-A3B_UD-Q4_K_XL_128K-ctx_fast','Gemma-4-26B-A4B_UD-Q4_K_XL_128K-ctx_fast','Gemma-4-E2B_UD_Q4_K_XL_fast']:[]));
  if(profile&&!profile.models?.length&&selectedConnection(key)!=='local-llamacpp')try {const result=await api(`/api/models?connectionId=${encodeURIComponent(profile.id)}`);populateModels(key,result.models?.map(model=>model.id)??[]);} catch {/* Manual model entry remains available. */}
}
for(const key of ['a','b']) {
  const update=()=>{
    const type=$(`type-${key}`).value,unused=['search','human','codex','agy'].includes(type),profile=connectionFor({connectionId:selectedConnection(key)});
    $('agy-identity-'+key).hidden=type!=='agy';$('codex-identity-'+key).hidden=type!=='codex';
    $(`connection-${key}`).parentElement.hidden=unused;$(`model-${key}`).parentElement.hidden=type==='agy';$(`model-id-${key}`).disabled=unused;$(`model-${key}`).disabled=unused;
    $(`connection-${key}`).parentElement.classList.toggle('dim',unused);$(`model-${key}`).parentElement.classList.toggle('dim',unused);
    const preview=Array.from($(`type-${key}`).options).find(o=>o.value==='llm-preview'),jev=profile?.protocol==='typesafe-jev-choice';
    preview.disabled=jev;if(jev&&type==='llm-preview')$(`type-${key}`).value='llm';
    render();
  };
  $(`type-${key}`).onchange=update;$(`connection-${key}`).onchange=catchErrors(async()=>{await loadConnectionModels(key);update();});
  $(`model-${key}`).onchange=()=>{$(`model-id-${key}`).value='';update();};$(`model-id-${key}`).oninput=update;
}
await catchErrors(async()=>{const config=await api('/api/config');connectionProfiles=config.connections??[];for(const key of ['a','b']){
  const select=$(`connection-${key}`);select.replaceChildren();for(const connection of connectionProfiles)select.append(new Option(`${connection.label}${connection.configured?'':'（未設定）'}`,connection.id));
  select.value=connectionProfiles.find(connection=>connection.id==='local-llamacpp')?.id??connectionProfiles[0]?.id??'';
  await loadConnectionModels(key);$(`type-${key}`).onchange();
}await refresh();const saved=sessionStorage.getItem('stackingbench-live');if(saved){try{current=await api(`/api/matches/${saved}`);liveId=saved;frame=current.records.length;}catch{sessionStorage.removeItem('stackingbench-live');}}render();})();
setInterval(catchErrors(async()=>{if(!liveId||!current?.busy&&!current?.running&&!(current?.hasAgent&&current.state.status==='playing'))return;const id=liveId,previousCount=current.records.length,wasHuman=!!current.human;const snapshot=await api(`/api/matches/${id}`);if(liveId!==id||submitting||snapshot.records.length<current.records.length)return;current=snapshot;if(follow)frame=current.records.length;render();if(current.human&&follow&&!wasHuman)focusBoard();if(!current.busy&&!current.running&&current.records.length!==previousCount)await refresh();}),1500);

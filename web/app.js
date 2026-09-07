import {SHAPES,cells,spawn,motion} from '/engine.js';
const $=id=>document.getElementById(id),colors={I:'#72cfdb',J:'#7498ec',L:'#e6b570',O:'#ded479',S:'#85c39a',T:'#b699d5',Z:'#dd8e91',G:'#6c8580'};
const labels={search:'探索 bot',llm:'LLM · 試し読みなし','llm-preview':'LLM · 試し読みあり'};
let current=null,liveId=null,frame=0,follow=true,animation=0,noticeTimer;
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
    piece($(`hold-${key}`),p?.hold);piece($(`current-${key}`),state?.active===i?p?.current:null);
    // The viewer follows the same NEXT visibility as the current actor.
    if(state?.active===i)for(const t of p.queue.slice(0,5))piece($(`next-${key}`),t);
    else if(p){const text=document.createElement('span');text.textContent='非公開';text.style.fontSize='8px';$(`next-${key}`).append(text);}
    $(`attack-${key}`).textContent=p?.stats.attack??0;$(`pending-${key}`).textContent=p?.pending.reduce((a,b)=>a+b,0)??0;
    $(`chain-${key}`).textContent=`${p?.b2b?'ON':'—'} / ${p&&p.combo>=0?p.combo:'—'}`;
    const active=state?.status==='playing'&&state.active===i;$(`panel-${key}`).classList.toggle('active',active);
    $(`turn-${key}`).textContent=active?`残り ${state.remaining} 固定`:'待機';
    $(`name-${key}`).textContent=labels[current?.header.config.players[i].type??$(`type-${key}`).value];
  }
  $('lock-label').textContent=`${state?.locks??0} / ${state?.rules.maxLocks??280} LOCKS`;
  $('timeline').max=records.length;$('timeline').value=frame;$('frame').textContent=`${frame} / ${records.length}`;
  const playable=liveId&&current?.state.status==='playing';
  $('step').disabled=!playable||current.busy||current.running;$('run').disabled=!playable||current.busy||current.running;
  $('stop').disabled=!playable||current.stopRequested;$('create').disabled=!!(current?.busy||current?.running);
  $('fork').disabled=!state||state.status!=='playing'||current?.busy||current?.running;$('path').disabled=!record?.move;
  $('prev').disabled=frame===0;$('next').disabled=frame===records.length;
  $('badge').textContent=!current?'READY':current.busy?'THINKING':!liveId||frame<records.length?'REPLAY':current.state.status==='playing'?'LIVE':current.state.status.toUpperCase();
  $('match-label').textContent=current?`${current.header.config.players.map(p=>labels[p.type]).join(' vs ')}${frame<records.length?' · REPLAY':''}`:'対局を作成して開始';
  const end=current?.state;
  $('progress').textContent=current?.runtimeError?`保存/実行エラー: ${current.runtimeError}`:current?.stopRequested&&current.busy?'現在の判断後に停止します':current?.busy?'判断中 · 応答を待っています':end&&end.status!=='playing'?`${end.winner===null?'勝者なし':`Player ${end.winner===0?'A':'B'} 勝利`} / ${end.reason}`:liveId?'次の判断を開始できます':'リプレイ操作 / 局面から比較';
  $('decision-label').textContent=record?`#${frame} · PLAYER ${record.actor===0?'A':'B'} · ${record.move?.id??record.error?.code}`:'WAITING FOR FIRST MOVE';
  $('reason').textContent=record?.error?`${record.error.code}: ${record.error.message}`:record?.reason??'選択理由、作戦メモ、実際の結果をここに表示します。';
  $('memo').textContent=record?.memo?`作戦メモ: ${record.memo}`:'';
  const m=record?.metrics;
  $('decision-metrics').replaceChildren();
  if(m)for(const text of [`${(m.elapsedMs/1000).toFixed(2)} 秒`,`${m.transitions} 遷移`,`${m.calls} API`,`${m.completionTokens??'不明'} 出力 tokens`]){const span=document.createElement('span');span.textContent=text;$('decision-metrics').append(span);}
  $('json-view').textContent=JSON.stringify(record?{move:record.move,result:state.last,metrics:m,summary:current.summary}:initial??{},null,2);
}
function player(key) {return {type:$(`type-${key}`).value,model:$(`model-${key}`).value,observation:$('observation').value,transitions:Number($('transitions').value),maxTokens:Number($('tokens').value),
  timeoutMs:Number($('timeout').value)*1000,temperature:Number($('temperature').value),thinking:$('thinking').value,decisionTokens:Number($('decision-tokens').value),maxCalls:Number($('max-calls').value)};}
async function create(parent) {
  current=await api('/api/matches',{players:[player('a'),player('b')],seeds:[Number($('seed-a').value),Number($('seed-b').value)],first:Number($('first').value),maxLocks:Number($('max-locks').value),...(parent?{parent}:{})});
  liveId=current.id;frame=0;follow=true;animation++;render();await refresh();
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
async function refresh(){const list=await api('/api/runs'),selected=$('saved-runs').value;$('saved-runs').replaceChildren(new Option('リプレイを選択',''));for(const r of list)$('saved-runs').append(new Option(`${r.createdAt.slice(5,16).replace('T',' ')} · ${r.locks}手 · ${r.status}`,r.id));$('saved-runs').value=selected;}
$('refresh').onclick=catchErrors(refresh);
$('open-run').onclick=catchErrors(async()=>{
  if(current?.busy||current?.running)throw Error('現在の判断を停止してからリプレイを開いてください');
  const id=$('saved-runs').value;if(!id)return;
  const all=await api(`/api/runs/${id}`),records=all.filter(r=>r.type==='decision'),end=all.findLast(r=>r.type==='end');
  current={id,header:all[0],records,state:end?.state??records.at(-1)?.state??all[0].initialState,summary:end?.summary};liveId=null;frame=records.length;follow=false;animation++;render();
});
$('probe').onclick=catchErrors(async()=>{const result=await api('/api/models');$('connection').textContent=`llama.cpp · ${result.models.length} models`;$('connection-dot').classList.add('online');notice('モデル一覧への接続に成功しました。生成・画像対応は各モデルで別途検証が必要です。');});
for(const key of ['a','b'])$(`type-${key}`).onchange=()=>{$(`model-${key}`).parentElement.classList.toggle('dim',$(`type-${key}`).value==='search');render();};
await catchErrors(async()=>{const config=await api('/api/config');for(const key of ['a','b']){for(const id of config.models)$(`model-${key}`).append(new Option(id,id));$(`type-${key}`).onchange();}await refresh();render();})();
setInterval(catchErrors(async()=>{if(!liveId||!current?.busy&&!current?.running)return;const id=liveId;const snapshot=await api(`/api/matches/${id}`);if(liveId!==id)return;current=snapshot;if(follow)frame=current.records.length;render();if(!current.busy&&!current.running)await refresh();}),1500);

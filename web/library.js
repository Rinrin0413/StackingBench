import {playerLabels,runTitle,formatDate,selectRuns,resultNames,efforts,identity} from './replay-display.js';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
async function request(path,patch) {
  const response=await fetch(path,patch===undefined?{}:{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
  const value=await response.json();if(!response.ok)throw Error(value.error??`HTTP ${response.status}`);return value;
}
export function createLibrary({openRun,changed}) {
  const dialog=$('replay-library'),list=$('library-list'),detail=$('library-detail');
  let runs=[],selected=null,trash=false,limit=50,dirty=false,saving=false,loading=false,editing=false,revision=0;
  const status=text=>{$('library-status').textContent=text;};
  const discard=()=>!dirty||confirm('未保存の変更を破棄しますか？');
  function close(){if(saving||!discard())return;dirty=false;editing=false;dialog.close();$('show-library').focus();}
  $('library-close').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  function button(text,fn,cls='secondary') {const b=el('button',text,cls);b.type='button';b.onclick=async()=>{try{await fn();}catch(e){status(`操作に失敗しました: ${e.message}`);}};return b;}
  const disabledBefore=new WeakMap();
  function setBusy(value){saving=value;dialog.setAttribute('aria-busy',String(value));for(const node of dialog.querySelectorAll('button,input,select')){if(value)disabledBefore.set(node,node.disabled);node.disabled=value||disabledBefore.get(node)||false;}}
  async function save(run,patch) {
    revision++;loading=false;$('library-refresh').disabled=false;setBusy(true);status('保存中…');
    try {
      run.metadata=await request(`/api/runs/${run.id}/metadata`,patch);runs=runs.map(value=>value.id===run.id?{...value,metadata:run.metadata}:value);dirty=false;editing=false;
      changed(run);status('保存しました');
    } finally {setBusy(false);}
    render();
  }
  function renderDetail() {
    detail.replaceChildren();const run=runs.find(r=>r.id===selected);detail.dataset.selected=String(!!run);
    if(!run){detail.append(el('p','対局を選ぶと詳細が表示されます。','library-empty'));return;}
    detail.append(button('← 一覧に戻る',()=>{if(!discard())return;dirty=false;editing=false;selected=null;render();list.scrollIntoView({block:'start'});list.querySelector('button')?.focus();},'text-button library-back'));
    detail.append(el('h3',runTitle(run)),el('p',`${formatDate(run.createdAt,{detail:true})} · ${run.active?'進行中':resultNames[run.status]??run.status} · ${run.locks}手`),el('p',`対局 ID: ${run.id}`,'run-id'));
    for(const [i,label] of playerLabels(run).entries())detail.append(el('p',`${i===0?'A':'B'} · ${label}`));
    if(run.winner===0||run.winner===1)detail.append(el('p',`Player ${run.winner===0?'A':'B'} 勝利`));
    const original=el('details'),summary=el('summary','元のモデル記録');original.append(summary);
    for(const [i,label]of playerLabels(run,true).entries())original.append(el('p',`${i===0?'A':'B'} · ${label}`));
    original.append(el('p','編集は表示情報に適用されます。対局時の設定・操作記録は保持されます。'));detail.append(original);
    if(editing){renderEditor(run);return;}
    const actions=el('div',undefined,'library-actions');
    actions.append(button('リプレイを開く',async()=>{setBusy(true);status('リプレイを読み込み中…');try{await openRun(run);dialog.close();$('show-library').focus();status('');}finally{setBusy(false);render();}},'primary'));
    actions.append(button('情報を編集',()=>{editing=true;renderDetail();$('replay-title').focus();}));
    const fav=button(run.metadata.favorite?'★ お気に入り解除':'☆ お気に入り',()=>save(run,{favorite:!run.metadata.favorite}));fav.setAttribute('aria-pressed',String(run.metadata.favorite));actions.append(fav);
    const remove=button(run.metadata.trashed?'復元する':'ゴミ箱へ移動',()=>save(run,{trashed:!run.metadata.trashed}),run.metadata.trashed?'secondary':'danger-button');
    remove.disabled=run.active;actions.append(remove);detail.append(actions);
    if(run.active)detail.append(el('p','進行中・入力待ちの対局は、停止後にゴミ箱へ移動できます。'));
    if(run.metadata.trashed)detail.append(el('p','ゴミ箱の対局は自動消去されません。いつでも復元できます。'));
  }
  function renderEditor(run) {
    const form=el('form'),title=el('input');title.id='replay-title';title.maxLength=160;title.value=run.metadata.title??'';title.placeholder='空欄なら対戦相手を表示';
    const field=(label,control)=>{const node=el('label',label);node.append(control);return node;};form.append(field('タイトル（任意）',title));
    const overrides=structuredClone(run.metadata.players),fields=[];
    run.players.forEach((player,i)=>{
      if(['human','search'].includes(player.type))return;
      const group=el('fieldset'),legend=el('legend',`PLAYER ${i===0?'A':'B'} の表示情報`);group.append(legend);
      for(const key of ['model','reasoningEffort']) {
        const mode=el('select');mode.id=`override-${i}-${key}`;
        for(const [value,label]of [['original','元の記録を使う'],['unknown','未記録にする'],['custom','訂正する']])mode.append(new Option(label,value));
        mode.value=!Object.hasOwn(overrides[i],key)?'original':overrides[i][key]===null?'unknown':'custom';
        const control=el(key==='model'?'input':'select');control.id=`value-${i}-${key}`;
        if(key==='model'){control.maxLength=300;control.placeholder='モデル名';}
        else for(const effort of efforts)control.append(new Option(effort,effort));
        const original=identity(player,run.executions?.[i]?.[0])[key];control.value=overrides[i][key]??original??(key==='model'?'':'medium');
        const update=()=>{control.hidden=mode.value!=='custom';control.required=mode.value==='custom';};update();mode.addEventListener('change',update);
        group.append(field(key==='model'?'モデル名':'推論レベル',mode),field(key==='model'?'訂正後のモデル名':'訂正後の推論レベル',control));
        control.parentElement.hidden=mode.value!=='custom';mode.addEventListener('change',()=>{control.parentElement.hidden=mode.value!=='custom';});
        fields.push({i,key,mode,control});
      }
      form.append(group);
    });
    const unsaved=el('p','変更はまだありません。');unsaved.setAttribute('role','status');
    form.addEventListener('input',()=>{dirty=true;unsaved.textContent='未保存の変更があります。';});
    form.addEventListener('change',()=>{dirty=true;unsaved.textContent='未保存の変更があります。';});
    const actions=el('div',undefined,'library-actions'),submit=el('button','保存する','primary');submit.type='submit';
    actions.append(submit,button('キャンセル',()=>{if(discard()){dirty=false;editing=false;renderDetail();}}));form.append(unsaved,actions);
    form.onsubmit=async e=>{e.preventDefault();if(saving)return;const players=[{},{}];for(const {i,key,mode,control}of fields){if(mode.value==='unknown')players[i][key]=null;else if(mode.value==='custom')players[i][key]=control.value.trim()||null;}
      try{await save(run,{title:title.value,players});}catch(error){status(`保存できませんでした。入力は保持されています: ${error.message}`);}};
    detail.append(form);
  }
  function render() {
    const filtered=selectRuns(runs,{trash,query:$('library-search').value,result:$('library-result').value,favorite:$('library-favorite').checked,sort:$('library-sort').value});
    $('library-count').textContent=`${filtered.length}件中 ${Math.min(limit,filtered.length)}件を表示`;
    $('library-more').hidden=filtered.length<=limit;
    if(selected&&!filtered.some(r=>r.id===selected)&&!dirty){selected=null;editing=false;}
    list.replaceChildren();
    if(!filtered.length)list.append(el('p',runs.some(r=>!!r.metadata.trashed===trash)?'条件に一致する対局がありません。フィルターを変更してください。':trash?'ゴミ箱は空です。':'保存した対局はまだありません。','library-empty'));
    for(const run of filtered.slice(0,limit)) {
      const row=button('',()=>{if(saving||!discard())return;dirty=false;editing=false;selected=run.id;render();detail.focus();detail.scrollIntoView({block:'nearest'});},'run-card');row.dataset.runId=run.id;row.setAttribute('aria-pressed',String(selected===run.id));
      row.append(el('strong',`${run.metadata.favorite?'★ ':''}${runTitle(run)}`));
      for(const [i,label] of playerLabels(run).entries())row.append(el('span',`${i===0?'A':'B'} · ${label}`));
      row.append(el('small',`${formatDate(run.createdAt)} · ${run.active?'進行中':resultNames[run.status]??run.status}${run.winner===0||run.winner===1?` · ${run.winner===0?'A':'B'} 勝利`:''} · ${run.locks}手`));list.append(row);
    }
    if(!dirty)renderDetail();
    for(const [id,value]of [['library-active',false],['library-trash',true]])$(id).setAttribute('aria-pressed',String(trash===value));
    $('library-total').textContent=`${runs.filter(r=>!r.metadata.trashed).length}件の保存対局`;
  }
  async function refresh() {
    if(saving)return;
    const token=++revision;loading=true;$('library-refresh').disabled=true;status('読み込み中…');
    try {
      const result=await request('/api/runs?library=1&trash=all');if(token!==revision)return;
      runs=result.runs;status(result.errors.length?`${result.errors.length}件を読み込めませんでした: ${result.errors.map(e=>e.id).join(', ')}`:'');render();
    }catch(e){status(`読み込めませんでした。更新から再試行できます: ${e.message}`);if(!runs.length)$('library-total').textContent='保存対局を取得できませんでした';}
    finally {if(token===revision){loading=false;$('library-refresh').disabled=false;}}
  }
  $('show-library').onclick=()=>{dialog.showModal();$('library-search').focus();if(!loading)refresh();};
  $('library-refresh').onclick=()=>{if(discard()){dirty=false;editing=false;refresh();}};
  for(const [id,value]of [['library-active',false],['library-trash',true]])$(id).onclick=()=>{if(!discard())return;dirty=false;editing=false;trash=value;selected=null;limit=50;render();};
  for(const id of ['library-search','library-result','library-favorite','library-sort'])$(id).addEventListener(id==='library-search'?'input':'change',()=>{limit=50;render();});
  $('library-more').onclick=()=>{limit+=50;render();};
  return {refresh,metadata:id=>runs.find(r=>r.id===id)?.metadata};
}

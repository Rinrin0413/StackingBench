export const playerNames={human:'人間',search:'探索 bot',codex:'Codex',agy:'Antigravity CLI (agy)',llm:'LLM','llm-preview':'LLM · 試し読みあり'};
export const resultNames={finished:'終了',forfeit:'失格',invalid:'無効',aborted:'停止',incomplete:'未完了'};
export const efforts=['none','minimal','low','medium','high','xhigh','max','ultra'];
export function identity(config,execution,override={}) {
  const original=execution??{model:['codex','agy'].includes(config.type)?config.agentModel:config.modelId??config.model,reasoningEffort:config.reasoningEffort};
  return {model:Object.hasOwn(override,'model')?override.model:original.model??null,reasoningEffort:Object.hasOwn(override,'reasoningEffort')?override.reasoningEffort:original.reasoningEffort??null};
}
export function identityLabel(config,execution,override={},{showCorrection=true}={}) {
  const name=playerNames[config.type]??config.type;
  if(['human','search'].includes(config.type))return name;
  const value=identity(config,execution,override);
  const note=Object.keys(override).length?(showCorrection?'（表示訂正）':''):['codex','agy'].includes(config.type)?'（申告情報）':'';
  return `${name} · ${value.model??'モデル未記録'} / ${value.reasoningEffort??'推論レベル未記録'}${note}`;
}
export function playerLabels(run,original=false) {
  return run.players.map((p,i)=>[...new Set((run.executions?.[i]?.length?run.executions[i]:[undefined]).map(e=>identityLabel(p,e,original?{}:run.metadata?.players?.[i])))].join(' → '));
}
export function runTitle(run){return run.metadata?.title||playerLabels(run).join(' vs ');}
export function formatDate(value,{locale, timeZone,detail=false}={}) {
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '日時不明';
  return new Intl.DateTimeFormat(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(timeZone?{timeZone}:{}),...(detail?{timeZoneName:'short'}:{})}).format(date);
}
export function selectRuns(runs,{trash=false,query='',result='',favorite=false,sort='newest'}={}) {
  const q=query.trim().toLocaleLowerCase();
  return runs.filter(r=>!!r.metadata?.trashed===trash&&(!favorite||r.metadata?.favorite)&&(!result||(r.active?'active':r.status)===result)&&(!q||[r.id,runTitle(r),...playerLabels(r),...playerLabels(r,true)].join(' ').toLocaleLowerCase().includes(q)))
    .sort((a,b)=>sort==='title'?runTitle(a).localeCompare(runTitle(b))||a.id.localeCompare(b.id):(sort==='oldest'?1:-1)*(Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id)));
}

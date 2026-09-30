import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve(process.env.STACKINGBENCH_RUNS??'runs');
const efforts=['none','minimal','low','medium','high','xhigh','max','ultra'];
const empty=()=>({title:null,favorite:false,trashed:false,players:[{},{}]});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function path(id){if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid run ID');return join(root,'metadata',`${id}.json`);}
function validate(input,players) {
  if(!object(input)||Object.keys(input).some(k=>!['title','favorite','trashed','players'].includes(k)))throw Error('Invalid metadata fields');
  const result={...input};
  if(Object.hasOwn(input,'title')) {
    if(input.title!==null&&(typeof input.title!=='string'||input.title.length>160))throw Error('Title must be at most 160 characters');
    result.title=input.title?.trim()||null;
  }
  for(const key of ['favorite','trashed'])if(Object.hasOwn(input,key)&&typeof input[key]!=='boolean')throw Error(`Invalid ${key}`);
  if(Object.hasOwn(input,'players')) {
    if(!Array.isArray(input.players)||input.players.length!==2)throw Error('Two player overrides required');
    result.players=input.players.map((p,i)=>{
      if(!object(p)||Object.keys(p).some(k=>!['model','reasoningEffort'].includes(k)))throw Error('Invalid player override');
      if(players&&['human','search'].includes(players[i]?.type)&&Object.keys(p).length)throw Error('This player does not use a model');
      const value={...p};
      if(Object.hasOwn(p,'model')) {
        if(p.model!==null&&(typeof p.model!=='string'||p.model.length>300))throw Error('Model must be at most 300 characters');
        value.model=p.model?.trim()||null;
      }
      if(Object.hasOwn(p,'reasoningEffort')&&p.reasoningEffort!==null&&!efforts.includes(p.reasoningEffort))throw Error('Invalid reasoning effort');
      return value;
    });
  }
  return result;
}
export async function readMetadata(id) {
  const file=path(id);
  try {return {...empty(),...validate(JSON.parse(await readFile(file,'utf8')))};}
  catch(e){if(e.code==='ENOENT')return empty();throw e;}
}
const pending=new Map();
export async function patchMetadata(id,input,players) {
  const file=path(id),patch=validate(input,players),previous=pending.get(id)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
    const value={...await readMetadata(id),...patch},temp=`${file}.${randomUUID()}.tmp`;
    await mkdir(join(root,'metadata'),{recursive:true});
    try {await writeFile(temp,JSON.stringify(value)+'\n',{flag:'wx'});await rename(temp,file);}
    finally {await rm(temp,{force:true});}
    return value;
  });
  pending.set(id,operation);
  try{return await operation;}finally{if(pending.get(id)===operation)pending.delete(id);}
}

import {mkdir,writeFile} from 'node:fs/promises';
import {completion,QUICK_MODEL} from '../src/players.js';
const base=process.env.LLM_BASE_URL??'http://localhost:8082';
const model=process.argv[2]??QUICK_MODEL;
await mkdir('runs',{recursive:true});
const models=await fetch(`${base}/v1/models`,{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
const metadata=models.data.find(m=>m.id===model);
if(!metadata) throw Error(`Model not found: ${model}`);
console.log(JSON.stringify({model,status:metadata.status?.value,architecture:metadata.architecture}));
const body={model,messages:[{role:'user',content:'Return only a JSON object with ok equal to true.'}],max_tokens:256,temperature:0,stream:false,
  response_format:{type:'json_object',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}};
const start=Date.now();
const response=await completion(base,body,120000);
const result={at:new Date().toISOString(),base,model,metadata:{status:metadata.status?.value,architecture:metadata.architecture},request:body,response,elapsedMs:Date.now()-start};
await writeFile(`runs/probe-${model}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({elapsedMs:result.elapsedMs,message:response.choices?.[0]?.message,finish:response.choices?.[0]?.finish_reason,usage:response.usage}));

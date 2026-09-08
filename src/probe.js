import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {completion,playerConfig,parseAction} from './players.js';
import {endpointFor} from './providers.js';

// A single, recorded diagnostic request, separate from match results.
export async function probeModel(model,{thinking='server-default',maxTokens=2048,timeoutMs=120000,transport=completion}={}) {
  const config=playerConfig({type:'llm',model,thinking,maxTokens,timeoutMs}),base=endpointFor(config);
  const request={model,messages:[{role:'user',content:'Return only the JSON object {"ok":true}, without markdown or commentary.'}],max_tokens:config.maxTokens,temperature:0,stream:false};
  if(config.provider==='llamacpp')request.response_format={type:'json_object',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}};
  if(thinking==='off')request.chat_template_kwargs={enable_thinking:false};
  const start=Date.now(),record={kind:'connection-probe',at:new Date().toISOString(),config,endpoint:base,request};
  try {
    record.response=await transport(base,request,timeoutMs);
    const choice=record.response.choices?.[0];
    if(choice?.finish_reason==='stop') {
      const parsed=parseAction(choice.message.content,config.responseParsing);
      record.responseNormalization=parsed.normalization;record.ok=parsed.value?.ok===true;
    } else record.ok=false;
    if(!record.ok)record.validationError='Expected complete JSON with ok=true';
  } catch(e) {record.ok=false;record.error={code:e.code??'probe-response',message:e.message,detail:e.detail};}
  record.elapsedMs=Date.now()-start;
  const runs=resolve(process.env.STACKINGBENCH_RUNS??'runs');await mkdir(runs,{recursive:true});
  const file=`probe-${model.replace(/[^a-zA-Z0-9_-]/g,'_')}-${randomUUID().slice(0,8)}.json`;
  await writeFile(join(runs,file),JSON.stringify(record,null,2));
  return {ok:record.ok,model,provider:config.provider,elapsedMs:record.elapsedMs,file,usage:record.response?.usage??null,
    finishReason:record.response?.choices?.[0]?.finish_reason,reasoningCharacters:(record.response?.choices?.[0]?.message?.reasoning_content??record.response?.choices?.[0]?.message?.reasoning)?.length??0,
    error:record.error?.message??record.validationError??null};
}

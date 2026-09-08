// Forced two-message protocol diagnostic, excluded from match results.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGame,legalMoves} from '../src/engine.js';
import {observe,PreviewSession} from '../src/observation.js';
import {completion,DEFAULT_MODEL,ACTION_SCHEMA,playerConfig} from '../src/players.js';
import {endpointFor} from '../src/providers.js';
const model=process.argv[2]??DEFAULT_MODEL,config=playerConfig({type:'llm',model}),base=endpointFor(config);
const state=createGame({seeds:[101,202]}),move=legalMoves(state)[0],session=new PreviewSession(state);
const messages=[{role:'system',content:'This is a forced protocol diagnostic, not a strategy evaluation. Return only the requested JSON action.'},
  {role:'user',content:JSON.stringify({instruction:`Request a preview of root move ${move.id}: action=preview, node=root, move=${move.id}`,observation:observe(state)})}];
const records=[];
for(const action of ['preview','choose']) {
  const schema=structuredClone(ACTION_SCHEMA);schema.properties.action.enum=[action];
  const request={model,messages:structuredClone(messages),temperature:0,max_tokens:512,stream:false,chat_template_kwargs:{enable_thinking:false}};
  if(config.provider==='llamacpp')request.response_format={type:'json_object',schema};
  const started=Date.now(),response=await completion(base,request,120000);records.push({request,response,elapsedMs:Date.now()-started});
  const output=JSON.parse(response.choices[0].message.content);assert.equal(output.action,action);assert.equal(output.move,move.id);
  messages.push({role:'assistant',content:response.choices[0].message.content});
  if(action==='preview')messages.push({role:'user',content:JSON.stringify({tool:session.run(output.node??'root',output.move),instruction:`Preview completed. Now choose ROOT move ${move.id}.`})});
}
await mkdir('runs',{recursive:true});
const path=`runs/protocol-${Date.now()}.json`;await writeFile(path,JSON.stringify({kind:'forced-protocol-diagnostic',model,records,preview:session.history,notBenchmark:true},null,2));
console.log(`Verified live preview request → engine tool result → root selection: ${path}`);

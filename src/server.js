import {isAgentPlayer} from './agent-identity.js';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Match,readRun,listRuns} from './match.js';
import {DEFAULT_PLAYER,DEFAULT_MODEL,QUICK_MODEL} from './players.js';
import {TYPESAFE_MODEL,SAKURA_MODELS} from './providers.js';
import {probeModel,probeConnection} from './probe.js';
import {connectionProfile,loadConnectionProfiles,publicConnection,configuredConnection} from './connections.js';
import {getModels,TransportError} from './transport.js';
import {modelMetadataSummary} from './capabilities.js';

const port=Number(process.env.PORT??3210),host='127.0.0.1',matches=new Map();
let probeBusy=false;
const web=fileURLToPath(new URL('../web/',import.meta.url));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
function publicProbeResult(result) {
  const features=result.features?Object.fromEntries(Object.entries(result.features).map(([key,value])=>[key,{status:value.status}])):undefined;
  return {ok:result.ok,connectionId:result.connectionId??null,modelId:result.modelId??result.model??null,protocol:result.protocol??null,provider:result.provider??null,
    elapsedMs:result.elapsedMs??null,cached:result.cached??false,...(features?{features}:{}),error:result.ok?null:'Connection probe failed'};
}
async function body(req) {
  let text='';
  for await(const chunk of req) {text+=chunk;if(text.length>100000) throw Error('Request body too large');}
  return text?JSON.parse(text):{};
}
const server=createServer(async(req,res)=>{
  try {
    const allowedHosts=new Set([`localhost:${port}`,`${host}:${port}`]);
    if(!allowedHosts.has(req.headers.host)) return json(res,403,{error:'Local host required'});
    if(req.headers.origin&&!new Set([`http://localhost:${port}`,`http://${host}:${port}`]).has(req.headers.origin)) return json(res,403,{error:'Same origin required'});
    if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON required'});
    const url=new URL(req.url,`http://${host}:${port}`),path=url.pathname;
    if(req.method==='GET'&&path==='/api/config') {
      const profiles=loadConnectionProfiles(),known=[DEFAULT_MODEL,'Gemma-4-26B-A4B_UD-Q4_K_XL_128K-ctx_fast',QUICK_MODEL,...SAKURA_MODELS,TYPESAFE_MODEL];
      return json(res,200,{defaults:DEFAULT_PLAYER,models:[...new Set(known)],connections:profiles.map(publicConnection),
        typesafeKeyConfigured:configuredConnection(connectionProfile('typesafe-jev')),sakuraModels:SAKURA_MODELS,sakuraKeyConfigured:configuredConnection(connectionProfile('sakura-ai'))});
    }
    if(req.method==='POST'&&path==='/api/probe') {
      const input=await body(req),connectionId=input.connectionId,model=input.modelId??input.model;
      if(probeBusy||[...matches.values()].some(m=>m.busy||m.running))return json(res,409,{error:'Wait for the running request before probing'});
      probeBusy=true;try {
        const result=connectionId?await probeConnection(connectionId,model,{targets:input.targets,refresh:input.refresh}):await probeModel(model);
        return json(res,200,publicProbeResult(result));
      }finally{probeBusy=false;}
    }
    if(req.method==='GET'&&path==='/api/models') {
      const connectionId=url.searchParams.get('connectionId')??'local-llamacpp',profile=connectionProfile(connectionId);
      try {
        const data=await getModels(profile),models=Array.isArray(data.data)?data.data.map(m=>({id:m.id,status:m.status?.value,architecture:m.architecture,...modelMetadataSummary(m)})):[];
        return json(res,200,{connectionId,available:true,models});
      } catch(e) {
        if(e instanceof TransportError||e.code==='unsupported'||e.code==='http'||e.code==='connection'||e.code==='timeout')return json(res,200,{connectionId,available:false,models:[],error:'Model discovery is unavailable; enter a model ID manually.'});
        throw e;
      }
    }
    if(req.method==='GET'&&path==='/api/runs') return json(res,200,await listRuns());
    const replay=path.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
    if(req.method==='GET'&&replay) return json(res,200,await readRun(replay[1]));
    if(req.method==='POST'&&path==='/api/matches') {
      const options=await body(req);
      if(probeBusy||[...matches.values()].some(m=>m.busy||m.running)) return json(res,409,{error:'Wait for the running decision before starting another match'});
      delete options.initialState;
      if(Array.isArray(options.players))options.players=options.players.map(player=>{
        const allowed=['type','connectionId','modelId','model','observation','preview','transitions','maxTokens','timeoutMs','temperature','thinking','decisionTokens','maxCalls','requestIntervalMs','responseFormat','responseParsing'];
        return Object.fromEntries(allowed.filter(key=>Object.hasOwn(player,key)).map(key=>[key,player[key]]));
      });
      delete options.capabilitySnapshots;delete options.preflightCapabilities;delete options.baseUrl;
      if(options.parent) {
        const records=await readRun(options.parent.id),index=options.parent.index;
        if(!Number.isInteger(index)||index<0||index>records.filter(r=>r.type==='decision').length) throw Error('Invalid replay position');
        options.initialState=index===0?records[0].initialState:records.filter(r=>r.type==='decision')[index-1].state;
      }
      probeBusy=true;
      try {
        const match=await Match.create({...options,preflightCapabilities:true});matches.set(match.id,match);return json(res,201,match.snapshot());
      } finally {probeBusy=false;}
    }
    if(req.method==='GET'&&path==='/api/agent/matches')return json(res,200,[...matches.values()]
      .filter(m=>m.config.players.some(p=>isAgentPlayer(p.type))).map(m=>({...m.agentStatus(),players:m.config.players.map(p=>({type:p.type,model:p.model??null}))})));
    const agent=path.match(/^\/api\/agent\/matches\/([a-zA-Z0-9_-]+)(?:\/(status|preview|choose))?$/);
    if(agent) {
      const match=matches.get(agent[1]);if(!match)return json(res,404,{error:'Match not loaded'});
      if(!match.config.players.some(p=>isAgentPlayer(p.type)))return json(res,400,{error:'This match has no session agent player'});
      if(req.method==='GET'&&agent[2]==='status')return json(res,200,match.agentStatus());
      if(req.method==='GET'&&!agent[2])return json(res,200,await match.agentObserve());
      if(req.method==='POST'&&['preview','choose'].includes(agent[2])) {
        const input=await body(req);
        if(probeBusy||[...matches.values()].some(m=>m!==match&&(m.busy||m.running)))return json(res,409,{error:'Another request is running'});
        const result=await match.agentAction(agent[2],input);
        if(agent[2]==='choose')match.run().catch(e=>{match.runtimeError=e.message;console.error(e);});
        return json(res,200,result);
      }
      return json(res,404,{error:'Unknown agent action'});
    }
    const target=path.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)(?:\/(step|run|stop))?$/);
    if(target) {
      const match=matches.get(target[1]);if(!match) return json(res,404,{error:'Match not loaded; open it in replay'});
      if(req.method==='GET'&&!target[2]) return json(res,200,match.snapshot());
      if(req.method==='POST') {
        const input=await body(req);
        if(['step','run'].includes(target[2])&&(probeBusy||[...matches.values()].some(m=>m!==match&&(m.busy||m.running)))) return json(res,409,{error:'Another request is running; execute matches sequentially'});
        if(target[2]==='stop') await match.stop();
        else if(target[2]==='step') {
          if(match.busy||match.running) return json(res,409,{error:'Decision already running'});
          if(match.isAgentTurn())return json(res,409,{error:'Session agent input is required; use the agent endpoint'});
          if(match.isHumanTurn()) {
            await match.step(input);
            match.run().catch(e=>{match.runtimeError=e.message;console.error(e);});
          } else {
            if(Object.keys(input).length) throw Error('Manual input requires a human player');
            match.step().catch(e=>{match.runtimeError=e.message;console.error(e);});
          }
        } else if(target[2]==='run') {
          if(match.busy||match.running) return json(res,409,{error:'Match already running'});
          match.run().catch(e=>{match.runtimeError=e.message;console.error(e);});
        } else return json(res,404,{error:'Unknown action'});
        return json(res,202,match.snapshot());
      }
    }
    if(req.method==='GET') {
      if(path==='/engine.js') {res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await readFile(new URL('./engine.js',import.meta.url)));return;}
      const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(files[path]) {
        const [name,type]=files[path];res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});res.end(await readFile(web+name));return;
      }
    }
    json(res,404,{error:'Not found'});
  } catch(e) {json(res,e.code==='ENOENT'?404:400,{error:e.message});}
});
server.listen(port,host,()=>console.log(`StackingBench: http://${host}:${port}`));

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Match,readRun,listRuns} from './match.js';
import {DEFAULT_PLAYER,DEFAULT_MODEL,QUICK_MODEL} from './players.js';

const port=Number(process.env.PORT??3210),host='127.0.0.1',matches=new Map();
const web=fileURLToPath(new URL('../web/',import.meta.url));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
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
    if(req.method==='GET'&&path==='/api/config') return json(res,200,{defaults:DEFAULT_PLAYER,models:[DEFAULT_MODEL,'Gemma-4-26B-A4B_UD-Q4_K_XL_128K-ctx_fast',QUICK_MODEL],baseUrl:process.env.LLM_BASE_URL??'http://localhost:8082'});
    if(req.method==='GET'&&path==='/api/models') {
      const response=await fetch(`${process.env.LLM_BASE_URL??'http://localhost:8082'}/v1/models`,{signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw Error(`Model server HTTP ${response.status}`);
      const data=await response.json();
      return json(res,200,{models:data.data.map(m=>({id:m.id,status:m.status?.value,architecture:m.architecture}))});
    }
    if(req.method==='GET'&&path==='/api/runs') return json(res,200,await listRuns());
    const replay=path.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
    if(req.method==='GET'&&replay) return json(res,200,await readRun(replay[1]));
    if(req.method==='POST'&&path==='/api/matches') {
      const options=await body(req);
      if([...matches.values()].some(m=>m.busy||m.running)) return json(res,409,{error:'Wait for the running decision before starting another match'});
      delete options.initialState;
      if(options.parent) {
        const records=await readRun(options.parent.id),index=options.parent.index;
        if(!Number.isInteger(index)||index<0||index>records.filter(r=>r.type==='decision').length) throw Error('Invalid replay position');
        options.initialState=index===0?records[0].initialState:records.filter(r=>r.type==='decision')[index-1].state;
      }
      const match=await Match.create(options);matches.set(match.id,match);return json(res,201,match.snapshot());
    }
    const target=path.match(/^\/api\/matches\/([a-zA-Z0-9_-]+)(?:\/(step|run|stop))?$/);
    if(target) {
      const match=matches.get(target[1]);if(!match) return json(res,404,{error:'Match not loaded; open it in replay'});
      if(req.method==='GET'&&!target[2]) return json(res,200,match.snapshot());
      if(req.method==='POST') {
        await body(req);
        if(['step','run'].includes(target[2])&&[...matches.values()].some(m=>m!==match&&(m.busy||m.running))) return json(res,409,{error:'Another match is running; execute matches sequentially'});
        if(target[2]==='stop') await match.stop();
        else if(target[2]==='step') {
          if(match.busy||match.running) return json(res,409,{error:'Decision already running'});
          match.step().catch(e=>{match.runtimeError=e.message;console.error(e);});
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

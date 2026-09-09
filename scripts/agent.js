// Local bridge for an already-running agent session. This script never calls a model.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const [command,id,...args]=process.argv.slice(2);
const usage='Usage: npm run agent -- list | observe ID | wait ID [--after DECISION_ID] [--timeout-ms 50000] | preview ID --file JSON_FILE | choose ID --file JSON_FILE (use --file - for stdin)';
try {
  const origin=new URL(process.env.STACKINGBENCH_URL??'http://127.0.0.1:3210');
  if(origin.protocol!=='http:'||!['localhost','127.0.0.1'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('STACKINGBENCH_URL must be a local HTTP origin');
  if(!['list','observe','wait','preview','choose'].includes(command))throw Error(usage);
  if(command!=='list'&&(!id||!/^[a-zA-Z0-9_-]+$/.test(id)))throw Error(usage);
  const options={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--after','--timeout-ms','--file'].includes(args[i])||args[i+1]===undefined||args[i] in options)throw Error(usage);
    options[args[i]]=args[i+1];
  }
  const request=async(path,data,timeout=10000)=>{
    const response=await fetch(`${origin.origin}/api/agent/matches${path}`,{
      ...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),
      signal:AbortSignal.timeout(timeout),redirect:'error'});
    const value=await response.json();if(!response.ok)throw Error(value.error??`HTTP ${response.status}`);return value;
  };
  let result;
  if(command==='list')result=await request('');
  else if(command==='observe')result=await request(`/${id}`);
  else if(command==='wait') {
    const limit=Number(options['--timeout-ms']??50000);
    if(!Number.isInteger(limit)||limit<1||limit>50000)throw Error('Wait timeout must be 1..50000 ms');
    const deadline=Date.now()+limit;
    for(;;) {
      const status=await request(`/${id}/status`,undefined,Math.max(1,Math.min(10000,deadline-Date.now())));
      if(status.status!=='playing'){result=status;break;}
      if(status.ready&&status.decisionId!==options['--after']){result=await request(`/${id}`);break;}
      const remaining=deadline-Date.now();
      if(remaining<=0){result={...status,waiting:true};break;}
      await delay(Math.min(1000,remaining));
      if(Date.now()>=deadline){result={...status,waiting:true};break;}
    }
  } else {
    const file=options['--file'];if(!file)throw Error(usage);
    let raw='';
    if(file==='-'){for await(const chunk of process.stdin){raw+=chunk;if(raw.length>100000)throw Error('Input too large');}}
    else raw=await readFile(file,'utf8');
    if(raw.length>100000)throw Error('Input too large');
    const input=JSON.parse(raw);
    if(command==='preview'&&input&&typeof input==='object'&&!Array.isArray(input))input.requestId??=randomUUID();
    result=await request(`/${id}/${command}`,input);
  }
  console.log(JSON.stringify(result,null,2));
} catch(e) {console.error(JSON.stringify({error:e.message}));process.exitCode=1;}

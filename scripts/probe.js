import {probeModel} from '../src/probe.js';
import {QUICK_MODEL} from '../src/players.js';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const connection=option('connection',null),positional=args.find((arg,index)=>!arg.startsWith('--')&&!args[index-1]?.startsWith('--')),model=option('model',positional??QUICK_MODEL);
const result=connection?await (await import('../src/probe.js')).probeConnection(connection,model):await probeModel(model,{thinking:option('thinking','server-default'),maxTokens:Number(option('max-tokens','2048'))});
console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;

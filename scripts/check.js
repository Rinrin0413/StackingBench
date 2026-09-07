import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function visit(path) {
  for(const entry of await readdir(path,{withFileTypes:true})) {
    if(['.git','.agents','.codex','node_modules','runs'].includes(entry.name)) continue;
    const full=`${path}/${entry.name}`;
    if(entry.isDirectory()) await visit(full);
    else if(entry.name.endsWith('.js')) {
      const result=spawnSync(process.execPath,['--check',full],{stdio:'inherit'});if(result.status) process.exit(result.status);
    }
  }
}
await visit('.');JSON.parse(await readFile('package.json','utf8'));console.log('JavaScript syntax and package metadata OK');

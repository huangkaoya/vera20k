import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const task of ['sync:check','build:wasm','build:assets','check:assets','typecheck']){
 const r=spawnSync('npm',['run',task],{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
}
const r=spawnSync('npx',['vite','build'],{cwd:root,stdio:'inherit'});process.exit(r.status??1);

import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version='0.2.114';
function run(command,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
  });
}
await run('rustup',['target','add','wasm32-unknown-unknown']);
const tools=path.join(root,'.build/wasm-tools');
for (const command of [process.env.WASM_BINDGEN,path.join(tools,'bin/wasm-bindgen'),path.join(tools,'wasm-bindgen')].filter(Boolean)) {
  try {const {stdout}=await promisify(execFile)(command,['--version']);if(stdout.trim()===`wasm-bindgen ${version}`){console.log(stdout.trim());process.exit(0);}}catch{}
}
await fs.mkdir(tools,{recursive:true});
await run('cargo',['install','--locked','--root',tools,'--version',version,'wasm-bindgen-cli']);

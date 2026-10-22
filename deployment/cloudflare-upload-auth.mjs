import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const directory=path.dirname(fileURLToPath(import.meta.url)),runFile=promisify(execFile);
const credentialKeys=['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_KEY','CLOUDFLARE_EMAIL','CF_EMAIL'];
const endpointKeys=['CLOUDFLARE_API_BASE_URL','CF_API_BASE_URL','CLOUDFLARE_BASE_URL','WRANGLER_API_BASE_URL','WRANGLER_API_ENVIRONMENT','CLOUDFLARE_COMPLIANCE_REGION','WRANGLER_AUTH_DOMAIN','WRANGLER_AUTH_URL','WRANGLER_TOKEN_URL','WRANGLER_REVOKE_URL','WRANGLER_CLIENT_ID'];
const accountKeys=['CLOUDFLARE_ACCOUNT_ID','CF_ACCOUNT_ID'];
const logSettings={WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false'};
const removedKeys=[...credentialKeys,...endpointKeys,...accountKeys];

export async function withDeploymentCredentials(target,operation,{
  env=process.env,run=runFile,fetchImpl=globalThis.fetch,baseDirectory=directory,
}={}) {
  const profile=env.VERA_CLOUDFLARE_PROFILE||target.profile;
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))throw new Error('Invalid named Cloudflare deployment profile');
  const childEnv={...env,...logSettings};
  for(const key of removedKeys)delete childEnv[key];
  let credentials;
  try {
    const result=await run(process.execPath,[path.join(baseDirectory,'node_modules/wrangler/bin/wrangler.js'),
      `--profile=${profile}`,'auth','token','--json'],{
      cwd:baseDirectory,env:childEnv,encoding:'utf8',maxBuffer:256*1024,timeout:60000,
    });
    credentials=JSON.parse(result.stdout);
    if(!['oauth','api_token'].includes(credentials?.type)||typeof credentials.token!=='string'||
      !credentials.token||/\s/.test(credentials.token))throw new Error('Invalid credentials');
  }catch{
    // execFile errors carry stdout/stderr, which may contain the credential.
    // Never propagate the original error or attach it as a cause.
    throw new Error('Unable to resolve the named Cloudflare deployment profile');
  }
  const token=credentials.token;
  let verified;
  try {
    const response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}`,{
      headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30000),
    });
    if(!response.ok)throw new Error('Account request rejected');
    const data=await response.json();
    verified=data.success===true&&data.result?.id===target.accountId;
  }catch{
    throw new Error('Unable to verify the pinned Cloudflare deployment account');
  }
  if(!verified)throw new Error('Named Cloudflare profile cannot access the pinned deployment account');
  const keys=[...removedKeys,...Object.keys(logSettings)],saved=new Map(keys.map(key=>[key,env[key]]));
  try {
    for(const key of removedKeys)delete env[key];
    Object.assign(env,logSettings,{CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:target.accountId});
    return await operation({profile});
  }catch(error){
    const message=typeof error?.message==='string'?error.message.split(token).join('[redacted]'):'Cloudflare upload failed';
    throw new Error(message);
  }finally{
    for(const [key,value] of saved)if(value===undefined)delete env[key];else env[key]=value;
  }
}

const source=process.env.HICODE_EVAL_SOURCE;
const home=process.env.HICODE_EVAL_HOME;
if(!source||!home)throw Error('Missing evaluation paths');
const {createSandboxRuntime}=await import(source+'/src/sandbox/runtime.js');
const {createHiCodeStorageLayout}=await import(source+'/src/persistence/layout.js');
const {runShellArgv}=await import(source+'/src/tools/bash/process.js');
const sandbox=await createSandboxRuntime({cwd:process.cwd(),storage:createHiCodeStorageLayout({hicodeHome:home}),settings:{filesystem:{denyRead:[],denyWrite:[]},network:{mode:'open',allowedDomains:[],allowLocalBinding:false}}});
try {
 if(sandbox.status.kind!=='ready')throw Error(JSON.stringify(sandbox.status));
 const signal=AbortSignal.timeout(20000);
 const wrapped=await sandbox.wrapCommand('node --version',process.cwd(),signal);
 const result=await runShellArgv({...wrapped,cwd:process.cwd(),signal,timeoutMs:20000});
 if(result.termination.kind!=='exit'||result.termination.code!==0)
  throw Error(JSON.stringify({termination:result.termination,stderr:result.stderr.slice(-300)}));
 process.stdout.write('Sandbox ready\n');
} finally {await sandbox.close();}
export {};

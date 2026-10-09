import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,utimes,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {Client} from '../src/host/client.js';
import {startDashboard as serve} from './helpers/server.js';
import {configSchema,runSchema,batchSchema} from '../src/host/types.js';
import {save,tree} from '../src/host/store.js';
import {seedCatalog} from './helpers/catalog.js';
import {environmentFixture} from './helpers/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import * as adapters from '../src/host/publicTasks.js';

async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-retry-')));
 const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments:join(root,'environments'),payload:join(root,'payload'),context:'offline',machine:'fixture',concurrency:2,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
 const original=runSchema.parse({version:2,id:'a'.repeat(16),batchId:'b'.repeat(16),task:'fixture',dataset:'terminal-bench-2.1',state:'error',network:'isolated',model:'fixture',budget:{agentSeconds:900},createdAt:1,updatedAt:2,finishedAt:2,execution:'failed',grading:'unavailable',collection:'complete',note:'original failure'});
 const batch=batchSchema.parse({version:2,id:original.batchId,name:'original',network:'isolated',taskRefs:[{dataset:original.dataset,id:original.task}],runIds:[original.id],concurrency:2,budget:{},createdAt:1,model:config.model,payload:{commit:'fixed'}});
 const frozen=join(root,'runs',original.id,'task','fixture'),source=join(root,'source');
 await mkdir(frozen,{recursive:true});await mkdir(source);
 await writeFile(join(frozen,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=30\n');
 await writeFile(join(frozen,'input.txt'),'original public input');await writeFile(join(source,'input.txt'),'new catalog input');
 await seedCatalog(config,[{dataset:'terminal-bench-2.1',id:'fixture',source}]);
 await save(join(root,'runs',original.id,'task-files.json'),await tree(frozen));
 await save(join(root,'runs',original.id,'state.json'),original);
 await save(join(root,'batches',batch.id+'.json'),batch);await save(join(config.payload,'manifest.json'),batch.payload);
 const validate=spyOn(adapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{}});
 const environment=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environmentFixture('terminal-bench-2.1:fixture'));
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockResolvedValue({type:'result',execution:'completed',grading:'passed',uid:20000});
 const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const lab=new Lab(config,'fake');await lab.init();await lab.prepareMachine();
 return {root,config,original,batch,frozen,lab,execute,cleanup:async()=>{try{await lab.close();}finally{validate.mockRestore();environment.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();cancel.mockRestore();await rm(root,{recursive:true,force:true});}}};
}

test('retry preserves frozen input and prior score; concurrent clicks and restart reuse one durable attempt',async()=>{
 const f=await fixture();let server:ReturnType<typeof serve>|undefined;
 try{
  const timestamp=new Date('2001-02-03T04:05:06Z');
  await utimes(join(f.frozen,'input.txt'),timestamp,timestamp);
  const before=await readFile(join(f.root,'runs',f.original.id,'state.json'),'utf8');
  const [a,b]=await Promise.all([f.lab.retry(f.original.id),f.lab.retry(f.original.id)]);
  expect(a.id).toBe(b.id);expect(a.id).not.toBe(f.batch.id);
  expect(a.retryOf).toEqual({batchId:f.batch.id,runId:f.original.id,attempt:2});
  const id=a.runIds[0]!;
  expect(await readFile(join(f.lab.path(id),'task/fixture/input.txt'),'utf8')).toBe('original public input');
  expect((await stat(join(f.lab.path(id),'task/fixture/input.txt'))).mtimeMs).toBe(timestamp.getTime());
  expect(f.lab.runs.get(id)).toMatchObject({budget:{agentSeconds:900},network:'isolated',model:'fixture'});
  for(let i=0;i<100&&f.lab.runs.get(id)?.state!=='passed';i++)await Bun.sleep(5);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.root,'runs',f.original.id,'state.json'),'utf8')).toBe(before);
  expect(f.lab.batchView(f.batch).counts).toMatchObject({total:1,errors:1,passed:0});
  const restored=new Lab(f.config,'fake');await restored.init();
  expect((await restored.retry(f.original.id)).id).toBe(a.id);
  server=serve(f.lab,0);
  expect(await new Client(server.port!).request('retry-run',{run:f.original.id})).toMatchObject({batch:{id:a.id}});
  await Bun.sleep(10);
  const third=await f.lab.retry(id);expect(third.retryOf).toMatchObject({runId:id,attempt:3});
  expect(f.lab.batches.size).toBe(3);
 }finally{server?.stop(true);await f.cleanup();}
});

test.each(['running','queued','verifying','cancelling','needs_recovery'] as const)('retry refuses %s without launching a duplicate',async state=>{
 const f=await fixture();
 try{f.lab.runs.set(f.original.id,{...f.original,state});await expect(f.lab.retry(f.original.id)).rejects.toThrow('completion or recover');expect(f.execute).not.toHaveBeenCalled();expect(f.lab.batches.size).toBe(1);}
 finally{f.lab.runs.set(f.original.id,f.original);await f.cleanup();}
});

test.each(['model','payload','input'] as const)('retry rejects changed %s before publishing a new attempt',async change=>{
 const f=await fixture();
 try{
  if(change==='model')f.lab.batches.set(f.batch.id,{...f.batch,model:{...f.batch.model,model:'another-model'}});
  if(change==='payload')await save(join(f.config.payload,'manifest.json'),{commit:'different'});
  if(change==='input')await writeFile(join(f.frozen,'input.txt'),'tampered');
  await expect(f.lab.retry(f.original.id)).rejects.toThrow(change==='model'?'model differs':change==='payload'?'payload differs':'frozen task changed');
  expect(f.execute).not.toHaveBeenCalled();expect(f.lab.batches.size).toBe(1);expect(f.lab.runs.size).toBe(1);
 }finally{await f.cleanup();}
});

test('retry refuses a task that is already active in another batch',async()=>{
 const f=await fixture(),other='c'.repeat(16);
 try{
  f.lab.runs.set(other,{...f.original,id:other,state:'running'});
  await expect(f.lab.retry(f.original.id)).rejects.toThrow('active attempt');
  expect(f.execute).not.toHaveBeenCalled();expect(f.lab.batches.size).toBe(1);
 }finally{f.lab.runs.delete(other);await f.cleanup();}
});

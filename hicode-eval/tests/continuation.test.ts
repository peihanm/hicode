import {test,expect,spyOn} from 'bun:test';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import {fixture,seed,finished} from './helpers/root.js';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {save,readJson,tree,runEvidenceTree} from '../src/host/store.js';
import {batchSchema,runSchema,checkpointSchema} from '../src/host/types.js';
import {readCheckpoint} from '../src/host/continuation.js';
import * as publicTasks from '../src/host/publicTasks.js';
import {publicTaskProfile} from '../src/host/publicTasks.js';
import {serveWorker} from '../src/host/server.js';
import {Client} from '../src/host/client.js';
import * as deepTasks from '../src/host/deepTasks.js';
import * as deepContinuation from '../src/host/deepContinuation.js';

async function stopped(f:Awaited<ReturnType<typeof fixture>>,id='a'.repeat(16),taskId='training-or-service',batchId='f'.repeat(16)){
 const task=await seed(f,taskId),state={...finished(task.id,id),batchId,model:f.config.model.model,state:'error' as const,execution:'timeout' as const,grading:'failed' as const};
 const root=f.layout.run(state.id),evidence=join(root,'evidence');await mkdir(evidence,{recursive:true});
 await cp(task.source,join(root,'task',task.id),{recursive:true,preserveTimestamps:true});
 await save(join(root,'task-files.json'),await tree(task.source));
 await save(join(root,'environment.json'),task.binding);await save(join(root,'state.json'),state);
 await save(join(root,'container-disposed.json'),{version:1,runId:state.id,at:new Date().toISOString()});
 const archive=Buffer.from('offline process boundary fixture');await writeFile(join(evidence,'continuation.tar.gz'),archive);
 const checkpoint=checkpointSchema.parse({version:1,runId:state.id,sessionId:'original-session',homePath:'/eval/runs/'+state.id+'/home',
  elapsedSeconds:4200,modelBridgePort:49152,servicePaths:['/etc','/var'],sha256:createHash('sha256').update(archive).digest('hex'),bytes:archive.length});
 await save(join(evidence,'continuation.json'),checkpoint);await save(join(root,'collection.json'),{complete:true,files:await runEvidenceTree(evidence)});
 await save(f.layout.batch(state.batchId),batchSchema.parse({version:1,id:state.batchId,name:'first attempt',network:'open',concurrency:1,
  budget:{agentSeconds:4200},createdAt:1,taskRefs:[{dataset:state.dataset,id:state.task}],runIds:[state.id],model:f.config.model,payload:{}}));
 await save(join(f.layout.payload,'manifest.json'),{});await f.catalog.record(state);
 return {task,state,checkpoint};
}

test('continuation rejects edited checkpoints and uncollected attempts without model calls',async()=>{
 const f=await fixture();
 try{
  const {state}=await stopped(f);expect((await readCheckpoint(f.layout,state)).sessionId).toBe('original-session');
  await expect(readCheckpoint(f.layout,{...state,collection:'retained'})).rejects.toThrow('fully collected');
  await writeFile(join(f.layout.run(state.id),'evidence/continuation.tar.gz'),'edited fixture');
  await expect(readCheckpoint(f.layout,state)).rejects.toThrow('size changed');
 }finally{await f.cleanup();}
});

test('multiple saved sessions publish one batch with independent checkpoint identities and shared concurrency',async()=>{
 const f=await fixture(),a=await stopped(f),b=await stopped(f,'b'.repeat(16),'second-task','e'.repeat(16));
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 const profile=publicTaskProfile({fixture:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'fixture');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(profile);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockImplementation(async task=>task.id===a.task.id?a.task.binding:b.task.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined),dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
 let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});const seen=new Set<string>();
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(run,_path,_key,phase,_model,continuation)=>{
  const original=run.task===a.task.id?a:b;
  expect(continuation?.runId).toBe(original.state.id);expect(continuation?.checkpoint).toEqual(original.checkpoint);
  expect(run.budget.agentSeconds).toBe(1800);seen.add(run.id);await phase('Running HiCode');await gate;
  return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 try{
  await lab.init();const request={runs:[a.state.id,b.state.id],agentSeconds:1800,prompt:'继续'};
  const batch=await lab.continueBatch(request);expect(batch.runIds).toHaveLength(2);expect(batch.concurrency).toBe(2);
  expect(batch.continueOf).toBeUndefined();expect(Object.keys(batch.continuations!)).toEqual(batch.runIds);
  expect((await lab.continueBatch(request)).id).toBe(batch.id);
  const deadline=Date.now()+2000;while(seen.size!==2){if(Date.now()>deadline)throw Error('Batch did not start both sessions');await Bun.sleep(5);}
  for(const original of [a,b])expect(await readJson(join(f.layout.run(original.state.id),'state.json'),runSchema)).toEqual(original.state);
  finish();await lab.close();expect(execute).toHaveBeenCalledTimes(2);
  const restarted=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));await restarted.init();await restarted.close();
 }finally{finish();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();dispose.mockRestore();cancel.mockRestore();execute.mockRestore();await f.cleanup();}
});

test('live continuation freezes original model, restores the checkpoint, adds time, and leaves original scores intact',async()=>{
 const f=await fixture();f.config.model={...f.config.model,source:'qwen-token-plan',model:'deepseek-v4.1-flash',reasoning:{effort:'max'}};
 const originalModel=structuredClone(f.config.model),{task,state,checkpoint}=await stopped(f),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 const metadata=publicTaskProfile({fixture:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'fixture');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata),resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(task.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined),dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
 let executed=false,finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(run,path,_key,phase,model,continuation)=>{
  expect(run.budget.agentSeconds).toBe(1800);expect(model).toEqual(originalModel);
  expect(continuation?.checkpoint).toEqual(checkpoint);expect(continuation?.prompt).toBe('继续，检查保存的 checkpoint。');
  expect(await Bun.file(f.layout.continuationArchive(run.id)).text()).toBe('offline process boundary fixture');
  expect(await Bun.file(join(path,'task',task.id,'instruction.md')).text()).toBe('fixture task');
  executed=true;await phase('Running HiCode');await gate;return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 let worker:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();f.config.models=[{...f.config.model,reasoning:{effort:'off'}}];
  f.config.model={source:'qwen',model:'fake-default',apiKeyEnv:'OTHER_DEFAULT_KEY',baseUrl:'https://default.invalid/v1'};
  worker=serveWorker(lab,0);const client=new Client(worker.port),request={run:state.id,agentSeconds:1800,prompt:'继续，检查保存的 checkpoint。'};
  const batch=batchSchema.parse((await client.request('continue-run',request) as {batch:unknown}).batch);
  expect(batch.continueOf?.runId).toBe(state.id);expect(batch.retryOf).toBeUndefined();expect(batch.continueOf?.attempt).toBe(2);
  const end=Date.now()+2000;while(!executed){if(Date.now()>end)throw Error('Continuation did not start');await Bun.sleep(5);}
  expect(batchSchema.parse((await client.request('continue-run',request) as {batch:unknown}).batch).id).toBe(batch.id);
  await expect(client.request('continue-run',{...request,agentSeconds:2400})).rejects.toThrow('different inputs');
  await expect(lab.retry(state.id)).rejects.toThrow('active attempt');
  expect(await readJson(join(f.layout.run(state.id),'state.json'),runSchema)).toEqual(state);
  expect((await client.status()).runs.find(r=>r.id===state.id)?.continuable).toBe(true);
  finish();await lab.close();expect(execute).toHaveBeenCalledTimes(1);
 }finally{finish();worker?.stop(true);await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();cancel.mockRestore();await f.cleanup();}
});

test('changed runtime and provider connections cannot silently continue an old attempt',async()=>{
 const f=await fixture(),{state}=await stopped(f),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 try{
  await lab.init();f.config.model={...f.config.model,baseUrl:'https://other.invalid/v1'};
  await expect(lab.continueRun({run:state.id,agentSeconds:60,prompt:'继续'})).rejects.toThrow('original model connection');
  expect(lab.batches.size).toBe(1);
 }finally{await lab.close();await f.cleanup();}
});

test('explicit DeepSWE Actor recovery resumes its saved session, records input provenance and retains the old result',async()=>{
 const f=await fixture(),saved=await stopped(f);
 const state=runSchema.parse({...saved.state,dataset:'deep-swe',network:'isolated'}),root=f.layout.run(state.id);
 const environment={...saved.task.binding,task: 'deep-swe:'+state.task};
 await save(join(root,'state.json'),state);await save(join(root,'environment.json'),environment);
 const source=f.layout.source({id:state.task,dataset:'deep-swe'});
 await cp(saved.task.source,source,{recursive:true});
 await f.catalog.register([{id:state.task,dataset:'deep-swe',source}]);await f.catalog.record(state);
 const parent=await readJson(f.layout.batch(state.batchId),batchSchema);
 await save(f.layout.batch(parent.id),{...parent,network:'isolated',taskRefs:[{dataset:'deep-swe',id:state.task}]});
 const archive=join(root,'evidence/continuation.tar.gz');let closed=0,executed=false,finish!:()=>void;
 const gate=new Promise<void>(r=>{finish=r;});
 const recover=spyOn(deepContinuation,'prepareDeepActor').mockImplementation(async(_layout,run)=>{
  expect(run.id).toBe(state.id);return {checkpoint:saved.checkpoint,archive,close:async()=>{closed++;}};
 });
 const validate=spyOn(deepTasks,'validateDeepTask').mockResolvedValue({kind:'deep-swe',repository:'https://github.com/fixture/repo',baseCommit:'a'.repeat(40),
  declaredImage:'public.ecr.aws/d3j8x8q7/swe-bench-202605:fixture',image:'public.ecr.aws/d3j8x8q7/swe-bench-202605@sha256:'+'a'.repeat(64),
  architecture:'amd64',agentSeconds:10800,verifierSeconds:1800,hashes:{},runtimeEnvironment:{}});
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environment);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined),dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(run,_path,_key,phase,model,continuation)=>{
  expect(run.network).toBe('isolated');expect(run.budget.agentSeconds).toBe(1800);expect(model).toEqual(parent.model);
  expect(continuation?.checkpoint.sessionId).toBe('original-session');expect(continuation?.inputSource).toBe('sealed-deep-actor');
  expect(continuation?.prompt).toBe('继续');executed=true;await phase('Running HiCode');await gate;
  return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 try{
  await lab.init();const request={run:state.id,agentSeconds:1800,prompt:'继续',restoreActor:true};
  const batch=await lab.continueRun(request);
  expect(batch.continueOf?.inputSource).toBe('sealed-deep-actor');expect(closed).toBe(1);
  expect((await lab.continueRun(request)).id).toBe(batch.id);expect(recover).toHaveBeenCalledTimes(1);
  await expect(lab.continueRun({...request,restoreActor:false})).rejects.toThrow('different inputs');
  const deadline=Date.now()+2000;while(!executed){if(Date.now()>deadline)throw Error('Saved Actor did not start');await Bun.sleep(5);}
  expect(await readJson(join(root,'state.json'),runSchema)).toEqual(state);
  finish();await lab.close();expect(execute).toHaveBeenCalledTimes(1);
 }finally{
  finish();await lab.close();recover.mockRestore();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();dispose.mockRestore();cancel.mockRestore();execute.mockRestore();await f.cleanup();
 }
});

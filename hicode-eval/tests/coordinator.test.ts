import {test,expect,spyOn} from 'bun:test';
import {join} from 'node:path';
import {fixture,seed,finished} from './helpers/root.js';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import * as publicTasks from '../src/host/publicTasks.js';
import {publicTaskProfile} from '../src/host/publicTasks.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {save,readJson,exists} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import {batchSchema,runSchema} from '../src/host/types.js';
import {EvaluationView} from '../src/host/view.js';
import {serve,serveWorker} from '../src/host/server.js';
import {Client} from '../src/host/client.js';

async function settled(lab:Lab){
 const limit=Date.now()+3000;
 while([...lab.runs.values()].some(r=>!['passed','failed','error','cancelled','needs_recovery'].includes(r.state))){if(Date.now()>limit)throw Error('fixture did not finish');await Bun.sleep(5);}
}

test('real coordinator freezes source, records independent grading, disposes resources and keeps the web contract',async()=>{
 const f=await fixture(),task=await seed(f,'fixture'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({fixture:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'fixture');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(task.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_state,_path,_key,phase)=>{
  await phase('Running HiCode');await phase('Verifying');return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockImplementation(async id=>{await save(join(f.layout.run(id),'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});});
 const processBoundary=spyOn(transport,'run').mockResolvedValue(task.binding.base.imageId+'\n'+task.binding.dependencies.imageId);
 let worker:ReturnType<typeof serveWorker>|undefined,dashboard:ReturnType<typeof serve>|undefined;
 try{
  await lab.init();worker=serveWorker(lab,0);dashboard=serve(new EvaluationView(f.layout.root),new Client(worker.port),0);
  const client=new Client(worker.port);const created=await client.request('submit',{name:'fixture',concurrency:1,tasks:[{dataset:task.dataset,id:task.id,agentSeconds:60}]});
  const batch=batchSchema.parse((created as {batch:unknown}).batch);await settled(lab);await lab.close();
  const state=await readJson(join(f.layout.run(batch.runIds[0]!),'state.json'),runSchema);
  expect(state.state).toBe('failed');expect(state.execution).toBe('completed');expect(state.grading).toBe('failed');expect(dispose).toHaveBeenCalledTimes(1);
  expect((await TaskCatalog.open(f.layout.catalog)).get(task.dataset,task.id).status).toBe('unpassed');expect(await exists(f.layout.batch(batch.id))).toBe(true);
  const view=new Client(dashboard.port),status=await view.status();expect(status.batches[0]?.counts.failed).toBe(1);expect(status.tasks[0]?.environmentPrepared).toBe(true);
  worker.stop(true);worker=undefined;const offline=await view.status();expect(offline.workerConnected).toBe(false);expect(offline.runs[0]?.id).toBe(state.id);
 }finally{dashboard?.stop(true);worker?.stop(true);await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();processBoundary.mockRestore();await f.cleanup();}
});

test('passed tasks cannot create new attempts and a restart cannot silently resume an active run',async()=>{
 const f=await fixture(),task=await seed(f,'one'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']]));
 try{
  await f.catalog.record(finished(task.id));await lab.init();
  await expect(lab.submit({name:'bad',concurrency:1,tasks:[{dataset:task.dataset,id:task.id}]})).rejects.toThrow('Passed tasks');expect(lab.runs.size).toBe(0);
  const id='d'.repeat(16),batchId='e'.repeat(16);
  await save(f.layout.batch(batchId),batchSchema.parse({version:1,id:batchId,name:'interrupted',taskRefs:[{dataset:task.dataset,id:task.id}],runIds:[id],createdAt:1,concurrency:1,budget:{},model:f.config.model,payload:{}}));
  await save(join(f.layout.run(id),'state.json'),runSchema.parse({...finished(task.id,id),state:'running',batchId,grading:'pending',collection:'pending',execution:'pending',startedAt:1}));
  const recovered=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']]));await recovered.init();expect(recovered.runs.get(id)?.state).toBe('needs_recovery');expect(recovered.health().schedulingBlocked).toBe(true);await recovered.close();
 }finally{await lab.close();await f.cleanup();}
});

test('local API rejects cross-origin commands and missing sessions',async()=>{
 const f=await fixture(),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'']]));await lab.init();const worker=serveWorker(lab,0),base='http://127.0.0.1:'+worker.port;
 try{
  expect((await fetch(base+'/api/status')).status).toBe(403);
  const root=await fetch(base),cookie=root.headers.get('set-cookie')!.split(';')[0]!;await root.body?.cancel();
  const response=await fetch(base+'/api/cancel-batch',{method:'POST',headers:{cookie,origin:'https://external.invalid','X-Eval-Request':'1'},body:'{}'});expect(response.status).toBe(403);
 }finally{worker.stop(true);await lab.close();await f.cleanup();}
});

test('worker preparation returns immediately, lets other tasks finish, and blocks conflicting submissions and garbage collection',async()=>{
 const f=await fixture(),active=await seed(f,'active','c'),candidate=await seed(f,'candidate','d'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({active:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'active');
 let finishExecution!:()=>void,finishBuild!:()=>void;let executing=false,building=false;
 const executionGate=new Promise<void>(resolve=>{finishExecution=resolve;});const buildGate=new Promise<void>(resolve=>{finishBuild=resolve;});
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(active.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const build=spyOn(EnvironmentStore.prototype,'prepareTask').mockImplementation(async()=>{building=true;await buildGate;return candidate.binding;});
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_state,_path,_key,phase)=>{await phase('Running HiCode');executing=true;await executionGate;return {type:'result',execution:'completed',grading:'failed',uid:20000};});
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockImplementation(async id=>{await save(join(f.layout.run(id),'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});});
 const boundary=spyOn(transport,'run').mockResolvedValue(active.binding.base.imageId+'\n'+active.binding.dependencies.imageId+'\n'+candidate.binding.dependencies.imageId);
 let worker:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();worker=serveWorker(lab,0);const client=new Client(worker.port);
  await lab.submit({name:'running',concurrency:1,tasks:[{dataset:active.dataset,id:active.id}]});
  const deadline=Date.now()+3000;while(!executing){if(Date.now()>deadline)throw Error('fixture not running');await Bun.sleep(5);}
  await expect(client.request('prepare-environments',{tasks:[{dataset:active.dataset,id:active.id}]})).rejects.toThrow('active or retained');
  expect(await client.request('prepare-environments',{tasks:[{dataset:candidate.dataset,id:candidate.id}]})).toEqual({accepted:['terminal-bench-2.1:candidate']});
  while(!building){if(Date.now()>deadline)throw Error('fixture not building');await Bun.sleep(5);}
  await expect(lab.submit({name:'conflict',concurrency:1,tasks:[{dataset:candidate.dataset,id:candidate.id}]})).rejects.toThrow('being prepared');
  await expect(lab.prepareEnvironments({tasks:[{dataset:candidate.dataset,id:candidate.id}]})).rejects.toThrow('already running');
  finishExecution();await settled(lab);await Bun.sleep(10);
  expect(lab.runs.values().next().value?.execution).toBe('completed');expect(await exists(join(f.layout.state,'maintenance.json'))).toBe(false);
  finishBuild();await lab.close();
  const progress=JSON.parse(await Bun.file(join(f.layout.state,'preparation.json')).text());expect(progress.running).toBe(false);expect(progress.ready).toEqual(['terminal-bench-2.1:candidate']);
 }finally{finishBuild();finishExecution();worker?.stop(true);await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();build.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});

test('closing aborts the routed environment build and leaves queued preparations unstarted',async()=>{
 const f=await fixture(),first=await seed(f,'first-build'),second=await seed(f,'next-build'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']]));
 f.config.datasetBackends={'terminal-bench-2.1':{context:'offline-routed',cpus:1,memoryMb:2048}};
 await f.catalog.setEnvironment(first,'unprepared');await f.catalog.setEnvironment(second,'unprepared');
 await save(join(f.layout.environments,'base.json'),first.binding.base);
 const metadata=publicTaskProfile({first:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'first');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 let started!:()=>void,builds=0;const building=new Promise<void>(resolve=>{started=resolve;});
 const boundary=spyOn(transport,'run').mockImplementation(async(argv,options)=>{
  if(argv.includes('build')){
   builds++;expect(argv).toContain('offline-routed');const signal=options?.signal;if(!signal)throw Error('Build has no cancellation owner');
   started();return new Promise<string>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }
  if(argv.includes('inspect'))return JSON.stringify([{Id:first.binding.base.imageId,Config:{Labels:{'dev.hicode.environment':first.binding.base.key}}}]);
  return '';
 });
 try{
  await lab.init();await lab.prepareEnvironments({tasks:[first,second].map(t=>({dataset:t.dataset,id:t.id}))});await building;
  await lab.close();expect(builds).toBe(1);
  const progress=JSON.parse(await Bun.file(join(f.layout.state,'preparation.json')).text());
  expect(progress.running).toBe(false);expect(progress.failed).toEqual([]);expect(progress.cancelled).toEqual([first,second].map(t=>t.dataset+':'+t.id));
  const catalog=await TaskCatalog.open(f.layout.catalog);
  expect(catalog.get(first.dataset,first.id).environment).toBe('unprepared');expect(catalog.get(second.dataset,second.id).environment).toBe('unprepared');
 }finally{await lab.close();validate.mockRestore();boundary.mockRestore();await f.cleanup();}
});

test.each(['qwen-token-plan','ark-agent-plan'] as const)('%s reasoning is frozen through batch, execution manifest and retry even after the service default changes',async source=>{
 const f=await fixture(),task=await seed(f,'reasoning'),second=await seed(f,'default-choice','d');
 f.config.model={...f.config.model,source,model:'deepseek-v4.1-flash',reasoning:{effort:'high'}};
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));let restarted:Lab|undefined;await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({reasoning:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'reasoning');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(task.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const efforts:string[]=[];
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_state,path,_key,phase,model)=>{
  const manifest=await readJson(join(path,'manifest.json'),batchSchema.pick({model:true}).passthrough());
  expect(manifest.model).toEqual(model);efforts.push(model.reasoning!.effort);
  await phase('Running HiCode');return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockImplementation(async id=>{await save(join(f.layout.run(id),'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});});
 const boundary=spyOn(transport,'run').mockResolvedValue(task.binding.base.imageId+'\n'+task.binding.dependencies.imageId+'\n'+second.binding.dependencies.imageId);
 try{
  await lab.init();
  await expect(lab.submit({name:'invalid',concurrency:1,reasoning:{effort:'medium'},tasks:[{dataset:task.dataset,id:task.id}]})).rejects.toThrow('not supported');
  expect(lab.batches.size).toBe(0);
  const batch=await lab.submit({name:'explicit',concurrency:1,reasoning:{effort:'max'},tasks:[{dataset:task.dataset,id:task.id}]});await settled(lab);
  expect(batch.model.reasoning).toEqual({effort:'max'});
  await lab.close();f.config.model.reasoning={effort:'low'};
  restarted=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));await restarted.init();
  const retried=await restarted.retry(batch.runIds[0]!);await settled(restarted);
  expect(retried.model.reasoning).toEqual({effort:'max'});
  const next=await restarted.submit({name:'default',concurrency:1,tasks:[{dataset:second.dataset,id:second.id}]});await settled(restarted);
  expect(next.model.reasoning).toEqual({effort:'low'});
  expect(efforts).toEqual(['max','max','low']);
 }finally{await restarted?.close();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});

async function failedService(f:Awaited<ReturnType<typeof fixture>>){
 await seed(f,'mailman');const state={...finished('mailman'),state:'failed' as const,grading:'failed' as const};
 await save(join(f.layout.run(state.id),'state.json'),state);
 await save(f.layout.batch(state.batchId),batchSchema.parse({version:1,id:state.batchId,name:'sealed service',network:'open',concurrency:1,budget:{},createdAt:1,
  taskRefs:[{dataset:state.dataset,id:state.task}],runIds:[state.id],model:f.config.model,payload:{}}));
 await f.catalog.record(state);return state;
}
async function until(condition:()=>boolean|Promise<boolean>){
 const end=Date.now()+3000;while(!await condition()){if(Date.now()>end)throw Error('Fixture did not settle');await Bun.sleep(5);}
}

test('live service recheck shares the worker catalog, permits other submissions, and defers cleanup until it finishes',async()=>{
 const f=await fixture(),original=await failedService(f),active=await seed(f,'active'),next=await seed(f,'next','d');f.config.concurrency=2;
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({active:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'active');
 let finishExecution!:()=>void,finishRecheck!:()=>void,executing=false,rechecking=false;
 const executionGate=new Promise<void>(resolve=>{finishExecution=resolve;}),recheckGate=new Promise<void>(resolve=>{finishRecheck=resolve;});
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(active.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(state,_path,_key,phase)=>{
  await phase('Running HiCode');if(state.task==='active'){executing=true;await executionGate;}return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal').mockImplementation(async(state,task,script,reviewId)=>{
  expect(state.id).toBe(original.id);expect(task.id).toBe('mailman');expect(script).toBe('restart reviewed service');
  rechecking=true;await recheckGate;return {version:1,runId:state.id,reviewId,grading:'passed',reason:null,modelCalls:0,snapshotSha256:'a'.repeat(64),projectSha256:'b'.repeat(64),elapsedSeconds:1};
 });
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const boundary=spyOn(transport,'run').mockResolvedValue(active.binding.base.imageId+'\n'+active.binding.dependencies.imageId+'\n'+next.binding.dependencies.imageId);
 let worker:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();worker=serveWorker(lab,0);const client=new Client(worker.port);
  await lab.submit({name:'active task',concurrency:1,tasks:[{dataset:active.dataset,id:active.id}]});await until(()=>executing);
  const input={run:original.id,restartScript:'restart reviewed service'};
  const accepted=await client.request('regrade-terminal',input) as {reviewId:string};await until(()=>rechecking);
  expect((await lab.recheck(original.id,accepted.reviewId)).state).toBe('running');
  expect((await client.request('regrade-terminal',input) as {reviewId:string}).reviewId).toBe(accepted.reviewId);
  await expect(lab.retry(original.id)).rejects.toThrow('Wait for completion');
  await expect(lab.prepareEnvironments({tasks:[{dataset:original.dataset,id:original.task}]})).rejects.toThrow('active or retained');
  const nextBatch=await lab.submit({name:'another submission',concurrency:1,tasks:[{dataset:next.dataset,id:next.id}]});
  expect(lab.runs.get(nextBatch.runIds[0]!)?.state).toBe('queued');finishExecution();
  await until(()=>lab.runs.get(nextBatch.runIds[0]!)?.execution==='completed');
  expect(await exists(join(f.layout.state,'maintenance.json'))).toBe(false);
  finishRecheck();await until(async()=> (await lab.recheck(original.id,accepted.reviewId)).state==='finished');
  expect(lab.runs.get(original.id)?.grading).toBe('passed');
  const catalog=await TaskCatalog.open(f.config.catalog);
  expect(catalog.get(original.dataset,original.task).status).toBe('passed');
  expect(catalog.get(active.dataset,active.id).status).toBe('unpassed');expect(catalog.get(next.dataset,next.id).status).toBe('unpassed');
  expect(regrade).toHaveBeenCalledTimes(1);
 }finally{finishExecution();finishRecheck();worker?.stop(true);await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();regrade.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});

test('queued service recheck can be cancelled without starting a verifier or changing the original score',async()=>{
 const f=await fixture(),original=await failedService(f),active=await seed(f,'active');f.config.concurrency=1;
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({active:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'active');
 let finish!:()=>void,executing=false;const gate=new Promise<void>(resolve=>{finish=resolve;});
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata),resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(active.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async()=>{executing=true;await gate;return {type:'result',execution:'completed',grading:'failed',uid:20000};});
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal');const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const boundary=spyOn(transport,'run').mockResolvedValue(active.binding.base.imageId+'\n'+active.binding.dependencies.imageId);
 try{
  await lab.init();await lab.submit({name:'active',concurrency:1,tasks:[{dataset:active.dataset,id:active.id}]});await until(()=>executing);
  const accepted=await lab.regrade({run:original.id,restartScript:'restart reviewed service'});expect(accepted.state).toBe('queued');
  await lab.cancel(original.id);await until(async()=> (await lab.recheck(original.id,accepted.reviewId)).state==='cancelled');
  expect(regrade).not.toHaveBeenCalled();expect(lab.runs.get(original.id)?.grading).toBe('failed');
 }finally{finish();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();regrade.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});

test('worker restart disposes an interrupted recheck without replaying the model or verifier',async()=>{
 const f=await fixture(),original=await failedService(f),reviewId='b'.repeat(16),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 const path=join(f.layout.recheck(original.id,reviewId),'operation.json');await save(path,{version:1,runId:original.id,reviewId,state:'running'});
 const dispose=spyOn(LinuxMachine.prototype,'disposeTerminalRecheck').mockResolvedValue(undefined);
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal'),execute=spyOn(LinuxMachine.prototype,'execute');
 try{
  await lab.init();expect(dispose).toHaveBeenCalledWith(original,reviewId);
  expect((await lab.recheck(original.id,reviewId)).state).toBe('cancelled');expect(lab.runs.get(original.id)?.grading).toBe('failed');
  expect(regrade).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
 }finally{await lab.close();dispose.mockRestore();regrade.mockRestore();execute.mockRestore();await f.cleanup();}
});

test('closing the worker aborts an in-flight recheck subprocess and preserves the original grade',async()=>{
 const f=await fixture(),original=await failedService(f),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));let started=false;
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal').mockImplementation(async(state,_task,_script,reviewId,signal)=>{
  started=true;await transport.run([process.execPath,'-e','setInterval(()=>{},1000)'],{signal,timeout:2000});
  return {version:1,runId:state.id,reviewId,grading:'passed',reason:null,modelCalls:0,snapshotSha256:'a'.repeat(64),projectSha256:'b'.repeat(64),elapsedSeconds:1};
 });
 try{
  await lab.init();const accepted=await lab.regrade({run:original.id,restartScript:'restart reviewed service'});await until(()=>started);
  const begin=Date.now();await lab.close();expect(Date.now()-begin).toBeLessThan(1000);
  expect((await lab.recheck(original.id,accepted.reviewId)).state).toBe('cancelled');expect(lab.runs.get(original.id)?.grading).toBe('failed');
 }finally{await lab.close();regrade.mockRestore();await f.cleanup();}
});

test('ordinary Terminal recheck uses the worker result queue without a restart script or model execution',async()=>{
 const f=await fixture();await seed(f,'ordinary');
 const original={...finished('ordinary'),state:'error' as const,grading:'unavailable' as const,reward:undefined};
 await save(join(f.layout.run(original.id),'state.json'),original);
 await save(f.layout.batch(original.batchId),batchSchema.parse({version:1,id:original.batchId,name:'sealed ordinary task',network:'open',concurrency:1,budget:{},createdAt:1,
  taskRefs:[{dataset:original.dataset,id:original.task}],runIds:[original.id],model:f.config.model,payload:{}}));
 await f.catalog.record(original);
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']])),execute=spyOn(LinuxMachine.prototype,'execute');
 let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal').mockImplementation(async(state,task,script,reviewId)=>{
  expect(state.id).toBe(original.id);expect(task.id).toBe('ordinary');expect(script).toBeUndefined();await gate;
  return {version:1,kind:'ordinary',runId:state.id,reviewId,grading:'passed',reason:null,modelCalls:0,projectSha256:'a'.repeat(64),elapsedSeconds:1};
 });
 const cleanup=spyOn(transport,'run').mockRejectedValue(new Error('Offline fixture engine unavailable'));
 let server:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();server=serveWorker(lab,0);const client=new Client(server.port);
  const accepted=await client.request('regrade-terminal',{run:original.id}) as {reviewId:string};
  await until(()=>regrade.mock.calls.length===1);expect(lab.runs.get(original.id)?.grading).toBe('unavailable');
  finish();await until(async()=> (await lab.recheck(original.id,accepted.reviewId)).state==='finished');
  expect(execute).not.toHaveBeenCalled();expect(lab.runs.get(original.id)?.execution).toBe('completed');
  expect(lab.runs.get(original.id)?.grading).toBe('passed');
  expect((await TaskCatalog.open(f.config.catalog)).get(original.dataset,original.task).status).toBe('passed');
 }finally{finish();server?.stop(true);await lab.close();regrade.mockRestore();execute.mockRestore();cleanup.mockRestore();await f.cleanup();}
});

test('DeepSWE recheck preserves failed execution while recording the independent verifier result',async()=>{
 const f=await fixture(),source=f.layout.source({dataset:'deep-swe',id:'failed-deep'});
 await Bun.write(join(source,'instruction.md'),'offline fixture');
 await f.catalog.register([{dataset:'deep-swe',id:'failed-deep',source}]);
 const original=runSchema.parse({...finished('failed-deep'),dataset:'deep-swe',network:'isolated',state:'error',execution:'failed',grading:'failed'});
 await save(join(f.layout.run(original.id),'state.json'),original);
 await save(f.layout.batch(original.batchId),batchSchema.parse({version:1,id:original.batchId,name:'failed sealed answer',network:'isolated',concurrency:1,budget:{},createdAt:1,
  taskRefs:[{dataset:original.dataset,id:original.task}],runIds:[original.id],model:f.config.model,payload:{}}));
 await f.catalog.record(original);
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']])),execute=spyOn(LinuxMachine.prototype,'execute');
 const regrade=spyOn(LinuxMachine.prototype,'regradeTerminal').mockImplementation(async(state,_task,_script,reviewId)=>({
  version:1,kind:'ordinary',runId:state.id,reviewId,grading:'passed',reason:null,modelCalls:0,projectSha256:'a'.repeat(64),elapsedSeconds:1}));
 const cleanup=spyOn(transport,'run').mockRejectedValue(new Error('Offline fixture engine unavailable'));
 try{
  await lab.init();const accepted=await lab.regrade({run:original.id});
  await until(async()=> (await lab.recheck(original.id,accepted.reviewId)).state==='finished');
  expect(execute).not.toHaveBeenCalled();expect(lab.runs.get(original.id)?.execution).toBe('failed');
  expect(lab.runs.get(original.id)?.grading).toBe('passed');expect(lab.runs.get(original.id)?.state).toBe('error');
  expect((await TaskCatalog.open(f.config.catalog)).get(original.dataset,original.task).status).toBe('unpassed');
 }finally{await lab.close();regrade.mockRestore();execute.mockRestore();cleanup.mockRestore();await f.cleanup();}
});


test('explicitly abandoning cancelled retained evidence unblocks scheduling without claiming complete collection',async()=>{
 const f=await fixture(),task=await seed(f,'abandoned'),id='a'.repeat(16),batchId='b'.repeat(16);
 await save(join(f.layout.payload,'manifest.json'),{});
 await save(f.layout.batch(batchId),batchSchema.parse({version:1,id:batchId,name:'cancelled',taskRefs:[{dataset:task.dataset,id:task.id}],runIds:[id],createdAt:1,concurrency:1,budget:{},model:f.config.model,payload:{}}));
 await save(join(f.layout.run(id),'state.json'),runSchema.parse({...finished(task.id,id),batchId,state:'needs_recovery',execution:'cancelled',grading:'unavailable',collection:'retained'}));
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']])),prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const abandon=spyOn(LinuxMachine.prototype,'abandonCancelled').mockRejectedValueOnce(Error('runner still alive')).mockResolvedValue(undefined);
 const cleanup=spyOn(transport,'run').mockResolvedValue('');
 let worker:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();worker=serveWorker(lab,0);const client=new Client(worker.port);
  await expect(client.request('abandon-cancelled-run',{run:id})).rejects.toThrow('runner still alive');
  expect(lab.health().schedulingBlocked).toBe(true);
  await client.request('abandon-cancelled-run',{run:id});
  expect(lab.runs.get(id)?.state).toBe('cancelled');expect(lab.runs.get(id)?.collection).toBe('retained');
  expect(lab.runs.get(id)?.grading).toBe('unavailable');expect(lab.health().schedulingBlocked).toBe(false);
  expect((await TaskCatalog.open(f.layout.catalog)).get(task.dataset,task.id).status).toBe('untested');
  await expect(client.request('abandon-cancelled-run',{run:id})).rejects.toThrow('Only cancelled');
 }finally{worker?.stop(true);await lab.close();prepare.mockRestore();abandon.mockRestore();cleanup.mockRestore();await f.cleanup();}
});

test.each([false,true])('deferred preparation waits for evaluation or is cancelled while waiting: %s',async cancel=>{
 const f=await fixture(),active=await seed(f,'deferred-active'),candidate=await seed(f,'deferred-build','d'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
 await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTaskProfile({active:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},'active');
 let finish!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{finish=r;}),running=new Promise<void>(r=>{started=r;});
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata),resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(active.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined),build=spyOn(EnvironmentStore.prototype,'prepareTask').mockResolvedValue(candidate.binding);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_s,_p,_k,phase)=>{await phase('Running HiCode');started();await gate;return {type:'result',execution:'completed',grading:'failed',uid:20000};});
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined),boundary=spyOn(transport,'run').mockResolvedValue('');
 try{
  await lab.init();await lab.submit({name:'evaluation',concurrency:1,tasks:[{dataset:active.dataset,id:active.id}]});await running;
  expect(await lab.prepareEnvironments({tasks:[{dataset:candidate.dataset,id:candidate.id}],afterEvaluations:true})).toEqual({accepted:['terminal-bench-2.1:deferred-build']});
  await Bun.sleep(30);expect(build).not.toHaveBeenCalled();
  expect(JSON.parse(await Bun.file(join(f.layout.state,'preparation.json')).text()).waitingForEvaluations).toBe(true);
  if(cancel){
   const closing=lab.close();finish();await closing;expect(build).not.toHaveBeenCalled();
   expect(JSON.parse(await Bun.file(join(f.layout.state,'preparation.json')).text()).cancelled).toEqual(['terminal-bench-2.1:deferred-build']);
  }else{
   finish();await settled(lab);
   const end=Date.now()+2000;while(!build.mock.calls.length){if(Date.now()>end)throw Error('Deferred build did not begin');await Bun.sleep(10);}
   await lab.close();expect(build).toHaveBeenCalledTimes(1);
  }
 }finally{finish();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();build.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});


test('worker startup and read-only status keep queued attempts idle without model execution',async()=>{
 const f=await fixture(),task=await seed(f,'queued-maintenance'),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'unused']]));
 const id='a'.repeat(16),batchId='f'.repeat(16);
 await save(f.layout.batch(batchId),batchSchema.parse({version:1,id:batchId,name:'queued maintenance',taskRefs:[{dataset:task.dataset,id:task.id}],runIds:[id],createdAt:1,concurrency:1,budget:{},model:f.config.model,payload:{}}));
 await save(join(f.layout.run(id),'state.json'),runSchema.parse({version:1,id,batchId,dataset:task.dataset,task:task.id,state:'queued',execution:'pending',grading:'pending',collection:'pending',model:'fake',budget:{},createdAt:1,updatedAt:1}));
 const execute=spyOn(LinuxMachine.prototype,'execute').mockRejectedValue(Error('Unexpected paid execution'));
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockRejectedValue(Error('Unexpected execution initialization'));
 let worker:ReturnType<typeof serveWorker>|undefined;
 try{
  await lab.init();worker=serveWorker(lab,0);
  const client=new Client(worker.port);await client.request('health');const status=await client.status();
  expect(status.schedulingBlocked).toBe(false);
  expect(status.runs[0]).toMatchObject({id,state:'queued',execution:'pending'});
  await Bun.sleep(20);expect(execute).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
  expect(lab.runs.get(id)?.state).toBe('queued');
 }finally{worker?.stop(true);await lab.close();execute.mockRestore();prepare.mockRestore();await f.cleanup();}
});

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
 const f=await fixture(),task=await seed(f,'fixture'),lab=new Lab(f.config,'offline-secret');
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
 const f=await fixture(),task=await seed(f,'one'),lab=new Lab(f.config,'unused');
 try{
  await f.catalog.record(finished(task.id));await lab.init();
  await expect(lab.submit({name:'bad',concurrency:1,tasks:[{dataset:task.dataset,id:task.id}]})).rejects.toThrow('Passed tasks');expect(lab.runs.size).toBe(0);
  const id='d'.repeat(16),batchId='e'.repeat(16);
  await save(f.layout.batch(batchId),batchSchema.parse({version:1,id:batchId,name:'interrupted',taskRefs:[{dataset:task.dataset,id:task.id}],runIds:[id],createdAt:1,concurrency:1,budget:{},model:f.config.model,payload:{}}));
  await save(join(f.layout.run(id),'state.json'),runSchema.parse({...finished(task.id,id),state:'running',batchId,grading:'pending',collection:'pending',execution:'pending',startedAt:1}));
  const recovered=new Lab(f.config,'unused');await recovered.init();expect(recovered.runs.get(id)?.state).toBe('needs_recovery');expect(recovered.health().schedulingBlocked).toBe(true);await recovered.close();
 }finally{await lab.close();await f.cleanup();}
});

test('local API rejects cross-origin commands and missing sessions',async()=>{
 const f=await fixture(),lab=new Lab(f.config,'');await lab.init();const worker=serveWorker(lab,0),base='http://127.0.0.1:'+worker.port;
 try{
  expect((await fetch(base+'/api/status')).status).toBe(403);
  const root=await fetch(base),cookie=root.headers.get('set-cookie')!.split(';')[0]!;await root.body?.cancel();
  const response=await fetch(base+'/api/cancel-batch',{method:'POST',headers:{cookie,origin:'https://external.invalid','X-Eval-Request':'1'},body:'{}'});expect(response.status).toBe(403);
 }finally{worker.stop(true);await lab.close();await f.cleanup();}
});

test('worker preparation returns immediately, lets other tasks finish, and blocks conflicting submissions and garbage collection',async()=>{
 const f=await fixture(),active=await seed(f,'active','c'),candidate=await seed(f,'candidate','d'),lab=new Lab(f.config,'offline-secret');
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

test('reasoning is frozen through batch, execution manifest and retry even after the service default changes',async()=>{
 const f=await fixture(),task=await seed(f,'reasoning'),second=await seed(f,'default-choice','d');
 f.config.model={...f.config.model,source:'qwen-token-plan',model:'deepseek-v4.1-flash',reasoning:{effort:'high'}};
 const lab=new Lab(f.config,'offline-secret');let restarted:Lab|undefined;await save(join(f.layout.payload,'manifest.json'),{});
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
  restarted=new Lab(f.config,'offline-secret');await restarted.init();
  const retried=await restarted.retry(batch.runIds[0]!);await settled(restarted);
  expect(retried.model.reasoning).toEqual({effort:'max'});
  const next=await restarted.submit({name:'default',concurrency:1,tasks:[{dataset:second.dataset,id:second.id}]});await settled(restarted);
  expect(next.model.reasoning).toEqual({effort:'low'});
  expect(efforts).toEqual(['max','max','low']);
 }finally{await restarted?.close();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();}
});

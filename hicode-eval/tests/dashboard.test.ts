import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,realpath,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {EvaluationView} from '../src/host/view.js';
import {Client} from '../src/host/client.js';
import {serve,serveWorker} from '../src/host/server.js';
import {configSchema,batchSchema,runSchema} from '../src/host/types.js';
import {save} from '../src/host/store.js';
import {taskAdapters} from '../src/host/datasets.js';
import {profiles} from '../src/host/publicTasks.js';
import {seedCatalog,environmentFixture} from './helpers/catalog.js';

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-dashboard-')));
  const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments:join(root,'environments'),
    payload:join(root,'payload'),context:'offline',machine:'unused',concurrency:1,budget:{},network:'isolated',
    model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'http://127.0.0.1:1'}});
  const source=join(root,'source');await mkdir(source);await writeFile(join(source,'instruction.md'),'offline fixture');
  await seedCatalog(config,[{id:'cancel-async-tasks',source}]);await save(join(root,'config.json'),config);
  await save(join(config.payload,'manifest.json'),{});
  return {root,config,cleanup:()=>rm(root,{recursive:true,force:true})};
}

function deferred(){let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;});return {promise,done};}

test('a separate dashboard process can stop and restart while its execution worker keeps the same running attempt',async()=>{
  const f=await fixture(),lab=new Lab(f.config,'offline-fixture'),started=deferred(),finish=deferred();
  const metadata=(await profiles('terminal-bench'))['cancel-async-tasks']!;
  const validate=spyOn(taskAdapters['terminal-bench'],'validate').mockResolvedValue(metadata);
  const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environmentFixture('terminal-bench:cancel-async-tasks'));
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
  const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
  const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_run,_path,_credential,phase)=>{
    await phase('Running HiCode');started.done();await finish.promise;
    return {type:'result',execution:'completed',grading:'passed',uid:20001};
  });
  let worker:ReturnType<typeof serveWorker>|undefined,child:ReturnType<typeof Bun.spawn>|undefined;
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=probe.port;probe.stop(true);
  if(port===undefined)throw Error('Expected a loopback TCP port');
  const boot=async()=>{
    child=Bun.spawn(['bun',join(import.meta.dir,'../src/cli.ts'),'serve','--data-dir',f.root,'--port',String(port),'--worker-port',String(worker!.port)],
      {cwd:f.root,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:join(f.root,'fake-home')},stdin:'ignore',stdout:'ignore',stderr:'pipe'});
    for(let i=0;i<100;i++){
      try{const response=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(100)});await response.body?.cancel();if(response.ok)return;}
      catch{}await Bun.sleep(10);
    }
    const errors=child.stderr instanceof ReadableStream?await new Response(child.stderr).text():'No stderr stream';
    throw Error('Dashboard failed to start: '+errors);
  };
  try{
    await lab.init();await lab.prepareMachine();worker=serveWorker(lab,0);
    await boot();const batchResponse=await new Client(port).request('submit',{name:'independent process',network:'isolated',concurrency:1,tasks:[{id:'cancel-async-tasks'}]});
    if(typeof batchResponse!=='object'||batchResponse===null||!('batch' in batchResponse))throw Error('Missing receipt');
    const batch=batchSchema.parse(batchResponse.batch);await started.promise;
    expect(lab.runs.get(batch.runIds[0]!)?.state).toBe('running');
    child!.kill('SIGTERM');expect(await child!.exited).toBe(0);child=undefined;
    expect(lab.runs.get(batch.runIds[0]!)?.state).toBe('running');expect(cancel).not.toHaveBeenCalled();
    await boot();const status=await new Client(port).status(batch.id);
    expect(status.runs[0]?.id).toBe(batch.runIds[0]);expect(status.runs[0]?.state).toBe('running');
    expect(execute).toHaveBeenCalledTimes(1);expect(cancel).not.toHaveBeenCalled();
    finish.done();for(let i=0;i<100&&lab.runs.get(batch.runIds[0]!)?.state!=='passed';i++)await Bun.sleep(5);
    expect(lab.runs.get(batch.runIds[0]!)?.state).toBe('passed');
  }finally{
    finish.done();if(child){child.kill('SIGTERM');await child.exited;}worker?.stop(true);await lab.close();
    validate.mockRestore();resolve.mockRestore();prepare.mockRestore();cancel.mockRestore();dispose.mockRestore();execute.mockRestore();await f.cleanup();
  }
});

test('an unavailable or miswired worker cannot mutate records; dashboard remains readable without acquiring the execution lease',async()=>{
  const f=await fixture(),other=await fixture(),foreign=new Lab(other.config,'offline-fixture');
  const worker=serveWorker(foreign,0),dashboard=serve(new EvaluationView(f.root),new Client(worker.port),0),client=new Client(dashboard.port);
  try{
    const status=await client.status();expect(status.runs).toHaveLength(0);
    await expect(client.request('submit',{name:'wrong owner',concurrency:1,tasks:[{id:'cancel-async-tasks'}]})).rejects.toThrow('another evaluation data directory');
    expect(foreign.batches.size).toBe(0);worker.stop(true);
    expect((await client.status()).tasks).toHaveLength(1);
    await expect(readFile(join(f.root,'.service.lock/owner.json'))).rejects.toThrow();
  }finally{dashboard.stop(true);worker.stop(true);await f.cleanup();await other.cleanup();}
});

test('read-only views reject cross-batch identities and symlinked run paths without repairing or writing them',async()=>{
  const f=await fixture(),id='a'.repeat(16),bid='b'.repeat(16),view=new EvaluationView(f.root);
  try{
    const run=runSchema.parse({version:2,id,batchId:bid,dataset:'terminal-bench',task:'cancel-async-tasks',state:'running',network:'isolated',createdAt:1,updatedAt:1,model:'fixture',budget:{}});
    await save(join(f.root,'runs',id,'state.json'),run);
    await save(join(f.root,'batches',bid+'.json'),batchSchema.parse({version:2,id:bid,name:'fixture',network:'isolated',taskRefs:[{dataset:run.dataset,id:'different-task'}],runIds:[id],concurrency:1,budget:{},createdAt:1,model:f.config.model,payload:{}}));
    await expect(view.snapshot()).rejects.toThrow('frozen batch');
    await expect(view.path('../outside')).rejects.toThrow();
    await rm(join(f.root,'runs',id),{recursive:true});await symlink(f.root,join(f.root,'runs',id));
    await expect(view.path(id)).rejects.toThrow('Symlinked storage parent');
    expect(await readFile(join(f.root,'batches',bid+'.json'),'utf8')).toContain('different-task');
  }finally{await f.cleanup();}
});

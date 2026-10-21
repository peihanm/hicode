import {test,expect,spyOn} from 'bun:test';
import {mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,seed,finished} from './helpers/root.js';
import {registerTasks} from '../src/host/taskRegistration.js';
import {save,tree,exists} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {serve,serveWorker} from '../src/host/server.js';
import {EvaluationView} from '../src/host/view.js';
import {Client} from '../src/host/client.js';

const dataset='terminal-bench-2.1' as const;
async function profile(source:string){
  return {hashes:Object.fromEntries(Object.entries(await tree(source)).map(([name,file])=>[name,file.sha256])),
    inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'};
}
async function inputs(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'eval-registration-'))),source=join(root,'tasks'),definition=join(root,'definition.json');
  await mkdir(source);
  const declarations:Record<string,Awaited<ReturnType<typeof profile>>>={};
  const add=async(id:string)=>{
    const task=join(source,id);await mkdir(task);
    await writeFile(join(task,'instruction.md'),'offline fixture');
    await writeFile(join(task,'task.toml'),'[agent]\ntimeout_sec=30\n[verifier]\ntimeout_sec=30\n');
    declarations[id]=await profile(task);await save(definition,declarations);
  };
  return {root,source,definition,declarations,add,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('offline import freezes reviewed source and preparation, starts untested/unprepared, and refuses overwrites',async()=>{
  const f=await fixture(),i=await inputs();
  try{
    await i.add('new-task');const preparation=join(i.root,'preparation');await mkdir(preparation);await writeFile(join(preparation,'setup.sh'),'#!/bin/sh\ntrue\n');
    const request={dataset,source:i.source,ids:['new-task'],definition:i.definition,preparation:{directory:preparation,script:'setup.sh'}};
    expect(await registerTasks(f.layout,f.catalog,request)).toEqual({registered:1,tasks:[dataset+':new-task']});
    const registered=(await TaskCatalog.open(f.layout.catalog)).get(dataset,'new-task');
    expect(registered.status).toBe('untested');expect(registered.environment).toBe('unprepared');expect(registered.results).toEqual([]);
    expect(await tree(registered.source!)).toEqual(await tree(join(i.source,'new-task')));
    expect(await tree(registered.preparation!.directory)).toEqual(await tree(preparation));
    await expect(registerTasks(f.layout,f.catalog,request)).rejects.toThrow('already exists');
    expect(await exists(join(f.layout.state,'import.json'))).toBe(false);
  }finally{await i.cleanup();await f.cleanup();}
});

test('invalid hashes, symlinks, duplicate selections and changed existing declarations never publish partial tasks',async()=>{
  const f=await fixture(),i=await inputs();
  try{
    await i.add('first');await i.add('second');
    await writeFile(join(i.source,'second','instruction.md'),'tampered');
    const request={dataset,source:i.source,ids:['first','second'],definition:i.definition};
    await expect(registerTasks(f.layout,f.catalog,request)).rejects.toThrow('reviewed dataset');
    expect(f.catalog.list()).toHaveLength(0);expect(await exists(f.layout.source({dataset,id:'first'}))).toBe(false);
    expect(await exists(f.layout.definition(dataset))).toBe(false);
    await expect(registerTasks(f.layout,f.catalog,{...request,ids:['first','first']})).rejects.toThrow('Duplicate');
    const alias=join(i.root,'alias');await symlink(i.source,alias);
    await expect(registerTasks(f.layout,f.catalog,{...request,source:alias})).rejects.toThrow('canonical');
    await symlink(join(i.root,'definition.json'),join(i.source,'first','escape'));
    await expect(registerTasks(f.layout,f.catalog,request)).rejects.toThrow('Symlinks');
    await rm(join(i.source,'first','escape'));
    await save(f.layout.definition(dataset),{first:{...i.declarations.first,commands:['git']}});
    await expect(registerTasks(f.layout,f.catalog,request)).rejects.toThrow('existing task definition');
    expect(f.catalog.list()).toHaveLength(0);
  }finally{await i.cleanup();await f.cleanup();}
});

test('catalog registration and result/environment writes share one queue without losing updates',async()=>{
  const f=await fixture(),active=await seed(f,'active');
  try{
    const next={dataset,id:'next',source:f.layout.source({dataset,id:'next'})};
    await Promise.all([f.catalog.register([next]),f.catalog.record(finished(active.id)),f.catalog.setEnvironment(active,'failed')]);
    const catalog=await TaskCatalog.open(f.layout.catalog);
    expect(catalog.get(dataset,'active')).toMatchObject({status:'passed',environment:'failed',results:[{accepted:true}]});
    expect(catalog.get(dataset,'next')).toMatchObject({status:'untested',environment:'unprepared'});
    await expect(f.catalog.register([next])).rejects.toThrow('already registered');
    await f.catalog.setEnvironment(next,'ready');expect(f.catalog.get(dataset,'next').environment).toBe('ready');
  }finally{await f.cleanup();}
});

test('a symlinked destination is rejected before creating an import journal or publishing a declaration',async()=>{
  const f=await fixture(),i=await inputs();
  try{
    await i.add('new-task');const external=join(i.root,'outside');await mkdir(external);
    await mkdir(join(f.layout.datasets,dataset));await symlink(external,join(f.layout.datasets,dataset,'tasks'));
    await expect(registerTasks(f.layout,f.catalog,{dataset,source:i.source,definition:i.definition})).rejects.toThrow('canonical');
    expect(await exists(join(f.layout.state,'import.json'))).toBe(false);
    expect(await exists(f.layout.definition(dataset))).toBe(false);expect(await exists(join(external,'new-task'))).toBe(false);
  }finally{await i.cleanup();await f.cleanup();}
});

test('worker imports new tasks during execution; dashboard sees the additions and the completed result survives',async()=>{
  const f=await fixture(),active=await seed(f,'active'),i=await inputs(),lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'offline-secret']]));
  await i.add('candidate');await save(f.layout.definition(dataset),{active:await profile(active.source)});
  await save(join(f.layout.payload,'manifest.json'),{});
  let finish!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{finish=resolve;}),running=new Promise<void>(resolve=>{started=resolve;});
  const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(active.binding);
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(_state,_path,_key,phase)=>{
    await phase('Running HiCode');started();await gate;return {type:'result',execution:'completed',grading:'failed',uid:20000};
  });
  const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
  const boundary=spyOn(transport,'run').mockResolvedValue(active.binding.base.imageId+'\n'+active.binding.dependencies.imageId);
  let worker:ReturnType<typeof serveWorker>|undefined,dashboard:ReturnType<typeof serve>|undefined;
  try{
    await lab.init();worker=serveWorker(lab,0);dashboard=serve(new EvaluationView(f.layout.root),new Client(worker.port),0);
    const batch=await lab.submit({name:'active',concurrency:1,tasks:[{dataset,id:active.id}]});await running;
    const client=new Client(dashboard.port);
    expect(await client.request('register-tasks',{dataset,source:i.source,ids:['candidate'],definition:i.definition})).toEqual({registered:1,tasks:[dataset+':candidate']});
    expect(lab.runs.get(batch.runIds[0]!)?.state).toBe('running');
    const view=await client.status();expect(view.tasks.find(t=>t.id==='candidate'&&t.category===dataset)).toMatchObject({status:'untested',sourcePrepared:true,environmentPrepared:false});
    finish();await lab.close();
    const catalog=await TaskCatalog.open(f.layout.catalog);expect(catalog.list()).toHaveLength(2);
    expect(catalog.get(dataset,active.id).status).toBe('unpassed');expect(catalog.get(dataset,active.id).results).toHaveLength(1);
    await expect(lab.registerTasks({dataset,source:i.source,ids:['candidate']})).rejects.toThrow('closing');
  }finally{finish();dashboard?.stop(true);worker?.stop(true);await lab.close();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await i.cleanup();await f.cleanup();}
});

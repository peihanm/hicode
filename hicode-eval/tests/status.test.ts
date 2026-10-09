import {test,expect,spyOn} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EnvironmentStore} from '../src/host/environments.js';
import {Lab} from '../src/host/manager.js';
import {startDashboard as serve} from './helpers/server.js';
import {configSchema} from '../src/host/types.js';
import {taskKey} from '../src/host/datasets.js';
import type {CatalogTask} from '../src/host/catalog.js';
import * as transport from '../src/host/store.js';
import {environmentFixture} from './helpers/catalog.js';

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-status-')));
  const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),
    environments:join(root,'environments'),payload:join(root,'payload'),context:'offline-arm',machine:'unused',
    datasetBackends:{'deep-swe':{context:'offline-amd64',cpus:2,memoryMb:8192}},network:'isolated',
    concurrency:2,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'http://127.0.0.1:1'}});
  const tasks:CatalogTask[]=(['terminal-bench-2.1','deep-swe'] as const).map(dataset=>({
    dataset,id:'shared',source:join(root,'unavailable-source',dataset),status:'untested',results:[]}));
  await transport.save(config.catalog,{version:1,updatedAt:'2026-10-09T00:00:00.000Z',tasks});
  const bindingPath=(task:CatalogTask)=>join(config.environments,'tasks',createHash('sha256').update(taskKey(task)).digest('hex')+'.json');
  for(const task of tasks)await transport.save(bindingPath(task),environmentFixture(taskKey(task)));
  return {root,config,tasks,bindingPath};
}

test('mixed-dataset status reads receipts without resolving sources or querying Docker; submission still resolves',async()=>{
  const f=await fixture(),lab=new Lab(f.config,'offline-fixture');
  const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockRejectedValue(Error('source or image identity changed'));
  const command=spyOn(transport,'run').mockRejectedValue(Error('status must not execute commands'));
  let server:ReturnType<typeof serve>|undefined;
  try{
    await lab.init();server=serve(lab,0);
    const home=await fetch('http://127.0.0.1:'+server.port);
    const cookie=home.headers.get('set-cookie')!.split(';')[0]!;await home.body?.cancel();
    const response=await fetch('http://127.0.0.1:'+server.port+'/api/status',{headers:{cookie}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({tasks:[
      {id:'shared',dataset:'terminal-bench-2.1',environmentPrepared:true},
      {id:'shared',dataset:'deep-swe',environmentPrepared:true},
    ]});
    expect(resolve).not.toHaveBeenCalled();expect(command).not.toHaveBeenCalled();
    await expect(lab.submit({name:'strict submission',network:'isolated',concurrency:1,
      tasks:[{id:'shared',dataset:'deep-swe'}]})).rejects.toThrow('source or image identity changed');
    expect(resolve).toHaveBeenCalledTimes(1);expect(command).not.toHaveBeenCalled();
  }finally{server?.stop(true);await lab.close();resolve.mockRestore();command.mockRestore();await rm(f.root,{recursive:true,force:true});}
});

test('inventory reflects receipt changes and rejects missing, mismatched, malformed and symlinked receipts',async()=>{
  const f=await fixture();const store=new EnvironmentStore(f.config.environments,f.config.context,f.config.datasetBackends);
  const task=f.tasks[1]!,path=f.bindingPath(task);
  try{
    expect(await store.ready(task)).toBe(true);
    await transport.save(path,environmentFixture('terminal-bench-2.1:shared'));
    expect(await store.ready(task)).toBe(false);
    const valid=environmentFixture(taskKey(task));
    await transport.save(path,{...valid,dependencies:{...valid.dependencies,parentImage:'sha256:'+'f'.repeat(64)}});
    expect(await store.ready(task)).toBe(false);
    await writeFile(path,'{broken');expect(await store.ready(task)).toBe(false);
    await rm(path);expect(await store.ready(task)).toBe(false);
    await transport.save(join(f.root,'receipt.json'),valid);await symlink(join(f.root,'receipt.json'),path);
    expect(await store.ready(task)).toBe(false);
    await rm(path);await transport.save(path,valid);expect(await store.ready(task)).toBe(true);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

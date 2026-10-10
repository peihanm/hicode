import {test,expect} from 'bun:test';
import {mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,seed,finished} from './helpers/root.js';
import {EvalLayout} from '../src/host/layout.js';
import {loadConfig,submissionSchema,configSchema} from '../src/host/types.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {save} from '../src/host/store.js';

test('root paths are derived, old configuration is rejected, and task identity is explicit',async()=>{
 const f=await fixture();try{
  expect((await loadConfig(f.layout.root)).catalog).toBe(join(f.layout.root,'state/catalog.json'));
  expect(()=>configSchema.parse({...f.config,version:4})).toThrow();
  expect(()=>submissionSchema.parse({name:'bad',tasks:[{id:'same'}]})).toThrow();
  expect(()=>submissionSchema.parse({name:'bad',tasks:[{dataset:'terminal-bench',id:'same'}]})).toThrow();
  expect(()=>f.layout.source({dataset:'terminal-bench-2.1',id:'../other'})).toThrow();
  expect(await f.layout.initialize()).toBe(false);
 }finally{await f.cleanup();}
});

test('old roots and redirected state directories fail closed',async()=>{
 const f=await fixture();try{
  const old=join(f.layout.cache,'old');await mkdir(old);await writeFile(join(old,'config.json'),'{}');
  await expect(new EvalLayout(old).initialize()).rejects.toThrow('empty root');
  await rm(f.layout.downloads,{recursive:true});await symlink(f.layout.datasets,f.layout.downloads);
  await expect(f.layout.assert()).rejects.toThrow('Symlinked');
 }finally{await f.cleanup();}
});

test('catalog owns results independently from evicted environments and rejects external source paths',async()=>{
 const f=await fixture();try{
  const task=await seed(f,'one');await Promise.all([f.catalog.record(finished('one')),f.catalog.setEnvironment(task,'evicted')]);
  const stored=await TaskCatalog.open(f.layout.catalog);expect(stored.get(task.dataset,task.id).status).toBe('passed');expect(stored.get(task.dataset,task.id).environment).toBe('evicted');
  await stored.releasePassedSource(task);expect((await TaskCatalog.open(f.layout.catalog)).get(task.dataset,task.id).source).toBeUndefined();
  await save(f.layout.catalog,{version:1,updatedAt:new Date().toISOString(),tasks:[{...stored.get(task.dataset,task.id),source:'/tmp/external'}]});
  await expect(TaskCatalog.open(f.layout.catalog)).rejects.toThrow('datasets/');
 }finally{await f.cleanup();}
});

import {test,expect,spyOn} from 'bun:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,seed,finished} from './helpers/root.js';
import {collectResources,archivePassedRun} from '../src/host/resources.js';
import * as transport from '../src/host/store.js';
import {runSchema} from '../src/host/types.js';
import {TaskCatalog} from '../src/host/catalog.js';

// Fake only the process boundary; real layout, receipts, catalog and archives are exercised.
test('cleanup preserves shared images, evicts passed-only images, and updates the ledger',async()=>{
 const f=await fixture();const a=await seed(f,'passed-shared','c'),b=await seed(f,'untested-shared','c'),c=await seed(f,'passed-only','d');
 await f.catalog.record(finished(a.id));await f.catalog.record(finished(c.id,'e'.repeat(16)));
 const present=new Set([a.binding.base.imageId,a.binding.dependencies.imageId,c.binding.dependencies.imageId]);const calls:string[][]=[];
 const fake=spyOn(transport,'run').mockImplementation(async args=>{
  calls.push(args);if(args.includes('ls'))return [...present].join('\n');if(args.includes('ps'))return '';
  if(args.includes('inspect')){const id=args.at(-1)!;return JSON.stringify([{Id:id,Config:{Labels:{'dev.hicode.environment':id.slice(7)}},RepoTags:['hicode-env-dependencies:'+id.slice(7)]}]);}
  if(args.includes('rm')){present.delete('sha256:'+args.at(-1)!.split(':')[1]);return '';}
  throw Error('Unexpected subprocess');
 });
 try{
  const preview=await collectResources(f.config,f.catalog,[],false);expect(preview.candidates).toEqual([c.binding.dependencies.imageId]);expect(calls.some(a=>a.includes('rm'))).toBe(false);
  const applied=await collectResources(f.config,f.catalog,[],true);expect(applied.deleted).toEqual([c.binding.dependencies.imageId]);
  const cat=await TaskCatalog.open(f.layout.catalog);expect(cat.get(c.dataset,c.id).environment).toBe('evicted');expect(cat.get(b.dataset,b.id).environment).toBe('ready');expect(cat.get(c.dataset,c.id).status).toBe('passed');
  expect(present.has(a.binding.dependencies.imageId)).toBe(true);
 }finally{fake.mockRestore();await f.cleanup();}
});

test('cleanup keeps images referenced by stopped containers or external tags',async()=>{
 const f=await fixture(),container=await seed(f,'container-image','c'),foreign=await seed(f,'external-image','d');
 await f.catalog.record(finished(container.id));await f.catalog.record(finished(foreign.id,'e'.repeat(16)));
 const present=[container.binding.base.imageId,container.binding.dependencies.imageId,foreign.binding.dependencies.imageId];
 const fake=spyOn(transport,'run').mockImplementation(async args=>{
  if(args.includes('ls'))return present.join('\n');if(args.includes('ps'))return container.binding.dependencies.imageId;
  if(args.includes('inspect')){const id=args.at(-1)!;return JSON.stringify([{Id:id,Config:{Labels:{'dev.hicode.environment':id.slice(7)}},RepoTags:['external:keep']}]);}
  throw Error('Unexpected image deletion');
 });
 try{
  const result=await collectResources(f.config,f.catalog,[],true);
  expect(result.deleted).toEqual([]);expect(result.candidates).toEqual([]);
  expect(result.blocked.map(b=>b.reason)).toEqual(['Container reference','External image tag']);
  expect(f.catalog.get(container.dataset,container.id).status).toBe('passed');
  expect(f.catalog.get(foreign.dataset,foreign.id).status).toBe('passed');
 }finally{fake.mockRestore();await f.cleanup();}
});

test('active or uncertain runs prevent any cleanup, unavailable engines do not turn ready into evicted',async()=>{
 const f=await fixture();await seed(f,'one');const fake=spyOn(transport,'run').mockRejectedValue(Error('engine offline'));
 try{
  const active=runSchema.parse({...finished('one'),state:'needs_recovery'});
  await expect(collectResources(f.config,f.catalog,[active],true)).rejects.toThrow('fully recovered');expect(fake).not.toHaveBeenCalled();
  const result=await collectResources(f.config,f.catalog,[],true);expect(result.blocked).toHaveLength(1);expect(f.catalog.get('terminal-bench-2.1','one').environment).toBe('ready');
 }finally{fake.mockRestore();await f.cleanup();}
});

test('passed log archives are readable, corruption stops cleanup, and small terminal records remain',async()=>{
 const f=await fixture(),state=finished('one'),path=f.layout.run(state.id);
 try{
  await mkdir(join(path,'evidence/home'),{recursive:true});await writeFile(join(path,'evidence/home/model-log.txt'),'saved response');await mkdir(join(path,'task/one'),{recursive:true});await writeFile(join(path,'task/one/instruction.md'),'task');await mkdir(join(path,'live'));await writeFile(join(path,'live/screen.txt'),'final screen');
  await transport.save(join(path,'collection.json'),{complete:true,files:await transport.runEvidenceTree(join(path,'evidence'))});await transport.save(join(path,'container-disposed.json'),{version:1,runId:state.id,at:new Date().toISOString()});
  await archivePassedRun(f.layout,state);
  expect(await transport.exists(join(path,'evidence'))).toBe(false);expect(await readFile(join(path,'live/screen.txt'),'utf8')).toBe('final screen');
  const saved=await transport.run(['tar','-xOf',join(path,'evidence.tar.gz'),'evidence/home/model-log.txt']);expect(saved).toBe('saved response');
  await writeFile(join(path,'evidence.tar.gz'),'corrupt');await mkdir(join(path,'evidence'));await writeFile(join(path,'evidence/keep.txt'),'keep');
  await expect(archivePassedRun(f.layout,state)).rejects.toThrow('identity');expect(await readFile(join(path,'evidence/keep.txt'),'utf8')).toBe('keep');
 }finally{await f.cleanup();}
});

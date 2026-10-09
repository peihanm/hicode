import {test,expect} from 'bun:test';
import {mkdtemp,realpath,rm,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TaskCatalog} from '../src/host/catalog.js';
import {archiveRuns} from '../src/host/archive.js';
import {runSchema,batchSchema} from '../src/host/types.js';
import {save,exists} from '../src/host/store.js';

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-catalog-'))),data=join(root,'runs-data'),catalogPath=join(root,'catalog.json');
  await mkdir(join(data,'runs'),{recursive:true});await mkdir(join(data,'batches'));
  await save(catalogPath,{version:1,updatedAt:'2026-10-02T00:00:00.000Z',tasks:[{id:'task',dataset:'terminal-bench',status:'untested',results:[]}]});
  const catalog=await TaskCatalog.open(catalogPath);
  const run=runSchema.parse({version:2,id:'a'.repeat(16),batchId:'b'.repeat(16),task:'task',dataset:'terminal-bench',state:'passed',network:'isolated',createdAt:1,updatedAt:2,startedAt:1,finishedAt:2,model:'fake',budget:{},execution:'completed',grading:'passed',collection:'complete'});
  return {root,data,catalogPath,catalog,run,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('task results survive run cleanup; queue-only cancellation is still untested',async()=>{
  const f=await fixture();
  try {
    await f.catalog.record({...f.run,state:'cancelled',execution:'cancelled',grading:'pending',startedAt:undefined});
    expect(f.catalog.get('terminal-bench','task').status).toBe('untested');
    await f.catalog.record(f.run);
    await f.catalog.record({...f.run,id:'c'.repeat(16),state:'failed',grading:'failed'});
    expect(f.catalog.get('terminal-bench','task').status).toBe('passed');
    expect((await TaskCatalog.open(f.catalogPath)).get('terminal-bench','task').results).toHaveLength(2);
  }finally{await f.cleanup();}
});

test('accepted recheck is preserved when the original failed run is recorded again',async()=>{
  const f=await fixture();
  try {
    await f.catalog.record(f.run);
    await f.catalog.record({...f.run,state:'failed',grading:'failed'});
    expect(f.catalog.get('terminal-bench','task').results[0]).toMatchObject({grading:'failed',accepted:true});
    expect(f.catalog.get('terminal-bench','task').status).toBe('passed');
  }finally{await f.cleanup();}
});

test('the same upstream task ID has independent results in two dataset releases',async()=>{
  const f=await fixture();
  try {
    await f.catalog.register([{id:'task',dataset:'terminal-bench-2.1',source:join(f.root,'new-task')}]);
    await f.catalog.record({...f.run,dataset:'terminal-bench-2.1'});
    expect(f.catalog.get('terminal-bench','task').status).toBe('untested');
    expect(f.catalog.get('terminal-bench-2.1','task').status).toBe('passed');
    expect((await TaskCatalog.open(f.catalogPath)).counts()).toMatchObject({total:2,passed:1,untested:1});
  }finally{await f.cleanup();}
});

test('historical Terminal-Bench 2.0 results remain readable but new registration is rejected',async()=>{
  const f=await fixture();
  try{
    await f.catalog.record(f.run);
    await expect(f.catalog.register([{id:'new',dataset:'terminal-bench',source:join(f.root,'new')}]))
      .rejects.toThrow('Terminal-Bench 2.0 registration is retired');
    expect((await TaskCatalog.open(f.catalogPath)).get('terminal-bench','task').status).toBe('passed');
    expect((await TaskCatalog.open(f.catalogPath)).counts().total).toBe(1);
  }finally{await f.cleanup();}
});

async function persist(f:Awaited<ReturnType<typeof fixture>>){
  await f.catalog.record(f.run);
  await save(join(f.data,'runs',f.run.id,'state.json'),f.run);
  await save(join(f.data,'batches',f.run.batchId+'.json'),batchSchema.parse({version:2,id:f.run.batchId,name:'fixture',network:'isolated',taskRefs:[{dataset:'terminal-bench',id:'task'}],runIds:[f.run.id],budget:{},concurrency:1,createdAt:1,model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED_KEY',baseUrl:'https://offline.invalid/v1'},payload:{}}));
}

test('archive keeps final patch and grading evidence before deleting the finished batch',async()=>{
  const f=await fixture();
  try {
    await persist(f);
    const path=join(f.data,'runs',f.run.id);
    await save(join(path,'evidence/prediction.json'),{model_patch:'preserved patch'});
    await save(join(path,'grading-correction.json'),{before:{grading:'unavailable'},grading:'failed',testsRerun:false});
    await mkdir(join(path,'evidence/logs/verifier'),{recursive:true});
    await writeFile(join(path,'evidence/logs/verifier/parsed-output.txt'),'canonical test outcome');
    await mkdir(join(path,'evidence/artifacts'),{recursive:true});
    await writeFile(join(path,'evidence/artifacts/model.patch'),'committed diff');
    await save(join(path,'evidence/logs/verifier/reward.json'),{reward:0});
    await writeFile(join(path,'evidence/logs/verifier/test-stdout.txt'),'x'.repeat(2*1024*1024)+'verifier tail');
    await writeFile(join(path,'large-disposable-log'),'transient output');
    expect(await archiveRuns(f.data,f.catalogPath,false)).toMatchObject({runs:1,batches:1,applied:false});
    expect(await exists(path)).toBe(true);
    const result=await archiveRuns(f.data,f.catalogPath,true);
    expect(await exists(path)).toBe(false);
    expect(JSON.parse(await readFile(join(result.archive,f.run.id,'evidence/prediction.json'),'utf8')).model_patch).toBe('preserved patch');
    expect(JSON.parse(await readFile(join(result.archive,f.run.id,'grading-correction.json'),'utf8')).testsRerun).toBe(false);
    expect(await readFile(join(result.archive,f.run.id,'evidence/logs/verifier/parsed-output.txt'),'utf8')).toBe('canonical test outcome');
    expect(await readFile(join(result.archive,f.run.id,'evidence/artifacts/model.patch'),'utf8')).toBe('committed diff');
    expect(JSON.parse(await readFile(join(result.archive,f.run.id,'evidence/logs/verifier/reward.json'),'utf8'))).toEqual({reward:0});
    const tail=await readFile(join(result.archive,f.run.id,'evidence/logs/verifier/test-stdout.txt'),'utf8');
    expect(tail.length).toBe(1024*1024);expect(tail.endsWith('verifier tail')).toBe(true);
    expect((await TaskCatalog.open(f.catalogPath)).counts()).toMatchObject({passed:1});
    expect(await exists(join(f.data,'batches',f.run.batchId+'.json'))).toBe(false);
  }finally{await f.cleanup();}
});

test('archive retains large prediction metadata without truncating the patch',async()=>{
  const f=await fixture();
  try {
    await persist(f);
    const prediction=join(f.data,'runs',f.run.id,'evidence/prediction.json');
    const original='{"model_patch":"'+'x'.repeat(53*1024*1024)+'"}';
    await mkdir(join(f.data,'runs',f.run.id,'evidence'),{recursive:true});
    await writeFile(prediction,original);
    const result=await archiveRuns(f.data,f.catalogPath,true);
    const archived=await readFile(join(result.archive,f.run.id,'evidence/prediction.json'),'utf8');
    expect(archived).toBe(original);
    expect(await exists(join(f.data,'runs',f.run.id))).toBe(false);
  }finally{await f.cleanup();}
});

test('active batches and redirected evidence cannot be purged',async()=>{
  const f=await fixture();
  try {
    await persist(f);const path=join(f.data,'runs',f.run.id);
    await save(join(path,'state.json'),{...f.run,state:'running'});
    expect(await archiveRuns(f.data,f.catalogPath,true)).toMatchObject({runs:0});
    expect(await exists(path)).toBe(true);
    await save(join(path,'state.json'),f.run);
    await mkdir(join(path,'evidence'));await writeFile(join(f.root,'private'),'private');
    await symlink(join(f.root,'private'),join(path,'evidence/prediction.json'));
    await expect(archiveRuns(f.data,f.catalogPath,true)).rejects.toThrow();
    expect(await exists(path)).toBe(true);
    expect(await readFile(join(f.root,'private'),'utf8')).toBe('private');
  }finally{await f.cleanup();}
});

test('interrupted deletion resumes only after revalidating the compact archive',async()=>{
  const f=await fixture();
  try {
    await persist(f);const result=await archiveRuns(f.data,f.catalogPath,true);
    const path=join(f.data,'runs',f.run.id);await mkdir(path);await writeFile(join(path,'leftover'),'unfinished deletion');
    await save(join(f.data,'.archive-cleanup.json'),{version:1,catalog:f.catalogPath,runs:[f.run.id],batches:[f.run.batchId]});
    const archived=join(result.archive,f.run.id,'state.json'),original=await readFile(archived);
    await writeFile(archived,'changed');
    await expect(archiveRuns(f.data,f.catalogPath,true)).rejects.toThrow('Archived evidence changed');
    expect(await exists(path)).toBe(true);
    await writeFile(archived,original);
    expect(await archiveRuns(f.data,f.catalogPath,true)).toMatchObject({runs:1,applied:true});
    expect(await exists(path)).toBe(false);
    expect(await exists(join(f.data,'.archive-cleanup.json'))).toBe(false);
  }finally{await f.cleanup();}
});

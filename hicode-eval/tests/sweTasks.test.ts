import {seedCatalog} from './helpers/catalog.js';
import {expect,test,beforeEach,afterEach,spyOn} from 'bun:test';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tree,save} from '../src/host/store.js';
import {validateSweTask,sweCatalog,sweTaskSchema} from '../src/host/sweTasks.js';
import {Lab} from '../src/host/manager.js';
import {configSchema} from '../src/host/types.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {environmentFixture} from './helpers/catalog.js';

let environment:ReturnType<typeof spyOn>;
beforeEach(()=>{environment=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environmentFixture('swe-bench-verified:fixture'));});
afterEach(()=>environment.mockRestore());

test('SWE bundles freeze original identity and split public code from private grading data',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-task-'))),id='django__django-15731',task=join(root,id);
 try {
  await mkdir(join(task,'repository/.git/hooks'),{recursive:true});await mkdir(join(task,'hidden'));
  await writeFile(join(task,'repository/example.py'),'public code');await writeFile(join(task,'instruction.md'),'public problem');
  await writeFile(join(task,'hidden/evaluation.json'),'hidden tests');
  const files=Object.fromEntries(Object.entries(await tree(task)).map(([name,file])=>[name,file.sha256]));
  const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:'4.2',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files,evaluationMode:'shared-linux-development'};
  await save(join(task,'swe-task.json'),descriptor);
  expect((await sweCatalog(root))[0]?.id).toBe(id);expect((await validateSweTask(id,task)).baseCommit).toBe('a'.repeat(40));
  // Directory removal does not alter the frozen file hashes. Reject this before
  // any batch is scheduled, instead of failing all Actors at their sandbox probe.
  await rm(join(task,'repository/.git/hooks'),{recursive:true});
  await expect(validateSweTask(id,task)).rejects.toThrow('repository/.git/hooks');
  await mkdir(join(task,'repository/.git/hooks'));
  expect((await validateSweTask(id,task)).baseCommit).toBe('a'.repeat(40));
  await expect(validateSweTask('django__django-99999',task)).rejects.toThrow('identity');
  expect(()=>sweTaskSchema.parse({...descriptor,harnessVersion:'5.0.2'})).toThrow();
  const terminal=join(root,'terminal');await mkdir(terminal);
  const payload=join(root,'payload');await mkdir(payload);await save(join(payload,'manifest.json'),{});
  const config=configSchema.parse({version:4,data:join(root,'data'),catalog:join(root,'catalog.json'),environments:join(root,'environments'),payload,context:'unused',machine:'eval',concurrency:2,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'TEST_KEY',baseUrl:'https://example.com'}});
  // root now also contains helper dirs; restrict catalog to its intended registry.
  const registry=join(root,'registry');await mkdir(registry);
  const {rename,symlink}=await import('node:fs/promises');await rename(task,join(registry,id));
  await seedCatalog(config,[{id,source:join(registry,id),dataset:'swe-bench-verified'}]);
  await symlink('/etc/passwd',join(registry,id,'repository/escape'));
  await expect(validateSweTask(id,join(registry,id))).rejects.toThrow('escapes');
  await rm(join(registry,id,'repository/escape'));
  const lab=new Lab(config,'unused');await lab.init();
  const batch=await lab.submit({name:'SWE pilot',tasks:[{id,agentSeconds:1800}],concurrency:2});
  expect(lab.runs.get(batch.runIds[0]!)?.dataset).toBe('swe-bench-verified');
  await lab.close();
  await writeFile(join(registry,id,'instruction.md'),'changed problem');
  await expect(validateSweTask(id,join(registry,id))).rejects.toThrow('snapshot');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('mixed submission under CLI umask preserves links and executable bits and runs at concurrency five',async()=>{
 const {spyOn}=await import('bun:test');
 const {symlink,chmod}=await import('node:fs/promises');
 const {LinuxMachine}=await import('../src/host/linux.js');
 const adapters=await import('../src/host/publicTasks.js');
 const {sweTree}=await import('../src/host/sweTasks.js');
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-mixed-submit-')));
 const prior=process.umask(0o077);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
 const validate=spyOn(adapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{}});
 let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,peak=0;
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async()=>{
  peak=Math.max(peak,++active);await gate;active--;return {type:'result',execution:'completed',grading:'passed',uid:20001};
 });
 let lab:Lab|undefined;
 try {
  const terminal=join(root,'terminal'),registry=join(root,'swe'),payload=join(root,'payload');
  await mkdir(terminal);await mkdir(registry);await mkdir(payload);await save(join(payload,'manifest.json'),{});
  const ids=['django__django-14725','django__django-14787','django__django-15863','django__django-16136'];
  for(const id of ids){
   const task=join(registry,id);await mkdir(join(task,'repository/.git/hooks'),{recursive:true});await mkdir(join(task,'hidden'));
   await writeFile(join(task,'repository/script'),'#!/bin/sh\nexit 0\n');await chmod(join(task,'repository/script'),0o755);
   await writeFile(join(task,'instruction.md'),'Public problem');await writeFile(join(task,'hidden/evaluation.json'),'Private fixture');
   await symlink('script',join(task,'repository/link'));
   const files=Object.fromEntries(Object.entries(await sweTree(task)).map(([path,file])=>[path,file.sha256]));
   await save(join(task,'swe-task.json'),{kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:id.startsWith('django__django-147')?'4.1':'4.2',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files,evaluationMode:'shared-linux-development'});
  }
  for(const id of ['regex-log','cancel-async-tasks']){
   await mkdir(join(terminal,id));await writeFile(join(terminal,id,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
  }
  const config=configSchema.parse({version:4,data:join(root,'data'),catalog:join(root,'catalog.json'),environments:join(root,'environments'),payload,context:'unused',machine:'fixture',concurrency:5,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'TEST_KEY',baseUrl:'https://example.com'}});
  await seedCatalog(config,[...ids.map(id=>({id,source:join(registry,id),dataset:'swe-bench-verified' as const})),...['regex-log','cancel-async-tasks'].map(id=>({id,source:join(terminal,id)}))]);
  lab=new Lab(config,'fixture');await lab.init();await lab.prepareMachine();
  const batch=await lab.submit({name:'mixed freeze',concurrency:5,tasks:['regex-log',...ids,'cancel-async-tasks'].map(id=>({id,agentSeconds:3600}))});
  for(let i=0;i<100&&execute.mock.calls.length<5;i++)await Bun.sleep(5);
  expect(execute).toHaveBeenCalledTimes(5);expect(peak).toBe(5);expect(batch.runIds).toHaveLength(6);
  const frozen=await sweTree(join(lab.path(batch.runIds[1]!),'task',ids[0]));
  expect(frozen).toEqual(await sweTree(join(registry,ids[0])));
  release();
  for(let i=0;i<100&&batch.runIds.some(id=>lab!.runs.get(id)?.state!=='passed');i++)await Bun.sleep(5);
  expect(execute).toHaveBeenCalledTimes(6);expect(peak).toBe(5);
  expect(batch.runIds.every(id=>lab!.runs.get(id)?.state==='passed')).toBe(true);
 }finally{release();await lab?.close();process.umask(prior);prepare.mockRestore();dispose.mockRestore();validate.mockRestore();execute.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('SWE version contract accepts only reviewed repository versions',()=>{
 expect(sweTaskSchema.shape.version.parse('4.0')).toBe('4.0');
 expect(sweTaskSchema.shape.version.parse('4.1')).toBe('4.1');
 expect(sweTaskSchema.shape.version.parse('4.2')).toBe('4.2');
 expect(sweTaskSchema.shape.version.parse('5.0')).toBe('5.0');
 for(const version of ['0.20','0.21','0.22','3.5','3.6','3.7','1.0','1.1','1.2','1.4','1.5','1.6','1.7','1.8','1.9','1.10','1.11','1.12','0.12','4.5','4.6','5.1','5.2','5.4','6.0','6.2','6.3','7.2','2022.03','2022.06','2022.09'] as const)expect(sweTaskSchema.shape.version.parse(version)).toBe(version);
 expect(sweTaskSchema.shape.python.parse('3.8')).toBe('3.8');
 expect(sweTaskSchema.shape.python.parse('3.7')).toBe('3.7');
 expect(sweTaskSchema.shape.python.parse('3.11')).toBe('3.11');
 expect(sweTaskSchema.shape.python.parse('3.10')).toBe('3.10');
 expect(sweTaskSchema.shape.version.safeParse('5.3').success).toBe(false);
 expect(sweTaskSchema.shape.version.safeParse('1.13').success).toBe(false);
});

test('Django 5.0 requires Python 3.11 before catalog or submission',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-python-')));
 const id='django__django-16485',task=join(root,id);
 try {
  await mkdir(task);
  const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:'5.0',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
  await save(join(task,'swe-task.json'),descriptor);
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await expect(validateSweTask(id,task)).rejects.toThrow('supported repository environment');
  await save(join(task,'swe-task.json'),{...descriptor,python:'3.11'});
  expect((await sweCatalog(root)).map(entry=>entry.id)).toEqual([id]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('SWE catalog ties each repository identity to its reviewed Python version',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-repos-')));
 try {
  const base={kind:'swe-bench-verified',revision:'c'.repeat(40),baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',
   environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),verifierSeconds:1800,baselineCommit:'b'.repeat(40),
   files:{},evaluationMode:'shared-linux-development'};
  const django='django__django-14007',sympy='sympy__sympy-12345',pytest='pytest-dev__pytest-10081',xarray='pydata__xarray-3095';
  for(const id of [django,sympy,pytest,xarray])await mkdir(join(root,id));
  await save(join(root,django,'swe-task.json'),{...base,instanceId:django,repo:'django/django',version:'4.0',python:'3.8'});
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version:'1.4',python:'3.6'});
  await save(join(root,pytest,'swe-task.json'),{...base,instanceId:pytest,repo:'pytest-dev/pytest',version:'7.2',python:'3.9'});
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.10'});
  expect((await sweCatalog(root)).map(entry=>entry.id).sort()).toEqual([django,pytest,sympy,xarray].sort());
  for(const version of ['1.0','1.1','1.2','1.4','1.5','1.6']){
   await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version,python:'3.9'});
   await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
   await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version,python:'3.6'});
   expect((await sweCatalog(root)).some(entry=>entry.id===sympy)).toBe(true);
  }
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version:'1.7',python:'3.9'});
  expect((await sweCatalog(root)).some(entry=>entry.id===sympy)).toBe(true);
  for(const version of ['4.5','4.6','6.3']){
   await save(join(root,pytest,'swe-task.json'),{...base,instanceId:pytest,repo:'pytest-dev/pytest',version,python:'3.6'});
   await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
   await save(join(root,pytest,'swe-task.json'),{...base,instanceId:pytest,repo:'pytest-dev/pytest',version,python:'3.9'});
   expect((await sweCatalog(root)).some(entry=>entry.id===pytest)).toBe(true);
  }
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.9'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.10'});
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version:'4.0',python:'3.8'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'django/django',version:'4.0',python:'3.8'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
 }finally{await rm(root,{recursive:true,force:true});}
});


test('Sphinx catalog enforces reviewed versions and original Python 3.9',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-sphinx-catalog-')));
 const id='sphinx-doc__sphinx-10614',path=join(root,id);
 try {
  await mkdir(path);
  const base={kind:'swe-bench-verified',instanceId:id,repo:'sphinx-doc/sphinx',version:'7.2',
   revision:'c'.repeat(40),baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',
   environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),verifierSeconds:1800,
   baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
  for(const version of ['3.0','3.1','3.2','3.3','3.4','3.5','4.0','4.1','4.2','4.3','5.0','5.1','5.2','7.1','7.2']) {
   await save(join(path,'swe-task.json'),{...base,version,python:'3.9'});
   expect((await sweCatalog(root))[0]?.id).toBe(id);
  }
  await save(join(path,'swe-task.json'),{...base,python:'3.11'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(path,'swe-task.json'),{...base,version:'6.2',python:'3.9'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Django 3.0 through 3.2 retain their original Python 3.6 contract',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-django32-')));
 const id='django__django-12754',path=join(root,id);
 try{
  await mkdir(path);
  const base={kind:'swe-bench-verified',instanceId:id,repo:'django/django',version:'3.2',
   revision:'c'.repeat(40),baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',
   environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),verifierSeconds:1800,
   baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
  for (const version of ['3.0','3.1','3.2']) {
   await save(join(path,'swe-task.json'),{...base,version,python:'3.6'});
   expect((await sweCatalog(root))[0]?.id).toBe(id);
   await save(join(path,'swe-task.json'),{...base,version,python:'3.9'});
   await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('additional repositories accept only reviewed repo/version/Python combinations',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-additional-repos-')));
 const pairs=[
  ['astropy/astropy','1.3','3.6'],['astropy/astropy','3.1','3.9'],['astropy/astropy','4.3','3.9'],['astropy/astropy','5.0','3.9'],['astropy/astropy','5.1','3.9'],['astropy/astropy','5.2','3.9'],
  ...['0.20','0.21','0.22'].map(version=>['scikit-learn/scikit-learn',version,'3.6']),
  ['scikit-learn/scikit-learn','1.3','3.9'],['mwaskom/seaborn','0.12','3.9'],
  ['pallets/flask','2.3','3.11'],
  ...['2.9','2.10','2.14','2.15','3.0'].map(version=>['pylint-dev/pylint',version,'3.9']),
  ...['1.1','2.0','2.3','2.4','2.9','2.26','2.27'].map(version=>['psf/requests',version,'3.9']),
 ];
 try{
  for(const [repo,version,python] of pairs){
   const id=repo!.replace('/','__')+'-12345',path=join(root,id);await mkdir(path,{recursive:true});
   const base={kind:'swe-bench-verified',instanceId:id,repo,version,python,
    revision:'c'.repeat(40),baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',
    environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),verifierSeconds:1800,
    baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
   await save(join(path,'swe-task.json'),base);
   expect((await sweCatalog(root)).some(task=>task.id===id)).toBe(true);
   await save(join(path,'swe-task.json'),{...base,python:python==='3.6'?'3.9':'3.6'});
   await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
   await save(join(path,'swe-task.json'),{...base,version:'7.2'});
   await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
   await rm(path,{recursive:true});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Xarray submission rejects absent, skipped and wrong-environment public preflight proofs',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-xarray-ready-'))),id='pydata__xarray-4094';
 try {
  await mkdir(join(root,'repository/.git/hooks'),{recursive:true});await mkdir(join(root,'hidden'));
  await writeFile(join(root,'repository/public.py'),'# original source');
  await writeFile(join(root,'instruction.md'),'public problem');await writeFile(join(root,'hidden/evaluation.json'),'{}');
  const environment='/opt/hicode-swe/cache/'+'c'.repeat(64),baseCommit='a'.repeat(40);
  await save(join(root,'repository/.git/hicode-source-version.json'),{baseCommit,describe:'v0.15.1-10-gaaaaaaa',version:'0.15.2.dev10+gaaaaaaa'});
  const saveTask=async()=>save(join(root,'swe-task.json'),{
    kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'pydata/xarray',version:'0.12',
    baseCommit,harnessVersion:'4.1.0',environment,python:'3.10',verifierSeconds:1800,
    baselineCommit:'b'.repeat(40),evaluationMode:'shared-linux-development',
    files:Object.fromEntries(Object.entries(await tree(root)).filter(([name])=>name!=='swe-task.json').map(([name,file])=>[name,file.sha256])),
  });
  await saveTask();await expect(validateSweTask(id,root)).rejects.toThrow();
  for(const proof of [
    {sourceCommit:baseCommit,environment,passed:false,checked:0},
    {sourceCommit:baseCommit,environment:'/opt/hicode-swe/cache/'+'b'.repeat(64),passed:true,checked:10},
    {sourceCommit:baseCommit,environment,passed:true,checked:0},
  ]){
    await save(join(root,'repository/.git/hicode-env-preflight.json'),proof);await saveTask();
    await expect(validateSweTask(id,root)).rejects.toThrow();
  }
  await save(join(root,'repository/.git/hicode-env-preflight.json'),{sourceCommit:baseCommit,environment,passed:true,checked:10});
  await saveTask();expect((await validateSweTask(id,root)).instanceId).toBe(id);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('Matplotlib 3.5 requires the reviewed Python 3.11 environment',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-matplotlib-contract-'))),id='matplotlib__matplotlib-24026';
 try{
  const path=join(root,id);await mkdir(path);
  const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'matplotlib/matplotlib',version:'3.5',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
  await save(join(path,'swe-task.json'),descriptor);await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(path,'swe-task.json'),{...descriptor,python:'3.11'});expect((await sweCatalog(root))[0]!.id).toBe(id);
  await save(join(path,'swe-task.json'),{...descriptor,version:'3.4',python:'3.8'});expect((await sweCatalog(root))[0]!.id).toBe(id);
  await save(join(path,'swe-task.json'),{...descriptor,version:'3.4',python:'3.11'});await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(path,'swe-task.json'),{...descriptor,version:'3.0',python:'3.7'});expect((await sweCatalog(root))[0]!.id).toBe(id);
 }finally{await rm(root,{recursive:true,force:true});}
});

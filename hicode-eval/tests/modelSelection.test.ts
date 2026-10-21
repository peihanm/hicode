import {test,expect,spyOn} from 'bun:test';
import {join} from 'node:path';
import {fixture,seed} from './helpers/root.js';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import * as publicTasks from '../src/host/publicTasks.js';
import {publicTaskProfile} from '../src/host/publicTasks.js';
import {save,readJson} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import {batchSchema,settingsSchema,submissionSchema} from '../src/host/types.js';
import {loadModelCredentials} from '../src/host/modelCredentials.js';

async function until(check:()=>boolean){
 const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Fixture did not settle');await Bun.sleep(5);}
}
const alternate={source:'ark-agent-plan' as const,model:'glm-5.3-flash',apiKeyEnv:'GLM_FIXTURE_KEY',baseUrl:'https://ark.invalid/plan/v3',reasoning:{effort:'max' as const}};

test('configured models share one concurrency limit and keep distinct credentials, manifests and retry identity across restart',async()=>{
 const f=await fixture(),a=await seed(f,'a','c'),b=await seed(f,'b','d'),c=await seed(f,'c','e');
 f.config.concurrency=2;
 f.config.model={...f.config.model,model:'qwen3.8-flash',reasoning:{effort:'xhigh'}};
 f.config.models=[alternate];
 const keys=new Map([[f.config.model.apiKeyEnv,'qwen-fixture-secret'],[alternate.apiKeyEnv,'glm-fixture-secret']]);
 const lab=new Lab(f.config,keys);let restarted:Lab|undefined;
 const releases=new Map<string,()=>void>(),seen:Array<{task:string;model:string;key:string;effort:string|undefined}>=[];
 let active=0,peak=0,hold=true;
 await save(join(f.layout.payload,'manifest.json'),{});
 const validate=spyOn(publicTasks,'validatePublicTask').mockImplementation(async(id)=>publicTaskProfile({[id]:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none'}},id));
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockImplementation(async task=>[a,b,c].find(item=>item.id===task.id)!.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async(state,path,key,phase,model)=>{
  active++;peak=Math.max(peak,active);seen.push({task:state.task,model:model.model,key,effort:model.reasoning?.effort});
  const manifest=await readJson(join(path,'manifest.json'),batchSchema.pick({model:true}).passthrough());
  expect(manifest.model).toEqual(model);
  expect(JSON.stringify(manifest)).not.toContain('fixture-secret');
  await phase('Running HiCode');
  if(hold)await new Promise<void>(done=>releases.set(state.task,done));
  active--;return {type:'result',execution:'completed',grading:'failed',uid:20000};
 });
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockImplementation(async id=>{await save(join(f.layout.run(id),'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});});
 const boundary=spyOn(transport,'run').mockResolvedValue([a.binding.base.imageId,...[a,b,c].map(t=>t.binding.dependencies.imageId)].join('\n'));
 try{
  await lab.init();
  const first=await lab.submit({name:'personal',concurrency:1,tasks:[{dataset:a.dataset,id:a.id}]});
  const second=await lab.submit({name:'plan',model:{source:alternate.source,model:alternate.model},concurrency:1,tasks:[{dataset:b.dataset,id:b.id}]});
  await until(()=>releases.size===2);
  const third=await lab.submit({name:'queued',concurrency:1,tasks:[{dataset:c.dataset,id:c.id}]});
  expect(lab.runs.get(third.runIds[0]!)?.state).toBe('queued');
  expect(first.model.source).toBe('qwen');expect(first.model.reasoning?.effort).toBe('xhigh');
  expect(second.model.source).toBe('ark-agent-plan');expect(second.model.reasoning?.effort).toBe('max');
  expect(seen.find(x=>x.task==='a')?.key).toBe('qwen-fixture-secret');
  expect(seen.find(x=>x.task==='b')?.key).toBe('glm-fixture-secret');
  releases.get('b')!();await until(()=>releases.has('c'));
  releases.get('a')!();releases.get('c')!();hold=false;
  await until(()=>[...lab.runs.values()].every(r=>r.state==='failed'));
  expect(peak).toBe(2);expect(JSON.stringify(await lab.snapshot())).not.toContain('fixture-secret');
  await lab.close();
  const originalQwen=f.config.model;f.config.model=alternate;f.config.models=[{...originalQwen,reasoning:{effort:'off'}}];
  restarted=new Lab(f.config,keys);await restarted.init();
  const retried=await restarted.retry(first.runIds[0]!);
  await until(()=>restarted!.runs.get(retried.runIds[0]!)?.state==='failed');
  expect(retried.model).toEqual(first.model);
  expect(seen.at(-1)).toMatchObject({model:'qwen3.8-flash',key:'qwen-fixture-secret',effort:'xhigh'});
 }finally{
  hold=false;for(const release of releases.values())release();await restarted?.close();await lab.close();
  validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();boundary.mockRestore();await f.cleanup();
 }
});

test('unknown models, invalid reasoning, missing credentials and connection overrides fail before publishing runs',async()=>{
 const f=await fixture(),task=await seed(f,'fixture');f.config.models=[alternate];
 const lab=new Lab(f.config,new Map([[f.config.model.apiKeyEnv,'default-fixture']]));
 const input={name:'reject',concurrency:1,tasks:[{dataset:task.dataset,id:task.id}]};
 try{
  await lab.init();
  await expect(lab.submit({...input,model:{source:'qwen',model:'not-configured'}})).rejects.toThrow('configured');
  await expect(lab.submit({...input,model:{source:alternate.source,model:alternate.model},reasoning:{effort:'xhigh'}})).rejects.toThrow('not supported');
  await expect(lab.submit({...input,model:{source:alternate.source,model:alternate.model}})).rejects.toThrow('Missing provider credential');
  expect(submissionSchema.safeParse({...input,model:{source:alternate.source,model:alternate.model,baseUrl:'https://untrusted.invalid',apiKeyEnv:'OTHER_SECRET'}}).success).toBe(false);
  expect(lab.batches.size).toBe(0);expect(lab.runs.size).toBe(0);
  const duplicate=settingsSchema.safeParse({...await readJson(f.layout.settings,settingsSchema),models:[f.config.model]});
  expect(duplicate.success).toBe(false);
  if(!duplicate.success)expect(duplicate.error.issues.some(issue=>issue.message==='Duplicate source/model connection')).toBe(true);
 }finally{await lab.close();await f.cleanup();}
});

test('worker credential loading uses environment then project then user files for configured names only',async()=>{
 const f=await fixture(),project=join(f.layout.builds,'project.env'),user=join(f.layout.builds,'user.env');
 try{
  await Bun.write(project,'UNUSED=project-key\nGLM_FIXTURE_KEY=project-glm\nUNDECLARED=do-not-load\n');
  await Bun.write(user,'UNUSED=user-key\nGLM_FIXTURE_KEY=user-glm\n');
  const keys=await loadModelCredentials([f.config.model,alternate],{UNUSED:'environment-key'},[join(f.layout.builds,'missing.env'),project,user]);
  expect([...keys]).toEqual([['UNUSED','environment-key'],['GLM_FIXTURE_KEY','project-glm']]);
  const fallback=await loadModelCredentials([f.config.model,alternate],{},[join(f.layout.builds,'missing.env'),user]);
  expect([...fallback]).toEqual([['UNUSED','user-key'],['GLM_FIXTURE_KEY','user-glm']]);
 }finally{await f.cleanup();}
});

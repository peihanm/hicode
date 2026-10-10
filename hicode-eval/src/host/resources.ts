import {readdir,mkdir,rm,lstat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EvalLayout} from './layout.js';
import {TaskCatalog} from './catalog.js';
import {bindingSchema,environmentBindingPath} from './environments.js';
import {taskKey,taskRefSchema} from './datasets.js';
import {run,readJson,save,exists,runEvidenceTree} from './store.js';
import {done} from './types.js';
import type {Config,Run} from './types.js';
import {EVAL_ROOT} from '../paths.js';
import {isDeepStrictEqual} from 'node:util';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const archiveSchema=z.object({version:z.literal(1),runId:z.string(),sha256:digest,entries:z.array(z.string())}).strict();
async function sha256(path:string){
  const fd=await open(path,'r');const hash=createHash('sha256');
  try{for(;;){const bytes=Buffer.alloc(65536);const n=(await fd.read(bytes)).bytesRead;if(!n)break;hash.update(bytes.subarray(0,n));}}
  finally{await fd.close();}return hash.digest('hex');
}

/** Keep the UI's small records and a verified archive; delete only disposable copies. */
export async function archivePassedRun(layout:EvalLayout,state:Run){
  if(state.state!=='passed'||state.execution!=='completed'||state.grading!=='passed'||state.collection!=='complete')return;
  const path=layout.run(state.id),receipt=join(path,'archive.json'),archive=join(path,'evidence.tar.gz');
  await readJson(join(path,'container-disposed.json'),z.object({version:z.literal(1),runId:z.literal(state.id),at:z.string().datetime()}).strict());
  let record:z.infer<typeof archiveSchema>;
  if(await exists(receipt)){
    record=await readJson(receipt,archiveSchema);
    if(record.runId!==state.id||await sha256(archive)!==record.sha256)throw Error('Run archive identity mismatch');
  }else{
    const sealed=await readJson(join(path,'collection.json'),z.object({complete:z.literal(true),files:z.record(z.unknown())}),32*1024*1024);
    if(!isDeepStrictEqual(await runEvidenceTree(join(path,'evidence')),sealed.files))throw Error('Run evidence changed before archiving');
    const entries:string[]=[];
    for(const name of ['evidence','task','inputs','public-test-inputs','worker']){
      const p=join(path,name);if(!await exists(p))continue;
      const stat=await lstat(p);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid archive source');entries.push(name);
    }
    await run(['tar','-czf',archive+'.tmp',...entries],{cwd:path,timeout:180000});
    await run(['python3','-B',join(EVAL_ROOT,'src/host/verify_archive.py'),archive+'.tmp'],{timeout:180000});
    const {rename}=await import('node:fs/promises');await rename(archive+'.tmp',archive);
    record={version:1,runId:state.id,sha256:await sha256(archive),entries};await save(receipt,record);
  }
  for(const name of record.entries){
    if(!['evidence','task','inputs','public-test-inputs','worker'].includes(name))throw Error('Unexpected archived entry');
    await rm(join(path,name),{recursive:true,force:true});
  }
}

/** Only the worker or an offline holder of the service lease may reclaim resources. */
export async function collectResources(config:Config,catalog:TaskCatalog,runs:readonly Run[],apply:boolean){
  const layout=new EvalLayout(config.data);await layout.assert();
  if(runs.some(r=>!done(r.state)||r.state==='needs_recovery'))throw Error('Resource cleanup requires an idle, fully recovered service');
  const bindings=new Map<string,z.infer<typeof bindingSchema>>();
  const images=new Map<string,{context:string;id:string;key:string;kind:string;tasks:Set<string>}>();
  const protectedImages=new Set<string>();
  for(const task of catalog.list()){
    const path=environmentBindingPath(config.environments,task);if(!await exists(path))continue;
    const b=await readJson(path,bindingSchema);if(b.task!==taskKey(task))throw Error('Environment binding identity mismatch');
    bindings.set(taskKey(task),b);const context=config.datasetBackends[task.dataset]?.context??config.context;
    for(const layer of [b.base,b.dependencies,b.preparation]){
      if(!layer)continue;const key=context+'|'+layer.imageId;
      let image=images.get(key);if(!image){image={context,id:layer.imageId,key:layer.key,kind:layer.kind,tasks:new Set()};images.set(key,image);}
      if(image.key!==layer.key)throw Error('Conflicting image receipts');image.tasks.add(taskKey(task));
      if(layer.kind==='base'||task.status!=='passed')protectedImages.add(key);
    }
  }
  const deleted:string[]=[],blocked:{image:string;reason:string}[]=[],candidates:string[]=[];
  const present=new Map<string,Set<string>>();
  for(const context of new Set([...images.values()].map(i=>i.context))){
    const docker=(...args:string[])=>['docker','--context',context,...args];
    let local:Set<string>,containers:Set<string>;
    try{
      local=new Set((await run(docker('image','ls','-a','--no-trunc','--format','{{.ID}}'),{timeout:15000})).split('\n'));
      containers=new Set((await run(docker('ps','-a','--no-trunc','--format','{{.Image}}'),{timeout:15000})).split('\n'));
    }catch{blocked.push({image:context,reason:'Docker engine unavailable; no deletion performed'});continue;}
    present.set(context,local);
    const eligible=[...images.entries()].filter(([key,i])=>i.context===context&&!protectedImages.has(key)&&local.has(i.id)).sort((a,b)=>(a[1].kind==='task'?0:1)-(b[1].kind==='task'?0:1));
    for(const [,image] of eligible){
      if(containers.has(image.id)){blocked.push({image:image.id,reason:'Container reference'});continue;}
      const info=z.array(z.object({Id:z.string(),Config:z.object({Labels:z.record(z.string()).nullable()}),RepoTags:z.array(z.string()).nullable()})).length(1).parse(JSON.parse(await run(docker('image','inspect',image.id))))[0]!;
      if(info.Id!==image.id||info.Config.Labels?.['dev.hicode.environment']!==image.key)throw Error('Image ownership mismatch');
      const tags=info.RepoTags??[];
      if(tags.some(tag=>!tag.startsWith('hicode-env-')&&!tag.startsWith('hicode-eval/'))){blocked.push({image:image.id,reason:'External image tag'});continue;}
      candidates.push(image.id);if(!apply)continue;
      try{for(const tag of tags)await run(docker('image','rm',tag));if(!tags.length)await run(docker('image','rm',image.id));}
      catch{blocked.push({image:image.id,reason:'Docker retained a referenced image'});}
    }
    if(apply)present.set(context,new Set((await run(docker('image','ls','-a','--no-trunc','--format','{{.ID}}'),{timeout:15000})).split('\n')));
    if(apply)for(const [,image] of eligible)if(!present.get(context)!.has(image.id))deleted.push(image.id);
  }
  if(apply){
    const journal=join(layout.state,'import.json');
    if(await exists(journal)){
      const pending=await readJson(journal,z.object({version:z.literal(1),tasks:z.array(taskRefSchema).max(200)}).strict());
      for(const task of pending.tasks)if(!catalog.list().some(t=>taskKey(t)===taskKey(task))){
        await rm(layout.source(task),{recursive:true,force:true});await rm(join(layout.preparations,task.dataset,task.id),{recursive:true,force:true});
      }
      await rm(journal);
    }
    for(const task of catalog.list()){
      const b=bindings.get(taskKey(task));if(!b)continue;
      const local=present.get(config.datasetBackends[task.dataset]?.context??config.context);if(!local)continue;
      if(!local.has((b.preparation??b.dependencies).imageId))await catalog.setEnvironment(task,task.status==='passed'?'evicted':'failed');
    }
    for(const state of runs)await archivePassedRun(layout,state);
    for(const task of catalog.list().filter(t=>t.status==='passed')){
      await catalog.releasePassedSource(task);
      await rm(layout.source(task),{recursive:true,force:true});
      if(task.preparation)await rm(task.preparation.directory,{recursive:true,force:true});
    }
    // Staging is reconstructible. Persistent recipes, bindings and payload are not cache garbage.
    for(const name of await readdir(layout.builds)){
      const path=join(layout.builds,name),stat=await lstat(path);
      if(stat.isDirectory()&&!stat.isSymbolicLink())await rm(path,{recursive:true});
    }
    await mkdir(layout.downloads,{recursive:true});
    const cutoff=Date.now()-7*86400000;
    for(const name of await readdir(layout.downloads))if(name.endsWith('.tmp')||name.endsWith('.part')){
      const path=join(layout.downloads,name),stat=await lstat(path);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs<cutoff)await rm(path);
    }
    await rm(join(layout.state,'maintenance-error.json'),{force:true});
  }
  const report={at:new Date().toISOString(),applied:apply,candidates,deleted,blocked};
  if(apply)await save(join(layout.state,'maintenance.json'),report);
  return report;
}

import {readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {TaskCatalog} from './catalog.js';
import {EvalLayout} from './layout.js';
import {taskKey} from './datasets.js';
import {readJson,exists} from './store.js';
import {batchSchema,runSchema,idSchema,done,liveSchema,containerSchema,loadConfig} from './types.js';
import type {Batch,Run,Config} from './types.js';

export function batchView(batch:Batch,runs:ReadonlyMap<string,Run>,halted=false){
  const children=batch.runIds.map(id=>{const run=runs.get(id);if(!run)throw Error('Batch has missing run evidence');return run;});
  const completed=children.filter(r=>done(r.state)).length;
  const counts={total:children.length,completed,queued:children.filter(r=>r.state==='queued').length,
    active:children.filter(r=>!done(r.state)&&r.state!=='queued').length,passed:children.filter(r=>r.state==='passed').length,
    failed:children.filter(r=>r.state==='failed').length,errors:children.filter(r=>r.state==='error'||r.state==='needs_recovery').length,
    cancelled:children.filter(r=>r.state==='cancelled').length};
  const blocked=halted||children.some(r=>r.state==='needs_recovery');
  return {...batch,counts,state:blocked?'blocked':completed===children.length?'finished':'running',
    analysis:batch.report?'published':completed===children.length?'pending':'waiting',
    finishedAt:completed===children.length?Math.max(...children.map(r=>r.finishedAt??r.updatedAt)):undefined};
}

export async function catalogView(_config:Config,catalog:TaskCatalog){
  return Promise.all(catalog.list().map(async task=>({id:task.id,category:task.dataset,seconds:1800,dataset:task.dataset,
    status:task.status,note:task.note,sourcePrepared:!!task.source,environmentPrepared:!!task.source&&task.environment==='ready',environmentState:task.environment})));
}

export async function runView(path:string,run:Run){
  const live=await exists(join(path,'live.json'))?await readJson(join(path,'live.json'),liveSchema):undefined;
  const container=await exists(join(path,'container.json'))?await readJson(join(path,'container.json'),containerSchema):undefined;
  const preparation=await exists(join(path,'preparation.json'))?await readJson(join(path,'preparation.json'),z.object({
    phase:z.string(),cached:z.boolean().optional(),image:z.string().optional(),updatedAt:z.number()})):undefined;
  return {...run,preparation,evidencePath:path,displayState:done(run.state)?run.state:live?.phase??run.state,live,container};
}

function validateChild(batch:Batch,run:Run){
  const index=batch.runIds.indexOf(run.id);
  if(run.batchId!==batch.id||index<0||!batch.taskRefs[index]||taskKey(batch.taskRefs[index]!)!==taskKey({dataset:run.dataset,id:run.task})||run.network!==batch.network)
    throw Error('Run does not belong to its frozen batch');
}

/** Reads atomic records only. Never initializes Lab, acquires its lease or repairs scores. */
export class EvaluationView {
  constructor(readonly data:string){}
  private async config(){
    if(await realpath(this.data)!==resolve(this.data))throw Error('Symlinked evaluation data');
    const config=await loadConfig(this.data);
    if(config.data!==this.data)throw Error('Evaluation data identity mismatch');
    return config;
  }
  async path(id:string){
    idSchema.parse(id);await this.config();
    const path=join(this.data,'runs',id),run=await readJson(join(path,'state.json'),runSchema);
    if(run.id!==id)throw Error('Run identity mismatch');
    const batch=await readJson(new EvalLayout(this.data).batch(run.batchId),batchSchema);
    validateChild(batch,run);return path;
  }
  async snapshot(halted=false){
    const config=await this.config(),directory=new EvalLayout(this.data).batches;
    const names=await exists(directory)?await readdir(directory):[];
    if(names.length>10000)throw Error('Too many batch records');
    const batches:Batch[]=[],runs=new Map<string,Run>();
    for(const name of names){
      if(!/^[a-f0-9]{16}\.json$/.test(name))continue;
      const batch=await readJson(join(directory,name),batchSchema);
      if(name!==batch.id+'.json'||batch.runIds.length!==batch.taskRefs.length||batch.runIds.length>200||
        new Set(batch.runIds).size!==batch.runIds.length||new Set(batch.taskRefs.map(taskKey)).size!==batch.taskRefs.length)
        throw Error('Invalid batch identity');
      batches.push(batch);
      for(const id of batch.runIds){
        if(runs.has(id))throw Error('Run belongs to multiple batches');
        const run=await readJson(join(this.data,'runs',id,'state.json'),runSchema);
        if(run.id!==id)throw Error('Run identity mismatch');validateChild(batch,run);runs.set(id,run);
      }
    }
    const catalog=await TaskCatalog.open(config.catalog);
    const active=new Set([...runs.values()].filter(r=>!done(r.state)&&r.state!=='queued').map(r=>taskKey({dataset:r.dataset,id:r.task})));
    return {batches:batches.sort((a,b)=>b.createdAt-a.createdAt).map(b=>batchView(b,runs,halted)),
      runs:await Promise.all([...runs.values()].sort((a,b)=>b.createdAt-a.createdAt).map(r=>runView(join(this.data,'runs',r.id),r))),
      tasks:await catalogView(config,catalog),inventory:catalog.counts(active),concurrency:config.concurrency,budget:config.budget,
      schedulingBlocked:halted||[...runs.values()].some(r=>r.state==='needs_recovery')};
  }
}

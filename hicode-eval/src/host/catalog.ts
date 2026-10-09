import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {readJson, save} from './store.js';
import type {Run} from './types.js';
import {datasetSchema,taskKey} from './datasets.js';
import type {Dataset} from './datasets.js';

const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/);
const resultSchema = z.object({
  runId:z.string().min(1).max(100), model:z.string().max(200),
  execution:z.enum(['pending','completed','timeout','cancelled','failed']),
  grading:z.enum(['pending','passed','failed','unavailable']), accepted:z.boolean(),
  finishedAt:z.number().nonnegative(), note:z.string().max(4000).optional(),
  record:z.string().max(4096).optional(),
}).strict();
export const catalogTaskSchema = z.object({
  id:taskId, dataset:datasetSchema,
  source:z.string().max(4096).refine(isAbsolute).optional(),
  preparation:z.object({directory:z.string().max(4096).refine(isAbsolute),
    script:z.string().regex(/^[A-Za-z0-9_.-]+\.sh$/),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  status:z.enum(['passed','unpassed','untested']),
  results:z.array(resultSchema).max(1000),
  note:z.string().max(4000).optional(),
}).strict().superRefine((task,ctx)=>{
  if(new Set(task.results.map(result=>result.runId)).size!==task.results.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Duplicate archived attempt'});
  if(task.status==='passed'&&!task.results.some(result=>result.accepted))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:'Passed task requires an accepted archived result'});
});
export const catalogSchema=z.object({version:z.literal(1),updatedAt:z.string().datetime(),tasks:z.array(catalogTaskSchema).max(10000)})
  .strict().superRefine((catalog,ctx)=>{
    if(new Set(catalog.tasks.map(taskKey)).size!==catalog.tasks.length)
      ctx.addIssue({code:z.ZodIssueCode.custom,message:'Duplicate task identity'});
  });
export type CatalogTask=z.infer<typeof catalogTaskSchema>;

/** Durable task results outlive disposable run directories. The service owns writes. */
export class TaskCatalog {
  private writes:Promise<void>=Promise.resolve();
  private constructor(readonly path:string, private document:z.infer<typeof catalogSchema>){}
  static async open(path:string):Promise<TaskCatalog>{return new TaskCatalog(path,await readJson(path,catalogSchema,16*1024*1024));}
  list():readonly CatalogTask[]{return this.document.tasks;}
  get(dataset:Dataset,id:string):CatalogTask {
    const task=this.document.tasks.find(task=>task.dataset===dataset&&task.id===id);
    if(!task)throw Error('Unknown catalog task');
    return task;
  }
  async register(entries:readonly Pick<CatalogTask,'id'|'dataset'|'source'>[]):Promise<void>{
    if(entries.some(entry=>entry.dataset==='terminal-bench'))throw Error('Terminal-Bench 2.0 registration is retired');
    const tasks=new Map(this.document.tasks.map(task=>[taskKey(task),task]));
    for(const entry of entries){
      const key=taskKey(entry),previous=tasks.get(key);
      tasks.set(key,catalogTaskSchema.parse({...previous,...entry,status:previous?.status??'untested',results:previous?.results??[]}));
    }
    const next=catalogSchema.parse({version:1,updatedAt:new Date().toISOString(),tasks:[...tasks.values()].sort((a,b)=>taskKey(a).localeCompare(taskKey(b)))});
    await save(this.path,next);this.document=next;
  }
  async record(run:Run):Promise<void>{
    if(!['passed','failed','error','cancelled'].includes(run.state))return;
    const operation=this.writes.then(async()=>{
      const task=this.get(run.dataset,run.task);
      const previous=task.results.find(item=>item.runId===run.id);
      const result={...previous,runId:run.id,model:run.model,execution:run.execution,grading:run.grading,
        accepted:previous?.accepted===true||(run.execution==='completed'&&run.grading==='passed'&&run.collection==='complete'),
        finishedAt:run.finishedAt??run.updatedAt,...(run.note?{note:run.note.slice(0,4000)}:{})};
      const results=[...task.results.filter(item=>item.runId!==run.id),result];
      const attempted=task.status==='unpassed'||run.startedAt!==undefined||['completed','failed','timeout'].includes(run.execution);
      const status=results.some(item=>item.accepted)?'passed':attempted?'unpassed':'untested';
      const next=catalogSchema.parse({...this.document,updatedAt:new Date().toISOString(),
        tasks:this.document.tasks.map(item=>taskKey(item)===taskKey(task)?{...item,status,results}:item)});
      await save(this.path,next);this.document=next;
    });
    this.writes=operation.catch(()=>{});await operation;
  }
  counts(active:ReadonlySet<string>=new Set()){
    return {total:this.document.tasks.length,passed:this.document.tasks.filter(t=>t.status==='passed').length,
      unpassed:this.document.tasks.filter(t=>t.status==='unpassed').length,
      untested:this.document.tasks.filter(t=>t.status==='untested').length,running:active.size,
      preparedSources:this.document.tasks.filter(t=>t.source!==undefined).length};
  }
}

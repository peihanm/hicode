import { mkdir, readdir, cp, rm,realpath,copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {TaskCatalog} from './catalog.js';
import type {CatalogTask} from './catalog.js';
import {taskAdapters,taskKey} from './datasets.js';
import {EnvironmentStore} from './environments.js';
import { EvidenceCollectionError, LinuxMachine } from './linux.js';
import { readJson, save, exists, contained } from './store.js';
import { runSchema, done, modelSchema,batchSchema, submissionSchema,environmentPreparationSchema,terminalRegradeRequestSchema,terminalRecheckSchema,continuationRequestSchema,batchContinuationRequestSchema,continuationFor } from './types.js';
import type { Config, Run, Batch, Submission,EnvironmentPreparation,TerminalRegradeRequest,ContinuationRequest,ContinuationOrigin,BatchContinuationRequest } from './types.js';
import {readCheckpoint,verifyCheckpointArchive,environmentDigest} from './continuation.js';
import {bindingSchema} from './environments.js';
import {terminalRegradeChanges,TerminalRegradeCleanupError} from './terminalRegrade.js';
import {batchView,catalogView,runView} from './view.js';

import { REPOSITORY_ROOT } from '../paths.js';
import {EvalLayout} from './layout.js';
import {collectResources} from './resources.js';
import {registerTasks,taskRegistrationSchema} from './taskRegistration.js';
import type {TaskRegistration} from './taskRegistration.js';
export function classify(error: string | undefined, rewards: Record<string, number> | null | undefined): Pick<Run, 'state' | 'execution' | 'grading'> {
  const grading = rewards && Object.keys(rewards).length ? (Object.values(rewards).every(x => x === 1) ? 'passed' : 'failed') : 'unavailable';
  return { execution: error ? (error === 'timeout' ? 'timeout' : 'failed') : 'completed', grading, state: error || grading === 'unavailable' ? 'error' : grading === 'passed' ? 'passed' : 'failed' };
}
export class Lab {
  readonly batches = new Map<string, Batch>();
  private submissions: Promise<unknown> = Promise.resolve();
  readonly runs = new Map<string, Run>();
  private machine: LinuxMachine | undefined;
  private taskCatalog:TaskCatalog|undefined;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;
  private halted = false;
  private machineReady=false;
  private readonly attempted = new Set<string>();
  private pumping = false;
  private maintenancePending=false;
  private preparationJob:{tasks:ReadonlySet<string>;completion:Promise<void>;controller:AbortController}|undefined;
  private readonly rechecks=new Map<string,{reviewId:string;task:string;restartScript:string|undefined;controller:AbortController}>();
  private readonly layout:EvalLayout;
  private readonly adapters:ReturnType<typeof taskAdapters>;
  constructor(readonly config: Config, private readonly credentials: ReadonlyMap<string,string>) {this.layout=new EvalLayout(config.data);this.adapters=taskAdapters(this.layout);}
  path(id: string): string { if (!this.runs.has(id)) throw Error('Unknown run'); return this.layout.run(id); }
  async init(): Promise<void> {
    if (contained(REPOSITORY_ROOT, this.config.data)) throw Error('Run data must be outside checkout');
    await this.layout.assert();
    await mkdir(join(this.config.data, 'runs'), { recursive: true, mode: 0o700 });
    await mkdir(this.layout.batches, { recursive: true, mode: 0o700 });
    this.taskCatalog=await TaskCatalog.open(this.config.catalog);
    for (const name of await readdir(this.layout.batches)) {
      if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
      const batch = await readJson(join(this.layout.batches,name), batchSchema);
      if (name !== batch.id + '.json' || batch.taskRefs.length !== batch.runIds.length ||
        new Set(batch.taskRefs.map(taskKey)).size!==batch.taskRefs.length||new Set(batch.runIds).size !== batch.runIds.length) throw Error('Invalid batch identity');
      this.batches.set(batch.id, batch);
    }
    for (const name of await readdir(join(this.config.data, 'runs'))) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const state = await readJson(join(this.config.data, 'runs', name, 'state.json'), runSchema);
      if (state.id !== name) throw Error('Run identity mismatch');
      const batch = this.batches.get(state.batchId);
      const index=batch?.runIds.indexOf(name)??-1;
      if (!batch || index<0 || taskKey(batch.taskRefs[index]!)!==taskKey({dataset:state.dataset,id:state.task})) throw Error('Orphan or mismatched run');
      if (batch.network==='isolated'&&state.network!=='isolated') throw Error('Run exceeds its frozen batch network permission');
      this.runs.set(name, state);
      if(done(state.state)&&state.state!=='needs_recovery'){
        // A crash may occur after state.json commits but before the catalog or disposal receipt.
        await this.taskCatalog.record(state);
        if(await exists(join(this.path(name),'container.json'))){
          const disposed=join(this.path(name),'container-disposed.json');
          if(await exists(disposed))await readJson(disposed,z.object({version:z.literal(1),runId:z.literal(name),at:z.string().datetime()}).strict());
          else await this.update(name,{state:'needs_recovery',note:'Result persisted; container disposal was not confirmed before restart'});
        }
      }
      const unstarted = state.state === 'queued' && state.startedAt === undefined &&
        !await exists(join(this.path(name), 'job.json')) && !await exists(join(this.path(name), 'container.json'));
      if (!done(state.state) && !unstarted) await this.update(name, { state: 'needs_recovery', collection: 'retained', note: 'Service restarted; inspect retained evidence before scheduling more work' });
    }
    for (const batch of this.batches.values()) if (batch.runIds.some(id => !this.runs.has(id))) throw Error('Batch has missing run evidence');
    const retried=new Set<string>();
    for(const batch of this.batches.values()){
      if(batch.continuations&&(batch.continueOf||batch.retryOf||Object.keys(batch.continuations).length!==batch.runIds.length
        ||Object.keys(batch.continuations).some(id=>!batch.runIds.includes(id))))throw Error('Invalid batch continuation ownership');
      for(const id of batch.runIds){
        const continuation=continuationFor(batch,id),origin=continuation??batch.retryOf;if(!origin)continue;
        if(batch.retryOf&&continuation)throw Error('An attempt cannot both retry and continue');
        const parent=this.runs.get(origin.runId),key=(continuation?'continue:':'retry:')+origin.runId;
        const parentBatch=parent&&this.batches.get(parent.batchId),parentContinuation=parentBatch&&continuationFor(parentBatch,parent.id);
        if(retried.has(key)||id===origin.runId||batch.id===origin.batchId||!parent||parent.batchId!==origin.batchId
          ||taskKey(batch.taskRefs[batch.runIds.indexOf(id)]!)!==taskKey({dataset:parent.dataset,id:parent.task})
          ||origin.attempt!==(parentBatch!.retryOf?.attempt??parentContinuation?.attempt??1)+1
          ||(continuation&&(parent.state==='passed'||(continuation.checkpoint.runId!==parent.id
            &&continuation.checkpoint.runId!==parentContinuation?.checkpoint.runId))))throw Error('Invalid retry lineage');
        retried.add(key);
      }
    }
    this.machine=new LinuxMachine(this.config);await this.machine.freeze();
    for(const state of this.runs.values()){
      const directory=join(this.path(state.id),'rechecks');if(!await exists(directory))continue;
      if(await realpath(directory)!==directory)throw Error('Symlinked recheck directory');
      for(const name of await readdir(directory)){
        if(!/^[a-f0-9]{16}$/.test(name))continue;
        const path=join(this.layout.recheck(state.id,name),'operation.json');if(!await exists(path))continue;
        const record=await readJson(path,terminalRecheckSchema);
        if(record.runId!==state.id||record.reviewId!==name||this.runs.has(name))throw Error('Invalid recheck ownership');
        if(!['queued','running','retained'].includes(record.state))continue;
        await this.machine.disposeTerminalRecheck(state,name);
        await save(path,{version:1,runId:state.id,reviewId:name,state:'cancelled',error:'Worker restarted; interrupted recheck stopped and stored Run result retained'});
      }
    }
  }
  private async prepareMachine():Promise<void>{
    if(this.machineReady)return;this.machine??=new LinuxMachine(this.config);await this.machine.prepare();this.machineReady=true;
  }
  async catalog() {
    const catalog=this.taskCatalog??await TaskCatalog.open(this.config.catalog);
    return catalogView(this.config,catalog);
  }
  private async update(id: string, changes: Partial<Run>): Promise<void> {
    const write = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      const previous = this.runs.get(id); if (!previous) throw Error('Unknown run');
      const next = runSchema.parse({ ...previous, ...changes, updatedAt: Date.now() / 1000 });
      await save(join(this.path(id), 'state.json'), next); this.runs.set(id, next);
      await this.taskCatalog?.record(next);
    });
    this.writes.set(id, write); await write;
  }

  private configuredModel(selection: Pick<Batch['model'],'source'|'model'>): Batch['model'] {
    const matches=[this.config.model,...this.config.models].filter(model=>model.source===selection.source&&model.model===selection.model);
    if(matches.length!==1)throw Error('Select a configured, unambiguous source/model connection');
    return matches[0]!;
  }
  private credentialFor(model: Batch['model']): string {
    const {reasoning:_frozen,...frozen}=model;
    const {reasoning:_current,...configured}=this.configuredModel(model);
    if(!isDeepStrictEqual(frozen,configured))throw Error('Restore the original model connection before retrying or executing its batch');
    const credential=this.credentials.get(model.apiKeyEnv);
    if(!credential)throw Error('Missing provider credential for '+model.source+'/'+model.model);
    return credential;
  }

  async submit(input: Submission): Promise<Batch> {
    const operation = this.submissions.then(() => this.createBatch(submissionSchema.parse(input),null));
    this.submissions = operation.catch(() => {});
    return operation;
  }
  async registerTasks(input:TaskRegistration){
    const operation=this.submissions.then(async()=>{
      if(this.closed||!this.taskCatalog)throw Error('Worker is closing or not initialized');
      return registerTasks(this.layout,this.taskCatalog,taskRegistrationSchema.parse(input));
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  async regrade(input:TerminalRegradeRequest){
    const operation=this.submissions.then(async()=>{
      const request=terminalRegradeRequestSchema.parse(input),state=this.runs.get(request.run);
      if(this.closed||this.halted||!state)throw Error('Recheck unavailable while worker is closing/blocked or run is unknown');
      const previous=this.rechecks.get(state.id);
      if(previous){if(previous.restartScript!==request.restartScript)throw Error('This run already has a different pending recheck');return this.recheck(state.id,previous.reviewId);}
      const key=taskKey({dataset:state.dataset,id:state.task});
      if((state.dataset!=='terminal-bench-2.1'&&state.dataset!=='deep-swe')
        ||(state.execution!=='completed'&&!(state.dataset==='deep-swe'&&((state.execution==='cancelled'&&state.grading==='unavailable')||state.execution==='failed')))
        ||state.collection!=='complete'||!['passed','failed','error','cancelled'].includes(state.state))
        throw Error('Recheck requires a completed and fully collected Terminal run');
      if(this.preparationJob?.tasks.has(key)||[...this.rechecks.values()].some(item=>item.task===key)||[...this.runs.values()].some(run=>
        taskKey({dataset:run.dataset,id:run.task})===key&&(!done(run.state)||run.state==='needs_recovery'||this.jobs.has(run.id))))
        throw Error('This task has an active attempt, recheck, preparation or retained evidence');
      const reviewId=randomBytes(8).toString('hex');
      const record=terminalRecheckSchema.parse({version:1,runId:state.id,reviewId,state:'queued'});
      await save(join(this.layout.recheck(state.id,reviewId),'operation.json'),record);
      this.rechecks.set(state.id,{reviewId,task:key,restartScript:request.restartScript,controller:new AbortController()});
      void this.pump();return record;
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  async recheck(runId:string,reviewId:string){
    this.path(runId);
    const record=await readJson(join(this.layout.recheck(runId,reviewId),'operation.json'),terminalRecheckSchema);
    if(record.runId!==runId||record.reviewId!==reviewId)throw Error('Recheck identity mismatch');
    return record;
  }
  private startRecheck(id:string){
    const pending=this.rechecks.get(id);if(!pending||this.jobs.has(id))return;
    const job=(async()=>{
      const path=join(this.layout.recheck(id,pending.reviewId),'operation.json');
      try{
        pending.controller.signal.throwIfAborted();
        await save(path,{version:1,runId:id,reviewId:pending.reviewId,state:'running'});
        if(!this.machine||!this.taskCatalog)throw Error('Worker not initialized');
        const state=this.runs.get(id)!;
        const result=await this.machine.regradeTerminal(state,this.taskCatalog.get(state.dataset,state.task),pending.restartScript,pending.reviewId,pending.controller.signal);
        pending.controller.signal.throwIfAborted();
        const changes=terminalRegradeChanges(result);if(changes)await this.update(id,{...changes,
          ...(state.execution==='failed'?{state:'error' as const}:{}),
          ...(state.dataset==='deep-swe'&&state.execution==='cancelled'?{execution:'completed'}:{})});
        await save(path,terminalRecheckSchema.parse({version:1,runId:id,reviewId:pending.reviewId,state:'finished',result}));
      }catch(error){
        if(error instanceof TerminalRegradeCleanupError)this.halted=true;
        await save(path,{version:1,runId:id,reviewId:pending.reviewId,state:error instanceof TerminalRegradeCleanupError?'retained':pending.controller.signal.aborted?'cancelled':'failed',error:String(error).slice(-2000)});
      }
    })().catch(()=>{this.halted=true;console.error('Recheck state could not be persisted; scheduling stopped.');})
      .finally(()=>{this.rechecks.delete(id);this.jobs.delete(id);void this.pump();});
    this.jobs.set(id,job);
  }
  async prepareEnvironments(input:EnvironmentPreparation):Promise<{accepted:string[]}>{
    const operation=this.submissions.then(async()=>{
      const request=environmentPreparationSchema.parse(input);
      if(this.closed||this.preparationJob)throw Error('Environment preparation is already running or the worker is closing');
      const keys=request.tasks.map(taskKey);if(new Set(keys).size!==keys.length)throw Error('Duplicate preparation tasks');
      const tasks=request.tasks.map(t=>this.taskCatalog!.get(t.dataset,t.id));
      if(tasks.some(t=>!t.source||t.status==='passed'||[...this.rechecks.values()].some(item=>item.task===taskKey(t))||[...this.runs.values()].some(r=>taskKey({dataset:r.dataset,id:r.task})===taskKey(t)&&(!done(r.state)||r.state==='needs_recovery'))))
        throw Error('Prepare only registered, unpassed tasks without active or retained attempts');
      const controller=new AbortController();
      const store=new EnvironmentStore(this.config.environments,this.config.context,this.config.datasetBackends,request.buildProxy,controller.signal);
      const completion=(async()=>{
        const ready:string[]=[],failed:{task:string;error:string}[]=[],cancelled:string[]=[];
        const progress=async(current:string|null,waiting=false)=>save(join(this.layout.state,'preparation.json'),{at:new Date().toISOString(),running:current!==null||waiting,current,ready,failed,cancelled,...(waiting?{waitingForEvaluations:true}:{})});
        try{
          for(const [index,task] of tasks.entries()){
            if(controller.signal.aborted){cancelled.push(...tasks.slice(index).map(taskKey));break;}
            if(request.afterEvaluations){
              await progress(null,true);
              while(!controller.signal.aborted&&(this.jobs.size>0||[...this.runs.values()].some(run=>!done(run.state))))await Bun.sleep(500);
              if(controller.signal.aborted){cancelled.push(...tasks.slice(index).map(taskKey));break;}
            }
            await progress(taskKey(task));
            try{await store.prepareTask(task);await this.taskCatalog!.setEnvironment(task,'ready');ready.push(taskKey(task));}
            catch(error){
              if(controller.signal.aborted){cancelled.push(...tasks.slice(index).map(taskKey));break;}
              await this.taskCatalog!.setEnvironment(task,'failed');failed.push({task:taskKey(task),error:String(error).slice(-1500)});
            }
          }
          await progress(null);
        }catch(error){await save(join(this.layout.state,'preparation.json'),{at:new Date().toISOString(),running:false,ready,failed,cancelled,error:String(error).slice(-1500)});}
      })().catch(error=>{console.error('Environment preparation record failed:',String(error).slice(-250));}).finally(()=>{this.preparationJob=undefined;void this.pump();});
      this.preparationJob={tasks:new Set(keys),completion,controller};
      return {accepted:keys};
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  async retry(id:string):Promise<Batch>{
    const operation=this.submissions.then(async()=>{
      const original=this.runs.get(id);if(!original)throw Error('Unknown run');
      const existing=[...this.batches.values()].find(batch=>batch.retryOf?.runId===id);
      if(existing)return existing;
      if(!done(original.state)||original.state==='needs_recovery'||this.jobs.has(id))throw Error('Wait for completion or recover retained evidence before rerunning');
      if([...this.runs.values()].some(run=>taskKey({dataset:run.dataset,id:run.task})===taskKey({dataset:original.dataset,id:original.task})&&(!done(run.state)||this.jobs.has(run.id))))throw Error('This task already has an active attempt');
      if(!this.machine)throw Error('Initialize the machine before rerunning');
      const parent=this.batches.get(original.batchId)!;
      this.credentialFor(parent.model);
      return this.createBatch({name:original.task.slice(0,90)+' · 第 '+((parent.retryOf?.attempt??continuationFor(parent,original.id)?.attempt??1)+1)+' 次尝试',
        network:original.network,concurrency:1,tasks:[{id:original.task,dataset:original.dataset,agentSeconds:original.budget.agentSeconds}]},original);
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  async continueRun(input:ContinuationRequest):Promise<Batch>{
    const operation=this.submissions.then(async()=>{
      const request=continuationRequestSchema.parse(input),original=this.runs.get(request.run);
      if(!original)throw Error('Unknown run');
      if(!this.adapters[original.dataset].canContinue)throw Error('This dataset does not support continuing saved attempts');
      const existing=[...this.batches.values()].find(batch=>batch.runIds.some(id=>continuationFor(batch,id)?.runId===original.id));
      if(existing){
        const id=existing.runIds.find(id=>continuationFor(existing,id)?.runId===original.id)!,origin=continuationFor(existing,id)!;
        if(origin.prompt!==request.prompt||this.runs.get(id)?.budget.agentSeconds!==request.agentSeconds
          ||origin.inputSource!==(request.restoreActor?'sealed-deep-actor':'checkpoint'))
          throw Error('This attempt already has a continuation with different inputs');
        return existing;
      }
      if(this.jobs.has(original.id)||[...this.rechecks.values()].some(item=>item.task===taskKey({dataset:original.dataset,id:original.task}))
        ||[...this.runs.values()].some(run=>run.dataset===original.dataset&&run.task===original.task&&(!done(run.state)||run.state==='needs_recovery'||this.jobs.has(run.id))))
        throw Error('Wait for this task to finish and its evidence to be collected');
      const parent=this.batches.get(original.batchId)!;
      this.credentialFor(parent.model);
      const recoverActor=this.adapters[original.dataset].recoverActor;
      if(request.restoreActor&&!recoverActor)throw Error('This dataset cannot recover collected Actor evidence');
      const restored=request.restoreActor?await recoverActor!(original):null;
      try{
        const checkpoint=restored?.checkpoint??await readCheckpoint(this.layout,original);
        const environment=await readJson(join(this.path(original.id),'environment.json'),bindingSchema);
        const origin:ContinuationOrigin={batchId:parent.id,runId:original.id,attempt:(parent.retryOf?.attempt??continuationFor(parent,original.id)?.attempt??1)+1,
          checkpoint,prompt:request.prompt,inputSource:restored?'sealed-deep-actor':'checkpoint',environmentSha256:environmentDigest(environment)};
        return await this.createBatch({name:original.task.slice(0,85)+' · 继续作答 '+origin.attempt,network:original.network,concurrency:1,
          tasks:[{id:original.task,dataset:original.dataset,agentSeconds:request.agentSeconds}]},original,{origin,archive:restored?.archive??join(this.path(original.id),'evidence/continuation.tar.gz')});
      }finally{await restored?.close();}
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  async continueBatch(input:BatchContinuationRequest):Promise<Batch>{
    const operation=this.submissions.then(async()=>{
      const request=batchContinuationRequestSchema.parse(input);
      if(new Set(request.runs).size!==request.runs.length)throw Error('Choose distinct saved attempts');
      const existing=[...this.batches.values()].find(batch=>batch.continuations&&request.runs.every(id=>
        Object.values(batch.continuations!).some(origin=>origin.runId===id)));
      if(existing){
        if(Object.values(existing.continuations!).length!==request.runs.length||Object.values(existing.continuations!).some(origin=>origin.prompt!==request.prompt)
          ||existing.runIds.some(id=>this.runs.get(id)?.budget.agentSeconds!==request.agentSeconds))throw Error('Continuation already has different inputs');
        return existing;
      }
      const entries=new Map<string,{original:Run;origin:ContinuationOrigin;archive:string}>(),closers:Array<()=>Promise<void>>=[];
      try{
        for(const id of request.runs){
          const original=this.runs.get(id);if(!original||!this.adapters[original.dataset].canContinue)throw Error('Unknown or unsupported saved attempt');
          if([...this.batches.values()].some(batch=>batch.runIds.some(child=>continuationFor(batch,child)?.runId===id)))
            throw Error('This attempt already has a continuation; choose its latest attempt');
          const key=taskKey({dataset:original.dataset,id:original.task});
          if(entries.has(key)||this.preparationJob?.tasks.has(key)||[...this.rechecks.values()].some(r=>r.task===key)
            ||[...this.runs.values()].some(r=>taskKey({dataset:r.dataset,id:r.task})===key&&(!done(r.state)||r.state==='needs_recovery'||this.jobs.has(r.id))))
            throw Error('Task is active, being prepared or selected twice');
          const parent=this.batches.get(original.batchId)!;
          this.credentialFor(parent.model);
          const recover=this.adapters[original.dataset].recoverActor;
          const restore=request.restoreActors&&!await exists(join(this.path(id),'evidence/continuation.json'));
          if(restore&&!recover)throw Error('This dataset cannot recover Actor evidence');
          const recovered=restore?await recover!(original):null;if(recovered)closers.push(recovered.close);
          const checkpoint=recovered?.checkpoint??await readCheckpoint(this.layout,original);
          const environment=await readJson(join(this.path(id),'environment.json'),bindingSchema);
          entries.set(key,{original,archive:recovered?.archive??join(this.path(id),'evidence/continuation.tar.gz'),origin:{batchId:parent.id,runId:id,
            attempt:(parent.retryOf?.attempt??continuationFor(parent,id)?.attempt??1)+1,checkpoint,prompt:request.prompt,
            inputSource:recovered?'sealed-deep-actor':'checkpoint',environmentSha256:environmentDigest(environment)}});
        }
        const first=entries.values().next().value!;
        if([...entries.values()].some(e=>e.original.network!==first.original.network))throw Error('Choose attempts with the same network policy');
        return await this.createBatch({name:'继续作答 · '+entries.size+' 题',network:first.original.network,concurrency:Math.min(this.config.concurrency,entries.size),
          tasks:[...entries.values()].map(e=>({dataset:e.original.dataset,id:e.original.task,agentSeconds:request.agentSeconds}))},null,undefined,entries);
      }finally{await Promise.all(closers.map(close=>close()));}
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  private async createBatch(input: Submission,singleOriginal:Run|null,continuationInput?:{origin:ContinuationOrigin;archive:string},multiple?:ReadonlyMap<string,{original:Run;origin:ContinuationOrigin;archive:string}>): Promise<Batch> {
    const original=singleOriginal??multiple?.values().next().value?.original;
    const continuation=continuationInput?.origin;
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    if ([...this.runs.values()].some(r => r.state === 'needs_recovery')) throw Error('Recover retained runs before submitting more');
    if (input.concurrency > this.config.concurrency) throw Error('Batch exceeds service concurrency');
    if(new Set(input.tasks.map(taskKey)).size!==input.tasks.length)
      throw Error('Choose distinct tasks');
    if(input.tasks.some(t=>this.preparationJob?.tasks.has(taskKey(t))))throw Error('Selected task environment is being prepared');
    if(input.tasks.some(t=>[...this.rechecks.values()].some(item=>item.task===taskKey(t))))throw Error('Selected task is being rechecked');
    const selectedModel = this.configuredModel(input.model ?? this.config.model);
    const model = modelSchema.parse(original ? this.batches.get(original.batchId)!.model : {...selectedModel, reasoning: input.reasoning ?? selectedModel.reasoning ?? {effort: "default"}});
    const selected:CatalogTask[]=input.tasks.map(ref=>{
      const matches=this.taskCatalog!.list().filter(task=>taskKey(task)===taskKey(ref));
      if(matches.length!==1)throw Error('Unknown dataset task');
      return matches[0]!;
    });
    if(new Set(selected.map(taskKey)).size!==selected.length)throw Error('Choose distinct tasks');
    if(selected.some(task=>task.status==='passed'))throw Error('Passed tasks are archived; select untested or unpassed tasks');
    this.credentialFor(model);
    const environments=new EnvironmentStore(this.config.environments,this.config.context,this.config.datasetBackends);
    const networks:Run['network'][]=[];
    for(const task of selected){
      const entry=multiple?.get(taskKey(task)),original=entry?.original??singleOriginal,continuation=entry?.origin??continuationInput?.origin;
      if(original&&!isDeepStrictEqual(this.batches.get(original.batchId)!.model,model))throw Error('Continue together only with the same frozen model');
      if(!task.source)throw Error('Prepare the selected task source before submission: '+taskKey(task));
      const source=original?join(this.path(original.id),'task',original.task):task.source;
      await this.adapters[task.dataset].validate(task.id,source);
      const permitted=await this.adapters[task.dataset].network(source);
      const network=(input.network??this.config.network)==='isolated'?'isolated':permitted;
      if(original&&network!==original.network)throw Error('Original frozen task network permission changed; refusing to rerun');
      networks.push(network);
      try{
        const environment=await environments.resolve(task);
        if(continuation&&environmentDigest(environment)!==continuation.environmentSha256)throw Error('Continuation environment changed');
      }
      catch(error){throw Error('Prepare the selected task environment before submission: '+taskKey(task)+' · '+String(error));}
    }
    if(!this.machineReady)await this.prepareMachine();
    const taskRefs=selected.map(task=>({id:task.id,dataset:task.dataset}));
    const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
    if(original&&!isDeepStrictEqual(this.batches.get(original.batchId)!.payload,payload))throw Error('Current payload differs from the original; restore the original payload before rerunning');
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    const id = randomBytes(8).toString('hex'), now = Date.now() / 1000;
    const runIds=taskRefs.map(()=>randomBytes(8).toString('hex'));
    const batch = batchSchema.parse({name:input.name, network: input.network ?? this.config.network, concurrency:input.concurrency,
      taskRefs,budget: this.config.budget, version: 1, id, createdAt: now, runIds, model, payload,
      ...(multiple?{continuations:Object.fromEntries(taskRefs.map((ref,i)=>[runIds[i],multiple.get(taskKey(ref))!.origin]))}:continuation?{continueOf:continuation}:original?{retryOf:{batchId:original.batchId,runId:original.id,
        attempt:(this.batches.get(original.batchId)!.retryOf?.attempt??continuationFor(this.batches.get(original.batchId)!,original.id)?.attempt??1)+1}}:{}) });
    const states = input.tasks.map((task, i) => runSchema.parse({ version: 1, network: networks[i], id: batch.runIds[i], batchId: id, task: task.id, dataset: selected[i]!.dataset, state: 'queued', createdAt: now, updatedAt: now, model: model.model, budget: { agentSeconds: task.agentSeconds ?? batch.budget.agentSeconds } }));
    // Publish the batch only after all children are durable; no worker sees a partial submission.
    try {
      for (const state of states) {
        const entry=multiple?.get(taskKey({dataset:state.dataset,id:state.task})),original=entry?.original??singleOriginal;
        const savedContinuation=entry??continuationInput,continuation=savedContinuation?.origin;
        if(original&&!isDeepStrictEqual(this.batches.get(original.batchId)!.payload,payload))throw Error('Original payload changed');
        const root = join(this.config.data, 'runs', state.id), source = original?join(this.path(original.id),'task',original.task):this.taskCatalog!.get(state.dataset,state.task).source!, target = join(root, 'task', state.task);
        await this.adapters[state.dataset].validate(state.task,source);
        const hashes = await this.adapters[state.dataset].snapshot(source);
        if(original){
          const frozen=await readJson(join(this.path(original.id),'task-files.json'),z.record(z.object({bytes:z.number(),sha256:z.string(),symlink:z.string().optional(),mode:z.number().optional()})));
          if(!isDeepStrictEqual(hashes,frozen))throw Error('Original frozen task changed; refusing to rerun');
        }
        // Native build outputs depend on source timestamps as well as bytes.
        await cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
        const copied = await this.adapters[state.dataset].snapshot(target);
        if (!isDeepStrictEqual(copied, hashes)) {
          const changed = [...new Set([...Object.keys(hashes), ...Object.keys(copied)])].find(name => !isDeepStrictEqual(hashes[name],copied[name]));
          throw Error(`Task changed during submission: ${state.task} (${changed ?? 'snapshot metadata'})`);
        }
        await save(join(root, 'task-files.json'), hashes);
        if(continuation&&original){
          await copyFile(savedContinuation!.archive,this.layout.continuationArchive(state.id));
          await verifyCheckpointArchive(this.layout.continuationArchive(state.id),continuation.checkpoint);
        }
        await save(join(root, 'state.json'), state);
      }
      await save(this.layout.batch(id), batch);
    } catch (error) {
      for (const state of states) await rm(join(this.config.data, 'runs', state.id), { recursive: true, force: true });
      throw error;
    }
    this.batches.set(id, batch);
    for (const state of states) this.runs.set(state.id, state);
    void this.pump(); return batch;
  }
  async cancelBatch(id: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id); if (!batch) throw Error('Unknown batch');
      const next = { ...batch, cancelledAt: Date.now() / 1000 };
      await save(this.layout.batch(id), next); this.batches.set(id, next);
      await Promise.all(batch.runIds.map(run => this.cancel(run)));
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async report(id: string, text: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id); if (!batch) throw Error('Unknown batch');
      if (batch.runIds.some(run => !done(this.runs.get(run)!.state))) throw Error('Wait for every attempt to finish before publishing analysis');
      const next = batchSchema.parse({ ...batch, report: { text, updatedAt: Date.now() / 1000 } });
      await save(this.layout.batch(id), next); this.batches.set(id, next);
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async resume(id: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id);
      if (!batch) throw Error('Unknown batch');
      if (this.closed || this.halted || [...this.runs.values()].some(r => r.state === 'needs_recovery'))
        throw Error('Recover retained runs and initialize the machine before resuming');
      if (batch.cancelledAt) throw Error('Cancelled batches cannot resume');
      if (!batch.runIds.some(run => this.runs.get(run)?.state === 'queued')) throw Error('No queued tasks to resume');
      if(!this.machineReady)await this.prepareMachine();
      // Pump only existing queued records. Completed and attempted tasks are never replayed.
      await this.pump();
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async recover(id: string): Promise<Run> {
    const operation = this.submissions.then(async () => {
      const current = this.runs.get(id);
      if (!current) throw Error('Unknown run');
      if (this.closed || this.halted || this.jobs.has(id)) throw Error('Recovery unavailable while task or service is active/closing');
      if (done(current.state) && current.state !== 'needs_recovery') return current;
      if(current.state!=='needs_recovery')throw Error('Task must require recovery');
      if(!this.machineReady)await this.prepareMachine();
      await this.reconcileRetained(id);
      await this.pump();
      return this.runs.get(id)!;
    });
    this.submissions = operation.catch(() => {});
    return operation;
  }
  async abandonCancelled(id:string):Promise<Run>{
    const operation=this.submissions.then(async()=>{
      const current=this.runs.get(id);
      if(!current||current.state!=='needs_recovery'||current.execution!=='cancelled'||current.grading!=='unavailable')
        throw Error('Only cancelled retained evidence without a grade may be abandoned');
      if(this.closed||this.halted||this.jobs.has(id))throw Error('Wait until the cancelled runner has stopped');
      if(!this.machineReady)await this.prepareMachine();
      await this.machine!.abandonCancelled(current);
      await this.update(id,{state:'cancelled',collection:'retained',note:'User explicitly discarded the cancelled workspace after collection failed; stop proof and local logs retained. No complete evidence, grade or continuation.',reward:undefined});
      await this.pump();return this.runs.get(id)!;
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  private async reconcileRetained(id: string): Promise<void> {
    const current = this.runs.get(id)!;
    const path = this.path(id), before = join(path, 'state.before-recovery.json');
    if (!await exists(before)) await save(before, current);
    const result = await this.machine!.recover(current, path);
    const classified = classify(result.execution === 'completed' ? undefined : result.execution,
      result.grading === 'unavailable' ? null : {reward: result.grading === 'passed' ? 1 : 0});
    await this.update(id, {state: result.execution === 'cancelled' ? 'cancelled' : classified.state,
      execution: result.execution, grading: result.grading, collection: 'complete',
      reward: result.grading === 'unavailable' ? undefined : result.grading === 'passed' ? 1 : 0,
      note: current.note ? `${current.note}; ${result.note ?? 'Recovered from verified durable evidence'}` : result.note,
      finishedAt: current.finishedAt ?? Date.now()/1000});
    await this.machine!.disposeRun(id);
  }
  batchView(batch: Batch) {
    return batchView(batch,this.runs,this.halted);
  }
  health(){return {data:this.config.data,schedulingBlocked:this.halted||[...this.runs.values()].some(r=>r.state==='needs_recovery')};}
  private async pump(): Promise<void> {
    if (this.pumping || this.closed || this.halted) return; this.pumping = true;
    try {
      if ([...this.runs.values()].some(r => r.state === 'needs_recovery')) return;
      for(const id of this.rechecks.keys()){if(this.jobs.size>=this.config.concurrency)break;this.startRecheck(id);}
      for (const r of this.runs.values()) {
        if (this.jobs.size >= this.config.concurrency) break;
        if (r.state !== 'queued' || this.jobs.has(r.id) || this.attempted.has(r.id)) continue;
        const batch = this.batches.get(r.batchId)!;
        if (batch.cancelledAt || [...this.jobs.keys()].filter(id => this.runs.get(id)?.batchId === r.batchId).length >= batch.concurrency) continue;
        this.attempted.add(r.id);
        const job = this.execute(r.id).catch(() => {
          this.halted = true;
          console.error('Run state could not be persisted; scheduling stopped. Inspect retained evidence.');
        }).finally(() => { this.jobs.delete(r.id); void this.pump(); }); this.jobs.set(r.id, job);
      }
    } finally {
      this.pumping=false;
      if(!this.closed&&!this.preparationJob&&!this.rechecks.size&&!this.maintenancePending&&!this.jobs.size&&![...this.runs.values()].some(r=>!done(r.state)||r.state==='needs_recovery')){
        this.maintenancePending=true;
        const operation=this.submissions.then(async()=>{
          if(this.closed||this.preparationJob||this.rechecks.size||[...this.runs.values()].some(r=>!done(r.state)||r.state==='needs_recovery'))return;
          await collectResources(this.config,this.taskCatalog!,[...this.runs.values()],true);
        }).catch(async error=>{
          await save(join(this.layout.state,'maintenance-error.json'),{at:new Date().toISOString(),message:String(error).slice(-1500)});
        }).finally(()=>{this.maintenancePending=false;});
        this.submissions=operation;
      }
    }
  }
  async cancel(id: string): Promise<void> {
    const recheck=this.rechecks.get(id);if(recheck){recheck.controller.abort();this.startRecheck(id);return;}
    const r = this.runs.get(id); if (!r) throw Error('Unknown run'); if (done(r.state)) return;
    await save(join(this.path(id), 'cancel'), { at: Date.now() });
    if (r.state === 'queued' && !this.jobs.has(id)) { await this.update(id, { state: 'cancelled', execution: 'cancelled', finishedAt: Date.now() / 1000 }); return; }
    await this.update(id, { state: 'cancelling' });
    await this.machine?.cancel(id);
  }
  private async execute(id: string): Promise<void> {
    const path = this.path(id);
    try {
      if (await exists(join(path, 'cancel'))) { await this.update(id, { state: 'cancelled', execution: 'cancelled', finishedAt: Date.now() / 1000 }); return; }
      await this.update(id, { state: 'preparing', startedAt: Date.now() / 1000 });
      const current = this.runs.get(id)!;
      const frozen = await readJson(join(path, 'task-files.json'), z.record(z.object({ bytes: z.number(), sha256: z.string(), symlink: z.string().optional(), mode:z.number().optional() })));
      if (!isDeepStrictEqual(await this.adapters[current.dataset].snapshot(join(path, 'task', current.task)),frozen)) throw Error('Frozen task changed');
      const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
      if (JSON.stringify(payload) !== JSON.stringify(this.batches.get(current.batchId)!.payload)) throw Error('Payload changed after submission');
      const batch=this.batches.get(current.batchId)!;
      await save(join(path, 'manifest.json'), { model: batch.model, payload, task: current.task, dataset: current.dataset, task_files: frozen, machine: this.config.machine, entry: 'tui', network: current.network, budget: current.budget,
        ...(continuationFor(batch,id)?{continueOf:continuationFor(batch,id)}:{}) });
      if (!this.machine) throw Error('Initialize the evaluation machine before running tasks');
      const result = await this.machine.execute(current, path, this.credentialFor(batch.model), async phase => {
        await appendPhase(path, phase);
        const state = phase === 'Running HiCode' ? 'running' : phase.includes('verif') || phase.includes('Verif') ? 'verifying' : 'preparing';
        if (this.runs.get(id)?.state !== 'cancelling') await this.update(id, { state });
      }, batch.model,continuationFor(batch,id));
      const execution = result.execution;
      const classified = classify(execution === 'completed' ? undefined : execution, result.grading === 'unavailable' ? null : { reward: result.grading === 'passed' ? 1 : 0 });
      await this.update(id, { state: execution === 'cancelled' ? 'cancelled' : classified.state, execution, grading: result.grading, note: result.note, reward: result.grading === 'unavailable' ? undefined : result.grading === 'passed' ? 1 : 0, collection: 'complete', finishedAt: Date.now() / 1000 });
      try {await this.machine.disposeRun(id);}
      catch(error){await this.update(id,{state:'needs_recovery',note:'Result archived; container cleanup failed: '+String(error).slice(-1000)});}
    } catch (error) {
      const retained = await exists(join(path, 'container.json'));
      const facts = error instanceof EvidenceCollectionError ? {execution: error.result.execution, grading: error.result.grading} : {execution: 'failed' as const};
      await this.update(id, { state: retained ? 'needs_recovery' : 'error', ...facts, reward: undefined, collection: retained ? 'retained' : 'pending', note: error instanceof Error ? error.message : 'Run failed', finishedAt: Date.now() / 1000 });
      if (retained && !(error instanceof EvidenceCollectionError) && this.machine) {
        // A failed Docker handoff can leave a sealed cancellation receipt moments later.
        // Only the existing recovery validator may clear the scheduling barrier.
        for (let attempt = 0; attempt < 8 && !this.closed; attempt++) {
          if (attempt) await Bun.sleep(3000);
          try { await this.reconcileRetained(id); break; }
          catch { /* No durable, verified outcome yet: keep needs_recovery. */ }
        }
      }
    }
  }
  async snapshot(): Promise<unknown> {
    const runs = [];
    for (const r of this.runs.values()) {
      const path = this.path(r.id);
      runs.push(await runView(path,r));
    }
    return { batches: [...this.batches.values()].sort((a,b) => b.createdAt - a.createdAt).map(b => this.batchView(b)), runs: runs.sort((a, b) => b.createdAt - a.createdAt), tasks: await this.catalog(),inventory:this.taskCatalog?.counts(new Set([...this.runs.values()].filter(r=>!done(r.state)&&r.state!=='queued').map(r=>taskKey({dataset:r.dataset,id:r.task})))), concurrency: this.config.concurrency, budget: this.config.budget, schedulingBlocked: this.halted || [...this.runs.values()].some(r => r.state === 'needs_recovery') };
  }
  async close(): Promise<void> { this.closed = true;this.preparationJob?.controller.abort(); await this.submissions;for(const [id,recheck] of this.rechecks){recheck.controller.abort();this.startRecheck(id);}await Promise.all([...this.runs.values()].filter(r => !done(r.state)).map(r => this.cancel(r.id))); await Promise.all(this.jobs.values());await this.preparationJob?.completion; }
}

async function appendPhase(path: string, phase: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await save(join(path, 'preparation.json'), { phase, updatedAt: Date.now() / 1000 });
  await appendFile(join(path, 'preparation.log'), phase + '\n');
}

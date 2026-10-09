import { mkdir, readdir, cp, rm } from 'node:fs/promises';
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
import { runSchema, done, batchSchema, submissionSchema } from './types.js';
import type { Config, Run, Batch, Submission } from './types.js';
import {batchView,catalogView,runView} from './view.js';

import { REPOSITORY_ROOT } from '../paths.js';
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
  private readonly attempted = new Set<string>();
  private pumping = false;
  constructor(readonly config: Config, private readonly credential: string) { }
  path(id: string): string { if (!this.runs.has(id)) throw Error('Unknown run'); return join(this.config.data, 'runs', id); }
  async init(): Promise<void> {
    if (contained(REPOSITORY_ROOT, this.config.data)) throw Error('Run data must be outside checkout');
    if(await exists(join(this.config.data,'.archive-cleanup.json')))throw Error('Resume archive-runs --apply before starting the service');
    await mkdir(join(this.config.data, 'runs'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.config.data, 'batches'), { recursive: true, mode: 0o700 });
    this.taskCatalog=await TaskCatalog.open(this.config.catalog);
    for (const name of await readdir(join(this.config.data, 'batches'))) {
      if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
      const batch = await readJson(join(this.config.data, 'batches', name), batchSchema);
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
      if (state.network !== batch.network) throw Error('Run network mode differs from its frozen batch');
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
    for(const batch of this.batches.values())if(batch.retryOf){
      const origin=batch.retryOf,parent=this.runs.get(origin.runId);
      if(retried.has(origin.runId)||batch.runIds.length!==1||batch.runIds[0]===origin.runId||batch.id===origin.batchId||
        (parent&&(parent.batchId!==origin.batchId||taskKey(batch.taskRefs[0]!)!==taskKey({dataset:parent.dataset,id:parent.task})||
          origin.attempt!==(this.batches.get(parent.batchId)!.retryOf?.attempt??1)+1)))
        throw Error('Invalid retry lineage');
      retried.add(origin.runId);
    }
  }
  async prepareMachine(): Promise<void> { this.machine = new LinuxMachine(this.config); await this.machine.prepare(); }
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

  async submit(input: Submission): Promise<Batch> {
    const operation = this.submissions.then(() => this.createBatch(submissionSchema.parse(input),null));
    this.submissions = operation.catch(() => {});
    return operation;
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
      if(!isDeepStrictEqual(parent.model,this.config.model))throw Error('Current service model differs from the original; restore the original model configuration before rerunning');
      return this.createBatch({name:original.task.slice(0,90)+' · 第 '+((parent.retryOf?.attempt??1)+1)+' 次尝试',
        network:original.network,concurrency:1,tasks:[{id:original.task,dataset:original.dataset,agentSeconds:original.budget.agentSeconds}]},original);
    });
    this.submissions=operation.catch(()=>{});return operation;
  }
  private async createBatch(input: Submission,original:Run|null): Promise<Batch> {
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    if ([...this.runs.values()].some(r => r.state === 'needs_recovery')) throw Error('Recover retained runs before submitting more');
    if (input.concurrency > this.config.concurrency) throw Error('Batch exceeds service concurrency');
    if(new Set(input.tasks.map(ref=>ref.dataset?taskKey({dataset:ref.dataset,id:ref.id}):ref.id)).size!==input.tasks.length)
      throw Error('Choose distinct tasks');
    const selected:CatalogTask[]=input.tasks.map(ref=>{
      const matches=this.taskCatalog!.list().filter(task=>task.id===ref.id&&(!ref.dataset||task.dataset===ref.dataset));
      if(matches.length!==1)throw Error(matches.length?'Ambiguous task ID; specify dataset':'Unknown task');
      return matches[0]!;
    });
    if(new Set(selected.map(taskKey)).size!==selected.length)throw Error('Choose distinct tasks');
    const environments=new EnvironmentStore(this.config.environments,this.config.context,this.config.datasetBackends);
    for(const task of selected){
      const network=taskAdapters[task.dataset].requiredNetwork;
      if(network&&(input.network??this.config.network)!==network)throw Error(task.dataset+' requires '+network+' execution');
      if(!task.source)throw Error('Prepare the selected task source before submission: '+taskKey(task));
      try{await environments.resolve(task);}
      catch(error){throw Error('Prepare the selected task environment before submission: '+taskKey(task)+' · '+String(error));}
    }
    const taskRefs=selected.map(task=>({id:task.id,dataset:task.dataset}));
    const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
    if(original&&!isDeepStrictEqual(this.batches.get(original.batchId)!.payload,payload))throw Error('Current payload differs from the original; restore the original payload before rerunning');
    if (this.closed || this.halted) throw Error('Service closing or scheduling blocked');
    const id = randomBytes(8).toString('hex'), now = Date.now() / 1000;
    const batch = batchSchema.parse({name:input.name, network: input.network ?? this.config.network, concurrency:input.concurrency,
      taskRefs,budget: this.config.budget, version: 2, id, createdAt: now, runIds: taskRefs.map(() => randomBytes(8).toString('hex')), model: this.config.model, payload,
      ...(original?{retryOf:{batchId:original.batchId,runId:original.id,attempt:(this.batches.get(original.batchId)!.retryOf?.attempt??1)+1}}:{}) });
    const states = input.tasks.map((task, i) => runSchema.parse({ version: 2, network: batch.network, id: batch.runIds[i], batchId: id, task: task.id, dataset: selected[i]!.dataset, state: 'queued', createdAt: now, updatedAt: now, model: this.config.model.model, budget: { agentSeconds: task.agentSeconds ?? batch.budget.agentSeconds } }));
    // Publish the batch only after all children are durable; no worker sees a partial submission.
    try {
      for (const state of states) {
        const root = join(this.config.data, 'runs', state.id), source = original?join(this.path(original.id),'task',original.task):this.taskCatalog!.get(state.dataset,state.task).source!, target = join(root, 'task', state.task);
        await taskAdapters[state.dataset].validate(state.task,source);
        const hashes = await taskAdapters[state.dataset].snapshot(source);
        if(original){
          const frozen=await readJson(join(this.path(original.id),'task-files.json'),z.record(z.object({bytes:z.number(),sha256:z.string(),symlink:z.string().optional(),mode:z.number().optional()})));
          if(!isDeepStrictEqual(hashes,frozen))throw Error('Original frozen task changed; refusing to rerun');
        }
        // Native build outputs depend on source timestamps as well as bytes.
        await cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
        const copied = await taskAdapters[state.dataset].snapshot(target);
        if (!isDeepStrictEqual(copied, hashes)) {
          const changed = [...new Set([...Object.keys(hashes), ...Object.keys(copied)])].find(name => !isDeepStrictEqual(hashes[name],copied[name]));
          throw Error(`Task changed during submission: ${state.task} (${changed ?? 'snapshot metadata'})`);
        }
        await save(join(root, 'task-files.json'), hashes);
        await save(join(root, 'state.json'), state);
      }
      await save(join(this.config.data, 'batches', id + '.json'), batch);
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
      await save(join(this.config.data, 'batches', id + '.json'), next); this.batches.set(id, next);
      await Promise.all(batch.runIds.map(run => this.cancel(run)));
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async report(id: string, text: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id); if (!batch) throw Error('Unknown batch');
      if (batch.runIds.some(run => !done(this.runs.get(run)!.state))) throw Error('Wait for every attempt to finish before publishing analysis');
      const next = batchSchema.parse({ ...batch, report: { text, updatedAt: Date.now() / 1000 } });
      await save(join(this.config.data, 'batches', id + '.json'), next); this.batches.set(id, next);
    });
    this.submissions = operation.catch(() => {}); await operation;
  }
  async resume(id: string): Promise<void> {
    const operation = this.submissions.then(async () => {
      const batch = this.batches.get(id);
      if (!batch) throw Error('Unknown batch');
      if (this.closed || this.halted || !this.machine || [...this.runs.values()].some(r => r.state === 'needs_recovery'))
        throw Error('Recover retained runs and initialize the machine before resuming');
      if (batch.cancelledAt) throw Error('Cancelled batches cannot resume');
      if (!batch.runIds.some(run => this.runs.get(run)?.state === 'queued')) throw Error('No queued tasks to resume');
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
      if (current.state !== 'needs_recovery' || !this.machine) throw Error('Task must require recovery and machine must be initialized');
      await this.reconcileRetained(id);
      await this.pump();
      return this.runs.get(id)!;
    });
    this.submissions = operation.catch(() => {});
    return operation;
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
    } finally { this.pumping = false; }
  }
  async cancel(id: string): Promise<void> {
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
      if (!isDeepStrictEqual(await taskAdapters[current.dataset].snapshot(join(path, 'task', current.task)),frozen)) throw Error('Frozen task changed');
      const payload = await readJson(join(this.config.payload, 'manifest.json'), z.record(z.unknown()));
      if (JSON.stringify(payload) !== JSON.stringify(this.batches.get(current.batchId)!.payload)) throw Error('Payload changed after submission');
      await save(join(path, 'manifest.json'), { model: this.config.model, payload, task: current.task, dataset: current.dataset, task_files: frozen, machine: this.config.machine, entry: 'tui', network: current.network, budget: current.budget });
      if (!this.machine) throw Error('Initialize the evaluation machine before running tasks');
      const result = await this.machine.execute(current, path, this.credential, async phase => {
        await appendPhase(path, phase);
        const state = phase === 'Running HiCode' ? 'running' : phase.includes('verif') || phase.includes('Verif') ? 'verifying' : 'preparing';
        if (this.runs.get(id)?.state !== 'cancelling') await this.update(id, { state });
      });
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
    return { batches: [...this.batches.values()].sort((a,b) => b.createdAt - a.createdAt).map(b => this.batchView(b)), runs: runs.sort((a, b) => b.createdAt - a.createdAt), tasks: await this.catalog(),inventory:this.taskCatalog?.counts(new Set([...this.runs.values()].filter(r=>!done(r.state)&&r.state!=='queued').map(r=>r.task))), concurrency: this.config.concurrency, budget: this.config.budget, schedulingBlocked: this.halted || [...this.runs.values()].some(r => r.state === 'needs_recovery') };
  }
  async close(): Promise<void> { this.closed = true; await this.submissions; await Promise.all([...this.runs.values()].filter(r => !done(r.state)).map(r => this.cancel(r.id))); await Promise.all(this.jobs.values()); }
}

async function appendPhase(path: string, phase: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await save(join(path, 'preparation.json'), { phase, updatedAt: Date.now() / 1000 });
  await appendFile(join(path, 'preparation.log'), phase + '\n');
}

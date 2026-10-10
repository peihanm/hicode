import {reasoningCapability} from "../../../src/llm/reasoningPolicy.js";
import { mkdir, appendFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {SweTask} from './sweTasks.js';
import type {RegradeInput} from './regrade.js';
import {taskAdapters} from './datasets.js';
import { run, readJson, save, runEvidenceTree, exists } from './store.js';
import type { Batch, Config, Run,ServiceRegradeResult } from './types.js';
import {regradeResultSchema,runSchema,containerSchema} from './types.js';
import type {Dataset} from './datasets.js';
import { EVAL_ROOT } from '../paths.js';
import {RunContainers} from './containers.js';
import {EnvironmentStore} from './environments.js';
import {TaskCatalog} from './catalog.js';
import type {CatalogTask} from './catalog.js';
import {regradeService} from './serviceRegrade.js';
import {EvalLayout} from './layout.js';
import {WorkerBundle} from './workerBundle.js';

const packetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('phase'), phase: z.string() }),
  z.object({ type: z.literal('verification_request'), runId: z.string().regex(/^[0-9a-f]{16}$/) }),
  z.object({ type: z.literal('screen'), screen: z.string().max(8 * 1024 * 1024) }),
  z.object({ type: z.literal('events'), data: z.string().max(1024 * 1024) }),
  z.object({ type: z.literal('verification'), text: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('result'), execution: z.enum(['completed', 'failed', 'timeout', 'cancelled']), grading: z.enum(['passed', 'failed', 'unavailable']), uid: z.number().int().positive() }),
]);
export type LinuxResult = Extract<z.infer<typeof packetSchema>, { type: 'result' }> & { note?: string };
/** A sealed runner result remains true even when its host evidence export fails. */
export class EvidenceCollectionError extends Error {
  constructor(readonly result: LinuxResult, detail: string) {super('Final evidence export failed: ' + detail);}
}
export class LinuxMachine {
  private release = '';
  private workerBundle:WorkerBundle|undefined;
  private readonly backends=new Map<Dataset,LinuxMachine>();
  private backend(dataset:Dataset):LinuxMachine{
    const settings=this.config.datasetBackends[dataset];if(!settings)return this;
    let machine=this.backends.get(dataset);
    if(!machine){machine=new LinuxMachine({...this.config,...settings,datasetBackends:{}});this.backends.set(dataset,machine);}
    machine.release=this.release;machine.workerBundle=this.workerBundle;return machine;
  }
  private async runBackend(id:string){
    const state=await readJson(join(this.config.data,'runs',id,'state.json'),runSchema);
    const backend=this.backend(state.dataset);
    const path=join(this.config.data,'runs',id,'container.json');
    if(await exists(path)){
      const receipt=await readJson(path,containerSchema);
      if(receipt.session!==id||receipt.id!==backend.containers.name(id)||receipt.attach!=='docker --context '+backend.config.context+' exec -it '+receipt.id+' bash')
        throw Error('Run backend differs from its sealed container receipt');
    }
    return backend;
  }
  private readonly containers:RunContainers;
  private readonly environments:EnvironmentStore;
  constructor(private readonly config: Config) {
    this.containers=new RunContainers(config);
    this.environments=new EnvironmentStore(config.environments,config.context);
  }
  async disposeRun(id:string):Promise<void>{
    const backend=await this.runBackend(id);if(backend!==this)return backend.disposeRun(id);
    await this.containers.remove(id);
    await save(join(this.config.data,'runs',id,'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});
  }
  private docker(...args: string[]) { return ['docker', '--context', this.config.context, ...args]; }
  async regrade(runId:string, reviewId:string, taskRoot:string, patchPath:string, task:SweTask, input:RegradeInput, output:string):Promise<void> {
    const backend=this.backend('swe-bench-verified');if(backend!==this)return backend.regrade(runId,reviewId,taskRoot,patchPath,task,input,output);
    if(!/^[a-f0-9]{16}$/.test(runId)||!/^[a-f0-9]{16}$/.test(reviewId))throw Error('Invalid recheck identity');
    const catalog=await TaskCatalog.open(this.config.catalog);
    const environment=await this.environments.resolve({...catalog.get('swe-bench-verified',task.instanceId),source:taskRoot});
    const container=await this.containers.create(reviewId,(environment.preparation??environment.dependencies).imageId);
    await save(join(output,'container.json'),{session:reviewId,id:container,attach:'docker --context '+this.config.context+' exec -it '+container+' bash'});
    await save(join(output,'environment.json'),environment);
    const remote=`/eval/rechecks/${runId}/${reviewId}`;
    await run(this.docker('exec',container,'mkdir','-p',`/eval/rechecks/${runId}`,'/testbed','/tests','/logs/verifier','/opt/hicode-swe/env'));
    await run(this.docker('exec',container,'mkdir',remote,remote+'/worker'));
    for(const name of ['regrade.py','swe.py','scm.py','venv_paths.py','protocol.py','xarray_report.py','django_report.py'])await run(this.docker('cp',join(EVAL_ROOT,'src/worker',name),container+':'+remote+'/worker/'+name));
    await run(this.docker('cp',join(EVAL_ROOT,'src/datasets/reviewed_test_deps.py'),container+':'+remote+'/worker/reviewed_test_deps.py'));
    await run(this.docker('cp',join(taskRoot,'repository'),container+':'+remote+'/baseline'),{timeout:60000});
    await run(this.docker('cp',join(taskRoot,'hidden'),container+':'+remote+'/tests'));
    await run(this.docker('cp',patchPath,container+':'+remote+'/model.patch'));
    await save(join(output,'job.json'),{dataset:'swe-bench-verified',swe:task,verifierSeconds:task.verifierSeconds,model:this.config.model,verifierProxy:input.verifierProxy});
    for(const name of ['job.json','input.json'])await run(this.docker('cp',join(output,name),container+':'+remote+'/'+name));
    // No runner, tmux, provider credential or Actor release is involved.
    await run(this.docker('exec',container,'/opt/hicode-swe/grader/bin/python',remote+'/worker/regrade.py',remote),{timeout:(task.verifierSeconds+300)*1000});
    for(const name of ['result.json','source-version.json','logs']){
      const present=await run(this.docker('exec',container,'python3','-c','import os,sys;print(int(os.path.exists(sys.argv[1])))',remote+'/'+name));
      if(present==='1')await run(this.docker('cp',container+':'+remote+'/'+name,join(output,name)),{timeout:60000});
    }
    // Check again after replay: neither the archived patch nor its frozen identity may change.
    if(createHash('sha256').update(await readFile(patchPath)).digest('hex')!==input.patchSha256)throw Error('Archived patch changed during regrade');
    const result=await readJson(join(output,'result.json'),regradeResultSchema);
    if(result.runId!==runId||result.instanceId!==task.instanceId||result.patchSha256!==input.patchSha256||result.originalExecution!==input.originalExecution)
      throw Error('Regrade result identity mismatch; container retained');
    await save(join(output,'collection.json'),{complete:true,files:await runEvidenceTree(join(output,'logs'))});
    await this.containers.remove(reviewId);
  }
  async freeze():Promise<void>{this.workerBundle??=await WorkerBundle.capture(EVAL_ROOT);}
  async regradeService(state:Run,task:CatalogTask,restartScript:string,reviewId:string,signal:AbortSignal):Promise<ServiceRegradeResult>{
    const backend=this.backend(state.dataset);if(backend!==this)return backend.regradeService(state,task,restartScript,reviewId,signal);
    await this.freeze();if(!this.workerBundle)throw Error('Worker package not frozen');
    return regradeService(this.config,state,task,restartScript,this.workerBundle,reviewId,signal);
  }
  async disposeServiceRecheck(state:Run,reviewId:string):Promise<void>{
    const backend=this.backend(state.dataset);if(backend!==this)return backend.disposeServiceRecheck(state,reviewId);
    const path=new EvalLayout(this.config.data).recheck(state.id,reviewId),receipt=join(path,'container.json');
    if(await exists(receipt))await readJson(receipt,z.object({reviewId:z.literal(reviewId),container:z.literal(this.containers.name(reviewId)),context:z.literal(this.config.context)}).strict());
    await this.containers.remove(reviewId);await save(join(path,'container-disposed.json'),{reviewId,at:new Date().toISOString()});
  }
  async prepare(): Promise<void> {
    await this.freeze();
    const bundle=this.workerBundle;if(!bundle)throw Error('Worker package not frozen');
    const manifest = await readJson(join(this.config.payload, 'manifest.json'), z.object({ files: z.record(z.string()) }));
    const archive = await readFile(join(this.config.payload, 'source.tar.gz'));
    const hash = createHash('sha256').update(archive).digest('hex');
    if (manifest.files['source.tar.gz'] !== hash) throw Error('Source payload changed');
    // Each attempt bootstraps this release inside its own dataset image.
    this.release = '/opt/hicode/releases/' + hash;
  }
  async cancel(id: string): Promise<void> {
    const backend=await this.runBackend(id);if(backend!==this)return backend.cancel(id);
    if(!await this.containers.exists(id))return;
    await this.containers.assert(id);
    await run(this.docker('exec', this.containers.name(id), 'sh', '-c', `test ! -d /eval/runs/${id} || touch /eval/runs/${id}/cancel`), { timeout: 10000 });
  }
  private async collect(id: string, path: string): Promise<void> {
    const stage = join(path, 'collecting'); await rm(stage, { recursive: true, force: true }); await mkdir(stage);
    // Native build outputs can span several GiB; export has a separate bounded window.
    await run(this.docker('cp', this.containers.name(id) + ':/eval/runs/' + id + '/.', stage), { timeout: 300000 });
    const files = await runEvidenceTree(stage);
    const previous = join(path, 'evidence.previous');
    // A prior interrupted rotation may have left both generations. The new stage
    // has been fully validated before replacing either one.
    if (await exists(previous) && await exists(join(path, 'evidence'))) await rm(previous, {recursive: true});
    if (await exists(join(path, 'evidence'))) await rename(join(path, 'evidence'), previous);
    await rename(stage, join(path, 'evidence')); await rm(previous, { recursive: true, force: true });
    await save(join(path, 'collection.json'), { complete: true, files });
  }
  private async handoffVerification(id: string, tests: string, credential: string): Promise<void> {
    const remote = '/eval/runs/' + id;
    const acknowledge = async (status: 'accepted' | 'ready' | 'failed', message?: string) => {
      const value = JSON.stringify({version: 1, runId: id, status, ...(message ? {message} : {})});
      await run(this.docker('exec', this.containers.name(id), 'python3', '-c',
        "import sys;sys.path.insert(0,'/opt/hicode-eval');from protocol import atomic_json;import json;atomic_json(sys.argv[1],json.loads(sys.argv[2]))",
        remote + '/verification.json', value), {timeout: status === 'accepted' ? 25000 : 30000});
    };
    await acknowledge('accepted');
    try {
      await run(this.docker('cp', tests, this.containers.name(id) + ':' + remote + '/tests'), {timeout: 90000});
      await run(this.docker('exec', this.containers.name(id), 'chmod', '-R', 'a+rX', remote + '/tests'), {timeout: 30000});
    } catch (error) {
      await acknowledge('failed', String(error).replaceAll(credential, '[redacted]').slice(-1500));
      return;
    }
    await acknowledge('ready');
  }
  async recover(state: Run, path: string): Promise<LinuxResult> {
    const backend=await this.runBackend(state.id);if(backend!==this)return backend.recover(state,path);
    if (!this.release || state.state !== 'needs_recovery') throw Error('Task is not eligible for recovery');
    if(await exists(join(path,'setup-failed.json'))){
      await readJson(join(path,'setup-failed.json'),z.object({version:z.literal(1),runId:z.literal(state.id),runnerSpawned:z.literal(false),error:z.string()}).strict());
      await this.containers.remove(state.id);
      return {type:'result',execution:'failed',grading:'unavailable',uid:20000,note:'Environment setup failed before the runner was spawned; disposable resources removed.'};
    }
    if(state.collection==='complete'){
      const receipt=await readJson(join(path,'collection.json'),z.object({complete:z.literal(true),files:z.record(z.unknown())}));
      if(JSON.stringify(await runEvidenceTree(join(path,'evidence')))!==JSON.stringify(receipt.files))throw Error('Archived evidence changed');
      const result=packetSchema.parse({type:'result',...await readJson(join(path,'evidence/result.json'),z.record(z.unknown()))});
      if(result.type!=='result')throw Error('Invalid archived outcome');
      return result;
    }
    await this.containers.assert(state.id);
    const output = await run(this.docker('exec', this.containers.name(state.id), 'python3', '/opt/hicode-eval/recovery.py', state.id), {timeout: 30000});
    const result = packetSchema.parse({ ...JSON.parse(output), type: 'result' });
    if (result.type !== 'result') throw Error('Invalid recovery result');
    await this.collect(state.id, path);
    return { ...result, note: 'Recovered from verified durable evidence; no Agent or verifier rerun.' };
  }
  async execute(state: Run, path: string, credential: string, onPhase: (phase: string) => Promise<void>, model: Batch["model"]): Promise<LinuxResult> {
    const backend=this.backend(state.dataset);if(backend!==this)return backend.execute(state,path,credential,onPhase,model);
    if (!this.release||!this.workerBundle) throw Error('Evaluation machine not initialized');
    const remote = '/eval/runs/' + state.id;
    const task = join(path, 'task', state.task);
    const execution=await taskAdapters(new EvalLayout(this.config.data))[state.dataset].execution(state,task);
    const catalog=await TaskCatalog.open(this.config.catalog);
    const environment=await this.environments.resolve({...catalog.get(state.dataset,state.task),source:task});
    const container=this.containers.name(state.id);
    let proc:Bun.Subprocess<'ignore','pipe','pipe'>;
    try {
    await save(join(path,'environment.json'),environment);
    await save(join(path,'container.json'),{session:state.id,id:container,attach:'docker --context '+this.config.context+' exec -it '+container+' bash'});
    await this.containers.create(state.id,(environment.preparation??environment.dependencies).imageId);
    await run(this.docker('exec',container,'mkdir','-p','/opt/hicode-eval','/opt/hicode-eval/eval_datasets'));
    const worker=join(path,'worker');await this.workerBundle.writeTo(worker);
    await save(join(path,'worker.json'),{version:1,sha256:this.workerBundle.sha256});
    await run(this.docker('cp',worker+'/.',container+':/opt/hicode-eval/'));
    const archive='/opt/hicode-eval/source-'+this.release.split('/').at(-1)+'.tar.gz';
    await run(this.docker('cp',join(this.config.payload,'source.tar.gz'),container+':'+archive));
    const release=await run(this.docker('exec',container,'python3','/opt/hicode-eval/bootstrap.py',archive,this.release.split('/').at(-1)!),{timeout:660000});
    if(release!==this.release)throw Error('Run source release identity changed');
    await run(this.docker('exec',container,'mkdir','-p',remote+'/project'));
    await execution.stage({container,remote,runPath:path,docker:(...args)=>this.docker(...args)});
    await run(this.docker('cp', join(task, 'instruction.md'), container + ':' + remote + '/instruction.md'));
    await save(join(path, 'job.json'), { model, reasoningPolicy: {...reasoningCapability(model.source, model.model), effort: model.reasoning?.effort ?? 'default'}, network: state.network, release: this.release,
      agentSeconds: state.budget.agentSeconds, originalAgentSeconds:execution.originalAgentSeconds,
      verifierSeconds:execution.verifierSeconds,...execution.job });
    await run(this.docker('cp', join(path, 'job.json'), container + ':' + remote + '/job.json'));
    if (await exists(join(path, 'cancel'))) await this.cancel(state.id);
    await mkdir(join(path, 'live'), { recursive: true });
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
    env[model.apiKeyEnv] = credential;
    proc = Bun.spawn(this.docker('exec', '--env', model.apiKeyEnv, container, execution.runnerPython, '/opt/hicode-eval/runner.py', state.id), { env, stdout: 'pipe', stderr: 'pipe' });
    } catch(error){
      try {await save(join(path,'setup-failed.json'),{version:1,runId:state.id,runnerSpawned:false,error:String(error).replaceAll(credential,'[redacted]').slice(-2000)});}
      finally {await this.containers.remove(state.id);}
      if(await exists(join(path,'container.json')))await rename(join(path,'container.json'),join(path,'container-setup.json'));
      throw error;
    }
    let result: LinuxResult | undefined, note = '', verificationSent = false;
    const stderr = new Response(proc.stderr).text();
    const timer = setTimeout(() => { void this.cancel(state.id).catch(() => {}); }, (state.budget.agentSeconds + execution.verifierSeconds + execution.setupAllowance) * 1000);
    let buffer = '';
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value: chunk, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 12 * 1024 * 1024) throw Error('Runner output exceeds limit');
        for (;;) {
          const index = buffer.indexOf('\n'); if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
          const packet = packetSchema.parse(JSON.parse(line));
          if (packet.type === 'phase') {
            await onPhase(packet.phase);
          } else if (packet.type === 'verification_request') {
            if (packet.runId !== state.id || verificationSent) throw Error('Invalid or duplicate verification handoff');
            verificationSent = true;
            await this.handoffVerification(state.id, execution.verifierSource, credential);
          } else if (packet.type === 'screen') {
            await Bun.write(join(path, 'live/screen.tmp'), packet.screen);
            await rename(join(path, 'live/screen.tmp'), join(path, 'live/screen.txt'));
          }
          else if (packet.type === 'events') await appendFile(join(path, 'live/events.jsonl'), Buffer.from(packet.data, 'base64'));
          else if (packet.type === 'verification') await Bun.write(join(path, 'verification.txt'), packet.text);
          else if (packet.type === 'error') note = (note + (note ? '\n' : '') + packet.message.replaceAll(credential, '[redacted]')).slice(0,4000);
          else result = packet;
        }
      }
      const code = await proc.exited;
      if (code || !result || buffer.trim()) throw Error(note || (await stderr).replaceAll(credential, '[redacted]').slice(-1000) || 'Runner ended without confirmed completion');
      try {await this.collect(state.id, path);}
      catch (error) {throw new EvidenceCollectionError(result, String(error).replaceAll(credential, '[redacted]').slice(-2000));}
      if (note) await Bun.write(join(path, 'error.txt'), note);
      return { ...result, ...(note ? { note } : {}) };
    } catch (error) {
      if (!(error instanceof EvidenceCollectionError)) {
        if (!result) await this.cancel(state.id).catch(() => {});
        await this.collect(state.id, path).catch(() => {});
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}

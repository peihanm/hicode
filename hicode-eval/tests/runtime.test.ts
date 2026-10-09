import { test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ROOT } from '../src/paths.js';
import {seedCatalog} from './helpers/catalog.js';
import {environmentFixture} from './helpers/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {TaskCatalog} from '../src/host/catalog.js';
import { classify, Lab } from '../src/host/manager.js';
import { run, save, tree } from '../src/host/store.js';
import { runSchema, configSchema, batchSchema, submissionSchema } from '../src/host/types.js';
import * as taskAdapters from '../src/host/publicTasks.js';
import {taskAdapters as datasetHandlers} from '../src/host/datasets.js';
import { startDashboard as serve } from './helpers/server.js';
import { EvidenceCollectionError, LinuxMachine } from '../src/host/linux.js';

let dispose:ReturnType<typeof spyOn>,resolveEnvironment:ReturnType<typeof spyOn>;
beforeEach(()=>{
  dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockResolvedValue(undefined);
  resolveEnvironment=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environmentFixture('terminal-bench:fixture'));
});
afterEach(()=>{dispose.mockRestore();resolveEnvironment.mockRestore();});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hicode-eval-')));
  await mkdir(join(dir, 'tasks')); await mkdir(join(dir, 'runs'));
  const config = configSchema.parse({ version: 4, data: dir, catalog:join(dir,'catalog.json'),environments:join(dir,'environments'), payload: join(dir, 'payload'), context: 'test', machine: 'test-machine', concurrency: 2, budget: {}, model: { source: 'qwen', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', baseUrl: 'http://127.0.0.1:1' } });
  await seedCatalog(config,['alpha','cancel-async-tasks','regex-log','sqlite-db-truncate'].map(id=>({id,source:join(dir,'tasks',id)})));
  return { dir, config, tasks:join(dir,'tasks'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function finished(id = '0123456789abcdef') {
  return runSchema.parse({ version: 2, id, batchId: 'fedcba9876543210', task: 'alpha', dataset:'terminal-bench', state: 'passed', createdAt: 1, updatedAt: 1, model: 'fixture', budget: {}, execution: 'completed', grading: 'passed', collection: 'complete' });
}

async function persist(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof finished>) {
  await save(join(f.dir, 'batches', s.batchId + '.json'), batchSchema.parse({ version: 2, id: s.batchId, name: 'fixture', budget: f.config.budget, taskRefs: [{dataset:s.dataset,id:s.task}], runIds: [s.id], concurrency: 1, createdAt: 1, model: f.config.model, payload: {} }));
  await save(join(f.dir, 'runs', s.id, 'state.json'), s);
}

test('timeout and grade remain independent', () => {
  expect(classify('timeout', { reward: 1 })).toEqual({ execution: 'timeout', grading: 'passed', state: 'error' });
  expect(classify(undefined, null)).toEqual({ execution: 'completed', grading: 'unavailable', state: 'error' });
  expect(classify(undefined, {reward: 0}).state).toBe('failed');
});
test('restart repairs the durable ledger and requires cleanup confirmation without rerunning a completed attempt',async()=>{
  const f=await fixture();
  try {
    const state=finished();await persist(f,state);
    await save(join(f.dir,'runs',state.id,'container.json'),{session:state.id,id:'owned-container',attach:'fixture'});
    const lab=new Lab(f.config,'fixture');await lab.init();
    expect(lab.runs.get(state.id)?.state).toBe('needs_recovery');
    expect((await TaskCatalog.open(f.config.catalog)).get('terminal-bench','alpha').status).toBe('passed');
    await save(join(f.dir,'runs',state.id,'state.json'),state);
    await save(join(f.dir,'runs',state.id,'container-disposed.json'),{version:1,runId:state.id,at:new Date().toISOString()});
    const restored=new Lab(f.config,'fixture');await restored.init();
    expect(restored.runs.get(state.id)?.state).toBe('passed');
  }finally{await f.cleanup();}
});
test('host command timeout reports its deadline instead of an ambiguous SIGKILL exit', async () => {
  await expect(run(['bun','-e','await Bun.sleep(1000)'],{timeout:80})).rejects.toThrow('bun timed out after 80ms');
});
test('Token Plan model survives evaluation config and batch persistence', async () => {
  const f=await fixture();
  try {
    const model={source:'qwen-token-plan',model:'deepseek-v4.1-flash',apiKeyEnv:'QWEN_TOKEN_PLAN_API_KEY',baseUrl:'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',imageInput:true} as const;
    const config=configSchema.parse({...f.config,model});
    await save(join(f.dir,'config.json'),config);
    expect(configSchema.parse(JSON.parse(await readFile(join(f.dir,'config.json'),'utf8'))).model).toEqual(model);
    const state=finished();
    expect(batchSchema.parse({version:2,id:state.batchId,name:'Token Plan',budget:config.budget,taskRefs:[{dataset:state.dataset,id:state.task}],runIds:[state.id],concurrency:1,createdAt:1,model,payload:{}}).model).toEqual(model);
    expect(()=>configSchema.parse({...config,model:{...model,source:'unknown-provider'}})).toThrow();
  } finally {await f.cleanup();}
});
test('relocated CLI starts from an unrelated directory without model work', () => {
  const entry = fileURLToPath(new URL('../eval.sh', import.meta.url));
  const result = Bun.spawnSync(['bash', entry, '--help'], { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('catalog | submit');
  expect(result.stderr.toString()).toBe('');
});
test('relocated host still rejects run data inside the HiCode checkout', async () => {
  const f = await fixture();
  try {
    const lab = new Lab({ ...f.config, data: REPOSITORY_ROOT }, 'fixture');
    await expect(lab.init()).rejects.toThrow('Run data must be outside checkout');
  } finally { await f.cleanup(); }
});
test('persisted payloads reject symlink parents and snapshot symlinks', async () => {
  const f = await fixture(); try {
    await mkdir(join(f.dir, 'real')); await symlink(join(f.dir, 'real'), join(f.dir, 'link'));
    await expect(save(join(f.dir, 'link/x.json'), {})).rejects.toThrow('Symlink');
    await expect(tree(f.dir)).rejects.toThrow('Symlink');
  } finally { await f.cleanup(); }
});
test('restart retains interrupted task and prevents new submissions', async () => {
  const f = await fixture(); try {
    const s = runSchema.parse({ ...finished(), state: 'running' });
    await persist(f, s);
    const lab = new Lab(f.config, 'fake'); await lab.init();
    expect(lab.runs.get(s.id)?.state).toBe('needs_recovery');
    await expect(lab.submit({ name: 'test', tasks: [{id:'alpha'}], concurrency: 1 })).rejects.toThrow('Recover');
  } finally { await f.cleanup(); }
});



test('viewer returns one current snapshot, not offset replay; rejects cross origin', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake'); const s = finished(); await persist(f, s); await lab.init();
  await save(join(f.dir, 'placeholder.json'), {}); await mkdir(join(f.dir, 'runs', s.id, 'live')); await writeFile(join(f.dir, 'runs', s.id, 'live/screen.txt'), 'final screen\n');
  // Bind then use the real local HTTP protocol. Port is test-local, no user server touched.
  const server = serve(lab, 0); const port = server.port;
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`); const cookie = home.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal?run=${s.id}`, { headers: { cookie } }); expect(await response.json()).toMatchObject({ screen: 'final screen\n' });
    await writeFile(join(lab.path(s.id),'collection-error.txt'),'temporary snapshot failure');
    await writeFile(join(lab.path(s.id),'verification.txt'),'AssertionError: deliverable mismatch');
    const logs=await (await fetch(`http://127.0.0.1:${port}/api/preparation?run=${s.id}`,{headers:{cookie}})).json();
    expect(logs.text).toContain('不代表执行失败');expect(logs.text).toContain('AssertionError: deliverable mismatch');
    await rm(join(lab.path(s.id),'verification.txt'));
    await symlink(join(f.dir,'placeholder.json'),join(lab.path(s.id),'verification.txt'));
    expect((await fetch(`http://127.0.0.1:${port}/api/preparation?run=${s.id}`,{headers:{cookie}})).status).toBe(400);
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie, origin: 'https://example.com' } }); expect(forbidden.status).toBe(403);
  } finally { server.stop(true); await f.cleanup(); }
});





test('catalog exposes only public tasks with an explicit reviewed adapter', async () => {
  const f = await fixture(); try {
    for (const name of ['cancel-async-tasks','unsupported']) {
      await mkdir(join(f.dir,'tasks',name));
      await writeFile(join(f.dir,'tasks',name,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
    }
    const lab=new Lab(f.config,'fake');
    expect((await lab.catalog()).map(t=>t.id)).toContain('cancel-async-tasks');
    expect((await lab.catalog()).map(t=>t.id)).not.toContain('unsupported');
  } finally { await f.cleanup(); }
});

test('batch analysis survives restart without changing scores; mismatched ownership fails closed', async () => {
  const f = await fixture(); const state = finished();
  try {
    await persist(f, state);
    const lab = new Lab(f.config, 'fake'); await lab.init();
    await lab.report(state.batchId, '# Analysis\nObserved a framework issue.');
    const restored = new Lab(f.config, 'fake'); await restored.init();
    expect(restored.batches.get(state.batchId)?.report?.text).toContain('framework');
    expect(restored.runs.get(state.id)?.grading).toBe('passed');
    expect(restored.batchView(restored.batches.get(state.batchId)!).counts).toMatchObject({ total: 1, completed: 1, passed: 1 });
    await save(join(f.dir, 'runs', state.id, 'state.json'), { ...state, task: 'other' });
    await expect(new Lab(f.config, 'fake').init()).rejects.toThrow('mismatched');
  } finally { await f.cleanup(); }
});

test('submission validates all tasks and concurrency before publishing a batch', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake');
  try {
    await lab.init();
    await expect(lab.submit({ name: 'invalid', tasks: [{id:'missing'}], concurrency: 1 })).rejects.toThrow('Unknown task');
    await expect(lab.submit({ name: 'invalid', tasks: [{id:'a'}], concurrency: 3 })).rejects.toThrow('concurrency');
    await expect(lab.submit({ name: 'invalid', tasks: [{id:'a',agentSeconds:900},{id:'a',agentSeconds:1800}], concurrency: 1 })).rejects.toThrow('distinct');
    expect(() => submissionSchema.parse({ name:'invalid',tasks:[{id:'a',agentSeconds:29}] })).toThrow();
    expect(() => submissionSchema.parse({ name:'invalid',tasks:[{id:'a',agentSeconds:10801}] })).toThrow();
    expect(lab.batches.size).toBe(0); expect(lab.runs.size).toBe(0);
  } finally { await lab.close(); await f.cleanup(); }
});

test('a reused task ID requires an explicit dataset at submission',async()=>{
  const f=await fixture();
  try {
    const catalog=await TaskCatalog.open(f.config.catalog);
    await catalog.register([{dataset:'terminal-bench-2.1',id:'regex-log',source:join(f.tasks,'regex-log')}]);
    const lab=new Lab(f.config,'fixture');await lab.init();
    await expect(lab.submit({name:'ambiguous',tasks:[{id:'regex-log'}],concurrency:1})).rejects.toThrow('Ambiguous task ID');
    await lab.close();
  }finally{await f.cleanup();}
});

test('stale environment is rejected before a batch or run is published',async()=>{
  const f=await fixture();
  try {
    resolveEnvironment.mockRejectedValue(new Error('Task environment is stale'));
    const lab=new Lab(f.config,'fixture');await lab.init();
    await expect(lab.submit({name:'stale',tasks:[{id:'regex-log'}],concurrency:1})).rejects.toThrow('Task environment is stale');
    expect(lab.batches.size).toBe(0);
    expect(lab.runs.size).toBe(0);
    await lab.close();
  }finally{await f.cleanup();}
});

test('one batch keeps equal task IDs from two releases separate',async()=>{
  const f=await fixture(),source=join(f.tasks,'regex-log');
  await mkdir(source);await writeFile(join(source,'instruction.md'),'offline fixture');
  await seedCatalog(f.config,[
    {dataset:'terminal-bench',id:'regex-log',source},
    {dataset:'terminal-bench-2.1',id:'regex-log',source},
  ]);
  const profile={hashes:{},inputs:[],publicTestInputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],
    verifierPrelude:'none' as const,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{},verifierRootOverlay:false,verifierChroot:false};
  const first=spyOn(datasetHandlers['terminal-bench'],'validate').mockResolvedValue(profile);
  const second=spyOn(datasetHandlers['terminal-bench-2.1'],'validate').mockResolvedValue(profile);
  const lab=new Lab(f.config,'fixture');
  try {
    await save(join(f.config.payload,'manifest.json'),{});
    await lab.init();
    const batch=await lab.submit({name:'two releases',concurrency:1,tasks:[
      {dataset:'terminal-bench',id:'regex-log'},
      {dataset:'terminal-bench-2.1',id:'regex-log'},
    ]});
    expect(batch.taskRefs).toEqual([{dataset:'terminal-bench',id:'regex-log'},{dataset:'terminal-bench-2.1',id:'regex-log'}]);
    expect(batch.runIds.map(id=>lab.runs.get(id)?.dataset)).toEqual(['terminal-bench','terminal-bench-2.1']);
  }finally{await lab.close();first.mockRestore();second.mockRestore();await f.cleanup();}
});

test('CLI client reads a batch and publishes a bounded report over the authenticated protocol', async () => {
  const { Client } = await import('../src/host/client.js');
  const f = await fixture(), s = finished(); await persist(f, s);
  const lab = new Lab(f.config, 'fake'); await lab.init();
  const server = serve(lab, 0); const client = new Client(server.port!);
  try {
    const status = await client.status(s.batchId);
    expect(status.batches[0].state).toBe('finished'); expect(status.runs).toHaveLength(1);
    await client.request('report', { batch: s.batchId, text: 'Verified logs, no task correction.' });
    expect((await client.status(s.batchId)).batches[0].report?.text).toContain('Verified');
    await expect(client.request('report', { batch: s.batchId, text: 'x'.repeat(200001) })).rejects.toThrow();
    await expect(client.status('1111111111111111')).rejects.toThrow('Unknown batch');
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    expect(html).not.toContain('id="submit"'); expect(html).toContain('id="batches"');
  } finally { server.stop(true); await f.cleanup(); }
});

test('queued batch cancellation prevents execution and premature reporting is rejected', async () => {
  const f = await fixture(); const lab = new Lab(f.config, 'fake');
  try {
    await persist(f, finished()); await lab.init();
    const previous = finished(), queued = runSchema.parse({ ...previous, state: 'queued', execution: 'pending', grading: 'pending' });
    lab.runs.set(queued.id, queued);
    await expect(lab.report(queued.batchId, 'too soon')).rejects.toThrow('finish');
    await lab.cancelBatch(queued.batchId);
    expect(lab.runs.get(queued.id)?.state).toBe('cancelled');
    expect(lab.batches.get(queued.batchId)?.cancelledAt).toBeDefined();
    expect(await Bun.file(join(lab.path(queued.id), 'job.json')).exists()).toBe(false);
  } finally { await lab.close(); await f.cleanup(); }
});

test('one batch executes and restores independently resolved task limits', async () => {
  const f = await fixture(), lab = new Lab(f.config, 'fixture');
  const validate = spyOn(taskAdapters, 'validatePublicTask').mockResolvedValue({hashes:{}, inputs:[], initializer:null, directories:[], packages:[], verifierPackages:[], verifierPrelude:'none', publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false, workspaceAliases:[],systemPackages:[], commands:[], environment:{}, verifierEnvironment:{}});
  const prepare = spyOn(LinuxMachine.prototype, 'prepare').mockResolvedValue(undefined);
  const execute = spyOn(LinuxMachine.prototype, 'execute').mockResolvedValue({type:'result',execution:'completed',grading:'passed',uid:20001});
  try {
    for (const id of ['cancel-async-tasks','regex-log','sqlite-db-truncate']) {
      await mkdir(join(f.tasks,id));
      await writeFile(join(f.tasks,id,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
    }
    await save(join(f.config.payload,'manifest.json'),{});
    await lab.init(); await lab.prepareMachine();
    const batch = await lab.submit({name:'mixed limits',network:'isolated',concurrency:2,tasks:[
      {id:'cancel-async-tasks',agentSeconds:900},
      {id:'regex-log',agentSeconds:1800},
      {id:'sqlite-db-truncate'},
    ]});
    for (let i=0;i<100&&batch.runIds.some(id=>lab.runs.get(id)?.state!=='passed');i++) await Bun.sleep(5);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(batch.network).toBe('isolated');
    expect(execute.mock.calls.every(([run])=>run.network==='isolated')).toBe(true);
    expect(Object.fromEntries(execute.mock.calls.map(([run])=>[run.task,run.budget.agentSeconds]))).toEqual({
      'cancel-async-tasks':900,'regex-log':1800,'sqlite-db-truncate':1800,
    });
    expect([...lab.batches.keys()]).toEqual([batch.id]);
    const restored = new Lab(f.config,'fixture'); await restored.init();
    expect(batch.runIds.map(id=>restored.runs.get(id)?.budget.agentSeconds)).toEqual([900,1800,1800]);
    expect(batch.runIds.every(id=>restored.runs.get(id)?.network==='isolated')).toBe(true);
    expect(restored.batchView(restored.batches.get(batch.id)!).counts.passed).toBe(3);
  } finally {await lab.close(); validate.mockRestore();prepare.mockRestore();execute.mockRestore();await f.cleanup();}
});


test('restart preserves unstarted queue; explicit resume does not replay completed tasks', async () => {
  const f = await fixture(), previous = finished();
  const queued = runSchema.parse({ ...previous, id: '1111111111111111', task: 'beta', state: 'queued', execution: 'pending', grading: 'pending', collection: 'pending' });
  const prepare = spyOn(LinuxMachine.prototype, 'prepare').mockResolvedValue(undefined);
  const execute = spyOn(LinuxMachine.prototype, 'execute').mockResolvedValue({type: 'result', execution: 'completed', grading: 'passed', uid: 20001});
  let lab: Lab | undefined;
  try {
    await persist(f, previous);
    await save(join(f.dir, 'batches', previous.batchId+'.json'), {version:2,id:previous.batchId,name:'fixture',budget:f.config.budget,taskRefs:[{dataset:'terminal-bench',id:'alpha'},{dataset:'terminal-bench',id:'beta'}],runIds:[previous.id,queued.id],concurrency:1,createdAt:1,model:f.config.model,payload:{}});
    await save(join(f.dir, 'runs', queued.id, 'state.json'), queued);
    await mkdir(join(f.dir, 'runs', queued.id, 'task/beta'), {recursive:true});
    await save(join(f.dir, 'runs', queued.id, 'task-files.json'), {});
    await save(join(f.config.payload, 'manifest.json'), {});
    lab=new Lab(f.config,'fake');await lab.init();
    expect(lab.runs.get(queued.id)?.state).toBe('queued');
    expect(execute).not.toHaveBeenCalled();
    await expect(lab.resume(previous.batchId)).rejects.toThrow('initialize');
    await lab.prepareMachine();await lab.resume(previous.batchId);
    for (let i=0;i<100&&lab.runs.get(queued.id)?.state!=='passed';i++) await Bun.sleep(5);
    expect(lab.runs.get(queued.id)?.state).toBe('passed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].id).toBe(queued.id);
    expect(lab.runs.get(previous.id)).toEqual(previous);
  } finally {await lab?.close();prepare.mockRestore();execute.mockRestore();await f.cleanup();}
});

test('a queued record with execution evidence requires recovery and cannot resume', async () => {
  const f=await fixture(), queued=runSchema.parse({...finished(),state:'queued',execution:'pending',grading:'pending'});
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  let lab:Lab|undefined;
  try {
    await persist(f,queued);await save(join(f.dir,'runs',queued.id,'job.json'),{});
    lab=new Lab(f.config,'fake');await lab.init();await lab.prepareMachine();
    expect(lab.runs.get(queued.id)?.state).toBe('needs_recovery');
    await expect(lab.resume(queued.batchId)).rejects.toThrow('Recover');
  } finally {await lab?.close();prepare.mockRestore();await f.cleanup();}
});

test('single-run recovery is serialized, idempotent, and exposed through the existing API', async () => {
  const f=await fixture(), previous=runSchema.parse({...finished(),state:'needs_recovery',execution:'failed',grading:'pending',collection:'retained',note:'cleanup failed'});
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const recover=spyOn(LinuxMachine.prototype,'recover').mockResolvedValue({type:'result',execution:'completed',grading:'passed',uid:20001,note:'recovered without rerun'});
  let lab:Lab|undefined,server:ReturnType<typeof serve>|undefined;
  try {
    await persist(f,previous);lab=new Lab(f.config,'fake');await lab.init();await lab.prepareMachine();
    const [a,b]=await Promise.all([lab.recover(previous.id),lab.recover(previous.id)]);
    expect(a.state).toBe('passed');expect(b.state).toBe('passed');expect(recover).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.dir,'runs',previous.id,'state.before-recovery.json'),'utf8'))).toEqual(previous);
    server=serve(lab,0);const {Client}=await import('../src/host/client.js');
    await new Client(server.port!).request('recover-run',{run:previous.id});
    expect(recover).toHaveBeenCalledTimes(1);
  } finally {server?.stop(true);await lab?.close();prepare.mockRestore();recover.mockRestore();await f.cleanup();}
});

test('failed recovery retains its blocked state and does not fabricate a score', async () => {
  const f=await fixture(), previous=runSchema.parse({...finished(),state:'needs_recovery',execution:'failed',grading:'pending',collection:'retained'});
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const recover=spyOn(LinuxMachine.prototype,'recover').mockRejectedValue(Error('Runner is still alive'));
  let lab:Lab|undefined;
  try {
    await persist(f,previous);lab=new Lab(f.config,'fake');await lab.init();await lab.prepareMachine();
    await expect(lab.recover(previous.id)).rejects.toThrow('still alive');
    expect(lab.runs.get(previous.id)).toEqual(previous);
    expect(lab.batchView(lab.batches.get(previous.batchId)!).state).toBe('blocked');
  } finally {await lab?.close();prepare.mockRestore();recover.mockRestore();await f.cleanup();}
});

test('verified cancellation after Docker handoff failure releases queued work without replaying the attempt', async () => {
  const f=await fixture(), lab=new Lab(f.config,'fixture');
  const validate=spyOn(taskAdapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{}});
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async (state,path) => {
    if (state.task==='cancel-async-tasks') {
      await save(join(path,'container.json'),{session:state.id,id:'test-machine',attach:'fixture'});
      throw Error('docker failed (exit 137)');
    }
    return {type:'result',execution:'completed',grading:'passed',uid:20002};
  });
  const recover=spyOn(LinuxMachine.prototype,'recover').mockResolvedValue({type:'result',execution:'cancelled',grading:'unavailable',uid:20001,note:'verified durable receipt'});
  try {
    for(const name of ['cancel-async-tasks','regex-log']) {
      await mkdir(join(f.tasks,name));
      await writeFile(join(f.tasks,name,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
    }
    await mkdir(f.config.payload);await save(join(f.config.payload,'manifest.json'),{});
    await lab.init();await lab.prepareMachine();
    const batch=await lab.submit({name:'handoff failure',concurrency:1,tasks:[{id:'cancel-async-tasks'},{id:'regex-log'}]});
    for(let i=0;i<100&&lab.runs.get(batch.runIds[1]!)?.state!=='passed';i++)await Bun.sleep(5);
    expect(lab.runs.get(batch.runIds[0]!)).toMatchObject({state:'cancelled',execution:'cancelled',grading:'unavailable',collection:'complete'});
    expect(lab.runs.get(batch.runIds[0]!)?.note).toContain('docker failed (exit 137)');
    expect(lab.runs.get(batch.runIds[1]!)?.state).toBe('passed');
    expect(execute).toHaveBeenCalledTimes(2);expect(recover).toHaveBeenCalledTimes(1);
    expect((await lab.snapshot() as {schedulingBlocked:boolean}).schedulingBlocked).toBe(false);
  } finally {await lab.close();validate.mockRestore();prepare.mockRestore();execute.mockRestore();recover.mockRestore();await f.cleanup();}
});


test('final export failure preserves sealed execution and grading without publishing a reward', async () => {
  const f=await fixture(), lab=new Lab(f.config,'fixture');
  const validate=spyOn(taskAdapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{}});
  const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
  const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async (_state,path) => {
    await save(join(path,'container.json'),{session:_state.id,id:'test-machine',attach:'fixture'});
    throw new EvidenceCollectionError({type:'result',execution:'completed',grading:'passed',uid:20001},'disk unavailable');
  });
  try {
    await mkdir(join(f.tasks,'cancel-async-tasks'));
    await writeFile(join(f.tasks,'cancel-async-tasks','task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
    await save(join(f.config.payload,'manifest.json'),{});
    await lab.init();await lab.prepareMachine();
    const batch=await lab.submit({name:'export failure',concurrency:1,tasks:[{id:'cancel-async-tasks'}]});
    const id=batch.runIds[0]!;
    for(let i=0;i<100&&lab.runs.get(id)?.state!=='needs_recovery';i++)await Bun.sleep(5);
    expect(lab.runs.get(id)).toMatchObject({state:'needs_recovery',execution:'completed',grading:'passed',collection:'retained'});
    expect(lab.runs.get(id)?.reward).toBeUndefined();
    expect(lab.batchView(batch).counts).toMatchObject({passed:0,failed:0,errors:1});
    const restored=new Lab(f.config,'fixture');await restored.init();
    expect(restored.runs.get(id)).toMatchObject({execution:'completed',grading:'passed',collection:'retained'});
  }finally{await lab.close();validate.mockRestore();prepare.mockRestore();execute.mockRestore();await f.cleanup();}
});

test('network mode defaults to isolated and invalid values fail before submission', async () => {
  const f=await fixture();
  try {
    expect(f.config.network).toBe('isolated');
    expect(configSchema.parse({...f.config,network:'isolated'}).network).toBe('isolated');
    expect(()=>configSchema.parse({...f.config,network:'disabled-ish'})).toThrow();
    expect(()=>submissionSchema.parse({name:'bad',tasks:[{id:'x'}],network:'proxy'})).toThrow();
  } finally {await f.cleanup();}
});

test('persisted task identity requires one complete dataset reference',()=>{
  const state=finished();
  expect(()=>runSchema.parse({...state,dataset:undefined})).toThrow();
  const batch={version:2,id:state.batchId,name:'fixture',taskRefs:[{dataset:state.dataset,id:state.task}],
    runIds:[state.id],concurrency:1,budget:{},createdAt:1,model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'},payload:{}};
  expect(batchSchema.parse(batch).taskRefs).toHaveLength(1);
  expect(()=>batchSchema.parse({...batch,tasks:[state.task]})).toThrow();
  expect(()=>batchSchema.parse({...batch,version:1})).toThrow();
});

test('restart refuses a run whose network mode differs from its batch', async () => {
  const f=await fixture();
  try {
    const state=finished();await persist(f,state);
    await save(join(f.dir,'runs',state.id,'state.json'),{...state,network:'isolated'});
    const restored=new Lab(f.config,'fixture');
    await expect(restored.init()).rejects.toThrow('network mode');
  } finally {await f.cleanup();}
});

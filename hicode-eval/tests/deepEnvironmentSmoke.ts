/** Actual prepared images, worker and sandbox; fixture provider never incurs model fees. */
import {z} from 'zod';
import {parseArgs} from 'node:util';
import {mkdtemp,rm,mkdir,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {EVAL_ROOT} from '../src/paths.js';
import {TaskCatalog,catalogTaskSchema} from '../src/host/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {RunContainers} from '../src/host/containers.js';
import {datasetBackendsSchema,configSchema,runSchema} from '../src/host/types.js';
import {readJson,run,save} from '../src/host/store.js';
import {deepExecution,deepProfiles} from '../src/host/deepTasks.js';

const {values:v}=parseArgs({options:{catalog:{type:'string'},environments:{type:'string'},backends:{type:'string'},payload:{type:'string'},ids:{type:'string'},report:{type:'string'},runner:{type:'boolean'},module:{type:'string'},'task-source':{type:'string'}}});
if((v.module||v['task-source'])&&v.ids?.includes(','))throw Error('An explicit import module or frozen source requires one task');
const required=(name:keyof typeof v)=>{const value=v[name];if(typeof value!=='string'||!value)throw Error('Missing '+name);return value;};
const catalog=await TaskCatalog.open(resolve(required('catalog')));
const backends=await readJson(resolve(required('backends')),datasetBackendsSchema),backend=backends['deep-swe'];
if(!backend)throw Error('DeepSWE backend is required');
const payload=resolve(required('payload')),archive=join(payload,'source.tar.gz');
const sourceHash=createHash('sha256').update(await readFile(archive)).digest('hex');
const manifest=await readJson(join(payload,'manifest.json'),z.object({commit:z.string().regex(/^[a-f0-9]{40}$/),files:z.record(z.string())}));
if(manifest.files['source.tar.gz']!==sourceHash)throw Error('Frozen smoke payload changed');
const data=await realpath(await mkdtemp(join(tmpdir(),'deep-environment-smoke-')));
const config=configSchema.parse({version:4,...backend,data,catalog:required('catalog'),environments:required('environments'),payload,machine:'unused',concurrency:1,budget:{agentSeconds:120},network:'isolated',
  model:{source:'qwen',model:'offline-smoke',apiKeyEnv:'HICODE_OFFLINE_SMOKE_KEY',baseUrl:'http://127.0.0.1:18080/v1'}});
const environments=new EnvironmentStore(config.environments,config.context),containers=new RunContainers(config);
const profiles=await deepProfiles();
const results:Record<string,unknown>[]=[];
try {
 for(const taskId of required('ids').split(',')){
  const task=v['task-source']?catalogTaskSchema.parse({id:taskId,dataset:'deep-swe',source:await realpath(resolve(v['task-source'])),status:'untested',results:[]}):catalog.get('deep-swe',taskId);
  if(!task.source)throw Error('Missing source');
  const binding=await environments.resolve(task),id=randomBytes(8).toString('hex'),remote='/eval/runs/'+id;
  const container=containers.name(id),docker=(...args:string[])=>['docker','--context',config.context,...args];
  const stage=join(data,id);await mkdir(stage);
  try {
   await containers.create(id,binding.dependencies.imageId);
   await run(docker('exec',container,'mkdir','-p','/opt/hicode-eval/eval_datasets',remote+'/project'));
   for(const name of ['bootstrap.py','protocol.py','preflight.ts','network_entry.py','scm.py','swe.py','venv_paths.py','verifier.py'])
    await run(docker('cp',join(EVAL_ROOT,'src/worker',name),container+':/opt/hicode-eval/'+name));
   await run(docker('cp',join(EVAL_ROOT,'src/worker/eval_datasets')+'/.',container+':/opt/hicode-eval/eval_datasets/'));
   await run(docker('cp',join(EVAL_ROOT,'src/worker/dataset_runtime.py'),container+':/opt/hicode-eval/dataset_runtime.py'));
   await run(docker('cp',archive,container+':/opt/hicode-eval/source.tar.gz'));
   const release=await run(docker('exec',container,'python3','/opt/hicode-eval/bootstrap.py','/opt/hicode-eval/source.tar.gz',sourceHash),{timeout:660000});
   const state=runSchema.parse({version:2,id,batchId:randomBytes(8).toString('hex'),dataset:'deep-swe',task:task.id,state:'preparing',createdAt:1,updatedAt:1,model:'offline-smoke',budget:{agentSeconds:120},network:'isolated'});
   const execution=await deepExecution(state,task.source);
   await execution.stage({container,remote,runPath:stage,docker});
   await save(join(stage,'job.json'),{...execution.job,model:config.model,network:'isolated',release,agentSeconds:120,verifierSeconds:1800});
   await run(docker('cp',join(stage,'job.json'),container+':'+remote+'/job.json'));
   let proof:unknown;
   if(!v.runner){
    await run(docker('cp',join(EVAL_ROOT,'tests/deep_actor_preflight.py'),container+':/opt/hicode-eval/deep_actor_preflight.py'));
    const module=v.module??new URL(profiles[taskId]!.repository).pathname.split('/').at(-1)!.replace(/\.git$/,'').replaceAll('-','_').toLowerCase();
    if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(module))throw Error('Smoke requires a reviewed Python import name');
    proof=z.object({actorSandboxReady:z.literal(true),network:z.literal('isolated'),uid:z.literal(20000),baseCommit:z.literal(profiles[taskId]!.baseCommit),module:z.literal(module),moduleFile:z.string().startsWith('/app/')}).strict().parse(JSON.parse(await run(docker('exec',container,'python3','/opt/hicode-eval/deep_actor_preflight.py',remote,release,module),{timeout:120000})));
   }else{
    for(const name of ['runner.py','model_proxy.py','cleanup.py','recovery.py','terminal.py','record.py'])
     await run(docker('cp',join(EVAL_ROOT,'src/worker',name),container+':/opt/hicode-eval/'+name));
    await run(docker('cp',join(EVAL_ROOT,'tests/deep_fake_provider.py'),container+':/opt/hicode-eval/deep_fake_provider.py'));
    await run(docker('exec','-d',container,'python3','/opt/hicode-eval/deep_fake_provider.py'));
    await run(docker('cp',join(task.source,'instruction.md'),container+':'+remote+'/instruction.md'));
    const proc=Bun.spawn(docker('exec','--env','HICODE_OFFLINE_SMOKE_KEY=offline',container,'python3','/opt/hicode-eval/runner.py',id),{stdout:'pipe',stderr:'pipe'});
    const stderr=new Response(proc.stderr).text();let buffer='',screen='',result:Record<string,unknown>|undefined;
    const timer=setTimeout(()=>{proc.kill();},2400000);
    try {
     const reader=proc.stdout.getReader(),decoder=new TextDecoder();
     for(;;){const {value:chunk,done}=await reader.read();if(done)break;buffer+=decoder.decode(chunk,{stream:true});let index;
      while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
       const packet=JSON.parse(line);
       if(packet.type==='screen'&&typeof packet.screen==='string')screen=packet.screen;
       if(packet.type==='phase'||packet.type==='error')console.log(taskId,packet);
       if(packet.type==='verification_request'){
        await run(docker('cp',execution.verifierSource,container+':'+remote+'/tests'));
        await run(docker('exec',container,'chmod','-R','a+rX',remote+'/tests'));
        await save(join(stage,'verification.json'),{version:1,runId:id,status:'ready'});
        await run(docker('cp',join(stage,'verification.json'),container+':'+remote+'/verification.json'));
       }
       if(packet.type==='result')result=packet;
      }
     }
     if(await proc.exited||!result||result.execution!=='completed'||result.grading!=='failed')throw Error('Empty-answer baseline runner did not complete: '+JSON.stringify(result)+' '+await stderr+'\n'+screen.slice(-4000));
     await run(docker('cp',container+':'+remote+'/logs/verifier/reward.json',join(stage,'reward.json')));
     await run(docker('cp',join(EVAL_ROOT,'tests/deep_verifier_boundary.py'),container+':/opt/hicode-eval/deep_verifier_boundary.py'));
     const boundary=await run(docker('exec',container,'python3','/opt/hicode-eval/deep_verifier_boundary.py',remote,release),{timeout:60000});
     if(!boundary.includes('PRISTINE_VERIFIER_BOUNDARY_OK'))throw Error('Pristine verifier boundary check missing');
     proof={runner:result,reward:JSON.parse(await readFile(join(stage,'reward.json'),'utf8')),pristineVerifierBoundary:true};
    }finally{clearTimeout(timer);}
   }
   results.push({task:taskId,imageId:binding.dependencies.imageId,sourceHash,proof});
   await save(resolve(required('report')),{version:1,dataset:'deep-swe',modelCalls:0,commit:manifest.commit,sourceHash,results});
   console.log('SMOKE_OK '+taskId);
  }finally{await containers.remove(id);}
 }
 await save(resolve(required('report')),{version:1,dataset:'deep-swe',modelCalls:0,commit:manifest.commit,sourceHash,results});
}finally{await rm(data,{recursive:true,force:true});}

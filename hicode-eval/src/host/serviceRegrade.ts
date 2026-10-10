import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {idSchema,serviceRegradeResultSchema,serviceRegradeRequestSchema} from './types.js';
import type {Config,Run,ServiceRegradeResult} from './types.js';
import {readJson,save,run,runEvidenceTree} from './store.js';
import {RunContainers} from './containers.js';
import type {CatalogTask} from './catalog.js';
import {EnvironmentStore} from './environments.js';
import {terminalExecution} from './terminalExecution.js';
import {EvalLayout} from './layout.js';
import type {WorkerBundle} from './workerBundle.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const file=z.object({bytes:z.number().int().nonnegative(),sha256:hash,symlink:z.string().optional()}).strict();
const digest=(content:string|Buffer)=>createHash('sha256').update(content).digest('hex');
export class ServiceRegradeCleanupError extends Error {}

/** The execution owner supplies frozen dependencies; this verifier never writes grades. */
export async function regradeService(config:Config,state:Run,task:CatalogTask,restartScript:string,bundle:WorkerBundle,reviewId:string,signal:AbortSignal){
  signal.throwIfAborted();idSchema.parse(reviewId);
  if(state.dataset!=='terminal-bench-2.1'||state.execution!=='completed'||state.collection!=='complete'||!['passed','failed'].includes(state.state))
    throw Error('Service regrade requires a completed and fully collected Terminal run');
  const layout=new EvalLayout(config.data),original=layout.run(state.id),evidence=join(original,'evidence');
  const receipt=await readJson(join(original,'collection.json'),z.object({complete:z.literal(true),files:z.record(file)}).strict(),32*1024*1024);
  const expected=Object.fromEntries(Object.entries(receipt.files).filter(([name])=>name.startsWith('project/')).map(([name,value])=>[name.slice(8),value]));
  const project=join(evidence,'project'),snapshot=join(evidence,'service-system.tar');
  for(const path of [original,evidence,project,snapshot])if(await realpath(path)!==path)throw Error('Symlinked collected service evidence');
  if(!Object.keys(expected).length||!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Collected answer differs from its receipt');
  const snapshotHandle=await open(snapshot,constants.O_RDONLY|constants.O_NOFOLLOW);
  let snapshotBytes:Buffer;
  try{const stat=await snapshotHandle.stat();if(!stat.isFile()||stat.size>512*1024*1024)throw Error('Invalid service snapshot size/type');snapshotBytes=await snapshotHandle.readFile();}
  finally{await snapshotHandle.close();}
  if(snapshotBytes.length>512*1024*1024||receipt.files['service-system.tar']?.sha256!==digest(snapshotBytes))throw Error('Collected service snapshot differs from its receipt');
  const shutdown=await readJson(join(evidence,'shutdown.json'),z.object({reason:z.literal('completed'),cliExited:z.literal(true),turnSaved:z.literal(true),
    pendingToolCallIds:z.array(z.string()).length(0),eventStreamComplete:z.literal(true),error:z.null()}).passthrough());
  if(!shutdown.turnSaved)throw Error('Answer was not sealed');
  serviceRegradeRequestSchema.parse({run:state.id,restartScript});
  const script=Buffer.from(restartScript);if(script.length>16384)throw Error('Invalid operator service restart script');
  const taskRoot=join(original,'task',state.task),plan=await terminalExecution(state,taskRoot,layout.definition(state.dataset));
  const oldJob=await readJson(join(original,'job.json'),z.record(z.unknown()));
  if(!plan.job.service||!isDeepStrictEqual(plan.job.service,oldJob.service))throw Error('Service declaration changed since the original run');
  const payload=await readFile(join(config.payload,'source.tar.gz')),release='/opt/hicode/releases/'+digest(payload);
  if(oldJob.release!==release)throw Error('Original frozen runtime payload is not available');
  const output=layout.recheck(state.id,reviewId);
  await mkdir(output,{recursive:true,mode:0o700});
  const input={version:1,runId:state.id,reviewId,createdAt:new Date().toISOString(),originalExecution:state.execution,originalGrading:state.grading,
    snapshotSha256:digest(snapshotBytes),projectSha256:digest(JSON.stringify(expected)),restartSha256:digest(script)};
  await save(join(output,'input.json'),input);await writeFile(join(output,'service-restart.sh'),script,{mode:0o600});
  if(task.dataset!==state.dataset||task.id!==state.task)throw Error('Recheck task identity mismatch');
  const binding=await new EnvironmentStore(config.environments,config.context,config.datasetBackends).resolve(task);
  const containers=new RunContainers(config),container=await containers.create(reviewId,(binding.preparation??binding.dependencies).imageId);
  const docker=(...args:string[])=>['docker','--context',config.context,...args],remote='/eval/rechecks/'+state.id+'/'+reviewId;
  const execute=(command:string[],options:{timeout?:number}={})=>run(command,{...options,signal});
  let disposed=false;
  const dispose=async()=>{
    try{await containers.remove(reviewId);disposed=true;await save(join(output,'container-disposed.json'),{reviewId,at:new Date().toISOString()});}
    catch(error){throw new ServiceRegradeCleanupError('Recheck container cleanup was not confirmed: '+String(error).slice(-1200));}
  };
  try{
    await save(join(output,'container.json'),{reviewId,container,context:config.context});
    await save(join(output,'environment.json'),binding);
    const staging=join(output,'worker');await bundle.writeTo(staging);
    await execute(docker('exec',container,'mkdir','-p','/opt/hicode-eval',remote+'/project'));
    await execute(docker('cp',staging+'/.',container+':/opt/hicode-eval/'));
    await execute(docker('cp',join(config.payload,'source.tar.gz'),container+':/opt/hicode-eval/source.tar.gz'));
    await execute(docker('exec',container,'python3','/opt/hicode-eval/bootstrap.py','/opt/hicode-eval/source.tar.gz',release.split('/').at(-1)!),{timeout:660000});
    await execute(docker('cp',project+'/.',container+':'+remote+'/project/'));
    if(!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Answer changed while staging');
    await save(join(output,'job.json'),{...oldJob,...plan.job,release,network:state.network,verifierSeconds:plan.verifierSeconds});
    for(const name of ['job.json','input.json','service-restart.sh'])await execute(docker('cp',join(output,name),container+':'+remote+'/'+name));
    await execute(docker('cp',snapshot,container+':'+remote+'/service-system.tar'));
    await execute(docker('cp',join(taskRoot,'tests'),container+':'+remote+'/tests'));
    await execute(docker('exec',container,'python3','/opt/hicode-eval/service_regrade.py',remote),{timeout:(plan.verifierSeconds+240)*1000});
    for(const name of ['result.json','logs'])await execute(docker('cp',container+':'+remote+'/'+name,join(output,name)));
    const result=await readJson(join(output,'result.json'),serviceRegradeResultSchema);
    if(result.runId!==state.id||result.reviewId!==reviewId||result.snapshotSha256!==input.snapshotSha256||result.projectSha256!==input.projectSha256)
      throw Error('Service recheck identity mismatch');
    if(digest(await readFile(snapshot))!==input.snapshotSha256||!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Original evidence changed during recheck');
    await save(join(output,'collection.json'),{complete:true,files:await runEvidenceTree(join(output,'logs'))});
    await dispose();
    return result;
  }finally{if(!disposed)await dispose();}
}

export function serviceRegradeChanges(result:ServiceRegradeResult):Pick<Run,'state'|'grading'|'reward'|'note'>|undefined{
  if(result.grading==='unavailable')return undefined;
  return {state:result.grading,grading:result.grading,reward:result.grading==='passed'?1:0,note:'Original verifier recheck '+result.reviewId+'; no model calls'};
}

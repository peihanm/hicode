import {constants} from 'node:fs';
import {open, mkdir, realpath, writeFile, cp, rm, readFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {z} from 'zod';
import {LinuxMachine} from './linux.js';
import {loadConfig, runSchema, done,idSchema,regradeResultSchema} from './types.js';
import type {Run} from './types.js';
import {validateFrozenSweTask} from './sweTasks.js';
import {readJson, save, exists, runEvidenceTree, run} from './store.js';
import {isDeepStrictEqual} from 'node:util';
import {EVAL_ROOT} from '../paths.js';
import {lease} from './lease.js';
import {serviceRegradeChanges} from './serviceRegrade.js';
import {TaskCatalog} from './catalog.js';

const patchManifestSchema = z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/), baseCommit:z.string(), baselineCommit:z.string(), revision:z.string(), method:z.literal('host-owned-tree-diff')}).strict();
const predictionSchema = z.object({instance_id:z.string(), model_name_or_path:z.string(), model_patch:z.string()}).strict();
const MAX_REGRADE_PATCH_BYTES=32*1024*1024;
const verifierProxySchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return !/[\s\x00-\x1f\x7f]/.test(value) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
}, 'Verifier proxy must be an HTTP(S) origin without credentials');
export interface RegradeInput {
  version:1;runId:string;reviewId:string;instanceId:string;baseCommit:string;patchSha256:string;
  originalExecution:Run['execution'];originalGrading:Run['grading'];createdAt:string;
  verifierProxy:string|null;
}

export async function regradeRun(data: string, runId: string, verifierProxy?: string, serviceRestartScript?:string) {
  idSchema.parse(runId);
  const proxy = verifierProxy === undefined ? null : verifierProxySchema.parse(verifierProxy);
  const release = await lease(data, 'service');
  try {
    const config = await loadConfig(data);
    if(config.data!==data)throw Error('Regrade data root differs from the recorded configuration');
    const original = join(data,'runs',runId);
    const state = await readJson(join(original,'state.json'),runSchema);
    if(state.id!==runId)throw Error('Regrade run identity mismatch');
    if(state.dataset==='terminal-bench-2.1'){
      if(!serviceRestartScript||proxy!==null)throw Error('Terminal service regrade requires --service-restart-script and no proxy');
      const catalog=await TaskCatalog.open(config.catalog),controller=new AbortController();
      const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
      try{
        const scriptPath=await realpath(resolve(serviceRestartScript)),stat=await Bun.file(scriptPath).stat();
        if(!stat.isFile()||stat.size>16384)throw Error('Invalid service restart script');
        const result=await new LinuxMachine(config).regradeService(state,catalog.get(state.dataset,state.task),await Bun.file(scriptPath).text(),randomBytes(8).toString('hex'),controller.signal);
        controller.signal.throwIfAborted();const changes=serviceRegradeChanges(result);
        if(changes){const current=runSchema.parse({...state,...changes,updatedAt:Date.now()/1000});await save(join(original,'state.json'),current);await catalog.record(current);}
        return {...result,evidencePath:join(original,'rechecks',result.reviewId)};
      }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
    }
    if(serviceRestartScript)throw Error('Service restart is only supported for Terminal service rechecks');
    if (state.id!==runId || state.dataset!=='swe-bench-verified' || !done(state.state) || state.state==='needs_recovery' || state.execution==='pending' || state.collection!=='complete') throw Error('Regrade requires a finished, fully collected SWE run');
    if (state.task.includes('/') || state.task.includes('..')) throw Error('Invalid task identity');
    const taskRoot = join(original,'task',state.task);
    const task = await validateFrozenSweTask(state.task,taskRoot);
    const evidence = join(original,'evidence');
    const reviewId = randomBytes(8).toString('hex');
    const output = join(original,'rechecks',reviewId);
    let manifest:z.infer<typeof patchManifestSchema>,prediction:z.infer<typeof predictionSchema>;
    let patchPath=join(evidence,'tests/model.patch');
    if(state.grading==='unavailable' && !await exists(join(evidence,'patch-manifest.json')) && !await exists(join(evidence,'prediction.json'))){
      await mkdir(output,{recursive:true,mode:0o700});
      patchPath=await recoverCollectedPatch(original,taskRoot,output);
      const patch=await readFile(patchPath);
      if(patch.length>MAX_REGRADE_PATCH_BYTES)throw Error('Recovered patch exceeds budget');
      manifest={sha256:createHash('sha256').update(patch).digest('hex'),baseCommit:task.baseCommit,baselineCommit:task.baselineCommit,revision:task.revision,method:'host-owned-tree-diff'};
      prediction={instance_id:task.instanceId,model_name_or_path:state.model,model_patch:patch.toString('utf8')};
      await save(join(output,'patch-manifest.json'),manifest);await save(join(output,'prediction.json'),prediction);
    }else{
      manifest=await readJson(join(evidence,'patch-manifest.json'),patchManifestSchema);
      prediction=await readJson(join(evidence,'prediction.json'),predictionSchema,MAX_REGRADE_PATCH_BYTES);
    }
    if(await realpath(dirname(patchPath))!==resolve(dirname(patchPath)))throw Error('Symlinked archived patch directory');
    let patch:Buffer;
    let predictionOnly = false;
    const fd = await open(patchPath,constants.O_RDONLY|constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if(error.code !== 'ENOENT')throw error;
      predictionOnly = true;
      return undefined;
    });
    if(fd){
      try {
        const stat = await fd.stat(); if(!stat.isFile()||stat.size>MAX_REGRADE_PATCH_BYTES)throw Error('Invalid archived patch size/type');
        patch = await fd.readFile();
      } finally {await fd.close();}
    } else patch=Buffer.from(prediction.model_patch,'utf8');
    if(patch.length>MAX_REGRADE_PATCH_BYTES)throw Error('Invalid archived patch size/type');
    const sha256 = createHash('sha256').update(patch).digest('hex');
    if (sha256!==manifest.sha256 || sha256!==createHash('sha256').update(prediction.model_patch).digest('hex') || prediction.instance_id!==task.instanceId || manifest.baseCommit!==task.baseCommit || manifest.baselineCommit!==task.baselineCommit || manifest.revision!==task.revision) throw Error('Archived prediction hash or baseline identity mismatch');
    await mkdir(output,{recursive:true,mode:0o700});
    // A verifier setup failure can occur after sealing prediction.json but before
    // model.patch is written. Reconstruct only in this independent recheck copy.
    if(predictionOnly){patchPath=join(output,'model.patch');await writeFile(patchPath,patch,{mode:0o600});}
    const input:RegradeInput = {version:1,runId,reviewId,instanceId:task.instanceId,baseCommit:task.baseCommit,patchSha256:sha256,originalExecution:state.execution,originalGrading:state.grading,createdAt:new Date().toISOString(),verifierProxy:proxy};
    await save(join(output,'input.json'),input);
    const machine = new LinuxMachine(config);
    await machine.regrade(runId,reviewId,taskRoot,patchPath,task,input,output);
    const result = await readJson(join(output,'result.json'),regradeResultSchema);
    if(result.runId!==runId||result.instanceId!==task.instanceId||result.patchSha256!==sha256||result.originalExecution!==state.execution)throw Error('Regrade result identity mismatch');
    return {...result,reviewId,evidencePath:output};
  } finally {await release();}
}


async function recoverCollectedPatch(original:string,taskRoot:string,output:string):Promise<string>{
  // The Actor never owns this receipt. Reject altered, missing and added files,
  // including symlinks, before recovering into an independent recheck copy.
  const project=join(original,'evidence/project');
  if(await realpath(project)!==resolve(project))throw Error('Symlinked collected project');
  const file=z.object({bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),symlink:z.string().max(4096).optional()}).strict();
  const receipt=await readJson(join(original,'collection.json'),z.object({complete:z.literal(true),files:z.record(file)}).strict(),32*1024*1024);
  const expected=Object.fromEntries(Object.entries(receipt.files).filter(([name])=>name.startsWith('project/')).map(([name,value])=>[name.slice(8),value]));
  if(!Object.keys(expected).length || !isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Collected project differs from its sealed receipt');
  const copy=join(output,'recovered-project'),patch=join(output,'model.patch');
  try{
    await cp(project,copy,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
    if(!isDeepStrictEqual(await runEvidenceTree(copy),expected))throw Error('Collected project changed during recovery');
    await run(['python3','-B','-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from swe import export_patch;Path(sys.argv[4]).write_text(export_patch(Path(sys.argv[2]),Path(sys.argv[3])))',join(EVAL_ROOT,'src/worker'),join(taskRoot,'repository'),copy,patch],{timeout:180000});
    await save(join(output,'recovered-from-collection.json'),{method:'verified-collected-project',files:expected});
    return patch;
  }finally{await rm(copy,{recursive:true,force:true});}
}

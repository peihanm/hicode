import {z} from 'zod';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {EVAL_ROOT} from '../paths.js';
import {readJson,tree,run} from './store.js';
import type {DatasetExecution} from './executionPlan.js';
import type {Run} from './types.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const profileSchema=z.object({repository:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),baseCommit:z.string().regex(/^[a-f0-9]{40}$/),
  declaredImage:z.string().regex(/^public\.ecr\.aws\/d3j8x8q7\/swe-bench-202605:[a-z0-9.-]+$/),
  image:z.string().regex(/^public\.ecr\.aws\/d3j8x8q7\/swe-bench-202605@sha256:[a-f0-9]{64}$/),
  architecture:z.literal('amd64'),agentSeconds:z.literal(10800),verifierSeconds:z.literal(1800),hashes:z.record(sha),
  runtimeEnvironment:z.object({PYTHONPATH:z.enum(['/app','/app/src']).optional(),VIRTUAL_ENV:z.literal('/opt/venv').optional()}).strict()}).strict();
export async function deepProfiles(){return readJson(join(EVAL_ROOT,'config/deep-swe.json'),z.record(profileSchema));}
export async function validateDeepTask(id:string,source:string){
  const profile=(await deepProfiles())[id];if(!profile)throw Error('No reviewed DeepSWE task: '+id);
  const files=await tree(source);
  if(JSON.stringify(Object.keys(files).sort())!==JSON.stringify(Object.keys(profile.hashes).sort())||
      Object.entries(files).some(([name,file])=>profile.hashes[name]!==file.sha256))throw Error('DeepSWE frozen task changed');
  const spec=z.object({schema_version:z.literal('1.3'),metadata:z.object({task_id:z.literal(id),
    repository_url:z.literal(profile.repository),base_commit_hash:z.literal(profile.baseCommit)}),
    agent:z.object({network_mode:z.literal('no-network'),timeout_sec:z.literal(profile.agentSeconds)}),
    environment:z.object({docker_image:z.literal(profile.declaredImage),memory_mb:z.literal(8192),gpus:z.literal(0)}),
    verifier:z.object({network_mode:z.literal('no-network'),environment_mode:z.literal('separate'),
      timeout_sec:z.literal(profile.verifierSeconds),collect:z.array(z.object({command:z.string(),timeout_sec:z.literal(300)})).length(1)})});
  const task=spec.parse(Bun.TOML.parse(await readFile(join(source,'task.toml'),'utf8')));
  const collect='cd /app && mkdir -p /logs/artifacts && git config --global --add safe.directory /app && git diff --binary '+profile.baseCommit+' HEAD > /logs/artifacts/model.patch';
  if(task.verifier.collect[0]!.command!==collect)throw Error('Unreviewed DeepSWE collection contract');
  return {...profile,kind:'deep-swe' as const};
}
export async function deepExecution(state:Run,source:string):Promise<DatasetExecution>{
  if(state.network!=='isolated')throw Error('DeepSWE requires the original no-network contract');
  const deep=await validateDeepTask(state.task,source);
  return {originalAgentSeconds:deep.agentSeconds,verifierSeconds:deep.verifierSeconds,setupAllowance:600,
    runnerPython:'python3',verifierSource:join(source,'tests'),
    job:{dataset:'deep-swe',deep:{id:state.task,baseCommit:deep.baseCommit,runtimeEnvironment:deep.runtimeEnvironment},initializer:null,packages:[],verifierPackages:[]},
    stage:async({container,remote,docker})=>{
      await run(docker('exec',container,'mkdir','-p','/logs/artifacts'));
      const head=await run(docker('exec',container,'git','-C','/app','rev-parse','HEAD'));
      if(head!==deep.baseCommit)throw Error('Official DeepSWE image baseline changed');
      await run(docker('exec',container,'cp','-a','/app',remote+'/baseline'),{timeout:120000});
      await run(docker('exec',container,'cp','-a','/app/.',remote+'/project/'),{timeout:120000});
      await run(docker('exec',container,'chmod','700',remote+'/baseline'));
    }};
}

#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { realpath, readdir } from 'node:fs/promises';
import { parse } from 'dotenv';
import { z } from 'zod';
import { Lab } from './host/manager.js';
import { EVAL_ROOT, REPOSITORY_ROOT } from './paths.js';
import { Client } from './host/client.js';
import { configSchema, modelSchema, submissionSchema, idSchema } from './host/types.js';
import { directory, readJson, run, save, exists } from './host/store.js';
import { lease } from './host/lease.js';
import { serve } from './host/server.js';
import {regradeRun} from './host/regrade.js';
import {TaskCatalog} from './host/catalog.js';
import {EnvironmentStore} from './host/environments.js';
import {archiveRuns} from './host/archive.js';
import {sweCatalog,validateSweTask} from './host/sweTasks.js';
import {validatePublicTask,profiles} from './host/publicTasks.js';
import {datasetSchema,taskKey} from './host/datasets.js';
async function main() {
  process.umask(0o077);
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    'verifier-proxy':{type:'string'},apply:{type:'boolean'},catalog:{type:'string'},environments:{type:'string'},'include-passed':{type:'boolean'},cpus:{type:'string',default:'1'},'memory-mb':{type:'string',default:'4096'},network: {type:'string', default:'isolated'}, ids: {type:'string'}, dataset:{type:'string'}, 'data-dir': { type: 'string' }, tasks: { type: 'string' }, 'swe-tasks': { type: 'string' }, payload: { type: 'string' }, 'docker-context': { type: 'string', default: 'colima-hicode' }, machine: { type: 'string', default: 'hicode-eval-clean' }, concurrency: { type: 'string', default: '2' }, port: { type: 'string', default: '8878' }, file: { type: 'string' }, run: { type: 'string' }, batch: { type: 'string' }, 'wait-seconds': { type: 'string', default: '30' }, source: { type: 'string' }, model: { type: 'string' }, 'model-config': { type: 'string' }, 'snapshot-worktree': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const command = positionals[0];
  if (v.help || !command) { console.log('HiCode Eval · isolated containers\n  serve --data-dir DIR --payload DIR --catalog FILE --environments DIR [--machine hicode-eval-clean] [--network open|isolated]\n  prepare --payload DIR [--snapshot-worktree]\n  register-tasks --catalog FILE [--tasks DIR --dataset terminal-bench|terminal-bench-2.1] [--swe-tasks DIR]\n  archive-runs --catalog FILE --data-dir DIR [--apply]\n  prepare-environments --catalog FILE --environments DIR [--ids DATASET:ID1,DATASET:ID2] [--include-passed]\n  catalog | submit --file batch.json | status [--batch ID]\n  wait --batch ID [--wait-seconds 30] | cancel --batch ID | resume --batch ID | recover --run ID | retry --run ID | report --batch ID --file report.md\n  regrade --data-dir DIR --run ID [--verifier-proxy URL]  # frozen SWE patch only; no Agent/model'); return; }
  if (positionals.length !== 1 || !['serve','prepare','catalog','submit','status','wait','cancel','resume','recover','retry','report','regrade','prepare-environments','register-tasks','archive-runs'].includes(command)) throw Error('Unknown command');
  if (v['verifier-proxy'] && command !== 'regrade') throw Error('--verifier-proxy is only supported by regrade');
  const required = (key: keyof typeof v) => { const value = v[key]; if (typeof value !== 'string' || !value) throw Error('Missing --' + key); return value; };
  const port = z.number().int().min(1024).max(65535).parse(Number(v.port));
  if(command==='archive-runs'){
    console.log(JSON.stringify(await archiveRuns(await directory(required('data-dir')),resolve(required('catalog')),v.apply??false),null,2));return;
  }
  if(command==='register-tasks'){
    const path=resolve(required('catalog')),release=await lease(await directory(dirname(path)),'catalog');
    try {
      if(!await exists(path))await save(path,{version:1,updatedAt:new Date().toISOString(),tasks:[]});
      const catalog=await TaskCatalog.open(path);
      const entries: {id:string;dataset:'swe-bench-verified'|'terminal-bench'|'terminal-bench-2.1';source:string}[]=[];
      if(v['swe-tasks'])for(const task of await sweCatalog(await realpath(resolve(v['swe-tasks'])))){
        const source=join(await realpath(resolve(v['swe-tasks'])),task.id);await validateSweTask(task.id,source);entries.push({id:task.id,dataset:'swe-bench-verified',source});
      }
      if(v.tasks){
        const dataset=datasetSchema.parse(v.dataset??'terminal-bench');
        if(dataset==='swe-bench-verified')throw Error('Use --swe-tasks for SWE-bench Verified');
        const root=await realpath(resolve(v.tasks)),supported=await profiles(dataset);
        for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&supported[entry.name]){
          const source=join(root,entry.name);await validatePublicTask(entry.name,source,dataset);entries.push({id:entry.name,dataset,source});
        }
      }
      if(!entries.length)throw Error('No reviewed task sources selected');
      await catalog.register(entries);console.log(JSON.stringify({registered:entries.length,catalog:path}));
    }finally{await release();}return;
  }
  if(command==='prepare-environments'){
    const catalog=await TaskCatalog.open(resolve(required('catalog')));
    const root=await directory(required('environments'));
    const store=new EnvironmentStore(root,v['docker-context']!);
    const selected=v.ids?new Set(v.ids.split(',').map(value=>{
      const matches=catalog.list().filter(task=>taskKey(task)===value||task.id===value);
      if(matches.length!==1)throw Error(matches.length?'Ambiguous task ID; use DATASET:ID':'Unknown task ID');
      return taskKey(matches[0]!);
    })):undefined;
    console.log('Checking public base runtime…');await store.prepareBase();
    const prepared:string[]=[],failed:{id:string;error:string}[]=[],unprepared:string[]=[];
    for(const task of catalog.list()){
      if(selected?!selected.has(taskKey(task)):task.status==='passed'&&!v['include-passed'])continue;
      if(!task.source){unprepared.push(taskKey(task));continue;}
      try{await store.prepareTask(task);prepared.push(taskKey(task));console.log('Ready: '+taskKey(task));}
      catch(error){failed.push({id:taskKey(task),error:error instanceof Error?error.message:String(error)});console.error('Blocked: '+taskKey(task)+': '+(error instanceof Error?error.message:String(error)).slice(0,240));}
    }
    const report={at:new Date().toISOString(),prepared,failed,unprepared};await save(join(root,'preparation-report.json'),report);
    console.log(JSON.stringify({prepared:prepared.length,failed,unprepared:unprepared.length}));
    if(failed.length)process.exitCode=1;return;
  }
  if(command==='regrade'){
    console.log(JSON.stringify(await regradeRun(await directory(required('data-dir')),idSchema.parse(required('run')),v['verifier-proxy']),null,2));
    return;
  }
  if (command === 'prepare') {
    console.log(await run(['python3',join(EVAL_ROOT,'src/host/prepare.py'),'--source',REPOSITORY_ROOT,'--payload',resolve(required('payload')),...(v['snapshot-worktree']?['--snapshot-worktree']:[])],{timeout:60000}));return;
  }
  if (command !== 'serve') {
    const client = new Client(port), batch = v.batch ? idSchema.parse(v.batch) : undefined;
    let result: unknown;
    if (command === 'catalog') result = (await client.status()).tasks;
    else if (command === 'submit') result = await client.request('submit', await readJson(await realpath(resolve(required('file'))), submissionSchema));
    else if (command === 'retry') result = await client.request('retry-run',{run:idSchema.parse(required('run'))});
    else if (command === 'recover') result = await client.request('recover-run',{run:idSchema.parse(required('run'))});
    else if (command === 'status') result = await client.status(batch);
    else {
      if (!batch) throw Error('Missing --batch');
      if (command === 'cancel') result = await client.request('cancel-batch',{batch});
      else if (command === 'resume') result = await client.request('resume-batch',{batch});
      else if (command === 'report') { const file=Bun.file(resolve(required('file')));if(file.size>200000)throw Error('Report too large');result=await client.request('report',{batch,text:await file.text()}); }
      else {
        const seconds=z.number().int().min(1).max(60).parse(Number(v['wait-seconds'])),deadline=Date.now()+seconds*1000;
        for (;;) {
          const status=await client.status(batch),b=status.batches[0];
          if(b.state!=='running'||status.schedulingBlocked||Date.now()>=deadline){result={...status,waitOutcome:b.state==='finished'?'finished':status.schedulingBlocked?'blocked':'pending'};break;}
          await Bun.sleep(Math.min(1000,Math.max(0,deadline-Date.now())));
        }
      }
    }
    console.log(JSON.stringify(result,null,2));return;
  }
  const data=await directory(required('data-dir')),release=await lease(data,'service');
  let lab: Lab|undefined,server:ReturnType<typeof serve>|undefined,catalogLease:(()=>Promise<void>)|undefined;
  try {
    catalogLease=await lease(dirname(resolve(required('catalog'))),'catalog');
    if(!!v.source!==!!v.model)throw Error('Supply both --source and --model');
    const model=v['model-config']?await readJson(resolve(v['model-config']),modelSchema):modelSchema.parse(JSON.parse(await run(['bun',join(EVAL_ROOT,'src/host/resolve-model.mjs'),REPOSITORY_ROOT,REPOSITORY_ROOT,join(process.env.HOME??'','.hicode'),...(v.source&&v.model?[v.source,v.model]:[])])));
    let credential=process.env[model.apiKeyEnv];
    for(const path of [join(REPOSITORY_ROOT,'.env'),join(process.env.HOME??'','.hicode/.env')])if(!credential&&await exists(path))credential=parse(await Bun.file(path).text())[model.apiKeyEnv];
    if(!credential)throw Error('Missing provider credential');
    const config=configSchema.parse({version:4,network:v.network,data,catalog:resolve(required('catalog')),environments:resolve(required('environments')),cpus:Number(v.cpus),memoryMb:Number(v['memory-mb']),payload:resolve(required('payload')),context:v['docker-context'],machine:v.machine,concurrency:Number(v.concurrency),budget:{},model});
    lab=new Lab(config,credential);await lab.init();
    console.log('Checking clean preparation container and fixed source release…');await lab.prepareMachine();
    server=serve(lab,port);await save(join(data,'config.json'),config);
    let closing=false;const shutdown=async()=>{if(closing)return;closing=true;server?.stop();await lab?.close();await catalogLease?.();await release();process.exit(0);};
    process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
    console.log(`HiCode Eval: http://127.0.0.1:${port}\nMachine: ${config.machine} · Concurrency: ${config.concurrency} · Network default: ${config.network} · Disposable container per attempt`);
  } catch(error){server?.stop();await lab?.close();await catalogLease?.();await release();throw error;}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Evaluation failed');process.exitCode=1;});

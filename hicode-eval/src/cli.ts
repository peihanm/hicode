#!/usr/bin/env bun
import {loadHiCodeSettings} from '../../src/settings/index.js';
import {createHiCodeStorageLayout} from '../../src/persistence/index.js';
import {PROVIDER_BASE_URLS} from '../../src/llm/providerRegistry.js';
import {parseArgs} from 'node:util';
import {join,resolve,dirname} from 'node:path';
import {readdir,cp,rm,copyFile,mkdir,realpath,mkdtemp,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parse} from 'dotenv';
import {z} from 'zod';
import {EvalLayout} from './host/layout.js';
import {loadConfig,settingsSchema,modelSchema,submissionSchema,reasoningSchema,runSchema,idSchema} from './host/types.js';
import {TaskCatalog} from './host/catalog.js';
import type {CatalogTask} from './host/catalog.js';
import {taskAdapters,datasetSchema,taskKey} from './host/datasets.js';
import {EnvironmentStore} from './host/environments.js';
import {readJson,save,run,exists,contained,tree} from './host/store.js';
import {lease} from './host/lease.js';
import {Lab} from './host/manager.js';
import {Client} from './host/client.js';
import {EvaluationView} from './host/view.js';
import {serve,serveWorker} from './host/server.js';
import {collectResources} from './host/resources.js';
import {imageInventory} from './host/imageInventory.js';
import {regradeRun} from './host/regrade.js';
import {EVAL_ROOT,REPOSITORY_ROOT} from './paths.js';

async function main(){
  const {positionals,values:v}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{
    preparation:{type:'string'},script:{type:'string'},root:{type:'string'},help:{type:'boolean'},file:{type:'string'},dataset:{type:'string'},tasks:{type:'string'},ids:{type:'string'},run:{type:'string'},batch:{type:'string'},apply:{type:'boolean'},
    port:{type:'string',default:'8878'},'worker-port':{type:'string',default:'8879'},'model-config':{type:'string'},reasoning:{type:'string'},'snapshot-worktree':{type:'boolean'},'build-proxy':{type:'string'},live:{type:'boolean'},'build-cache':{type:'boolean'},'verifier-proxy':{type:'string'}
  }});
  const command=positionals[0];
  if(v.help||!command){console.log('HiCode Eval · current root only\n  init --root DIR [--model-config FILE]\n  prepare --root DIR [--snapshot-worktree]\n  register --root DIR --dataset DATASET --tasks DIR [--ids ID1,ID2]\n  prepare-environments --root DIR [--ids DATASET:ID1,DATASET:ID2] [--build-proxy URL]\n  worker --root DIR [--worker-port 8879]\n  serve --root DIR [--port 8878] [--worker-port 8879]\n  submit --file FILE [--reasoning EFFORT] | status [--batch ID] | catalog | cancel --batch ID | recover --run ID | retry --run ID\n  image-inventory --root DIR [--dataset DATASET]\n  gc --root DIR [--apply] [--build-cache]\n  regrade --root DIR --run ID [--verifier-proxy URL]\nAll operations read the root README first. No old format, old data-dir or independent catalog paths.');return;}
  if(positionals.length!==1||!v.root)throw Error('Supply one command and --root');
  if(v.reasoning!==undefined&&command!=='submit')throw Error('--reasoning is only supported by submit; retry preserves the original batch reasoning');
  const reasoning=v.reasoning===undefined?undefined:reasoningSchema.parse({effort:v.reasoning});
  const layout=new EvalLayout(v.root);
  if(contained(REPOSITORY_ROOT,layout.root))throw Error('Evaluation data must be outside the checkout');
  const required=(name:'tasks'|'file'|'dataset'|'run'|'batch')=>{const value=v[name];if(!value)throw Error('Missing --'+name);return value;};
  const port=z.coerce.number().int().min(1024).max(65535).parse(v.port),workerPort=z.coerce.number().int().min(1024).max(65535).parse(v['worker-port']);
  if(command==='init'){
    const model=v['model-config']?await readJson(resolve(v['model-config']),modelSchema):(() => {
      const loaded=loadHiCodeSettings({cwd:process.cwd(),storage:createHiCodeStorageLayout()});
      const target=loaded.values.models.primary,source=loaded.values.sources[target.source];
      return modelSchema.parse({source:target.source,model:target.model,apiKeyEnv:source.apiKeyEnv,baseUrl:source.baseUrl??PROVIDER_BASE_URLS[target.source],
        imageInput:source.models.find(model=>model.id===target.model)?.imageInput===true,reasoning:{effort:target.reasoning??'default'}});
    })();
    if(!await layout.initialize())throw Error('Root already initialized');
    await save(layout.settings,settingsSchema.parse({version:1,context:'colima-hicode',machine:'hicode-eval-runtime',concurrency:5,cpus:1,memoryMb:4096,budget:{agentSeconds:1800},model}));
    await save(layout.catalog,{version:1,updatedAt:new Date().toISOString(),tasks:[]});
    await copyFile(join(EVAL_ROOT,'templates/data-README.md'),join(layout.root,'README.md'));console.log(JSON.stringify({root:layout.root,initialized:true}));return;
  }
  const config=await loadConfig(layout.root);
  if(command==='prepare-environments'&&v.live){
    if(!v.ids)throw Error('Live preparation requires explicit --ids DATASET:ID');
    const client=new Client(workerPort),health=z.object({data:z.string()}).passthrough().parse(await client.request('health'));
    if(health.data!==layout.root)throw Error('Worker belongs to another data root');
    const tasks=v.ids.split(',').map(key=>{const parts=key.split(':');if(parts.length!==2)throw Error('Use DATASET:ID');return {dataset:datasetSchema.parse(parts[0]),id:parts[1]!};});
    console.log(JSON.stringify(await client.request('prepare-environments',{tasks,...(v['build-proxy']?{buildProxy:v['build-proxy']}:{})})));return;
  }
  if(command==='serve'){
    const server=serve(new EvaluationView(layout.root),new Client(workerPort),port);
    const stop=()=>{server.stop();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
    console.log('HiCode Eval dashboard: http://127.0.0.1:'+server.port);return;
  }
  if(command==='worker'){
    const release=await lease(layout.root,'service');let lab:Lab|undefined;let server:ReturnType<typeof serveWorker>|undefined;
    try{
      let credential=process.env[config.model.apiKeyEnv]??'';
      for(const path of [join(REPOSITORY_ROOT,'.env'),join(process.env.HOME??'','.hicode/.env')])if(!credential&&await exists(path))credential=parse(await Bun.file(path).text())[config.model.apiKeyEnv]??'';
      lab=new Lab(config,credential);await lab.init();server=serveWorker(lab,workerPort);
      let closing=false;const shutdown=async()=>{if(closing)return;closing=true;server?.stop();await lab?.close();await release();process.exit(0);};
      process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
      console.log('HiCode Eval worker: http://127.0.0.1:'+server.port+' · root '+layout.root);return;
    }catch(error){server?.stop();await lab?.close();await release();throw error;}
  }
  if(['catalog','status','submit','cancel','recover','retry'].includes(command)){
    const client=new Client(workerPort);const health=z.object({data:z.string()}).passthrough().parse(await client.request('health'));
    if(health.data!==layout.root)throw Error('Worker belongs to another root');
    let result:unknown;
    if(command==='catalog')result=(await client.status()).tasks;
    else if(command==='status')result=await client.status(v.batch);
    else if(command==='submit'){
      const input=await readJson(resolve(required('file')),submissionSchema);
      result=await client.request('submit',reasoning?{...input,reasoning}:input);
    }
    else if(command==='cancel')result=await client.request('cancel-batch',{batch:idSchema.parse(required('batch'))});
    else if(command==='recover')result=await client.request('recover-run',{run:idSchema.parse(required('run'))});
    else result=await client.request('retry-run',{run:idSchema.parse(required('run'))});
    console.log(JSON.stringify(result,null,2));return;
  }
  if(command==='image-inventory'){console.log(JSON.stringify(await imageInventory(layout.root,v.dataset?datasetSchema.parse(v.dataset):undefined),null,2));return;}
  if(command==='regrade'){console.log(JSON.stringify(await regradeRun(layout.root,idSchema.parse(required('run')),v['verifier-proxy']),null,2));return;}
  const release=await lease(layout.root,'service');
  try{
    const catalog=await TaskCatalog.open(layout.catalog);
    if(command==='prepare'){
      if(await exists(layout.payload))throw Error('Payload already frozen; remove it only after checking every unfinished batch');
      const stage=await mkdtemp(join(layout.builds,'payload-'));
      try{await run(['python3','-B',join(EVAL_ROOT,'src/host/prepare.py'),'--source',REPOSITORY_ROOT,'--payload',join(stage,'payload'),...(v['snapshot-worktree']?['--snapshot-worktree']:[])],{timeout:60000});await rename(join(stage,'payload'),layout.payload);console.log(layout.payload);}
      finally{await rm(stage,{recursive:true,force:true});}return;
    }
    if(command==='register'){
      if(await exists(join(layout.state,'import.json')))throw Error('Interrupted import; run gc --apply before registering');
      const dataset=datasetSchema.parse(required('dataset')),input=await realpath(resolve(required('tasks'))),selected=v.ids?new Set(v.ids.split(',')):undefined;
      const names=(await readdir(input,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&(!selected||selected.has(d.name))).map(d=>d.name);
      if(!names.length||selected&&names.length!==selected.size)throw Error('Every selected task needs a validated source');
      if(!!v.preparation!==!!v.script)throw Error('Specify --preparation and --script together');
      const script=v.script?z.string().regex(/^[A-Za-z0-9_.-]+\.sh$/).parse(v.script):undefined;
      const preparation=v.preparation?await realpath(resolve(v.preparation)):undefined;
      const stage=await mkdtemp(join(layout.builds,'import-'));const entries:Pick<CatalogTask,'id'|'dataset'|'source'|'preparation'>[]=[];
      try{
        for(const id of names){
          const task={dataset,id},source=join(input,id),target=layout.source(task);
          if(catalog.list().some(t=>taskKey(t)===taskKey(task))||await exists(target))throw Error('Task/source already exists: '+taskKey(task));
          await taskAdapters(layout)[dataset].validate(id,source);const before=await taskAdapters(layout)[dataset].snapshot(source);
          const staged=join(stage,id);await mkdir(staged);await cp(source,join(staged,'source'),{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true,preserveTimestamps:true});
          if(JSON.stringify(await taskAdapters(layout)[dataset].snapshot(join(staged,'source')))!==JSON.stringify(before))throw Error('Source changed during import');
          let prepared:CatalogTask['preparation'];
          if(preparation&&script){
            const files=await tree(preparation);if(!files[script])throw Error('Preparation script missing');
            await cp(preparation,join(staged,'preparation'),{recursive:true,errorOnExist:true,force:false});
            if(JSON.stringify(await tree(join(staged,'preparation')))!==JSON.stringify(files))throw Error('Preparation changed during import');
            const directory=join(layout.preparations,dataset,id);if(await exists(directory))throw Error('Preparation path exists');
            prepared={directory,script,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
          }
          entries.push({...task,source:target,...(prepared?{preparation:prepared}:{})});
        }
        await save(join(layout.state,'import.json'),{version:1,tasks:entries.map(t=>({dataset:t.dataset,id:t.id}))});
        for(const entry of entries){
          await mkdir(dirname(entry.source!),{recursive:true});await rename(join(stage,entry.id,'source'),entry.source!);
          if(entry.preparation){await mkdir(dirname(entry.preparation.directory),{recursive:true});await rename(join(stage,entry.id,'preparation'),entry.preparation.directory);}
        }
        await catalog.register(entries);await rm(join(layout.state,'import.json'));console.log(JSON.stringify({registered:entries.length}));
      }finally{await rm(stage,{recursive:true,force:true});}return;
    }
    if(command==='prepare-environments'){
      const selected=v.ids?new Set(v.ids.split(',')):undefined;
      if(selected&&[...selected].some(k=>!catalog.list().some(t=>taskKey(t)===k)))throw Error('Use registered DATASET:ID identities');
      const tasks=catalog.list().filter(t=>t.status!=='passed'&&(!selected||selected.has(taskKey(t))));
      const proxy=v['build-proxy']?z.string().url().refine(value=>{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}).parse(v['build-proxy']):undefined;
      const store=new EnvironmentStore(config.environments,config.context,config.datasetBackends,proxy);
      if(tasks.some(t=>t.dataset!=='deep-swe')){
        console.log('Preparing common runtime from '+join(layout.runtime,'Dockerfile'));
        await store.prepareBase();
      }
      const failed=[];
      for(const task of tasks){
        try{console.log('Preparing '+taskKey(task));await store.prepareTask(task);await catalog.setEnvironment(task,'ready');console.log('Ready: '+taskKey(task));}
        catch(error){await catalog.setEnvironment(task,'failed');failed.push({task:taskKey(task),error:String(error).slice(-1000)});}
      }
      console.log(JSON.stringify({prepared:tasks.length-failed.length,failed}));if(failed.length)process.exitCode=1;return;
    }
    if(command==='gc'){
      const runs=[];for(const name of await readdir(layout.runs))if(/^[a-f0-9]{16}$/.test(name))runs.push(await readJson(join(layout.run(name),'state.json'),runSchema));
      const result=await collectResources(config,catalog,runs,v.apply??false);
      if(v.apply&&v['build-cache'])for(const context of new Set([config.context,...Object.values(config.datasetBackends).map(b=>b.context)]))
        await run(['docker','--context',context,'builder','prune','--force','--filter','until=168h','--keep-storage',config.cacheGiB+'GB'],{timeout:180000});
      console.log(JSON.stringify(result,null,2));return;
    }
    throw Error('Unknown command');
  }finally{await release();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Evaluation failed');process.exitCode=1;});

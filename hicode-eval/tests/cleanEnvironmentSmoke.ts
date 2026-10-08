// Explicit Docker smoke: install only public source offline and import its native dependencies.
import {mkdtemp,realpath,readFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {parseArgs} from 'node:util';
import {TaskCatalog} from '../src/host/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {RunContainers} from '../src/host/containers.js';
import {configSchema} from '../src/host/types.js';
import {validateSweTask} from '../src/host/sweTasks.js';
import {EVAL_ROOT} from '../src/paths.js';
import {run,save,readJson} from '../src/host/store.js';

const {values}=parseArgs({options:{catalog:{type:'string'},environments:{type:'string'},payload:{type:'string'},task:{type:'string'},imports:{type:'string'}}});
if(!values.catalog||!values.environments||!values.payload||!values.task)throw Error('Supply --catalog, --environments, --payload and --task');
const payload=await realpath(values.payload);
const manifest=await readJson(join(payload,'manifest.json'),z.object({files:z.record(z.string())}));
const sourceHash=createHash('sha256').update(await readFile(join(payload,'source.tar.gz'))).digest('hex');
if(sourceHash!==manifest.files['source.tar.gz'])throw Error('Source payload changed');
const task=(await TaskCatalog.open(values.catalog)).get('swe-bench-verified',values.task);
if(!task.source||task.dataset!=='swe-bench-verified')throw Error('A prepared SWE source is required');
const metadata=await validateSweTask(task.id,task.source);
const imports=(values.imports??metadata.repo.split('/')[1]!).split(',');
if(imports.some(name=>!/^\w+(?:\.\w+)*$/.test(name)))throw Error('Invalid import name');
const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-clean-imports-')));
const config=configSchema.parse({version:4,data:root,catalog:values.catalog,environments:values.environments,payload,
  context:'colima-hicode',machine:'hicode-eval-clean',concurrency:1,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'http://127.0.0.1:1/v1'}});
const store=new EnvironmentStore(config.environments,config.context),binding=await store.resolve(task);
const containers=new RunContainers(config),id=randomBytes(8).toString('hex'),container=containers.name(id);
try{
  await containers.create(id,(binding.preparation??binding.dependencies).imageId);
  const staged=join(root,'repository');
  await cp(join(task.source,'repository'),staged,{recursive:true,verbatimSymlinks:true,preserveTimestamps:true});
  await run(['docker','--context',config.context,'cp',staged+'/.',container+':/testbed']);
  await run(['docker','--context',config.context,'exec',container,'chown','-R','20000:20000','/testbed']);
  await run(['docker','--context',config.context,'exec',container,'mkdir','-p','/opt/hicode-eval/eval_datasets']);
  for(const name of ['swe.py','protocol.py','verifier.py','dataset_runtime.py','scm.py','venv_paths.py','preflight.ts','network_entry.py','bootstrap.py'])await run(['docker','--context',config.context,'cp',join(EVAL_ROOT,'src/worker',name),container+':/opt/hicode-eval/'+name]);
  await run(['docker','--context',config.context,'cp',join(EVAL_ROOT,'src/worker/eval_datasets')+'/.',container+':/opt/hicode-eval/eval_datasets/']);
  const output=await run(['docker','--context',config.context,'exec','--user','20000:20000','--env','HOME=/tmp',container,'python3','-c',
    'import os,sys,subprocess,json;from pathlib import Path;sys.path.insert(0,"/opt/hicode-eval");from swe import editable_install_argv,materialize_versioneer_source,project_environment,SOURCE_INSTALL_TIMEOUT_SECONDS;from dataset_runtime import dataset_runtime;from scm import read_source_version;assert dataset_runtime({"dataset":"swe-bench-verified"}).public_test_entries({"swe":{"repo":sys.argv[1]}});materialize_versioneer_source(Path("/testbed"),sys.argv[1],sys.argv[2]);py="/opt/hicode-swe/actor/bin/python";env={k:v for k,v in os.environ.items() if k!="XDG_CACHE_HOME"};env.update(PIP_NO_INDEX="1",PATH="/opt/hicode-swe/actor/bin:"+os.environ["PATH"],**project_environment(sys.argv[1],Path("/testbed"),sys.argv[2]));subprocess.run(editable_install_argv(py,"/testbed",sys.argv[1],sys.argv[2]),cwd="/testbed",env=env,check=True,timeout=SOURCE_INSTALL_TIMEOUT_SECONDS);subprocess.run([py,"-c","import importlib,sys;[importlib.import_module(n) for n in sys.argv[1:]]",*sys.argv[3:]],cwd="/testbed",env=env,check=True,timeout=120);expected=read_source_version(Path("/testbed"))["version"] if sys.argv[1]=="matplotlib/matplotlib" and sys.argv[2] in ("3.0","3.1") else None;subprocess.run([py,"-c","import matplotlib,sys;assert matplotlib.__version__==sys.argv[1],(matplotlib.__version__,sys.argv[1])",expected],cwd="/testbed",env=env,check=True,timeout=120) if expected else None;print("CLEAN_IMPORTS_OK")',metadata.repo,metadata.version,...imports],{timeout:450000,includeStderr:true});
  if(!output.includes('CLEAN_IMPORTS_OK'))throw Error('Import proof missing');
  await run(['docker','--context',config.context,'cp',join(payload,'source.tar.gz'),container+':/opt/hicode-eval/source.tar.gz']);
  const release=await run(['docker','--context',config.context,'exec',container,'python3','/opt/hicode-eval/bootstrap.py','/opt/hicode-eval/source.tar.gz',sourceHash],{timeout:660000});
  if(release!=='/opt/hicode/releases/'+sourceHash)throw Error('Prepared source identity changed');
  await run(['docker','--context',config.context,'cp',join(EVAL_ROOT,'tests/clean_actor_preflight.py'),container+':/opt/hicode-eval/clean_actor_preflight.py']);
  const preflight=await run(['docker','--context',config.context,'exec',container,'python3','/opt/hicode-eval/clean_actor_preflight.py',release],{timeout:60000,includeStderr:true});
  if(!preflight.includes('CLEAN_ACTOR_PREFLIGHT_OK'))throw Error('Actor sandbox proof missing');
  await save(join(root,'result.json'),{task:task.id,image:(binding.preparation??binding.dependencies).imageId,sourceHash,imports,actorSandboxReady:true,passed:true});
  console.log(JSON.stringify({root,task:task.id,sourceHash,imports,actorSandboxReady:true,passed:true}));
}finally{await containers.remove(id);}

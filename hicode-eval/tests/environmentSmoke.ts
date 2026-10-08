// Explicit Docker smoke for native preparation and five concurrent isolated writable layers.
import {mkdtemp,realpath,mkdir,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {TaskCatalog} from '../src/host/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {RunContainers} from '../src/host/containers.js';
import {configSchema} from '../src/host/types.js';
import {tree,run,save} from '../src/host/store.js';
const {values}=parseArgs({options:{catalog:{type:'string'},environments:{type:'string'},task:{type:'string'}}});
if(!values.catalog||!values.environments||!values.task)throw Error('Supply --catalog FILE --environments DIR --task SWE_TASK_ID');
const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-layer-smoke-')));
const source=join(root,'recipe'),environments=join(root,'environments');await mkdir(source);await mkdir(environments);
await cp(join(values.environments,'base.json'),join(environments,'base.json'));
await writeFile(join(source,'probe.c'),'#include <stdio.h>\nint main(void){puts("native-ready");return 0;}\n');
await writeFile(join(source,'prepare.sh'),'set -eu\nmkdir -p /opt/hicode-task/bin\ncc /opt/hicode-task/source/probe.c -o /opt/hicode-task/bin/probe\n');
const original=(await TaskCatalog.open(values.catalog)).get('swe-bench-verified',values.task);
const task={...original,preparation:{directory:source,script:'prepare.sh',sha256:createHash('sha256').update(JSON.stringify(await tree(source))).digest('hex')}};
const store=new EnvironmentStore(environments,'colima-hicode');
const binding=await store.prepareTask(task);
const config=configSchema.parse({version:4,data:root,catalog:values.catalog,environments,payload:root,context:'colima-hicode',machine:'hicode-eval-clean',concurrency:5,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'http://127.0.0.1:1/v1'}});
const containers=new RunContainers(config),ids=Array.from({length:5},()=>randomBytes(8).toString('hex'));
const started=Date.now();
try {
 await Promise.all(ids.map(id=>containers.create(id,binding.preparation!.imageId)));
 await Promise.all(ids.map(id=>run(['docker','--context',config.context,'exec',containers.name(id),'python3','-c',
  'from pathlib import Path;import subprocess,sys;p=Path("/eval/marker");assert not p.exists();p.write_text(sys.argv[1]);Path("/opt/hicode-swe/actor/probe").write_text(sys.argv[1]);assert not Path("/opt/hicode-swe/verifier/probe").exists();assert not Path("/eval/runs").exists();assert not Path("/opt/hicode-swe/bundles").exists();assert subprocess.check_output(["/opt/hicode-task/bin/probe"]).strip()==b"native-ready"',id])));
 await Promise.all(ids.map(id=>run(['docker','--context',config.context,'exec',containers.name(id),'python3','-c','from pathlib import Path;import sys;assert Path("/eval/marker").read_text()==sys.argv[1];assert Path("/opt/hicode-swe/actor/probe").read_text()==sys.argv[1]',id])));
 const result={root,concurrency:5,nativePreparation:true,privateWorkspace:true,separateVerifier:true,milliseconds:Date.now()-started};
 await save(join(root,'smoke-result.json'),result);console.log(JSON.stringify(result));
}finally{await Promise.all(ids.map(id=>containers.remove(id)));}
if((await Promise.all(ids.map(id=>containers.exists(id)))).some(Boolean))throw Error('Container cleanup incomplete');

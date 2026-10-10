// Explicit Linux integration check. A local fake provider returns immediately; no paid API is reachable.
import {parseArgs} from 'node:util';
import {mkdtemp,realpath,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EvalLayout} from '../src/host/layout.js';
import {loadConfig,settingsSchema,configSchema} from '../src/host/types.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {datasetSchema} from '../src/host/datasets.js';
import {lease} from '../src/host/lease.js';
import {Lab} from '../src/host/manager.js';
import {RunContainers} from '../src/host/containers.js';
import {bindingSchema,environmentBindingPath,EnvironmentStore} from '../src/host/environments.js';
import {save,readJson,run,exists} from '../src/host/store.js';

const {values:v}=parseArgs({options:{root:{type:'string'},dataset:{type:'string'},task:{type:'string'},cancel:{type:'boolean'},'probe-command':{type:'string'}}});
if(!v.root||!v.dataset||!v.task)throw Error('Use --root, --dataset and --task');
if(v.cancel&&v['probe-command'])throw Error('Use cancellation or a functional command, not both');
const probeCommand=v['probe-command']?await Bun.file(v['probe-command']).text():null,agentSeconds=probeCommand?180:45;
const current=await loadConfig(v.root),original=await TaskCatalog.open(current.catalog),task=original.get(datasetSchema.parse(v.dataset),v.task);
if(!task.source||task.environment!=='ready')throw Error('Prepare the smoke task first');
const release=await lease(current.data,'service');let temporary:string|undefined;
try{
const layout=new EvalLayout(await realpath(await mkdtemp(join(tmpdir(),'hicode-linux-smoke-'))));temporary=layout.root;await layout.initialize();
const model={source:'qwen' as const,model:'fixture',apiKeyEnv:'HICODE_SMOKE_KEY',baseUrl:'http://127.0.0.1:18991/v1'};
const backend=current.datasetBackends[task.dataset];
const settings=settingsSchema.parse({...await readJson(new EvalLayout(current.data).settings,settingsSchema),model,machine:'hicode-smoke-'+createHash('sha256').update(layout.root).digest('hex').slice(0,12),concurrency:1,budget:{agentSeconds}});
const config=configSchema.parse({...settings,data:layout.root});
const executionConfig=configSchema.parse({...settings,...backend,datasetBackends:{},data:layout.root});
await save(layout.settings,settings);await save(layout.catalog,{version:1,updatedAt:new Date().toISOString(),tasks:[]});
await mkdir(join(layout.datasets,task.dataset),{recursive:true});
await cp(new EvalLayout(current.data).definition(task.dataset),layout.definition(task.dataset));
const runtimeDockerfile=new EvalLayout(current.data).runtimeDockerfile(task.dataset);
if(await exists(runtimeDockerfile))await cp(runtimeDockerfile,layout.runtimeDockerfile(task.dataset));
await mkdir(join(layout.source(task),'..'),{recursive:true});await cp(task.source,layout.source(task),{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true});
await cp(current.payload,layout.payload,{recursive:true,errorOnExist:true,force:false});
const catalog=await TaskCatalog.open(layout.catalog);
let preparation:typeof task.preparation;
if(task.preparation){
 const directory=join(layout.preparations,task.dataset,task.id);await mkdir(join(directory,'..'),{recursive:true});
 await cp(task.preparation.directory,directory,{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true});preparation={...task.preparation,directory};
}
await catalog.register([{id:task.id,dataset:task.dataset,source:layout.source(task),...(preparation?{preparation}:{})}]);
const originalBinding=await readJson(environmentBindingPath(current.environments,task),bindingSchema);
await save(join(layout.environments,'base.json'),originalBinding.base);
await new EnvironmentStore(layout.environments,config.context,config.datasetBackends).prepareTask(catalog.get(task.dataset,task.id));
await catalog.setEnvironment(task,'ready');
const docker=(...a:string[])=>['docker','--context',executionConfig.context,...a];
const lab=new Lab(config,'local-fake-key'),containers=new RunContainers(executionConfig);
const fake=`import http.server,json,time,re
from pathlib import Path
command=json.loads(${JSON.stringify(JSON.stringify(probeCommand))})
class H(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  request=json.loads(self.rfile.read(int(self.headers['Content-Length'])));self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  time.sleep(${v.cancel?60:0})
  results=[m.get('content','') for m in request['messages'] if m.get('role')=='tool'];text=json.dumps(results)
  call=None
  if command and not results:call={'name':'bash','arguments':json.dumps({'command':command,'timeout_ms':150000,'yield_time_ms':30000})}
  elif command and not list(Path('/eval/runs').glob('*/project/.probe-passed')):
   match=re.search(r't_[0-9a-f]+',text)
   if match:call={'name':'task','arguments':json.dumps({'action':'wait','task_id':match.group(0)})}
  if call:
   chunks=[{'choices':[{'index':0,'delta':{'role':'assistant','tool_calls':[{'index':0,'id':'probe-'+str(len(results)),'type':'function','function':call}]},'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]}]
  else:
   verdict='Offline smoke complete.' if not command or list(Path('/eval/runs').glob('*/project/.probe-passed')) else 'Functional probe failed.'
   chunks=[{'choices':[{'index':0,'delta':{'role':'assistant','content':verdict},'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]
  for c in chunks:self.wfile.write(('data: '+json.dumps(c)+'\\n\\n').encode())
  self.wfile.write(b'data: [DONE]\\n\\n');self.wfile.flush()
http.server.ThreadingHTTPServer(('127.0.0.1',18991),H).serve_forever()`;
try{

 await lab.init();const batch=await lab.submit({name:'Offline Linux smoke',concurrency:1,tasks:[{dataset:task.dataset,id:task.id,agentSeconds}]});const id=batch.runIds[0]!;
 let provider=false,cancelled=false;const deadline=Date.now()+(probeCommand?300000:180000);
 while(Date.now()<deadline){
  const state=lab.runs.get(id)!;
  if(!provider&&await containers.exists(id)){await run(docker('exec','-d',containers.name(id),'python3','-c',fake));provider=true;}
  if(v.cancel&&state.state==='running'&&!cancelled){await lab.cancel(id);cancelled=true;}
  if(['passed','failed','error','cancelled','needs_recovery'].includes(state.state)){
   // Container disposal follows the durable result; wait for its separate receipt.
   if(state.state!=='needs_recovery'&&!await exists(join(layout.run(id),'container-disposed.json'))){await Bun.sleep(100);continue;}
   const remaining=await containers.exists(id);
   const proof=join(layout.run(id),'evidence/project/.probe-passed');
   const functionalProof=!probeCommand||(await exists(proof)&&!!await readJson(proof,z.object({ok:z.literal(true)})));
   const deep=task.dataset==='deep-swe'&&!v.cancel?await readJson(join(layout.run(id),'evidence/logs/verifier/reward.json'),z.object({p2p_total:z.number().int(),p2p_passed:z.number().int(),f2p_total:z.number().int(),f2p_passed:z.number().int()})):null;
   const patch=deep?await Bun.file(join(layout.run(id),'evidence/artifacts/model.patch')).text():null;
   const deepProof=!deep||(deep.p2p_total>0&&deep.p2p_passed===deep.p2p_total&&deep.f2p_total>0&&deep.f2p_passed<deep.f2p_total&&(!probeCommand||!!patch));
   const ok=deepProof&&(v.cancel?state.execution==='cancelled':state.execution==='completed'&&state.grading==='failed')&&state.collection==='complete'&&!remaining&&functionalProof;
   const report={at:new Date().toISOString(),kind:'local-fake-provider',task:{dataset:task.dataset,id:task.id},context:executionConfig.context,paidModelCalls:0,mode:v.cancel?'cancel':'complete',ok,execution:state.execution,grading:state.grading,collection:state.collection,containerRemaining:remaining,...(deep?{tests:deep,committedPatchBytes:Buffer.byteLength(patch!)}:{}),note:state.note};
   await save(join(new EvalLayout(current.data).state,'validation.json'),report);console.log(JSON.stringify(report));
   if(!ok){
    const probeError=join(layout.run(id),'evidence/project/.probe-error');
    if(probeCommand&&await exists(probeError))console.error((await Bun.file(probeError).text()).slice(-8000));
    const screen=join(layout.run(id),'live/screen.txt');if(await exists(screen))console.error((await Bun.file(screen).text()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-5000));
    const terminal=join(layout.run(id),'evidence/logs/terminal.bin');if(await exists(terminal)){const diagnostics=(await Bun.file(terminal).text()).match(/Model gateway [^\r\n\x1b]{0,150}/g);if(diagnostics)console.error(diagnostics.join('\n'));}
    throw Error('Linux smoke failed: '+state.note);
   }
   break;
  }
  await Bun.sleep(100);
 }
 if(Date.now()>=deadline)throw Error('Smoke deadline exceeded');
}finally{
 await lab.close();for(const id of lab.runs.keys())await containers.remove(id);
 await rm(layout.root,{recursive:true,force:true});
}

}finally{if(temporary)await rm(temporary,{recursive:true,force:true});await release();}

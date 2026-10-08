// Explicit Docker integration smoke. Local fake provider only; preserves diagnostics in a temporary directory.
import {mkdir,mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {Lab} from '../src/host/manager.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {configSchema} from '../src/host/types.js';
import {save,run} from '../src/host/store.js';
import {RunContainers} from '../src/host/containers.js';
const {values}=parseArgs({options:{catalog:{type:'string'},environments:{type:'string'},payload:{type:'string'},task:{type:'string'},dataset:{type:'string'},machine:{type:'string',default:'hicode-eval-clean'},cancel:{type:'boolean'},retry:{type:'boolean'}}});
const required=(name:'catalog'|'environments'|'payload'|'task')=>{const value=values[name];if(!value)throw Error('Missing --'+name);return value;};
const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-container-smoke-')));await mkdir(root,{recursive:true});
const original=await TaskCatalog.open(required('catalog'));
const matches=original.list().filter(task=>task.id===required('task')&&(!values.dataset||task.dataset===values.dataset));
if(matches.length!==1)throw Error('Smoke task ID must be unique across datasets');
const task=matches[0]!;
await save(join(root,'catalog.json'),{version:1,updatedAt:new Date().toISOString(),tasks:[{...task,status:'untested',results:[]}]});
const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments:required('environments'),payload:required('payload'),context:'colima-hicode',machine:values.machine,concurrency:5,cpus:1,memoryMb:4096,budget:{agentSeconds:90},network:'isolated',model:{source:'qwen',model:'fixture',apiKeyEnv:'HICODE_SMOKE_KEY',baseUrl:'http://127.0.0.1:18991/v1'}});
const fake=`import http.server,json,time
class H(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  time.sleep(${values.cancel?60:0})
  chunks=[{'id':'smoke','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','content':'Smoke test completed.'},'finish_reason':None}]},{'id':'smoke','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]
  for c in chunks:self.wfile.write(('data: '+json.dumps(c)+'\\n\\n').encode())
  self.wfile.write(b'data: [DONE]\\n\\n');self.wfile.flush()
http.server.ThreadingHTTPServer(('127.0.0.1',18991),H).serve_forever()`;
await save(join(root,'config.json'),config);
const lab=new Lab(config,'fake-local-key'),containers=new RunContainers(config);
console.log(JSON.stringify({root}));
try{
 await lab.init();await lab.prepareMachine();
 let previous:string|undefined;
 for(let attempt=0;attempt<(values.retry?2:1);attempt++){
 const before=previous?JSON.stringify(lab.runs.get(previous)):undefined;
 const batch=previous?await lab.retry(previous):await lab.submit({name:'Offline complete-chain smoke',tasks:[{id:task.id,dataset:task.dataset}],concurrency:1});
 const id=batch.runIds[0]!;console.log(JSON.stringify({id}));
 const deadline=Date.now()+600000;let started=false,cancelled=false,last='';
 while(Date.now()<deadline){
  const state=lab.runs.get(id)!;
  if(state.state!==last){console.log(JSON.stringify(state));last=state.state;}
  if(values.cancel&&state.state==='running'&&!cancelled){await lab.cancel(id);cancelled=true;}
  if(!started&&await containers.exists(id)){
   await run(['docker','--context',config.context,'exec','-d',containers.name(id),'python3','-c',fake]);started=true;
  }
  if(['passed','failed','error','needs_recovery','cancelled'].includes(state.state)){
   await Bun.sleep(2000);
   const catalog=await TaskCatalog.open(config.catalog);
   const result={root,state:lab.runs.get(id),containerRemaining:await containers.exists(id),catalog:catalog.get(task.dataset,task.id)};
   await save(join(root,'smoke-result.json'),result);console.log(JSON.stringify({state:result.state,containerRemaining:result.containerRemaining}));
   if((values.cancel?state.execution!=='cancelled':state.execution!=='completed'||state.grading!=='failed')||state.collection!=='complete'||result.containerRemaining)throw Error('Complete-chain smoke did not reach expected archived failed grade');
   break;
  }
  await Bun.sleep(1000);
 }
 if(Date.now()>=deadline)throw Error('Smoke deadline exceeded');
 if(previous){if(JSON.stringify(lab.runs.get(previous))!==before||batch.retryOf?.runId!==previous||(await lab.retry(previous)).id!==batch.id)throw Error('Retry modified the original or lost idempotency');}
 previous=id;
 }
}finally{await lab.close();}

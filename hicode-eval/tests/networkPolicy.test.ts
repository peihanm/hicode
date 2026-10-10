import {test,expect,spyOn} from 'bun:test';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {fixture,seed} from './helpers/root.js';
import {taskAdapters} from '../src/host/datasets.js';
import {Lab} from '../src/host/manager.js';
import {LinuxMachine} from '../src/host/linux.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {EvaluationView} from '../src/host/view.js';
import * as publicTasks from '../src/host/publicTasks.js';
import {save} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import {done} from '../src/host/types.js';

test('dataset network rules parse original permission and refuse malformed declarations',async()=>{
 const f=await fixture(),t=await seed(f,'network'),adapters=taskAdapters(f.layout);
 try{
  expect(f.config.network).toBe('open');
  expect(await adapters[t.dataset].network(t.source)).toBe('open');
  for(const entry of ['allow_internet=false','','allow_internet="true"']){
   await writeFile(join(t.source,'task.toml'),'[agent]\ntimeout_sec=30\n[verifier]\ntimeout_sec=30\n[environment]\n'+entry);
   if(entry.includes('"'))await expect(adapters[t.dataset].network(t.source)).rejects.toThrow();
   else expect(await adapters[t.dataset].network(t.source)).toBe('isolated');
  }
  expect(await adapters['deep-swe'].network(t.source)).toBe('isolated');
 }finally{await f.cleanup();}
});

test.each(['open','isolated'] as const)('one %s batch freezes per-task networking and the dashboard accepts mixed runs',async network=>{
 const f=await fixture(),online=await seed(f,'online'),offline=await seed(f,'offline','d'),lab=new Lab({...f.config,network},'offline-secret');
 await writeFile(join(offline.source,'task.toml'),'[agent]\ntimeout_sec=30\n[verifier]\ntimeout_sec=30\n[environment]\nallow_internet=false\n');
 await save(join(f.layout.payload,'manifest.json'),{});
 const metadata=publicTasks.publicTaskProfile({fixture:{hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPrelude:'none',service:{writablePaths:[]}}},'fixture');
 const validate=spyOn(publicTasks,'validatePublicTask').mockResolvedValue(metadata);
 const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(online.binding);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async()=>{await gate;return {type:'result',execution:'completed',grading:'failed',uid:20000};});
 const dispose=spyOn(LinuxMachine.prototype,'disposeRun').mockImplementation(async id=>{await save(join(f.layout.run(id),'container-disposed.json'),{version:1,runId:id,at:new Date().toISOString()});});
 const cancel=spyOn(LinuxMachine.prototype,'cancel').mockResolvedValue(undefined);
 const boundary=spyOn(transport,'run').mockResolvedValue('');
 try{
  await lab.init();const batch=await lab.submit({name:'mixed',concurrency:2,tasks:[online,offline].map(({id,dataset})=>({id,dataset}))});
  expect(lab.runs.get(batch.runIds[0]!)?.network).toBe(network);
  expect(lab.runs.get(batch.runIds[1]!)?.network).toBe('isolated');
  const view=new EvaluationView(f.layout.root);
  for(const id of batch.runIds)expect(await view.path(id)).toBe(f.layout.run(id));
  finish();const deadline=Date.now()+3000;
  while([...lab.runs.values()].some(r=>!done(r.state))){if(Date.now()>deadline)throw Error('Fixture did not finish');await Bun.sleep(1);}
  await lab.close();
  const restored=new Lab(f.config,'offline-secret');
  try{await restored.init();expect(restored.runs.get(batch.runIds[1]!)?.network).toBe('isolated');}
  finally{await restored.close();}
 }finally{finish();await lab.close();validate.mockRestore();resolve.mockRestore();prepare.mockRestore();execute.mockRestore();dispose.mockRestore();cancel.mockRestore();boundary.mockRestore();await f.cleanup();}
});

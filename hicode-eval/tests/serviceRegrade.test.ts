import {test,expect} from 'bun:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,seed,finished} from './helpers/root.js';
import {save,runEvidenceTree} from '../src/host/store.js';
import {LinuxMachine} from '../src/host/linux.js';

test('service recheck rejects incomplete attempts and corrupted collected answers before contacting Docker',async()=>{
 const f=await fixture();await seed(f,'mailman');const task=f.catalog.get('terminal-bench-2.1','mailman'),machine=new LinuxMachine(f.config),state={...finished('mailman'),state:'failed' as const,grading:'failed' as const};
 try{
  await expect(machine.regradeService({...state,execution:'failed'},task,'unused','b'.repeat(16),new AbortController().signal)).rejects.toThrow('completed');
  const original=f.layout.run(state.id),project=join(original,'evidence/project');await mkdir(project,{recursive:true});
  await writeFile(join(project,'answer.txt'),'original answer');
  const before=await runEvidenceTree(project);
  await writeFile(join(original,'evidence/service-system.tar'),'fixture');
  await save(join(original,'collection.json'),{complete:true,files:Object.fromEntries(Object.entries(before).map(([path,value])=>['project/'+path,value]))});
  await writeFile(join(project,'answer.txt'),'changed answer');
  await expect(machine.regradeService(state,task,'unused','b'.repeat(16),new AbortController().signal)).rejects.toThrow('receipt');
 }finally{await f.cleanup();}
});

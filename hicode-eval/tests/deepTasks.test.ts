import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {taskKey} from '../src/host/datasets.js';
import {configSchema,submissionSchema,runSchema} from '../src/host/types.js';
import {LinuxMachine} from '../src/host/linux.js';
import * as transport from '../src/host/store.js';

test('DeepSWE has an explicit identity and accepts the original three-hour agent budget',()=>{
  const submission=submissionSchema.parse({name:'DeepSWE',concurrency:1,network:'isolated',tasks:[{dataset:'deep-swe',id:'cattrs-partial-structuring-recovery',agentSeconds:10800}]});
  expect(submission.tasks[0]?.agentSeconds).toBe(10800);
  expect(()=>submissionSchema.parse({...submission,tasks:[{...submission.tasks[0],agentSeconds:10801}]})).toThrow();
  expect(taskKey({dataset:'deep-swe',id:'same'})).not.toBe(taskKey({dataset:'terminal-bench-2.1',id:'same'}));
});

test('release initialization validates the frozen payload without requiring another dataset engine',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'deep-release-')));
  const config=configSchema.parse({version:1,data:root,context:'arm-offline',machine:'cache',concurrency:1,budget:{},
    datasetBackends:{'deep-swe':{context:'amd-offline',cpus:2,memoryMb:8192}},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
  const archive=Buffer.from('frozen source fixture');
  await transport.save(join(config.payload,'manifest.json'),{files:{'source.tar.gz':createHash('sha256').update(archive).digest('hex')}});
  await Bun.write(join(config.payload,'source.tar.gz'),archive);
  const boundary=spyOn(transport,'run').mockRejectedValue(Error('No Docker engine is required'));
  try {
    const machine=new LinuxMachine(config);await machine.freeze();boundary.mockClear();await machine.prepare();
    expect(boundary).not.toHaveBeenCalled();
    await Bun.write(join(config.payload,'source.tar.gz'),'changed');
    await expect(new LinuxMachine(config).prepare()).rejects.toThrow('Source payload changed');
    expect(boundary).not.toHaveBeenCalled();
  }finally{boundary.mockRestore();await rm(root,{recursive:true});}
});

test('cancel and disposal select the frozen run dataset backend, without touching the ARM engine',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'deep-backend-'))),id='a'.repeat(16);
  const config=configSchema.parse({version:1,data:root,context:'arm-offline',machine:'cache',concurrency:2,budget:{},
    datasetBackends:{'deep-swe':{context:'amd-offline',cpus:2,memoryMb:8192}},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
  await mkdir(join(root,'runs',id),{recursive:true});
  await transport.save(join(root,'runs',id,'state.json'),runSchema.parse({version:1,id,batchId:'b'.repeat(16),dataset:'deep-swe',task:'case',state:'running',createdAt:1,updatedAt:1,model:'fake',budget:{}}));
  const calls:string[][]=[];
  const fake=spyOn(transport,'run').mockImplementation(async args=>{calls.push(args);return '';});
  try {
    const machine=new LinuxMachine(config);await machine.cancel(id);await machine.disposeRun(id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(args=>args[2]==='amd-offline')).toBe(true);
    await transport.save(join(root,'runs',id,'container.json'),{session:id,id:'wrong',attach:'docker --context arm-offline exec -it wrong bash'});
    await expect(machine.cancel(id)).rejects.toThrow('sealed container receipt');
    const missing='c'.repeat(16);await expect(machine.cancel(missing)).rejects.toThrow();
  }finally{fake.mockRestore();await rm(root,{recursive:true});}
});

import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deepProfiles,validateDeepTask} from '../src/host/deepTasks.js';
import {taskAdapters,taskKey} from '../src/host/datasets.js';
import {configSchema,submissionSchema,runSchema} from '../src/host/types.js';
import {LinuxMachine} from '../src/host/linux.js';
import * as transport from '../src/host/store.js';

test('DeepSWE selection pins official images and validates the entire frozen contract',async()=>{
  const profiles=await deepProfiles();expect(profiles['cattrs-partial-structuring-recovery']?.baseCommit).toBe('6bc4708fb9b2ac52d9a18997e923da6a58916102');
  expect(profiles['httpx-streaming-json-iteration']?.image).toBe(profiles['httpx-multipart-response-parsing']?.image);
  expect(taskAdapters['deep-swe'].validate).toBe(validateDeepTask);
  expect(taskAdapters['deep-swe'].requiredNetwork).toBe('isolated');
  const root=await mkdtemp(join(tmpdir(),'deep-task-'));
  try {
    await writeFile(join(root,'instruction.md'),'altered');
    await expect(validateDeepTask('cattrs-partial-structuring-recovery',root)).rejects.toThrow('frozen task changed');
    await expect(validateDeepTask('unknown',root)).rejects.toThrow('reviewed');
  }finally{await rm(root,{recursive:true});}
});

test('DeepSWE has an explicit identity and accepts the original three-hour agent budget',()=>{
  const submission=submissionSchema.parse({name:'DeepSWE',concurrency:1,network:'isolated',tasks:[{dataset:'deep-swe',id:'cattrs-partial-structuring-recovery',agentSeconds:10800}]});
  expect(submission.tasks[0]?.agentSeconds).toBe(10800);
  expect(()=>submissionSchema.parse({...submission,tasks:[{...submission.tasks[0],agentSeconds:10801}]})).toThrow();
  expect(taskKey({dataset:'deep-swe',id:'same'})).not.toBe(taskKey({dataset:'terminal-bench',id:'same'}));
});

test('cancel and disposal select the frozen run dataset backend, without touching the ARM engine',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'deep-backend-'))),id='a'.repeat(16);
  const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments:join(root,'env'),payload:join(root,'payload'),context:'arm-offline',machine:'cache',concurrency:2,budget:{},
    datasetBackends:{'deep-swe':{context:'amd-offline',cpus:2,memoryMb:8192}},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
  await mkdir(join(root,'runs',id),{recursive:true});
  await transport.save(join(root,'runs',id,'state.json'),runSchema.parse({version:2,id,batchId:'b'.repeat(16),dataset:'deep-swe',task:'case',state:'running',createdAt:1,updatedAt:1,model:'fake',budget:{}}));
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

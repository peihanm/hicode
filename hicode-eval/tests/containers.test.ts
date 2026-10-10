import {test,expect,spyOn} from 'bun:test';
import {RunContainers} from '../src/host/containers.js';
import {configSchema} from '../src/host/types.js';
import * as transport from '../src/host/store.js';

const config=()=>configSchema.parse({version:1,data:'/tmp/fake-runs',context:'offline',machine:'cache',concurrency:5,budget:{},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
test('each attempt has its own network, identity and bounded resources without shared volumes',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64),calls:string[][]=[];
 const fake=spyOn(transport,'run').mockImplementation(async argv=>{
   calls.push(argv);
   if(argv.includes('inspect'))return JSON.stringify([{Id:'container',Image:image,State:{Running:true},Config:{Labels:{'dev.hicode.role':'attempt','dev.hicode.owner':runtime.owner,'dev.hicode.run':id}}}]);
   if(argv.includes('{{.Names}}'))return runtime.name(id);
   if(argv.includes('{{.Name}}'))return runtime.name(id)+'-net';
   return '';
 });
 try {
   expect(await runtime.create(id,image)).toBe(runtime.name(id));
   const create=calls.find(c=>c.includes('create')&&c.includes('--memory'))!;
   expect(create).toContain('4096m');expect(create).toContain('--cpus');expect(create).toContain(runtime.name(id)+'-net');
   expect(create).not.toContain('--mount');expect(create).not.toContain('-v');expect(create).not.toContain('--privileged');
   await runtime.remove(id);
   expect(calls.some(c=>c.includes('rm')&&c.includes(runtime.name(id)))).toBe(true);
   expect(calls.some(c=>c.includes('network')&&c.includes('rm'))).toBe(true);
 }finally{fake.mockRestore();}
});

test('container ownership mismatch fails closed',async()=>{
 const runtime=new RunContainers(config());
 const fake=spyOn(transport,'run').mockResolvedValue(JSON.stringify([{Id:'other',Image:'sha256:'+'b'.repeat(64),State:{Running:true},Config:{Labels:{'dev.hicode.owner':'another service'}}}]));
 try{await expect(runtime.assert('a'.repeat(16))).rejects.toThrow('ownership');}finally{fake.mockRestore();}
});

test('invalid attempt/image identifiers never reach Docker',async()=>{
 const runtime=new RunContainers(config()),fake=spyOn(transport,'run').mockRejectedValue(Error('must not execute'));
 try {
  expect(()=>runtime.name('../other')).toThrow();
  await expect(runtime.create('a'.repeat(16),'mutable:latest')).rejects.toThrow('immutable');
  expect(fake).not.toHaveBeenCalled();
 }finally{fake.mockRestore();}
});

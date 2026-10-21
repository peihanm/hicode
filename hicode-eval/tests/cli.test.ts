import {test,expect} from 'bun:test';
import {mkdtemp,rm,realpath,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,submissionSchema} from '../src/host/types.js';
import type {Submission} from '../src/host/types.js';
import {fixture} from './helpers/root.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {EVAL_ROOT} from '../src/paths.js';
import {taskRegistrationSchema} from '../src/host/taskRegistration.js';

test('fresh root is initialized without Docker, credentials or historical records',async()=>{
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'eval-cli-'))),root=join(temporary,'data');
 try{
  const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'init','--root',root],{cwd:temporary,env:{PATH:process.env.PATH,HOME:join(temporary,"isolated-user")},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(JSON.parse(output).initialized).toBe(true);
  const config=await loadConfig(root);expect(config.data).toBe(root);expect((await TaskCatalog.open(config.catalog)).list()).toHaveLength(0);
  const old=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'status','--data-dir',root],{stdout:'pipe',stderr:'pipe'});const error=await new Response(old.stderr).text();expect(await old.exited).not.toBe(0);expect(error).toContain('Unknown option');
 }finally{await rm(temporary,{recursive:true,force:true});}
});


test.each(['qwen-token-plan','ark-agent-plan'] as const)('init imports the isolated %s model and saved effort, or validates an explicit model declaration',async source=>{
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'eval-cli-model-'))),root=join(temporary,'data'),user=join(temporary,'user');
 try{
  await mkdir(join(user,'.hicode'),{recursive:true});
  await writeFile(join(user,'.hicode/settings.json'),JSON.stringify({models:{primary:{source,model:'deepseek-v4.1-flash'},reasoning:[{source,model:'deepseek-v4.1-flash',effort:'max'}]}}));
  const init=async(target:string,file?:string)=>{
   const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'init','--root',target,...(file?['--model-config',file]:[])],{cwd:temporary,env:{PATH:process.env.PATH,HOME:user},stdout:'pipe',stderr:'pipe'});
   const [output,error]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
   expect(await proc.exited).toBe(0);expect(error).toBe('');expect(JSON.parse(output).initialized).toBe(true);
   return loadConfig(target);
  };
  const imported=await init(root);expect(imported.model).toMatchObject({source,model:'deepseek-v4.1-flash',reasoning:{effort:'max'},apiKeyEnv:source==='ark-agent-plan'?'ARK_AGENT_PLAN_API_KEY':'QWEN_TOKEN_PLAN_API_KEY'});
  const file=join(temporary,'model.json');await writeFile(file,JSON.stringify({...imported.model,reasoning:{effort:'off'}}));
  const explicit=await init(join(temporary,'explicit'),file);expect(explicit.model.reasoning).toEqual({effort:'off'});
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('submit CLI reasoning overrides the file without changing it; invalid values and retry overrides never reach the worker',async()=>{
 const f=await fixture(),file=join(f.layout.root,'batch-input.json'),received:Submission[]=[];
 const input={name:'fixture',concurrency:1,model:{source:'qwen',model:'qwen3.8-flash'},reasoning:{effort:'high'},tasks:[{dataset:'terminal-bench-2.1',id:'fixture'}]};
 await writeFile(file,JSON.stringify(input));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/'||path==='/api/health')return Response.json({data:f.layout.root},{headers:{'Set-Cookie':'fixture=local; Path=/'}});
  if(path==='/api/submit'){
   expect(request.headers.get('X-Eval-Request')).toBe('1');
   const submitted=submissionSchema.parse(await request.json());received.push(submitted);return Response.json(submitted);
  }
  return new Response('Unexpected worker call',{status:500});
 }});
 const invoke=async(command:string,args:string[])=>{
  const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),command,'--root',f.layout.root,'--worker-port',String(server.port),...args],
   {env:{PATH:process.env.PATH,HOME:join(f.layout.root,'unused-user')},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>proc.kill('SIGKILL'),30000);
  try{const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return {output,error,code};}
  finally{clearTimeout(timer);}
 };
 try{
  for(const effort of [undefined,'max','default']){
   const result=await invoke('submit',['--file',file,...(effort?['--reasoning',effort]:[])]);
   expect(result.code).toBe(0);expect(JSON.parse(result.output).reasoning).toEqual({effort:effort??'high'});
  }
  const invalid=await invoke('submit',['--file',file,'--reasoning','ultra']);expect(invalid.code).not.toBe(0);
  const retry=await invoke('retry',['--run','a'.repeat(16),'--reasoning','max']);expect(retry.code).not.toBe(0);expect(retry.error).toContain('retry preserves');
  expect(received.map(s=>s.reasoning?.effort)).toEqual(['high','max','default']);expect(JSON.parse(await Bun.file(file).text())).toEqual(input);
  expect(received.every(s=>s.model?.source==='qwen')).toBe(true);
  const selected=await invoke('submit',['--file',file,'--model-source','ark-agent-plan','--model','glm-5.3-flash','--reasoning','max']);
  expect(selected.code).toBe(0);
  expect(received.at(-1)?.model).toEqual({source:'ark-agent-plan',model:'glm-5.3-flash'});
  expect(received.at(-1)?.reasoning).toEqual({effort:'max'});
  for(const args of [['--model-source','qwen'],['--model','qwen3.8-flash'],['--model-source','unknown','--model','fake']]){
   expect((await invoke('submit',['--file',file,...args])).code).not.toBe(0);
  }
  expect((await invoke('retry',['--run','a'.repeat(16),'--model-source','qwen','--model','qwen3.8-flash'])).code).not.toBe(0);
  expect(received).toHaveLength(4);
  expect(JSON.parse(await Bun.file(file).text())).toEqual(input);
 }finally{server.stop(true);await f.cleanup();}
});

test('register --live transfers reviewed paths to the worker without taking its service lease',async()=>{
 const f=await fixture();let received:unknown;
 await mkdir(join(f.layout.root,'.service.lock'));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/'||path==='/api/health')return Response.json({data:f.layout.root},{headers:{'Set-Cookie':'fixture=local; Path=/'}});
  if(path==='/api/register-tasks'){received=taskRegistrationSchema.parse(await request.json());return Response.json({registered:1});}
  return new Response('Unexpected call',{status:500});
 }});
 try{
  const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'register','--live','--root',f.layout.root,'--worker-port',String(server.port),
    '--dataset','deep-swe','--tasks','/external/tasks','--ids','candidate','--definition','/external/reviewed.json'],
    {env:{PATH:process.env.PATH,HOME:join(f.layout.root,'unused-user')},stdout:'pipe',stderr:'pipe'});
  const [output,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(code).toBe(0);expect(error).toBe('');expect(JSON.parse(output)).toEqual({registered:1});
  expect(received).toEqual({dataset:'deep-swe',source:'/external/tasks',ids:['candidate'],definition:'/external/reviewed.json'});
 }finally{server.stop(true);await f.cleanup();}
});

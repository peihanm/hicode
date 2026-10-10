import {test,expect} from 'bun:test';
import {mkdtemp,rm,realpath,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/host/types.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {EVAL_ROOT} from '../src/paths.js';

test('fresh root is initialized without Docker, credentials or historical records',async()=>{
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'eval-cli-'))),root=join(temporary,'data');
 try{
  const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'init','--root',root],{cwd:temporary,env:{PATH:process.env.PATH,HOME:join(temporary,"isolated-user")},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(JSON.parse(output).initialized).toBe(true);
  const config=await loadConfig(root);expect(config.data).toBe(root);expect((await TaskCatalog.open(config.catalog)).list()).toHaveLength(0);
  const old=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'status','--data-dir',root],{stdout:'pipe',stderr:'pipe'});const error=await new Response(old.stderr).text();expect(await old.exited).not.toBe(0);expect(error).toContain('Unknown option');
 }finally{await rm(temporary,{recursive:true,force:true});}
});


test('init imports the isolated user model and saved effort, or validates an explicit model declaration',async()=>{
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'eval-cli-model-'))),root=join(temporary,'data'),user=join(temporary,'user');
 try{
  await mkdir(join(user,'.hicode'),{recursive:true});
  await writeFile(join(user,'.hicode/settings.json'),JSON.stringify({models:{primary:{source:'qwen-token-plan',model:'deepseek-v4.1-flash'},reasoning:[{source:'qwen-token-plan',model:'deepseek-v4.1-flash',effort:'max'}]}}));
  const init=async(target:string,file?:string)=>{
   const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'init','--root',target,...(file?['--model-config',file]:[])],{cwd:temporary,env:{PATH:process.env.PATH,HOME:user},stdout:'pipe',stderr:'pipe'});
   const [output,error]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
   expect(await proc.exited).toBe(0);expect(error).toBe('');expect(JSON.parse(output).initialized).toBe(true);
   return loadConfig(target);
  };
  const imported=await init(root);expect(imported.model).toMatchObject({source:'qwen-token-plan',model:'deepseek-v4.1-flash',reasoning:{effort:'max'},apiKeyEnv:'QWEN_TOKEN_PLAN_API_KEY'});
  const file=join(temporary,'model.json');await writeFile(file,JSON.stringify({...imported.model,reasoning:{effort:'off'}}));
  const explicit=await init(join(temporary,'explicit'),file);expect(explicit.model.reasoning).toEqual({effort:'off'});
 }finally{await rm(temporary,{recursive:true,force:true});}
});

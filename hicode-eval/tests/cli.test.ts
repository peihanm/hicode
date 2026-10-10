import {test,expect} from 'bun:test';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/host/types.js';
import {TaskCatalog} from '../src/host/catalog.js';
import {EVAL_ROOT} from '../src/paths.js';

test('fresh root is initialized without Docker, credentials or historical records',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'eval-cli-')));
 try{
  const proc=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'init','--root',root],{env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(JSON.parse(output).initialized).toBe(true);
  const config=await loadConfig(root);expect(config.data).toBe(root);expect((await TaskCatalog.open(config.catalog)).list()).toHaveLength(0);
  const old=Bun.spawn(['bun',join(EVAL_ROOT,'src/cli.ts'),'status','--data-dir',root],{stdout:'pipe',stderr:'pipe'});const error=await new Response(old.stderr).text();expect(await old.exited).not.toBe(0);expect(error).toContain('Unknown option');
 }finally{await rm(root,{recursive:true,force:true});}
});

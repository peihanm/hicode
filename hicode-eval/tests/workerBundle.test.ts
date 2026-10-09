import {test,expect} from 'bun:test';
import {mkdir,mkdtemp,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerBundle} from '../src/host/workerBundle.js';

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'eval-worker-bundle-')));
  const source=join(root,'source'),worker=join(source,'src/worker');
  await mkdir(worker,{recursive:true});await mkdir(join(source,'src/datasets'));
  for(const name of ['runner.py','protocol.py','cleanup.py','recovery.py','service_namespace.py','service_bwrap.py','preflight.ts'])
    await writeFile(join(worker,name),'# fixture\n');
  await writeFile(join(source,'src/datasets/reviewed_test_deps.py'),'# fixture\n');
  return {root,source,worker,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('queued attempts deploy one frozen package even when source modules change or are added',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.worker,'runtime_extension.py'),'value = "original"\n');
    await writeFile(join(f.worker,'runner.py'),'from runtime_extension import value\nprint(value)\n');
    const bundle=await WorkerBundle.capture(f.source);
    await writeFile(join(f.worker,'runtime_extension.py'),'value = "changed"\n');
    await writeFile(join(f.worker,'future_module.py'),'# next worker only\n');
    for(const attempt of ['first','queued']){
      const target=join(f.root,attempt);await bundle.writeTo(target);
      const process=Bun.spawn(['python3','-B',join(target,'runner.py')],{stdout:'pipe',stderr:'pipe'});
      expect(await process.exited).toBe(0);expect((await new Response(process.stdout).text()).trim()).toBe('original');
      await expect(readFile(join(target,'future_module.py'))).rejects.toThrow();
      expect(await readFile(join(target,'service_namespace.py'),'utf8')).toBe('# fixture\n');
    }
    const updated=await WorkerBundle.capture(f.source);expect(updated.sha256).not.toBe(bundle.sha256);
    await updated.writeTo(join(f.root,'new-worker'));
    expect(await readFile(join(f.root,'new-worker/future_module.py'),'utf8')).toBe('# next worker only\n');
  }finally{await f.cleanup();}
});

test('incomplete or symlinked packages fail before deployment; staging never overwrites an existing module',async()=>{
  const f=await fixture();
  try{
    const bundle=await WorkerBundle.capture(f.source),target=join(f.root,'staged');
    await bundle.writeTo(target);await expect(bundle.writeTo(target)).rejects.toThrow();
    await rm(join(f.worker,'service_namespace.py'));
    await expect(WorkerBundle.capture(f.source)).rejects.toThrow('Incomplete worker package');
    await symlink(join(f.worker,'runner.py'),join(f.worker,'service_namespace.py'));
    await expect(WorkerBundle.capture(f.source)).rejects.toThrow('symlinks');
    await symlink(target,join(f.root,'alias'));
    await expect(bundle.writeTo(join(f.root,'alias'))).rejects.toThrow('Symlinked');
  }finally{await f.cleanup();}
});

test('frozen worker modules remain readable by the unprivileged actor under a restrictive host umask',async()=>{
  const f=await fixture(),previous=process.umask(0o077);
  try{
    const bundle=await WorkerBundle.capture(f.source),target=join(f.root,'restricted');
    await bundle.writeTo(target);
    expect((await stat(target)).mode&0o777).toBe(0o755);
    expect((await stat(join(target,'preflight.ts'))).mode&0o777).toBe(0o644);
    expect((await stat(join(target,'service_namespace.py'))).mode&0o777).toBe(0o644);
  }finally{process.umask(previous);await f.cleanup();}
});

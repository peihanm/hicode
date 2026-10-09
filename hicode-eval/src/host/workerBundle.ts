import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

/** One immutable execution package per worker lifetime, including future Python modules. */
export class WorkerBundle {
  private constructor(private readonly files:ReadonlyMap<string,Buffer>,readonly sha256:string){}
  static async capture(evalRoot:string):Promise<WorkerBundle>{
    const files=new Map<string,Buffer>();
    let bytes=0;
    const collect=async(directory:string,prefix:string)=>{
      for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(entry.name==='__pycache__')continue;
        if(entry.isSymbolicLink())throw Error('Worker package cannot contain symlinks');
        if(entry.isDirectory())await collect(join(directory,entry.name),prefix+entry.name+'/');
        else if(entry.isFile()&&(entry.name.endsWith('.py')||entry.name==='preflight.ts')){
          if(!/^[A-Za-z0-9_./-]+$/.test(prefix+entry.name))throw Error('Invalid worker package path');
          const path=join(directory,entry.name);
          if((await lstat(path)).size>1024*1024)throw Error('Worker module exceeds budget');
          const content=await readFile(path);bytes+=content.length;
          if(content.length>1024*1024||bytes>8*1024*1024||files.size>=256)throw Error('Worker package exceeds budget');
          files.set(prefix+entry.name,content);
        }
      }
    };
    await collect(join(evalRoot,'src/worker'),'');
    files.set('reviewed_test_deps.py',await readFile(join(evalRoot,'src/datasets/reviewed_test_deps.py')));
    for(const path of ['runner.py','protocol.py','cleanup.py','recovery.py','service_namespace.py','service_bwrap.py','preflight.ts'])
      if(!files.has(path))throw Error('Incomplete worker package: '+path);
    const hash=createHash('sha256');
    for(const [name,content] of files){hash.update(name+'\0');hash.update(createHash('sha256').update(content).digest());}
    return new WorkerBundle(files,hash.digest('hex'));
  }
  async writeTo(directory:string):Promise<void>{
    await mkdir(directory,{recursive:true,mode:0o755});
    if(await realpath(directory)!==resolve(directory))throw Error('Symlinked worker staging directory');
    await chmod(directory,0o755);
    for(const [name,content] of this.files){
      const target=join(directory,name);
      await mkdir(dirname(target),{recursive:true,mode:0o755});
      if(await realpath(dirname(target))!==resolve(dirname(target)))throw Error('Symlinked worker staging parent');
      await chmod(dirname(target),0o755);
      await writeFile(target,content,{flag:'wx',mode:0o644});
      await chmod(target,0o644);
    }
  }
}

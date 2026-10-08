import {constants} from 'node:fs';
import {open,mkdir,rm,realpath,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TaskCatalog} from './catalog.js';
import {batchSchema,runSchema,idSchema} from './types.js';
import type {Run} from './types.js';
import {readJson,save,exists} from './store.js';
import {lease} from './lease.js';

const MAX_ARCHIVE_METADATA_BYTES=32*1024*1024;
const journalSchema=z.object({version:z.literal(1),catalog:z.string(),runs:z.array(idSchema).max(10000),batches:z.array(idSchema).max(10000)}).strict();
const archiveSchema=z.object({version:z.literal(1),runId:idSchema,task:z.string(),originalPath:z.string(),
  files:z.record(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(MAX_ARCHIVE_METADATA_BYTES),originalBytes:z.number().nonnegative()}))}).strict();

/** Archive compact results before removing only fully finished batches. */
export async function archiveRuns(data:string,catalogPath:string,apply:boolean){
  if(await realpath(data)!==resolve(data))throw Error('Run data must use its canonical path');
  const release=await lease(data,'service');
  let releaseRegrade:(()=>Promise<void>)|undefined;
  try {
    releaseRegrade=await lease(data,'regrade');
    const catalog=await TaskCatalog.open(catalogPath),archive=join(dirname(catalogPath),'run-archive');
    const journal=join(data,'.archive-cleanup.json');
    const finish=async()=>{
      const pending=await readJson(journal,journalSchema);
      if(pending.catalog!==catalogPath)throw Error('Cleanup catalog changed');
      for(const id of pending.runs){
        const receipt=await readJson(join(archive,id,'archive.json'),archiveSchema);
        if(receipt.runId!==id||receipt.originalPath!==join(data,'runs',id))throw Error('Invalid cleanup receipt');
        for(const [name,metadata] of Object.entries(receipt.files)){
          if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.startsWith('/')||name.split('/').includes('..'))throw Error('Unsafe archive entry');
          const path=join(archive,id,name);
          if(await realpath(path)!==resolve(path))throw Error('Symlinked archive entry');
          const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
          try {if((await fd.stat()).size!==metadata.bytes||createHash('sha256').update(await fd.readFile()).digest('hex')!==metadata.sha256)throw Error('Archived evidence changed');}
          finally {await fd.close();}
        }
        const state=await readJson(join(archive,id,'state.json'),runSchema);
        if(state.task!==receipt.task||state.id!==id||!catalog.get(state.dataset,receipt.task).results.some(r=>r.runId===id))
          throw Error('Invalid cleanup receipt');
      }
      for(const id of pending.runs){const path=join(data,'runs',id);if(await exists(path)&&await realpath(path)!==resolve(path))throw Error('Redirected cleanup directory');await rm(path,{recursive:true,force:true});}
      for(const id of pending.batches)await rm(join(data,'batches',id+'.json'),{force:true});
      const result={runs:pending.runs.length,batches:pending.batches.length,archive,applied:true};
      await save(join(archive,'last-cleanup.json'),{...result,at:new Date().toISOString()});
      await rm(journal);return result;
    };
    if(await exists(journal)){
      if(apply)return await finish();
      const pending=await readJson(journal,journalSchema);return {runs:pending.runs.length,batches:pending.batches.length,archive,applied:false,resuming:true};
    }
    const eligible:{id:string;path:string;state:Run}[]=[];
    const batches=[];
    for(const name of await readdir(join(data,'batches'))){
      if(!/^[a-f0-9]{16}\.json$/.test(name))continue;
      const batch=await readJson(join(data,'batches',name),batchSchema);
      if(batch.id+'.json'!==name)throw Error('Batch archive identity mismatch');
      const rows=[];
      for(const id of batch.runIds){
        const path=join(data,'runs',id),state=await readJson(join(path,'state.json'),runSchema);
        if(state.id!==id||state.batchId!==batch.id)throw Error('Run archive identity mismatch');
        rows.push({id,path,state});
      }
      if(rows.some(row=>!['passed','failed','error','cancelled'].includes(row.state.state)))continue;
      for(const row of rows){
        const stored=catalog.get(row.state.dataset,row.state.task).results.find(result=>result.runId===row.id);
        if(!stored||stored.execution!==row.state.execution||stored.grading!==row.state.grading)
          throw Error('Archive the task result before deleting its run: '+row.id);
      }
      eligible.push(...rows);batches.push(batch);
    }
    if(!apply)return {runs:eligible.length,batches:batches.length,archive,applied:false};
    await mkdir(archive,{recursive:true,mode:0o700});
    for(const row of eligible){
      const destination=join(archive,row.id);await mkdir(destination,{recursive:true,mode:0o700});
      const files:Record<string,{sha256:string;bytes:number;originalBytes:number}>={};
      for(const relative of ['state.json','job.json','environment.json','grading-correction.json','evidence/result.json','evidence/outcome.json','evidence/shutdown.json',
        'evidence/prediction.json','evidence/patch-manifest.json','evidence/logs/verifier/report.json','evidence/logs/verifier/ctrf.json',
        'evidence/logs/verifier/validity.json','evidence/logs/verifier/output.txt','evidence/logs/verifier/parsed-output.txt']){
        const source=join(row.path,relative);if(!await exists(source))continue;
        if(await realpath(dirname(source))!==resolve(dirname(source)))throw Error('Symlinked result archive path');
        const fd=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          const stat=await fd.stat();if(!stat.isFile())throw Error('Result archive requires regular files');
          const max=relative.endsWith('output.txt')?1024*1024:MAX_ARCHIVE_METADATA_BYTES;
          if(stat.size>max&&!relative.endsWith('output.txt'))throw Error('Result metadata exceeds archive budget');
          const buffer=Buffer.alloc(Math.min(stat.size,max));const {bytesRead}=await fd.read(buffer,0,buffer.length,Math.max(0,stat.size-max));
          if(bytesRead!==buffer.length)throw Error('Result changed while archiving');
          const target=join(destination,relative);await mkdir(dirname(target),{recursive:true,mode:0o700});
          if(await realpath(dirname(target))!==resolve(dirname(target)))throw Error('Symlinked archive destination');
          const output=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
          try {await output.writeFile(buffer);await output.sync();}finally{await output.close();}
          files[relative]={sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,originalBytes:stat.size};
        } finally {await fd.close();}
      }
      await save(join(destination,'archive.json'),{version:1,runId:row.id,task:row.state.task,originalPath:row.path,files});
    }
    for(const batch of batches)await save(join(archive,'batches',batch.id+'.json'),batch);
    // Revalidate every state before the first deletion; an archive failure leaves all source runs intact.
    for(const row of eligible){
      if(await realpath(row.path)!==resolve(row.path)||JSON.stringify(await readJson(join(row.path,'state.json'),runSchema))!==JSON.stringify(row.state))
        throw Error('Run changed during archival');
    }
    await save(journal,{version:1,catalog:catalogPath,runs:eligible.map(row=>row.id),batches:batches.map(batch=>batch.id)});
    return await finish();
  } finally {await releaseRegrade?.();await release();}
}

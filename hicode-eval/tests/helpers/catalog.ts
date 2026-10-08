import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {save} from '../../src/host/store.js';
import type {Config} from '../../src/host/types.js';
import type {EnvironmentBinding} from '../../src/host/environments.js';
import {taskKey} from '../../src/host/datasets.js';

export function environmentFixture(task:string):EnvironmentBinding {
  const base={version:2 as const,kind:'base' as const,key:'b'.repeat(64),imageId:'sha256:'+'b'.repeat(64),parentImage:'sha256:'+'a'.repeat(64),recipeSha256:'c'.repeat(64),createdAt:'2026-10-02T00:00:00.000Z'};
  return {version:2,task,sourceHash:'d'.repeat(64),base,dependencies:{...base,kind:'dependencies',key:'e'.repeat(64),imageId:'sha256:'+'e'.repeat(64),parentImage:base.imageId},preparation:null};
}
export async function seedCatalog(config:Pick<Config,'catalog'|'environments'>,entries:{id:string;source:string;dataset?:'terminal-bench'|'terminal-bench-2.1'|'swe-bench-verified'}[]){
  await save(config.catalog,{version:1,updatedAt:'2026-10-02T00:00:00.000Z',tasks:entries.map(entry=>({dataset:'terminal-bench',...entry,status:'untested',results:[]}))});
  for(const entry of entries){
    const key=taskKey({dataset:entry.dataset??'terminal-bench',id:entry.id});
    await save(join(config.environments,'tasks',createHash('sha256').update(key).digest('hex')+'.json'),environmentFixture(key));
  }
}

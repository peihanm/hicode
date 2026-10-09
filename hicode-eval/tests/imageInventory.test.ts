import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imageInventory} from '../src/host/imageInventory.js';
import {organizeEnvironmentImages} from '../src/host/imageTags.js';
import {environmentBindingPath} from '../src/host/environments.js';
import {configSchema} from '../src/host/types.js';
import {save} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import {environmentFixture} from './helpers/catalog.js';

test('image inventory groups shared IDs only within one Docker context and isolates invalid receipts',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-image-inventory-')));
  const environments=join(root,'environments');
  const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments,
    payload:join(root,'payload'),context:'arm-fixture',machine:'fixture',concurrency:1,budget:{},
    datasetBackends:{'deep-swe':{context:'amd-fixture',cpus:2,memoryMb:8192}},
    model:{source:'qwen',model:'fixture',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
  const tasks=[
    {dataset:'terminal-bench' as const,id:'old'},
    {dataset:'terminal-bench-2.1' as const,id:'new'},
    {dataset:'deep-swe' as const,id:'deep'},
  ];
  const base='sha256:'+'b'.repeat(64),dependency='sha256:'+'e'.repeat(64);
  const tags=new Map<string,string>([['hicode-env-base:fixed',base]]);
  const docker=spyOn(transport,'run').mockImplementation(async args=>{
    const context=args[2];
    if(context==='amd-fixture')throw Error('AMD engine timed out');
    if(context!=='arm-fixture')throw Error('Unexpected Docker context');
    if(args.includes('tag')){tags.set(args.at(-1)!,args.at(-2)!);return '';}
    if(args.includes('ls')){
      const reference=args.find(arg=>arg.startsWith('reference='))?.slice('reference='.length);
      return [...tags].filter(([tag])=>{
        if(!reference)return true;
        return reference==='hicode-eval/*'?tag.startsWith('hicode-eval/'):tag===reference;
      })
        .map(([tag,id])=>`${id}|${tag}`).join('\n');
    }
    if(args.includes('inspect')){
      const ids=[...new Set(args.slice(args.indexOf('--format')+2))];
      if(ids.some(id=>![...tags.values()].includes(id)))throw Error('No such image');
      return ids.map(id=>`${id}|arm64`).join('\n');
    }
    throw Error('Unexpected Docker query');
  });
  try{
    await save(join(root,'config.json'),config);
    await save(config.catalog,{version:1,updatedAt:'2026-10-09T00:00:00.000Z',tasks:tasks.map(task=>({...task,
      source:join(root,task.id),status:'untested',results:[]}))});
    for(const task of tasks)await save(environmentBindingPath(environments,task),environmentFixture(`${task.dataset}:${task.id}`));
    await writeFile(join(environments,'tasks','f'.repeat(64)+'.json'),'{broken');
    await symlink(join(root,'config.json'),join(environments,'tasks','a'.repeat(64)+'.json'));

    const selected=await imageInventory(root,'terminal-bench-2.1');
    expect(selected.totals).toEqual({receipts:3,images:4,sharedImages:2,invalidReceipts:2});
    expect(selected.contexts).toEqual([{name:'arm-fixture',status:'available'}]);
    expect(selected.images).toHaveLength(2);
    expect(selected.images.find(image=>image.imageId===dependency)?.availability).toBe('missing');
    expect(selected.images.find(image=>image.imageId===base)).toMatchObject({architecture:'arm64',
      datasets:['terminal-bench','terminal-bench-2.1']});
    expect(docker.mock.calls.every(([args])=>args[2]==='arm-fixture')).toBe(true);

    docker.mockClear();
    const all=await imageInventory(root);
    expect(all.contexts).toEqual([{name:'amd-fixture',status:'unavailable',error:'AMD engine timed out'},
      {name:'arm-fixture',status:'available'}]);
    expect(all.images.filter(image=>image.imageId===base)).toHaveLength(2);
    expect(all.images.filter(image=>image.context==='amd-fixture').every(image=>image.availability==='unavailable')).toBe(true);
    expect(all.invalidReceipts).toHaveLength(2);

    tags.set('hicode-env-dependencies:fixed',dependency);
    const preview=await organizeEnvironmentImages(root,'terminal-bench-2.1');
    expect(preview.counts).toMatchObject({ready:2,added:0,conflict:0});
    expect(preview.entries.every(entry=>entry.dataset==='terminal-bench-2.1')).toBe(true);
    expect(tags.has(`hicode-eval/terminal-bench-2.1:base-${'b'.repeat(64)}`)).toBe(false);
    const applied=await organizeEnvironmentImages(root,'terminal-bench-2.1',true);
    expect(applied.counts).toMatchObject({added:2,failed:0});
    expect((await organizeEnvironmentImages(root,'terminal-bench-2.1',true)).counts)
      .toMatchObject({existing:2,added:0});
    expect((await organizeEnvironmentImages(root)).counts.unavailable).toBe(2);

    const alias=`hicode-eval/terminal-bench-2.1:dependencies-${'e'.repeat(64)}`;
    tags.set(alias,'sha256:'+'f'.repeat(64));
    expect((await organizeEnvironmentImages(root,'terminal-bench-2.1')).counts.conflict).toBe(1);
    await expect(organizeEnvironmentImages(root,'terminal-bench-2.1',true)).rejects.toThrow('tag conflict');
  }finally{docker.mockRestore();await rm(root,{recursive:true,force:true});}
});

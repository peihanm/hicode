import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvalLayout} from '../../src/host/layout.js';
import {settingsSchema,configSchema,runSchema} from '../../src/host/types.js';
import {save} from '../../src/host/store.js';
import {TaskCatalog} from '../../src/host/catalog.js';
import {environmentBindingPath} from '../../src/host/environments.js';
import type {EnvironmentBinding} from '../../src/host/environments.js';
import {taskKey} from '../../src/host/datasets.js';

export async function fixture(){
 const layout=new EvalLayout(await realpath(await mkdtemp(join(tmpdir(),'eval-root-'))));await layout.initialize();
 const settings=settingsSchema.parse({version:1,context:'offline',machine:'runtime',concurrency:5,budget:{},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
 await save(layout.settings,settings);await save(layout.catalog,{version:1,updatedAt:new Date().toISOString(),tasks:[]});
 return {layout,config:configSchema.parse({...settings,data:layout.root}),catalog:await TaskCatalog.open(layout.catalog),cleanup:()=>rm(layout.root,{recursive:true,force:true})};
}
export function binding(key:string,letter='c'):EnvironmentBinding{
 const base={version:1 as const,kind:'base' as const,key:'b'.repeat(64),imageId:'sha256:'+'b'.repeat(64),parentImage:'sha256:'+'a'.repeat(64),recipeSha256:'d'.repeat(64),createdAt:new Date().toISOString()};
 return {version:1,task:key,sourceHash:'e'.repeat(64),base,dependencies:{...base,kind:'dependencies',key:letter.repeat(64),imageId:'sha256:'+letter.repeat(64),parentImage:base.imageId},preparation:null};
}
export async function seed(f:Awaited<ReturnType<typeof fixture>>,id:string,letter='c'){
 const task={id,dataset:'terminal-bench-2.1' as const},source=f.layout.source(task);await mkdir(source,{recursive:true});await writeFile(join(source,'instruction.md'),'fixture task');
 await f.catalog.register([{...task,source}]);await f.catalog.setEnvironment(task,'ready');
 const b=binding(taskKey(task),letter);await save(environmentBindingPath(f.config.environments,task),b);return {...task,source,binding:b};
}
export function finished(task:string,id='a'.repeat(16)){
 return runSchema.parse({version:1,id,batchId:'f'.repeat(16),dataset:'terminal-bench-2.1',task,state:'passed',execution:'completed',grading:'passed',collection:'complete',model:'fake',budget:{},createdAt:1,updatedAt:2,finishedAt:2});
}

import {readFile} from 'node:fs/promises';
import {parse} from 'dotenv';
import type {Batch} from './types.js';

/** Worker startup reads only configured credential names; secrets never enter batch data. */
export async function loadModelCredentials(
  models: readonly Batch['model'][],
  environment: Readonly<Record<string,string|undefined>>,
  files: readonly string[],
): Promise<ReadonlyMap<string,string>> {
  const names=new Set(models.map(model=>model.apiKeyEnv));
  const credentials=new Map<string,string>();
  for(const name of names){
    const value=environment[name];
    if(Object.hasOwn(environment,name)&&typeof value==='string'&&value)credentials.set(name,value);
  }
  for(const path of files){
    if(credentials.size===names.size)break;
    let content:string;
    try{content=await readFile(path,'utf8');}
    catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')continue;throw error;}
    const values=parse(content);
    for(const name of names){
      const value=values[name];
      if(!credentials.has(name)&&Object.hasOwn(values,name)&&typeof value==='string'&&value)credentials.set(name,value);
    }
  }
  return credentials;
}

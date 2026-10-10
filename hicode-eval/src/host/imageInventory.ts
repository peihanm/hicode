import {readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {TaskCatalog} from './catalog.js';
import {datasetSchema,taskKey,taskRefSchema} from './datasets.js';
import type {Dataset} from './datasets.js';
import {bindingSchema,environmentBindingPath} from './environments.js';
import type {EnvironmentBinding} from './environments.js';
import {readJson,run} from './store.js';
import {loadConfig} from './types.js';

type Layer=EnvironmentBinding['base'];
type ImageRef={context:string;imageId:string;datasets:Set<Dataset>;tasks:Set<string>;
  layers:Map<string,{kind:Layer['kind'];key:string;datasets:Set<Dataset>}>};
type DockerImage={architecture:string|null;tags:Set<string>};
type DockerContext={name:string;status:'available'|'unavailable';error?:string;images:Map<string,DockerImage>};
const imageId=/^sha256:[a-f0-9]{64}$/;

async function inspectContext(name:string,referenced:readonly string[]):Promise<DockerContext>{
  const images=new Map<string,DockerImage>();
  try{
    const listing=await run(['docker','--context',name,'image','ls','-a','--no-trunc','--format','{{.ID}}|{{.Repository}}:{{.Tag}}'],{timeout:8000});
    for(const line of listing.split('\n').filter(Boolean)){
      const separator=line.indexOf('|'),id=line.slice(0,separator),tag=line.slice(separator+1);
      if(separator<0||!imageId.test(id))throw Error('Invalid Docker image listing');
      let image=images.get(id);if(!image){image={architecture:null,tags:new Set()};images.set(id,image);}
      if(!tag.endsWith(':<none>')&&!tag.startsWith('<none>:'))image.tags.add(tag);
    }
    const present=referenced.filter(id=>images.has(id));
    if(present.length){
      try{
        const details=await run(['docker','--context',name,'image','inspect','--format','{{.Id}}|{{.Architecture}}',...present],{timeout:8000});
        for(const line of details.split('\n').filter(Boolean)){
          const separator=line.indexOf('|'),id=line.slice(0,separator),architecture=line.slice(separator+1);
          if(separator<0||!imageId.test(id)||!['amd64','arm64','386','arm','ppc64le','s390x','riscv64'].includes(architecture))
            throw Error('Invalid Docker image inspection');
          const image=images.get(id);if(image)image.architecture=architecture;
        }
      }catch{return {name,status:'available',error:'Image architecture inspection unavailable',images};}
    }
    return {name,status:'available',images};
  }catch(error){return {name,status:'unavailable',error:error instanceof Error?error.message.slice(0,240):'Docker context unavailable',images:new Map()};}
}

/** A derived view of validated local receipts; source/recipe validity still belongs to resolve(). */
export async function imageInventory(dataDir:string,selected?:Dataset){
  const data=await realpath(resolve(dataDir));
  const config=await loadConfig(data);
  if(resolve(config.data)!==data)throw Error('Inventory data directory differs from service config');
  const environment=await realpath(config.environments);
  if(environment!==resolve(config.environments))throw Error('Symlinked environment directory');
  const catalog=await TaskCatalog.open(config.catalog);
  const catalogStatus=new Map(catalog.list().map(task=>[taskKey(task),task.status]));
  const names=await readdir(join(environment,'tasks'),{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
  if(names.length>10000)throw Error('Too many environment receipts');
  const images=new Map<string,ImageRef>();
  const receiptCounts=new Map<Dataset,number>();
  const invalidReceipts:{file:string;reason:string}[]=[];
  for(const entry of names){
    if(!entry.name.endsWith('.json'))continue;
    try{
      if(!entry.isFile()||!/^[a-f0-9]{64}\.json$/.test(entry.name))throw Error('Invalid receipt filename or type');
      const path=join(environment,'tasks',entry.name);
      const binding=await readJson(path,bindingSchema,65536);
      const parts=binding.task.split(':');
      if(parts.length!==2)throw Error('Invalid receipt task identity');
      const task=taskRefSchema.parse({dataset:datasetSchema.parse(parts[0]),id:parts[1]});
      if(environmentBindingPath(environment,task)!==path)throw Error('Receipt filename does not match task identity');
      receiptCounts.set(task.dataset,(receiptCounts.get(task.dataset)??0)+1);
      const context=config.datasetBackends[task.dataset]?.context??config.context;
      for(const layer of [binding.base,binding.dependencies,binding.preparation].filter((value):value is Layer=>value!==null)){
        const key=context+'|'+layer.imageId;
        let image=images.get(key);
        if(!image){image={context,imageId:layer.imageId,datasets:new Set(),tasks:new Set(),layers:new Map()};images.set(key,image);}
        image.datasets.add(task.dataset);image.tasks.add(binding.task);
        const layerKey=layer.kind+'|'+layer.key;
        let layerRef=image.layers.get(layerKey);
        if(!layerRef){layerRef={kind:layer.kind,key:layer.key,datasets:new Set()};image.layers.set(layerKey,layerRef);}
        layerRef.datasets.add(task.dataset);
      }
    }catch(error){invalidReceipts.push({file:entry.name,reason:error instanceof Error?error.message.slice(0,240):'Invalid receipt'});}
  }
  const chosen=[...images.values()].filter(image=>!selected||image.datasets.has(selected));
  const contexts=[...new Set(chosen.map(image=>image.context))].sort();
  const inspected=await Promise.all(contexts.map(name=>inspectContext(name,[...new Set(chosen.filter(image=>image.context===name).map(image=>image.imageId))])));
  const engines=new Map(inspected.map(context=>[context.name,context]));
  const datasets=datasetSchema.options.filter(dataset=>!selected||dataset===selected).map(dataset=>{
    const members=[...images.values()].filter(image=>image.datasets.has(dataset));
    return {dataset,receipts:receiptCounts.get(dataset)??0,images:members.length,
      sharedImages:members.filter(image=>image.datasets.size>1).length};
  });
  return {data,dataset:selected??null,generatedAt:new Date().toISOString(),
    totals:{receipts:[...receiptCounts.values()].reduce((sum,count)=>sum+count,0),images:images.size,
      sharedImages:[...images.values()].filter(image=>image.datasets.size>1).length,invalidReceipts:invalidReceipts.length},
    datasets,contexts:inspected.map(({name,status,error})=>({name,status,...(error?{error}:{})})),
    images:chosen.sort((a,b)=>a.context.localeCompare(b.context)||a.imageId.localeCompare(b.imageId)).map(image=>{
      const context=engines.get(image.context)!;
      const docker=context.images.get(image.imageId);
      return {context:image.context,imageId:image.imageId,
        availability:context.status==='unavailable'?'unavailable':docker?'present':'missing',
        architecture:docker?.architecture??null,tags:[...(docker?.tags??[])].sort(),
        datasets:[...image.datasets].sort(),layers:[...image.layers.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.key.localeCompare(b.key))
          .map(layer=>({kind:layer.kind,key:layer.key,datasets:[...layer.datasets].sort()})),
        tasks:[...image.tasks].sort().map(key=>({key,status:catalogStatus.get(key)??null}))};
    }),invalidReceipts};
}

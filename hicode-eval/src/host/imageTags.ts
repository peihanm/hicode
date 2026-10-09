import {imageInventory} from './imageInventory.js';
import {run} from './store.js';
import type {Dataset} from './datasets.js';

type TagState='existing'|'ready'|'added'|'conflict'|'missing'|'unavailable'|'failed';
type TagEntry={context:string;dataset:Dataset;kind:'base'|'dependencies'|'task';key:string;
  imageId:string;tag:string;state:TagState;owner?:string;error?:string};
const imageId=/^sha256:[a-f0-9]{64}$/;

function parseListing(output:string):Map<string,string>{
  const tags=new Map<string,string>();
  for(const line of output.split('\n').filter(Boolean)){
    const separator=line.indexOf('|'),id=line.slice(0,separator),tag=line.slice(separator+1);
    if(separator<0||!imageId.test(id))throw Error('Invalid Docker image listing');
    if(tag.endsWith(':<none>')||tag.startsWith('<none>:'))continue;
    const previous=tags.get(tag);
    if(previous&&previous!==id)throw Error('Docker tag has multiple image owners');
    tags.set(tag,id);
  }
  return tags;
}

/** Classification aliases only; task receipts and immutable image IDs remain untouched. */
export async function organizeEnvironmentImages(dataDir:string,selected?:Dataset,apply=false){
  const inventory=await imageInventory(dataDir,selected);
  const contextStatus=new Map(inventory.contexts.map(context=>[context.name,context.status]));
  const owners=new Map<string,Map<string,string>>();
  for(const context of inventory.contexts){
    if(context.status!=='available')continue;
    try{
      const output=await run(['docker','--context',context.name,'image','ls','--no-trunc',
        '--filter','reference=hicode-eval/*','--format','{{.ID}}|{{.Repository}}:{{.Tag}}'],{timeout:8000});
      owners.set(context.name,parseListing(output));
    }catch{
      contextStatus.set(context.name,'unavailable');
    }
  }
  const entries:TagEntry[]=[];
  const seen=new Map<string,string>();
  for(const image of inventory.images)for(const layer of image.layers)for(const dataset of layer.datasets){
    if(dataset==='terminal-bench'||selected&&dataset!==selected)continue;
    const tag=`hicode-eval/${dataset}:${layer.kind}-${layer.key}`;
    const identity=image.context+'|'+tag,previous=seen.get(identity);
    if(previous&&previous!==image.imageId)throw Error('Classification alias has conflicting receipt owners');
    if(previous)continue;
    seen.set(identity,image.imageId);
    const owner=owners.get(image.context)?.get(tag);
    const state:TagState=contextStatus.get(image.context)==='unavailable'?'unavailable':
      image.availability==='missing'?'missing':owner===image.imageId?'existing':owner?'conflict':'ready';
    entries.push({context:image.context,dataset,kind:layer.kind,key:layer.key,imageId:image.imageId,tag,state,
      ...(owner&&owner!==image.imageId?{owner}:{})});
  }
  entries.sort((a,b)=>a.context.localeCompare(b.context)||a.tag.localeCompare(b.tag));
  if(apply){
    if(entries.some(entry=>entry.state==='conflict'))throw Error('Classification tag conflict; no tags were changed');
    for(const entry of entries){
      if(entry.state!=='ready')continue;
      try{
        // Recheck each alias immediately before mutation; an existing foreign tag must never be replaced.
        const current=parseListing(await run(['docker','--context',entry.context,'image','ls','-a','--no-trunc',
          '--filter','reference='+entry.tag,'--format','{{.ID}}|{{.Repository}}:{{.Tag}}'],{timeout:8000})).get(entry.tag);
        if(current&&current!==entry.imageId){entry.state='conflict';entry.owner=current;continue;}
        if(current===entry.imageId){entry.state='existing';continue;}
        await run(['docker','--context',entry.context,'tag',entry.imageId,entry.tag],{timeout:8000});
        entry.state='added';
      }catch(error){entry.state='failed';entry.error=error instanceof Error?error.message.slice(0,240):'Docker tag failed';}
    }
  }
  const counts=Object.fromEntries((['existing','ready','added','conflict','missing','unavailable','failed'] as const)
    .map(state=>[state,entries.filter(entry=>entry.state===state).length]));
  return {data:inventory.data,dataset:selected??null,applied:apply,counts,entries};
}

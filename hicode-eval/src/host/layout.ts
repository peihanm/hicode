import {join,resolve,basename,dirname} from 'node:path';
import {mkdir,realpath,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {readJson,save,exists} from './store.js';
import type {TaskRef} from './datasets.js';

const identity=z.object({version:z.literal(1),kind:z.literal('hicode-eval')}).strict();
const safeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/);
const runId=z.string().regex(/^[a-f0-9]{16}$/);

/** Every host path is owned by this layout; external inputs are copied into it. */
export class EvalLayout {
  readonly root:string;
  constructor(root:string){this.root=resolve(root);}
  get state(){return join(this.root,'state');}
  get settings(){return join(this.state,'settings.json');}
  get catalog(){return join(this.state,'catalog.json');}
  get batches(){return join(this.state,'batches');}
  get environments(){return join(this.root,'environments');}
  get datasets(){return join(this.root,'datasets');}
  get runtime(){return join(this.environments,'runtime');}
  definition(dataset:string){return join(this.datasets,safeId.parse(dataset),'definition.json');}
  recipes(dataset:string){return join(this.datasets,safeId.parse(dataset),'recipes');}
  runtimeDockerfile(dataset:string){return join(this.datasets,safeId.parse(dataset),'runtime.Dockerfile');}
  get runs(){return join(this.root,'runs');}
  get cache(){return join(this.root,'cache');}
  get payload(){return join(this.cache,'payload');}
  get builds(){return join(this.cache,'builds');}
  get downloads(){return join(this.cache,'downloads');}
  get preparations(){return join(this.environments,'preparations');}
  run(id:string){return join(this.runs,runId.parse(id));}
  batch(id:string){return join(this.batches,runId.parse(id)+'.json');}
  source(task:TaskRef){return join(this.datasets,safeId.parse(task.dataset),'tasks',safeId.parse(task.id));}
  static fromEnvironments(path:string){
    if(basename(path)!=='environments')throw Error('Environment store must belong to the current evaluation root');
    return new EvalLayout(dirname(path));
  }
  async assert(){
    if(await realpath(this.root)!==this.root)throw Error('Symlinked evaluation root');
    await readJson(join(this.state,'layout.json'),identity);
    for(const path of [this.state,this.datasets,this.environments,this.runs,this.cache,this.batches,this.builds,this.downloads,this.preparations])
      if(await realpath(path)!==path)throw Error('Symlinked evaluation directory');
  }
  async initialize(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    if(await realpath(this.root)!==this.root)throw Error('Symlinked evaluation root');
    if(await exists(join(this.state,'layout.json'))){await this.assert();return false;}
    if((await readdir(this.root)).length)throw Error('Initialize an empty root; old data must remain in the offline backup');
    for(const path of [this.state,this.datasets,this.environments,this.runs,this.cache,this.batches,this.builds,this.downloads,this.preparations])
      await mkdir(path,{recursive:true,mode:0o700});
    await save(join(this.state,'layout.json'),{version:1,kind:'hicode-eval'});
    return true;
  }
}

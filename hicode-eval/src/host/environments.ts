import {createHash,randomUUID} from 'node:crypto';
import {mkdir,rm,writeFile,cp,realpath,readFile,copyFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {EVAL_ROOT,REPOSITORY_ROOT} from '../paths.js';
import {readJson,save,run,exists,tree} from './store.js';
import {lease} from './lease.js';
import {EvalLayout} from './layout.js';
import {baseImagesSchema,dependencyRecipeSchema} from './environmentRecipes.js';
import type {DependencyRecipe} from './environmentRecipes.js';
import type {CatalogTask} from './catalog.js';
import {taskAdapters,taskKey} from './datasets.js';
import type {TaskMetadata} from './datasets.js';
import type {DatasetBackends} from './types.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const imageId=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const layerSchema=z.object({version:z.literal(1),kind:z.enum(['base','dependencies','task']),key:hash,
  imageId,parentImage:imageId,recipeSha256:hash,createdAt:z.string().datetime()}).strict();
export const bindingSchema=z.object({version:z.literal(1),task:z.string(),sourceHash:hash,
  base:layerSchema,dependencies:layerSchema,preparation:layerSchema.nullable()}).strict().refine(value=>
    value.base.kind==='base'&&value.dependencies.kind==='dependencies'&&value.dependencies.parentImage===value.base.imageId&&
    (!value.preparation||(value.preparation.kind==='task'&&value.preparation.parentImage===value.dependencies.imageId)),
    'Invalid environment layer graph');
export type EnvironmentBinding=z.infer<typeof bindingSchema>;
type Layer=z.infer<typeof layerSchema>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function environmentBindingPath(root:string,task:Pick<CatalogTask,'dataset'|'id'>):string{
  return join(root,'tasks',digest(taskKey(task))+'.json');
}

function aptInstall(packages:readonly string[]):string {
  return packages.length?'RUN --mount=type=cache,id=hicode-clean-apt-lists-v1,target=/var/lib/apt/lists,sharing=locked --mount=type=cache,id=hicode-clean-apt-archives-v1,target=/var/cache/apt,sharing=locked apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=15 update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends '+packages.join(' ')+'\n':'';
}
function environmentBuilder(definition?:DependencyRecipe){
  if(definition?.python==='3.6.15')return 'prepare_source_environment.py';
  if(definition?.python==='3.7.17')return 'prepare_source_environment37.py';
  return 'prepare_environment.py';
}


/** Only recipe inputs enter builds. The cache machine and run files are never imported. */
export class EnvironmentStore {
  private readonly dependencyBuilds=new Map<string,Promise<Layer>>();
  constructor(readonly root:string,private readonly context:string,private readonly backends:DatasetBackends={},private readonly buildProxy?:string){}
  private routed(task:CatalogTask){
    const backend=this.backends[task.dataset];
    return backend&&backend.context!==this.context?new EnvironmentStore(this.root,backend.context,{},this.buildProxy):null;
  }
  private docker(...args:string[]){return ['docker','--context',this.context,...args];}
  private bindingPath(task:CatalogTask){return environmentBindingPath(this.root,task);}
  private async inspect(name:string){
    return z.array(z.object({Id:imageId,Config:z.object({Labels:z.record(z.string()).nullable().optional()})})).length(1)
      .parse(JSON.parse(await run(this.docker('image','inspect',name))))[0]!;
  }
  private async verifyImage(layer:Layer){
    const image=await this.inspect(layer.imageId);
    if(image.Id!==layer.imageId||image.Config.Labels?.['dev.hicode.environment']!==layer.key)throw Error('Environment image identity changed');
  }
  private async available(layer:Layer){
    try{await this.verifyImage(layer);return true;}
    catch(error){
      if(error instanceof Error&&error.message.includes('Error response from daemon: No such image:'))return false;
      throw error;
    }
  }
  private async build(kind:Layer['kind'],parent:string,recipeSha256:string,stage:string,dockerfile:string){
    const key=digest(JSON.stringify({version:1,kind,parent,recipeSha256,dockerfile}));
    const directory=join(this.root,'layers',key),receipt=join(directory,'layer.json');
    await mkdir(directory,{recursive:true,mode:0o700});
    const release=await lease(directory,'build');
    try {
      if(await exists(receipt)){
        const layer=await readJson(receipt,layerSchema);
        if(await this.available(layer)){await this.verifyImage(layer);return layer;}
      }
      const tag='hicode-env-'+kind+':'+key;
      if(await run(this.docker('image','ls','--quiet','--filter','reference='+tag))){
        const image=await this.inspect(tag);
        const layer:Layer={version:1,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),recipeSha256,createdAt:new Date().toISOString()};
        await this.verifyImage(layer);await save(receipt,layer);return layer;
      }
      const source=dockerfile+'\nLABEL dev.hicode.environment="'+key+'" dev.hicode.layer="'+kind+'"\nWORKDIR /eval\nCMD ["sleep","infinity"]\n';
      await writeFile(join(stage,'Dockerfile'),source);
      // Keep only the explicit build context and immutable image receipt for reconstruction.
      try {
        const output=await run(this.docker('build',...(this.buildProxy?['--build-arg','HTTP_PROXY='+this.buildProxy,'--build-arg','HTTPS_PROXY='+this.buildProxy]:[]),'--network=default','--pull=false','--progress=plain','-t',tag,stage),{timeout:1800000,includeStderr:true});
        await writeFile(join(directory,'build.log'),output.slice(-32768));
      }catch(error){
        const log=join(directory,'build.log');await writeFile(log,String(error));
        throw new Error('Environment build failed; full log: '+log+'\n'+String(error).slice(-1200));
      }
      const image=await this.inspect(tag);
      const layer:Layer={version:1,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),recipeSha256,createdAt:new Date().toISOString()};
      await this.verifyImage(layer);await save(receipt,layer);return layer;
    }finally{await release();}
  }
  private async childDockerfile(parent:Layer,body:string){
    const tag='hicode-env-parent:'+parent.imageId.slice(7);
    await run(this.docker('tag',parent.imageId,tag));
    return 'FROM '+tag+'\nUSER root\n'+body;
  }
  async prepareBase():Promise<Layer>{
    await mkdir(this.root,{recursive:true,mode:0o700});
    const release=await lease(this.root,'prepare');
    const stage=join(EvalLayout.fromEnvironments(this.root).builds,'stage-'+randomUUID());await mkdir(stage);
    try {
      const images=await readJson(join(EvalLayout.fromEnvironments(this.root).runtime,'images.json'),baseImagesSchema);
      let dockerfile=await readFile(join(EvalLayout.fromEnvironments(this.root).runtime,'Dockerfile'),'utf8');
      for(const [name,ref] of Object.entries(images)){
        dockerfile=dockerfile.replaceAll('{{'+name+'}}',ref);
      }
      for(const name of ['package.json','bun.lock'])await cp(join(REPOSITORY_ROOT,name),join(stage,name));
      await save(join(stage,'upstream-images.json'),images);
      const recipeSha256=digest(JSON.stringify(await tree(stage))+dockerfile);
      if(await exists(join(this.root,'base.json'))){
        const previous=await readJson(join(this.root,'base.json'),layerSchema);
        if(previous.recipeSha256===recipeSha256&&await this.available(previous)){await this.verifyImage(previous);return previous;}
      }
      for(const ref of Object.values(images)){
        try{await this.inspect(ref);}catch{await run(this.docker('pull',ref),{timeout:180000});}
      }
      const parent=(await this.inspect(images.system)).Id;
      const layer=await this.build('base',parent,recipeSha256,stage,dockerfile);
      await save(join(this.root,'base.json'),layer);return layer;
    }finally{await rm(stage,{recursive:true,force:true});await release();}
  }
  private async identity(task:CatalogTask){
    if(!task.source)throw Error('Task source has not been prepared');
    const metadata=await taskAdapters(EvalLayout.fromEnvironments(this.root))[task.dataset].validate(task.id,task.source);
    let dependencies:DependencyRecipe|undefined;
    if('environment' in metadata&&typeof metadata.environment==='string'){
      const path=join(EvalLayout.fromEnvironments(this.root).recipes(task.dataset),metadata.environment.split('/').at(-1)!+'.json');
      if(!await exists(path))throw Error('No reviewed clean dependency recipe for '+task.id);
      dependencies=await readJson(path,dependencyRecipeSchema);
      if(!('python' in metadata)||!dependencies.python.startsWith(metadata.python+'.'))throw Error('Recipe interpreter differs from task');
      if('repo' in metadata&&dependencies.requirements.some(pin=>pin.split('==')[0]!.toLowerCase()===metadata.repo.split('/')[1])){
        throw Error('The target project must come from the frozen task source, not a package in the dependency image');
      }
    }
    const recipe='image' in metadata?digest(await readFile(EvalLayout.fromEnvironments(this.root).runtimeDockerfile(task.dataset),'utf8')+
      await readFile(join(REPOSITORY_ROOT,'package.json'),'utf8')+await readFile(join(REPOSITORY_ROOT,'bun.lock'),'utf8')+
      (metadata.runtimeTools?.length?'\n'+JSON.stringify(metadata.runtimeTools):'')):digest((await Promise.all([environmentBuilder(dependencies),'venv_paths.py'].map(name=>readFile(join(EVAL_ROOT,'src/worker',name),'utf8')))).join('\n')+
      JSON.stringify(dependencies??null)+await readFile(join(EVAL_ROOT,'src/datasets/reviewed_test_deps.py'),'utf8'));
    if(task.preparation){
      if(await realpath(task.preparation.directory)!==resolve(task.preparation.directory))throw Error('Symlinked preparation directory');
      const files=await tree(task.preparation.directory);
      if(digest(JSON.stringify(files))!==task.preparation.sha256||!files[task.preparation.script])throw Error('Task preparation differs from its frozen recipe');
    }
    return {metadata,dependencies,recipe,hash:digest(JSON.stringify({version:1,recipe,dataset:task.dataset,metadata,
      ...(dependencies?.sourceArchives?.length?{sourceArchiveAccess:'non-root-readable-v1'}:{}),
      preparation:task.preparation??null}))};
  }
  private dependencies(metadata:TaskMetadata,recipe:string,base:Layer,definition?:DependencyRecipe):Promise<Layer>{
    const inputs=definition??('packages' in metadata?{actor:metadata.packages,verifier:metadata.verifierPackages,commands:metadata.commands,
      ...(metadata.systemPackages?.length?{systemPackages:metadata.systemPackages}:{})}:null);
    const key=digest(JSON.stringify({base:base.imageId,recipe,inputs}));
    let build=this.dependencyBuilds.get(key);
    if(!build){
      build=(async()=>{
        const stage=join(EvalLayout.fromEnvironments(this.root).builds,'stage-'+randomUUID());await mkdir(stage);
        try {
          let body='';
          if(definition){
            await save(join(stage,'recipe.json'),definition);
            await mkdir(join(stage,'worker'));
            const builder=environmentBuilder(definition);
            for(const name of [builder,'venv_paths.py'])await cp(join(EVAL_ROOT,'src/worker',name),join(stage,'worker',name));
            if(definition.python==='3.6.15'||definition.python==='3.7.17'){
              const sourceRoot=join(EvalLayout.fromEnvironments(this.root).downloads,'runtime-sources');
              if(await realpath(sourceRoot)!==resolve(sourceRoot))throw Error('Symlinked runtime source cache');
              await mkdir(join(stage,'runtime-sources'));
              for(const name of [`Python-${definition.python}.tar.xz`,'openssl-1.1.1w.tar.gz']){
                const source=join(sourceRoot,name),stat=await lstat(source);
                if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100_000_000)throw Error('Invalid runtime source archive');
                await copyFile(source,join(stage,'runtime-sources',name));
              }
            }
            if(definition.sourceArchives?.length){
              const sourceRoot=join(EvalLayout.fromEnvironments(this.root).downloads,'runtime-sources');
              if(await realpath(sourceRoot)!==resolve(sourceRoot))throw Error('Symlinked source archive cache');
              for(const archive of definition.sourceArchives){
                const source=join(sourceRoot,archive.sha256),stat=await lstat(source);
                if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100_000_000||
                  createHash('sha256').update(await readFile(source)).digest('hex')!==archive.sha256)
                  throw Error('Invalid reviewed source archive');
                const target=join(stage,'source-cache',archive.namespace);
                await mkdir(target,{recursive:true});
                await copyFile(source,join(target,archive.sha256));
              }
            }
            body=aptInstall(definition.systemPackages)+'COPY recipe.json /opt/hicode-environment/dependencies.json\nCOPY worker /opt/hicode-eval\n'+
              (definition.python==='3.6.15'||definition.python==='3.7.17'?'COPY runtime-sources /opt/hicode-eval/runtime-sources\n':'')+
              (definition.sourceArchives?.length?'COPY source-cache /opt/hicode-swe/source-cache\nENV XDG_CACHE_HOME=/opt/hicode-swe/source-cache\n':'')+
              'RUN --mount=type=cache,id=hicode-clean-uv-v1,target=/root/.cache/uv,sharing=locked python3 /opt/hicode-eval/'+builder+' /opt/hicode-environment/dependencies.json\n';
          }else if('packages' in metadata){
            body=aptInstall(metadata.systemPackages??[]);
            for(const [name,pins] of [['actor',metadata.packages],['verifier',metadata.verifierPackages]] as const){
              if(pins.length)body+='RUN --mount=type=cache,id=hicode-clean-terminal-uv-v1,target=/root/.cache/uv,sharing=locked '+
                JSON.stringify(['uv','pip','install','--python','/opt/python313/bin/python3.13','--target','/opt/hicode-terminal/'+name,...pins])+'\n';
            }
            if(metadata.commands.length)body+='RUN '+JSON.stringify(['python3','-c','import shutil,sys;assert all(shutil.which(x) for x in sys.argv[1:])',...metadata.commands])+'\n';
          }
          body+='RUN dpkg-query -W > /opt/hicode-environment/system-packages.txt\n';
          const inputs=digest(JSON.stringify(await tree(stage))+recipe+body);
          return await this.build('dependencies',base.imageId,inputs,stage,await this.childDockerfile(base,body));
        }finally{await rm(stage,{recursive:true,force:true});}
      })();
      this.dependencyBuilds.set(key,build);
    }
    return build;
  }
  private async prepareImageTask(task:CatalogTask,identity:Awaited<ReturnType<EnvironmentStore['identity']>>):Promise<EnvironmentBinding>{
    const metadata=identity.metadata;if(!('image' in metadata))throw Error('Missing reviewed source image');
    await mkdir(this.root,{recursive:true,mode:0o700});
    const stage=join(EvalLayout.fromEnvironments(this.root).builds,'stage-'+randomUUID());await mkdir(stage);
    try {
      let source;
      try{source=await this.inspect(metadata.image);}catch{await run(this.docker('pull','--platform','linux/amd64',metadata.image),{timeout:600000});source=await this.inspect(metadata.image);}
      const arch=await run(this.docker('image','inspect','--format','{{.Architecture}}',source.Id));
      if(arch!==metadata.architecture)throw Error('Reviewed image architecture changed');
      await run(this.docker('tag',source.Id,'hicode-env-source:'+source.Id.slice(7)));
      const base=await this.build('base',source.Id,digest(metadata.image),stage,'FROM hicode-env-source:'+source.Id.slice(7)+'\nUSER root\n');
      for(const name of ['package.json','bun.lock'])await cp(join(REPOSITORY_ROOT,name),join(stage,name));
      const template=await readFile(EvalLayout.fromEnvironments(this.root).runtimeDockerfile(task.dataset),'utf8');
      const parentTag='hicode-env-parent:'+base.imageId.slice(7);await run(this.docker('tag',base.imageId,parentTag));
      let dockerfile=template.replace('{{source}}',parentTag);
      if(metadata.runtimeTools?.includes('go-ctrf-json-reporter'))
        dockerfile+='\nRUN install -m 755 /root/go/bin/go-ctrf-json-reporter /usr/local/bin/go-ctrf-json-reporter && mkdir -p /opt/hicode-go && cp -a /root/go/pkg /opt/hicode-go/pkg && chmod -R a+rX /opt/hicode-go\n'+
          'ENV GOMODCACHE=/opt/hicode-go/pkg/mod GOPROXY=off\n';
      if(metadata.runtimeTools?.includes('rust-toolchain'))
        dockerfile+='\nRUN mkdir -p /opt/hicode-rust && cp -a /root/.cargo /opt/hicode-rust/cargo && cp -a /root/.rustup /opt/hicode-rust/rustup && chmod -R a+rX /opt/hicode-rust\n'+
          'ENV CARGO_HOME=/opt/hicode-rust/cargo RUSTUP_HOME=/opt/hicode-rust/rustup CARGO_NET_OFFLINE=true PATH=/opt/hicode-rust/cargo/bin:${PATH}\n';
      const dependencies=await this.build('dependencies',base.imageId,identity.recipe,stage,dockerfile);
      const binding:EnvironmentBinding={version:1,task:taskKey(task),sourceHash:identity.hash,base,dependencies,preparation:null};
      await save(this.bindingPath(task),binding);return binding;
    }finally{await rm(stage,{recursive:true,force:true});}
  }
  async prepareTask(task:CatalogTask):Promise<EnvironmentBinding>{
    const routed=this.routed(task);if(routed)return routed.prepareTask(task);
    const identity=await this.identity(task);
    if('image' in identity.metadata)return this.prepareImageTask(task,identity);
    const base=await readJson(join(this.root,'base.json'),layerSchema);await this.verifyImage(base);
    if(await exists(this.bindingPath(task))){
      const previous=await readJson(this.bindingPath(task),bindingSchema);
      if(previous.task===taskKey(task)&&previous.sourceHash===identity.hash&&previous.base.imageId===base.imageId&&await this.available(previous.dependencies)&&(!previous.preparation||await this.available(previous.preparation))){
        await this.verifyImage(previous.dependencies);if(previous.preparation)await this.verifyImage(previous.preparation);return previous;
      }
    }
    const stage=join(EvalLayout.fromEnvironments(this.root).builds,'stage-'+randomUUID());await mkdir(stage);
    try {
      const dependencies=await this.dependencies(identity.metadata,identity.recipe,base,identity.dependencies);
      let preparation:Layer|null=null,body='';
      if(identity.dependencies?.sourceArchives?.length)
        body+='RUN chmod -R a+rX /opt/hicode-swe/source-cache\n';
      if('repo' in identity.metadata){
        const metadata=identity.metadata;
        const pins=z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*$/)).parse(JSON.parse(await run(['python3','-c',
          'import sys,json;sys.path.insert(0,sys.argv[1]);from reviewed_test_deps import reviewed_test_dependencies;print(json.dumps(reviewed_test_dependencies(sys.argv[2],sys.argv[3],sys.argv[4])))',
          join(EVAL_ROOT,'src/datasets'),metadata.repo,metadata.version,join(task.source!,'repository')])));
        if(pins.length){
          for(const view of ['actor','verifier'])body+='RUN '+JSON.stringify(['/opt/hicode-swe/'+view+'/bin/python','-m','pip','install','--no-cache-dir','--no-deps',...pins])+'\n';
          body+='RUN ["chown","-R","20000:20000","/opt/hicode-swe/actor","/opt/hicode-swe/verifier"]\n';
        }
      }
      if(task.preparation){
        await cp(task.preparation.directory,join(stage,'preparation'),{recursive:true,errorOnExist:true});
        if(digest(JSON.stringify(await tree(join(stage,'preparation'))))!==task.preparation.sha256)throw Error('Task preparation changed while staging');
        body+='COPY preparation /opt/hicode-task/source\nRUN '+JSON.stringify(['/bin/bash','/opt/hicode-task/source/'+task.preparation.script])+'\n';
      }
      if(body)preparation=await this.build('task',dependencies.imageId,digest(JSON.stringify(await tree(stage))+body),stage,await this.childDockerfile(dependencies,body));
      const binding:EnvironmentBinding={version:1,task:taskKey(task),sourceHash:identity.hash,base,dependencies,preparation};
      await save(this.bindingPath(task),binding);return binding;
    }finally{await rm(stage,{recursive:true,force:true});}
  }
  async resolve(task:CatalogTask):Promise<EnvironmentBinding>{
    const routed=this.routed(task);if(routed)return routed.resolve(task);
    const binding=await readJson(this.bindingPath(task),bindingSchema);
    if(binding.task!==taskKey(task)||binding.sourceHash!==(await this.identity(task)).hash)throw Error('Task environment is stale; prepare it before submission');
    await this.verifyImage(binding.preparation??binding.dependencies);return binding;
  }
}

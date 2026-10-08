import {createHash,randomUUID} from 'node:crypto';
import {mkdir,rm,writeFile,cp,realpath,readFile,copyFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {EVAL_ROOT,REPOSITORY_ROOT} from '../paths.js';
import {readJson,save,run,exists,tree} from './store.js';
import {lease} from './lease.js';
import {baseImagesSchema,dependencyRecipeSchema} from './environmentRecipes.js';
import type {DependencyRecipe} from './environmentRecipes.js';
import type {CatalogTask} from './catalog.js';
import {taskAdapters,taskKey} from './datasets.js';
import type {TaskMetadata} from './datasets.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const imageId=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const layerSchema=z.object({version:z.literal(2),kind:z.enum(['base','dependencies','task']),key:hash,
  imageId,parentImage:imageId,recipeSha256:hash,createdAt:z.string().datetime()}).strict();
const bindingSchema=z.object({version:z.literal(2),task:z.string(),sourceHash:hash,
  base:layerSchema,dependencies:layerSchema,preparation:layerSchema.nullable()}).strict().refine(value=>
    value.base.kind==='base'&&value.dependencies.kind==='dependencies'&&value.dependencies.parentImage===value.base.imageId&&
    (!value.preparation||(value.preparation.kind==='task'&&value.preparation.parentImage===value.dependencies.imageId)),
    'Invalid environment layer graph');
export type EnvironmentBinding=z.infer<typeof bindingSchema>;
type Layer=z.infer<typeof layerSchema>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

function aptInstall(packages:readonly string[]):string {
  return packages.length?'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends '+packages.join(' ')+' && rm -rf /var/lib/apt/lists/*\n':'';
}
const commandPackages:Record<string,string>={gcc:'build-essential','g++':'build-essential',rustc:'rustc',bc:'bc',openssl:'openssl',vim:'vim',sqlite3:'sqlite3',ffmpeg:'ffmpeg',chromium:'chromium',chromedriver:'chromium-driver',oligotm:'primer3',Rscript:'r-base',cobc:'gnucobol3',screen:'screen',expect:'expect',gfortran:'gfortran',h5cc:'libhdf5-dev','pkg-config':'pkg-config',gcov:'gcc',tclsh:'tcl',pdflatex:'texlive-latex-base=2023.20240207-1',coqc:'coq',zip:'zip',unzip:'unzip',strings:'binutils',extundelete:'extundelete',foremost:'foremost',fls:'sleuthkit',e2fsck:'e2fsprogs',pmars:'pmars'};
function environmentBuilder(definition?:DependencyRecipe){
  if(definition?.python==='3.6.15')return 'prepare_source_environment.py';
  if(definition?.python==='3.7.17')return 'prepare_source_environment37.py';
  return 'prepare_environment.py';
}


/** Only recipe inputs enter builds. The cache machine and run files are never imported. */
export class EnvironmentStore {
  private readonly dependencyBuilds=new Map<string,Promise<Layer>>();
  constructor(readonly root:string,private readonly context:string){}
  private docker(...args:string[]){return ['docker','--context',this.context,...args];}
  private bindingPath(task:CatalogTask){return join(this.root,'tasks',digest(taskKey(task))+'.json');}
  private async inspect(name:string){
    return z.array(z.object({Id:imageId,Config:z.object({Labels:z.record(z.string()).nullable().optional()})})).length(1)
      .parse(JSON.parse(await run(this.docker('image','inspect',name))))[0]!;
  }
  private async verifyImage(layer:Layer){
    const image=await this.inspect(layer.imageId);
    if(image.Config.Labels?.['dev.hicode.environment']!==layer.key)throw Error('Environment image identity changed');
  }
  private async available(layer:Layer){
    return (await run(this.docker('image','ls','-a','--no-trunc','--quiet','--filter','label=dev.hicode.environment='+layer.key))).split('\n').includes(layer.imageId);
  }
  private async build(kind:Layer['kind'],parent:string,recipeSha256:string,stage:string,dockerfile:string){
    const key=digest(JSON.stringify({version:2,kind,parent,recipeSha256,dockerfile}));
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
        const layer:Layer={version:2,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),recipeSha256,createdAt:new Date().toISOString()};
        await this.verifyImage(layer);await save(receipt,layer);return layer;
      }
      const source=dockerfile+'\nLABEL dev.hicode.environment="'+key+'" dev.hicode.layer="'+kind+'"\nWORKDIR /eval\nCMD ["sleep","infinity"]\n';
      await writeFile(join(stage,'Dockerfile'),source);
      // Keep only the explicit build context and immutable image receipt for reconstruction.
      await cp(stage,join(directory,'context'),{recursive:true});
      try {
        const output=await run(this.docker('build','--network=default','--pull=false','--progress=plain','-t',tag,stage),{timeout:1800000,includeStderr:true});
        await writeFile(join(directory,'build.log'),output);
      }catch(error){
        const log=join(directory,'build.log');await writeFile(log,String(error));
        throw new Error('Environment build failed; full log: '+log+'\n'+String(error).slice(-1200));
      }
      const image=await this.inspect(tag);
      const layer:Layer={version:2,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),recipeSha256,createdAt:new Date().toISOString()};
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
    const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage);
    try {
      const images=await readJson(join(EVAL_ROOT,'config/clean-base-images.json'),baseImagesSchema);
      let dockerfile=await readFile(join(EVAL_ROOT,'config/clean-base.Dockerfile'),'utf8');
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
    const metadata=await taskAdapters[task.dataset].validate(task.id,task.source);
    let dependencies:DependencyRecipe|undefined;
    if(typeof metadata.environment==='string'){
      const path=join(EVAL_ROOT,'config/environment-recipes',metadata.environment.split('/').at(-1)!+'.json');
      if(!await exists(path))throw Error('No reviewed clean dependency recipe for '+task.id);
      dependencies=await readJson(path,dependencyRecipeSchema);
      if(!('python' in metadata)||!dependencies.python.startsWith(metadata.python+'.'))throw Error('Recipe interpreter differs from task');
      if('repo' in metadata&&dependencies.requirements.some(pin=>pin.split('==')[0]!.toLowerCase()===metadata.repo.split('/')[1])){
        throw Error('The target project must come from the frozen task source, not a package in the dependency image');
      }
    }
    const recipe=digest((await Promise.all([environmentBuilder(dependencies),'venv_paths.py'].map(name=>readFile(join(EVAL_ROOT,'src/worker',name),'utf8')))).join('\n')+
      JSON.stringify(dependencies??null)+await readFile(join(EVAL_ROOT,'src/datasets/reviewed_test_deps.py'),'utf8'));
    if(task.preparation){
      if(await realpath(task.preparation.directory)!==resolve(task.preparation.directory))throw Error('Symlinked preparation directory');
      const files=await tree(task.preparation.directory);
      if(digest(JSON.stringify(files))!==task.preparation.sha256||!files[task.preparation.script])throw Error('Task preparation differs from its frozen recipe');
    }
    return {metadata,dependencies,recipe,hash:digest(JSON.stringify({version:2,recipe,dataset:task.dataset,metadata,
      ...(dependencies?.sourceArchives?.length?{sourceArchiveAccess:'non-root-readable-v1'}:{}),
      preparation:task.preparation??null}))};
  }
  private dependencies(metadata:TaskMetadata,recipe:string,base:Layer,definition?:DependencyRecipe):Promise<Layer>{
    const inputs=definition??('packages' in metadata?{actor:metadata.packages,verifier:metadata.verifierPackages,commands:metadata.commands}:null);
    const key=digest(JSON.stringify({base:base.imageId,recipe,inputs}));
    let build=this.dependencyBuilds.get(key);
    if(!build){
      build=(async()=>{
        const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage);
        try {
          let body='';
          if(definition){
            await save(join(stage,'recipe.json'),definition);
            await mkdir(join(stage,'worker'));
            const builder=environmentBuilder(definition);
            for(const name of [builder,'venv_paths.py'])await cp(join(EVAL_ROOT,'src/worker',name),join(stage,'worker',name));
            if(definition.python==='3.6.15'||definition.python==='3.7.17'){
              const sourceRoot=join(this.root,'runtime-sources');
              if(await realpath(sourceRoot)!==resolve(sourceRoot))throw Error('Symlinked runtime source cache');
              await mkdir(join(stage,'runtime-sources'));
              for(const name of [`Python-${definition.python}.tar.xz`,'openssl-1.1.1w.tar.gz']){
                const source=join(sourceRoot,name),stat=await lstat(source);
                if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100_000_000)throw Error('Invalid runtime source archive');
                await copyFile(source,join(stage,'runtime-sources',name));
              }
            }
            if(definition.sourceArchives?.length){
              const sourceRoot=join(this.root,'runtime-sources');
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
            const packages=[...new Set(metadata.commands.map(command=>{
              const value=commandPackages[command];if(!value)throw Error('No system package recipe for command '+command);return value;
            }))];
            body=aptInstall(packages);
            if(metadata.commands.includes('pmars'))body+='ENV PATH="/usr/games:${PATH}"\n';
            for(const [name,pins] of [['actor',metadata.packages],['verifier',metadata.verifierPackages]] as const){
              if(pins.length)body+='RUN '+JSON.stringify(['/opt/python313/bin/python3.13','-m','pip','install','--no-cache-dir','--no-compile','--target','/opt/hicode-terminal/'+name,...pins])+'\n';
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
  async prepareTask(task:CatalogTask):Promise<EnvironmentBinding>{
    const base=await readJson(join(this.root,'base.json'),layerSchema);await this.verifyImage(base);
    const identity=await this.identity(task);
    if(await exists(this.bindingPath(task))){
      const previous=await readJson(this.bindingPath(task),bindingSchema);
      if(previous.task===taskKey(task)&&previous.sourceHash===identity.hash&&previous.base.imageId===base.imageId&&await this.available(previous.dependencies)&&(!previous.preparation||await this.available(previous.preparation))){
        await this.verifyImage(previous.dependencies);if(previous.preparation)await this.verifyImage(previous.preparation);return previous;
      }
    }
    const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage);
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
      const binding:EnvironmentBinding={version:2,task:taskKey(task),sourceHash:identity.hash,base,dependencies,preparation};
      await save(this.bindingPath(task),binding);return binding;
    }finally{await rm(stage,{recursive:true,force:true});}
  }
  async resolve(task:CatalogTask):Promise<EnvironmentBinding>{
    const binding=await readJson(this.bindingPath(task),bindingSchema);
    if(binding.task!==taskKey(task)||binding.sourceHash!==(await this.identity(task)).hash)throw Error('Task environment is stale; prepare it before submission');
    await this.verifyImage(binding.preparation??binding.dependencies);return binding;
  }
  async ready(task:CatalogTask):Promise<boolean>{
    if(!await exists(this.bindingPath(task)))return false;
    try{return (await readJson(this.bindingPath(task),bindingSchema)).task===taskKey(task);}
    catch{return false;}
  }
}

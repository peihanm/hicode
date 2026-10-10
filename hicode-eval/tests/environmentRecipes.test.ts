import {EvalLayout} from '../src/host/layout.js';
import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,readFile,rm,realpath,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EnvironmentStore} from '../src/host/environments.js';
import {dependencyRecipeSchema,baseImagesSchema} from '../src/host/environmentRecipes.js';
import * as transport from '../src/host/store.js';

test('clean base builds from explicit files and pinned images, never from a live machine',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-clean-recipe-')));
  const calls:string[][]=[];let key='',builds=0;
  const id='sha256:'+'a'.repeat(64);
  const fake=spyOn(transport,'run').mockImplementation(async argv=>{
    calls.push(argv);
    if(argv.includes('build')){
      builds++;
      const dockerfile=await readFile(join(argv.at(-1)!,'Dockerfile'),'utf8');
      key=dockerfile.match(/dev.hicode.environment="([a-f0-9]+)"/)![1]!;
      expect(dockerfile).toContain('COPY package.json bun.lock /opt/hicode/');
      expect(dockerfile).not.toContain('environment.tar.gz');
      expect(dockerfile).not.toContain('{{');
      return 'built';
    }
    if(argv.includes('inspect'))return JSON.stringify([{Id:id,Config:{Labels:key?{'dev.hicode.environment':key}:{}}}]);
    if(argv.includes('ls')&&argv.some(value=>value.startsWith('label=')))return key?id:'';
    return '';
  });
  try{
    const layout=new EvalLayout(root);await layout.initialize();await mkdir(layout.runtime,{recursive:true});
    const images={system:'ubuntu@sha256:'+'a'.repeat(64),python:'python@sha256:'+'b'.repeat(64),bun:'oven/bun@sha256:'+'c'.repeat(64),node:'node@sha256:'+'d'.repeat(64),uv:'ghcr.io/astral-sh/uv@sha256:'+'e'.repeat(64)};
    await writeFile(join(layout.runtime,'images.json'),JSON.stringify(images));await writeFile(join(layout.runtime,'Dockerfile'),'FROM {{system}}\nCOPY package.json bun.lock /opt/hicode/\n');
    const store=new EnvironmentStore(layout.environments,'offline');
    const first=await store.prepareBase(),second=await store.prepareBase();
    expect(first.version).toBe(1);expect(second).toEqual(first);expect(builds).toBe(1);
    expect(calls.some(argv=>argv.includes('exec')||argv.includes('cp'))).toBe(false);
  }finally{fake.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('dependency recipe rejects unpinned dependencies, direct references and shell injection',()=>{
  const recipe={version:1,python:'3.9.23',requirements:['pytest==8.4.2'],buildRequirements:[],buildEnvironment:{},buildGroups:[],systemPackages:['graphviz'],provenance:'reviewed'};
  expect(dependencyRecipeSchema.safeParse(recipe).success).toBe(true);
  for(const pin of ['pytest','pkg @ file:///tmp/answer','--index-url=https://other.invalid','pkg==1;id']){
    expect(dependencyRecipeSchema.safeParse({...recipe,requirements:[pin]}).success).toBe(false);
  }
  expect(dependencyRecipeSchema.safeParse({...recipe,systemPackages:['gcc;id']}).success).toBe(false);
  expect(dependencyRecipeSchema.safeParse({...recipe,requirements:['pkg==1','PKG==2']}).success).toBe(false);
  expect(dependencyRecipeSchema.safeParse({...recipe,buildGroups:[{packages:['other==1'],requirements:[]}]}).success).toBe(false);
  const sourceArchives=[{namespace:'matplotlib',sha256:'a'.repeat(64)}];
  expect(dependencyRecipeSchema.safeParse({...recipe,sourceArchives}).success).toBe(true);
  expect(dependencyRecipeSchema.safeParse({...recipe,sourceArchives:[{namespace:'../escape',sha256:'a'.repeat(64)}]}).success).toBe(false);
  expect(dependencyRecipeSchema.safeParse({...recipe,sourceArchives:[{namespace:'matplotlib',sha256:'wrong'}]}).success).toBe(false);
  expect(baseImagesSchema.safeParse({system:'ubuntu:latest'}).success).toBe(false);
});


test('source Python recipes accept only the reviewed release without custom build injection',()=>{
  const recipe={version:1,python:'3.6.15',requirements:['pip==21.3.1'],buildRequirements:[],buildEnvironment:{},buildGroups:[],systemPackages:['build-essential'],provenance:'reviewed'};
  expect(dependencyRecipeSchema.safeParse(recipe).success).toBe(true);
  for(const python of ['3.6','3.6.14'])expect(dependencyRecipeSchema.safeParse({...recipe,python}).success).toBe(false);
  expect(dependencyRecipeSchema.safeParse({...recipe,python:'3.7.17'}).success).toBe(true);
  expect(dependencyRecipeSchema.safeParse({...recipe,python:'3.7.17',buildEnvironment:{LD_PRELOAD:'/tmp/library'}}).success).toBe(false);
  for(const changes of [{buildRequirements:['other==1']},{buildEnvironment:{LD_PRELOAD:'/tmp/library'}},{buildGroups:[{packages:['pip==21.3.1'],requirements:['other==1']}]}])
    expect(dependencyRecipeSchema.safeParse({...recipe,...changes}).success).toBe(false);
  expect(dependencyRecipeSchema.safeParse({...recipe,buildGroups:[{packages:['pip==21.3.1'],requirements:[]}]}).success).toBe(true);
  expect(dependencyRecipeSchema.safeParse({...recipe,sourceArchives:[{namespace:'matplotlib',sha256:'a'.repeat(64)}]}).success).toBe(true);
});

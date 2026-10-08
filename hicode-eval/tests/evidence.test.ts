import {seedCatalog,environmentFixture} from './helpers/catalog.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {RunContainers} from '../src/host/containers.js';
import {test, expect, spyOn} from 'bun:test';
import {mkdtemp, writeFile, symlink, rm, readFile, mkdir, chmod, realpath, open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {evidenceTree, runEvidenceTree, tree} from '../src/host/store.js';

test('evidence records dangling, external and cyclic links without reading their targets; sources reject links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hicode-evidence-'));
  try {
    await writeFile(join(root, 'actual'), 'kept');
    await symlink('/app/sqlite/sqlite3', join(root, 'sqlite3'));
    await symlink('/etc/passwd', join(root, 'external'));
    await symlink('.', join(root, 'cycle'));
    const snapshot = await evidenceTree(root);
    expect(snapshot['sqlite3']!.symlink).toBe('/app/sqlite/sqlite3');
    expect(snapshot['external']!.bytes).toBe('/etc/passwd'.length);
    expect(snapshot['cycle']!.symlink).toBe('.');
    expect(Object.keys(snapshot)).toHaveLength(4);
    expect(await runEvidenceTree(root)).toEqual(snapshot);
    expect(await readFile(join(root, 'actual'), 'utf8')).toBe('kept');
    await expect(tree(root)).rejects.toThrow('Symlink');
  } finally {await rm(root, {recursive:true, force:true});}
});

test('source and run evidence refuse oversized sparse artifacts before reading their contents', async () => {
  const root=await mkdtemp(join(tmpdir(),'hicode-artifact-budget-'));
  try {
    const file=await open(join(root,'oversized'),'wx');
    try {await file.truncate(1024**3+1);} finally {await file.close();}
    await expect(tree(root)).rejects.toThrow('budget');
    const growing=await open(join(root,'oversized'),'r+');
    try {await growing.truncate(8*1024**3+1);} finally {await growing.close();}
    await expect(runEvidenceTree(root)).rejects.toThrow('budget');
  } finally {await rm(root,{recursive:true,force:true});}
});


// Real execute/collection control flow, with only Docker transport and dataset validation replaced.
// The fake runner emits sealed packets; no Linux machine, network, user state or model is used.
test.each([{finalFailure:false,uploadFailure:false},{finalFailure:true,uploadFailure:false},{finalFailure:false,uploadFailure:true}])('handoff precedes final collection and preserves facts: %j', async ({finalFailure,uploadFailure}) => {
  const {createHash}=await import('node:crypto');
  const {LinuxMachine,EvidenceCollectionError}=await import('../src/host/linux.js');
  const {configSchema,runSchema}=await import('../src/host/types.js');
  const transport=await import('../src/host/store.js');
  const adapters=await import('../src/host/publicTasks.js');
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-evidence-flow-')));
  const payload=join(root,'payload'),path=join(root,'run'),tools=join(root,'tools');
  await mkdir(payload);await mkdir(tools);await mkdir(join(path,'task','fixture'),{recursive:true});
  const archive=Buffer.from('offline source fixture'),hash=createHash('sha256').update(archive).digest('hex');
  await writeFile(join(payload,'source.tar.gz'),archive);
  await transport.save(join(payload,'manifest.json'),{files:{'source.tar.gz':hash}});
  await writeFile(join(path,'task','fixture','task.toml'),'[agent]\ntimeout_sec=30\n[verifier]\ntimeout_sec=30\n');
  await writeFile(join(tools,'docker'),`#!/bin/sh
printf '%s\n' '{"type":"phase","phase":"Running HiCode"}'
printf '%s\n' '{"type":"screen","screen":"final screen"}'
sleep 0.05
printf '%s\n' '{"type":"phase","phase":"Awaiting local verification"}'
printf '%s\n' '{"type":"verification_request","runId":"0123456789abcdef"}'
for i in $(seq 1 100); do test ! -f '${join(tools,'handoff-done')}' || break; sleep 0.01; done
test -f '${join(tools,'handoff-done')}' || exit 1
printf '%s\n' '{"type":"result","execution":"completed","grading":"${uploadFailure?'unavailable':'passed'}","uid":20001}'
`);
  await chmod(join(tools,'docker'),0o700);
  const config=configSchema.parse({version:4,data:root,catalog:join(root,'catalog.json'),environments:join(root,'environments'),payload,context:'fixture',machine:'fixture-machine',concurrency:1,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'FIXTURE_KEY',baseUrl:'http://127.0.0.1:1'}});
  await seedCatalog(config,[{id:'fixture',source:join(path,'task','fixture')}]);
  const resolve=spyOn(EnvironmentStore.prototype,'resolve').mockResolvedValue(environmentFixture('fixture'));
  let attemptCreated=false,workerDirectoryReady=false;
  const create=spyOn(RunContainers.prototype,'create').mockImplementation(async()=>{attemptCreated=true;return 'fixture-machine';});
  const name=spyOn(RunContainers.prototype,'name').mockReturnValue('fixture-machine');
  const state=runSchema.parse({version:2,id:'0123456789abcdef',batchId:'fedcba9876543210',task:'fixture',dataset:'terminal-bench',state:'preparing',createdAt:1,updatedAt:1,model:'fixture',budget:{}});
  const calls:string[][]=[];let copies=0;const acknowledgements:string[]=[];
  const run=spyOn(transport,'run').mockImplementation(async command => {
    calls.push(command);
    if(attemptCreated&&command.includes('exec')&&command.includes('mkdir')&&command.includes('/opt/hicode-eval'))workerDirectoryReady=true;
    if(attemptCreated&&command.includes('cp')&&command.at(-1)?.startsWith('fixture-machine:/opt/hicode-eval/'))
      expect(workerDirectoryReady).toBe(true);
    if(command.includes('inspect'))return JSON.stringify([{State:{Running:true},Config:{Labels:{'dev.hicode.role':'eval'}}}]);
    if(command.includes('/opt/hicode-eval/bootstrap.py'))return '/opt/hicode/releases/'+hash;
    if(command.includes('/eval/runs/'+state.id+'/verification.json')){
      const value=JSON.parse(command.at(-1)!);
      expect(value.runId).toBe(state.id);expect(value.version).toBe(1);expect(copies).toBe(0);
      acknowledgements.push(value.status);
      if(value.status==='failed')expect(value.message).toBe('Error: hidden tests upload failed [redacted]');
      if(value.status!=='accepted')await writeFile(join(tools,'handoff-done'),'done');
    }
    if(command.at(-1)==='fixture-machine:/eval/runs/'+state.id+'/tests'){
      expect(acknowledgements).toEqual(['accepted']);
      expect(await readFile(join(path,'live/screen.txt'),'utf8')).toBe('final screen');
      if(uploadFailure)throw Error('hidden tests upload failed fixture-secret');
    }
    if(command.includes('fixture-machine:/eval/runs/'+state.id+'/.')){
      copies++;
      expect(acknowledgements).toEqual(['accepted',uploadFailure?'failed':'ready']);
      if(finalFailure)throw Error('temporary snapshot transport failure');
      const stage=command.at(-1)!;
      await writeFile(join(stage,'result.json'),JSON.stringify({execution:'completed',grading:'passed'}));
      await symlink('/app/sqlite/sqlite3',join(stage,'sqlite3'));
    }
    return '';
  });
  const validate=spyOn(adapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,workspaceAliases:[],systemPackages:[],commands:[],environment:{},verifierEnvironment:{}});
  const oldPath=process.env.PATH;
  // Make the old periodic-copy condition true without waiting 30 seconds.
  const now=Date.now();let clock=0;const time=spyOn(Date,'now').mockImplementation(()=>now+(clock++)*31000);
  process.env.PATH=tools+':'+oldPath;
  try {
    const machine=new LinuxMachine(config);await machine.prepare();
    expect(calls.some(command=>command.includes('fixture-machine:/opt/hicode-eval/reviewed_test_deps.py'))).toBe(true);
    const executing=machine.execute(state,path,'fixture-secret',async()=>{});
    if(finalFailure){
      try {await executing;throw Error('Expected evidence export failure');}
      catch(error){
        expect(error).toBeInstanceOf(EvidenceCollectionError);
        if(!(error instanceof EvidenceCollectionError))throw error;
        expect(error.result).toMatchObject({execution:'completed',grading:'passed'});
      }
    }else{
      expect(await executing).toMatchObject({execution:'completed',grading:uploadFailure?'unavailable':'passed'});
      const receipt=JSON.parse(await readFile(join(path,'collection.json'),'utf8'));
      expect(receipt.files.sqlite3.symlink).toBe('/app/sqlite/sqlite3');
    }
    expect(copies).toBe(1);
    expect(calls.some(command=>command.some(arg=>arg.includes('/cancel')))).toBe(false);
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    time.mockRestore();run.mockRestore();validate.mockRestore();resolve.mockRestore();create.mockRestore();name.mockRestore();await rm(root,{recursive:true,force:true});
  }
});

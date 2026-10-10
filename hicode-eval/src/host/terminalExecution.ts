import {join} from 'node:path';
import {validatePublicTask,prepareTaskInputs,preparePublicTestInputs,taskSchema} from './publicTasks.js';
import {run} from './store.js';
import type {Run} from './types.js';
import type {DatasetExecution} from './executionPlan.js';

export async function terminalExecution(state:Run,task:string,definition:string):Promise<DatasetExecution>{
  const profile=await validatePublicTask(state.task,task,definition);
  const spec=taskSchema.parse(Bun.TOML.parse(await Bun.file(join(task,'task.toml')).text()));
  if(state.network==='open'&&spec.environment?.allow_internet!==true)throw Error('Frozen task does not permit internet access');
  return {
    originalAgentSeconds:spec.agent.timeout_sec,
    verifierSeconds:spec.verifier.timeout_sec,
    setupAllowance:profile.verifierPackages.length?660:profile.packages.length?360:240,
    runnerPython:'python3',verifierSource:join(task,'tests'),
    job:{dataset:'terminal-bench-2.1',service:profile.service,commands:profile.commands,workspaceAliases:profile.workspaceAliases??[],publicTestInputs:profile.publicTestInputs,
      writableRuntimeBin:profile.writableRuntimeBin??false,
      verifierInputs:profile.verifierInputs??[],verifierSetup:profile.verifierSetup,
      verifierWritableTests:profile.verifierWritableTests??false,
      verifierTestPaths:profile.verifierTestPaths??['/tests/test_outputs.py'],
      verifierPython:profile.verifierPython,
      environment:profile.environment,verifierEnvironment:profile.verifierEnvironment,
      initializer:profile.initializer,packages:profile.packages,verifierPackages:profile.verifierPackages,
      verifierPrelude:profile.verifierPrelude,verifierRootOverlay:profile.verifierRootOverlay,
      verifierChroot:profile.verifierChroot},
    stage:async({container,remote,runPath,docker})=>{
      const inputs=join(runPath,'inputs');
      await prepareTaskInputs(task,inputs,profile);
      await run(docker('cp',inputs+'/.',container+':'+remote+'/project/'));
      if(profile.publicTestInputs.length){
        const helpers=join(runPath,'public-test-inputs');
        await preparePublicTestInputs(task,helpers,profile);
        await run(docker('cp',helpers,container+':'+remote+'/public-tests'));
      }
      if(profile.initializer)
        await run(docker('cp',join(task,'environment',profile.initializer.file),container+':'+remote+'/project/'+profile.initializer.file));
    },
  };
}

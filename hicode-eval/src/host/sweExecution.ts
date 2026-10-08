import {join} from 'node:path';
import {validateSweTask} from './sweTasks.js';
import {run} from './store.js';
import type {Run} from './types.js';
import type {DatasetExecution} from './executionPlan.js';

export async function sweExecution(state:Run,task:string):Promise<DatasetExecution>{
  const swe=await validateSweTask(state.task,task);
  return {
    originalAgentSeconds:1800,verifierSeconds:swe.verifierSeconds,setupAllowance:360,
    runnerPython:'/opt/hicode-swe/grader/bin/python',verifierSource:join(task,'hidden'),
    job:{dataset:'swe-bench-verified',swe,initializer:null,packages:[],verifierPackages:[],verifierPrelude:'none'},
    stage:async({container,remote,docker})=>{
      await run(docker('exec',container,'/opt/hicode-swe/grader/bin/python','-c',"import swebench; assert swebench.__version__ == '4.1.0'"));
      await run(docker('cp',join(task,'repository')+'/.',container+':'+remote+'/project/'));
      await run(docker('cp',join(task,'repository'),container+':'+remote+'/baseline'));
      await run(docker('exec',container,'chmod','700',remote+'/baseline'));
    },
  };
}

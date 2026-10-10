import {z} from 'zod';
import {validateDeepTask,deepExecution} from './deepTasks.js';
import {validatePublicTask,publicTaskNetwork} from './publicTasks.js';
import {validateSweTask, sweTree} from './sweTasks.js';
import {tree} from './store.js';
import {terminalExecution} from './terminalExecution.js';
import {sweExecution} from './sweExecution.js';
import type {EvalLayout} from './layout.js';
import type {Run} from './types.js';
import type {DatasetExecution} from './executionPlan.js';

export const datasetSchema=z.enum(['terminal-bench-2.1','swe-bench-verified','deep-swe']);
export type Dataset=z.infer<typeof datasetSchema>;
export const taskRefSchema=z.object({dataset:datasetSchema,id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/)}).strict();
export type TaskRef=z.infer<typeof taskRefSchema>;
export function taskKey(task:TaskRef):string{return task.dataset+':'+task.id;}

export type TaskMetadata=Awaited<ReturnType<typeof validateDeepTask>>|Awaited<ReturnType<typeof validateSweTask>>|Awaited<ReturnType<typeof validatePublicTask>>;
type TaskAdapter={
  network:(source:string)=>Promise<'open'|'isolated'>;
  validate:(id:string,source:string)=>Promise<TaskMetadata>;
  snapshot:(source:string)=>ReturnType<typeof tree>;
  execution:(state:Run,source:string)=>Promise<DatasetExecution>;
};

export function taskAdapters(layout:EvalLayout):Record<Dataset,TaskAdapter>{
  return {
    'terminal-bench-2.1':{
      network:publicTaskNetwork,
      validate:(id,source)=>validatePublicTask(id,source,layout.definition('terminal-bench-2.1')),
      snapshot:tree,
      execution:(state,source)=>terminalExecution(state,source,layout.definition('terminal-bench-2.1')),
    },
    'deep-swe':{network:async()=> 'isolated',validate:(id,source)=>validateDeepTask(id,source,layout.definition('deep-swe')),snapshot:tree,execution:(state,source)=>deepExecution(state,source,layout.definition('deep-swe'))},
    'swe-bench-verified':{network:async()=> 'open',validate:validateSweTask,snapshot:sweTree,execution:sweExecution},
  };
}

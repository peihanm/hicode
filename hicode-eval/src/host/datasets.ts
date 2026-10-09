import {z} from 'zod';
import {validateDeepTask,deepExecution} from './deepTasks.js';
import {validatePublicTask} from './publicTasks.js';
import {validateSweTask, sweTree} from './sweTasks.js';
import {tree} from './store.js';
import {terminalExecution} from './terminalExecution.js';
import {sweExecution} from './sweExecution.js';
import type {Run} from './types.js';
import type {DatasetExecution} from './executionPlan.js';

export const datasetSchema=z.enum(['terminal-bench','terminal-bench-2.1','swe-bench-verified','deep-swe']);
export type Dataset=z.infer<typeof datasetSchema>;
export const taskRefSchema=z.object({dataset:datasetSchema,id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/)}).strict();
export type TaskRef=z.infer<typeof taskRefSchema>;
export function taskKey(task:TaskRef):string{return task.dataset+':'+task.id;}

export type TaskMetadata=Awaited<ReturnType<typeof validateDeepTask>>|Awaited<ReturnType<typeof validateSweTask>>|Awaited<ReturnType<typeof validatePublicTask>>;
type TaskAdapter={
  requiredNetwork?:'isolated';
  validate:(id:string,source:string)=>Promise<TaskMetadata>;
  snapshot:(source:string)=>ReturnType<typeof tree>;
  execution:(state:Run,source:string)=>Promise<DatasetExecution>;
};

const terminal=(dataset:'terminal-bench'|'terminal-bench-2.1'):TaskAdapter=>({
  validate:(id,source)=>validatePublicTask(id,source,dataset),
  snapshot:tree,
  execution:(state,source)=>terminalExecution(state,source,dataset),
});
export const taskAdapters:Record<Dataset,TaskAdapter>={
  'terminal-bench':terminal('terminal-bench'),
  'terminal-bench-2.1':terminal('terminal-bench-2.1'),
  'deep-swe':{requiredNetwork:'isolated',validate:validateDeepTask,snapshot:tree,execution:deepExecution},
  'swe-bench-verified':{validate:validateSweTask,snapshot:sweTree,execution:sweExecution},
};

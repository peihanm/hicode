export interface StageContext {
  container:string;
  remote:string;
  runPath:string;
  docker:(...args:string[])=>string[];
}

/** Dataset-owned inputs and verifier contract; LinuxMachine owns the container. */
export interface DatasetExecution {
  originalAgentSeconds:number;
  verifierSeconds:number;
  setupAllowance:number;
  runnerPython:string;
  verifierSource:string;
  job:Record<string,unknown>;
  stage:(context:StageContext)=>Promise<void>;
}

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Lab} from '../../src/host/manager.js';
import {Client} from '../../src/host/client.js';
import {EvaluationView} from '../../src/host/view.js';
import {serve,serveWorker} from '../../src/host/server.js';

export function startDashboard(lab:Lab,port:number){
  writeFileSync(join(lab.config.data,'config.json'),JSON.stringify(lab.config));
  const worker=serveWorker(lab,0);
  try{
    const dashboard=serve(new EvaluationView(lab.config.data),new Client(worker.port),port);
    return {port:dashboard.port,stop(force=false){dashboard.stop(force);worker.stop(force);}};
  }catch(error){worker.stop(true);throw error;}
}

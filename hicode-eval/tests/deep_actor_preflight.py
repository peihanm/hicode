"""Non-root, no-network smoke of an actual DeepSWE workspace; no model call."""
import json
import os
import pwd
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, '/opt/hicode-eval')
from protocol import namespace_argv
from dataset_runtime import dataset_runtime

root=Path(sys.argv[1]);release=sys.argv[2];module=sys.argv[3]
config=json.loads((root/'job.json').read_text())
subprocess.run(['useradd','--uid','20000','--user-group','--no-create-home','eval-smoke'],check=True)
account=pwd.getpwnam('eval-smoke')
project=root/'project';home=root/'home';logs=root/'logs';control=root/'control';events=root/'actor-events'
root.chmod(0o755)
for p in [home,logs,control,events]:p.mkdir()
subprocess.run(['chown','-R','20000:20000',str(project),str(home),str(logs),str(control),str(events)],check=True)
def demote():os.setgroups([]);os.setgid(account.pw_gid);os.setuid(account.pw_uid)
env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8',
     'HICODE_EVAL_SOURCE':release,'HICODE_EVAL_HOME':str(home/'.hicode')}
def namespace(args):return namespace_argv(args,project,home,logs,control,
                    isolated_network=True,actor_release=release,actor_events=events)
def command(args,**options):
    r=subprocess.run(args,preexec_fn=demote,env=env,timeout=60,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if r.returncode:raise RuntimeError('Actor preflight failed: '+r.stderr[-4000:])
    return r.stdout
handler=dataset_runtime(config)
env.update(handler.command_environment(config,home,root))
handler.prepare_actor(config,project,logs,command,namespace)
if 'VIRTUAL_ENV' in config['deep']['runtimeEnvironment']:
    command(namespace(['python3','-c','import os; assert not os.access("/opt/venv", os.W_OK), "Prepared dependencies are writable"']))
command(namespace(['python3','-c',"import socket; assert [n for _,n in socket.if_nameindex()]==['lo']"]))
module_file=command(namespace(['python3','-c',"import importlib,sys; print(importlib.import_module(sys.argv[1]).__file__)",module])).strip()
output=command(namespace(['bun','/opt/hicode-eval/preflight.ts']))
print(json.dumps({'actorSandboxReady':'Sandbox ready' in output,'network':'isolated','uid':account.pw_uid,'baseCommit':config['deep']['baseCommit'],'module':module,'moduleFile':module_file}))

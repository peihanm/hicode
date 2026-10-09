"""Real outer Actor namespace checks; no model calls or benchmark assertions."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from protocol import namespace_argv


@unittest.skipUnless(sys.platform=='linux' and os.environ.get('HICODE_EVAL_ACTOR_SMOKE')=='1',
                     'Requires the dedicated Linux machine and a prepared release')
class ActorBoundaryTest(unittest.TestCase):
    def test_actor_tmux_cannot_stop_evaluation_terminal_but_can_use_model_socket(self):
        release=os.environ['HICODE_EVAL_ACTOR_RELEASE']
        with tempfile.TemporaryDirectory(prefix='actor-tmux-',dir='/eval') as tmp:
            root=Path(tmp);root.chmod(0o755)
            project=root/'project';home=root/'home';logs=root/'logs';control=root/'control';events=root/'events'
            for path in [project,home,logs,control,events]:
                path.mkdir();os.chown(path,65534,65534);path.chmod(0o700)
            terminal=str(control/'tmux.sock');model=str(control/'model.sock')
            def demote():os.setgroups([]);os.setgid(65534);os.setuid(65534)
            env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8','SHELL':'/bin/bash'}
            def tmux(*args):
                return subprocess.run(['tmux','-S',terminal,*args],preexec_fn=demote,env=env,capture_output=True,text=True,timeout=5)
            gateway=socket.socket(socket.AF_UNIX);gateway.settimeout(5);gateway.bind(model);gateway.listen(1);os.chown(model,65534,65534)
            try:
                created=tmux('-f','/dev/null','new-session','-d','-s','evaluation','sleep 30')
                self.assertEqual(created.returncode,0,created.stderr)
                pid=tmux('display-message','-p','#{pid}').stdout.strip()
                script='''import os,socket,subprocess,sys
assert 'TMUX' not in os.environ and 'TMUX_PANE' not in os.environ
terminal,model=sys.argv[1:]
assert not os.path.exists(terminal), 'Evaluation control socket is visible'
def tmux(*args):return subprocess.run(['tmux',*args],capture_output=True,text=True,timeout=3)
assert tmux('-S',terminal,'kill-server').returncode!=0
assert tmux('kill-server').returncode!=0
created=tmux('-f','/dev/null','new-session','-d','-s','probe','sleep 10')
assert created.returncode==0, created.stderr
stopped=tmux('kill-server');assert stopped.returncode==0, stopped.stderr
client=socket.socket(socket.AF_UNIX);client.connect(model);client.sendall(b'MODEL_GATEWAY_OK');client.close()
print('TERMINAL_ISOLATION_OK')
'''
                args=namespace_argv(['python3','-c',script,terminal,model],project,home,logs,control,
                                    actor_release=release,actor_events=events,isolated_network=True,model_gateway=True)
                result=subprocess.run(args,preexec_fn=demote,env={**env,'TMUX':terminal+','+pid+',0','TMUX_PANE':'%0'},
                                      capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,0,result.stderr);self.assertIn('TERMINAL_ISOLATION_OK',result.stdout)
                self.assertEqual(tmux('has-session','-t','evaluation').returncode,0)
                with gateway.accept()[0] as client:self.assertEqual(client.recv(100),b'MODEL_GATEWAY_OK')
            finally:
                tmux('kill-server');gateway.close()

    def test_terminal_and_swe_views_keep_own_storage_without_host_evidence(self):
        release=os.environ['HICODE_EVAL_ACTOR_RELEASE']
        env_cache=os.environ['HICODE_EVAL_ACTOR_SWE_CACHE']
        from venv_paths import relocate_environment
        for workspace in ['/app','/testbed']:
            with self.subTest(workspace=workspace),tempfile.TemporaryDirectory(prefix='actor-boundary-',dir='/eval') as tmp:
                root=Path(tmp);root.chmod(0o755)
                project=root/'project';home=root/'home';logs=root/'logs';control=root/'control';events=root/'actor-events';public=root/'public'
                for path in [project,home,logs,control,events,public]:path.mkdir();os.chown(path,65534,65534);path.chmod(0o700)
                (root/'other-answer.txt').write_text('HOST_ONLY_CANARY')
                (root/'other-answer.txt').chmod(0o644)
                (logs/'terminal.bin').write_text('TERMINAL_CANARY')
                (root/'hidden').mkdir();(root/'hidden/test.py').write_text('HIDDEN_CANARY')
                (public/'helper.txt').write_text('PUBLIC_OK')
                store=home/'.hicode/projects/fixture/sessions/session-fixture/tool-results';store.mkdir(parents=True)
                (store/'result.txt').write_text('TOOL_RESULT_OK')
                (store/'requests.json').write_text('OWN_REQUEST_LOG')
                (project/'task.txt').write_text('WORKSPACE_OK')
                subprocess.run(['git','init','--template=',str(project)],check=True,capture_output=True)
                (project/'.git/hooks').mkdir()
                subprocess.run(['chown','-R','65534:65534',str(project)],check=True)
                env=None
                if workspace=='/testbed':
                    env=root/'environment';shutil.copytree(env_cache,env,symlinks=True);relocate_environment(env,env_cache)
                    subprocess.run(['chown','-R','65534:65534',str(env)],check=True)
                script=home/'check.ts'
                script.write_text('''import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const [release,workspace,home,events,root]=process.argv.slice(2);
for(const name of [root+'/other-answer.txt',root+'/hidden/test.py',root+'/logs/terminal.bin','/opt/hicode-swe/cache','/opt/hicode-swe/grader','/opt/hicode-swe/staging','/opt/hicode-swe/upstream-metadata','/opt/hicode-swe/preflight-reports','/opt/hicode-eval/bootstrap.py','/root']) {
 if(existsSync(name))throw Error('Host path visible: '+name);
}
if(readFileSync(workspace+'/task.txt','utf8')!=='WORKSPACE_OK')throw Error('Workspace unavailable');
if(readFileSync('/tests/helper.txt','utf8')!=='PUBLIC_OK')throw Error('Public tests unavailable');
const store=home+'/.hicode/projects/fixture/sessions/session-fixture/tool-results/';
if(readFileSync(store+'result.txt','utf8')!=='TOOL_RESULT_OK')throw Error('Tool result unavailable');
if(readFileSync(store+'requests.json','utf8')!=='OWN_REQUEST_LOG')throw Error('Own runtime logs unavailable');
writeFileSync(store+'new-result.txt','WRITE_OK');writeFileSync('/tmp/actor-temp','TEMP_OK');
const {createInteractiveEventLog}=await import(release+'/src/cli/interactiveEventLog.ts');
const log=createInteractiveEventLog(events+'/events.jsonl',workspace,()=>{throw Error('Event write failed')});
log.emit({type:'ready',sessionId:'fixture'});log.close();
console.log('ACTOR_BOUNDARY_OK');
''')
                subprocess.run(['chown','-R','65534:65534',str(home)],check=True)
                def demote():os.setgroups([]);os.setgid(65534);os.setuid(65534)
                runtime_env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(home),'LANG':'C.UTF-8'}
                args=namespace_argv(['bun',str(script),release,workspace,str(home),str(events),str(root)],
                                    project,home,logs,control,workdir=workspace,environment=env,public_tests=public,
                                    actor_release=release,actor_events=events,isolated_network=True)
                result=subprocess.run(args,preexec_fn=demote,env=runtime_env,capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode,0,result.stderr);self.assertIn('ACTOR_BOUNDARY_OK',result.stdout)
                self.assertEqual(json.loads((events/'events.jsonl').read_text())['type'],'ready')
                if env:
                    args=namespace_argv(['/opt/hicode-swe/env/bin/python','-c',"import sys,ssl,sqlite3,ctypes;assert sys.version_info[:2]==(3,6);assert sys.prefix=='/opt/hicode-swe/env';print('PYTHON36_OK')"],
                                        project,home,logs,control,workdir=workspace,environment=env,actor_release=release,actor_events=events)
                    result=subprocess.run(args,preexec_fn=demote,env=runtime_env,capture_output=True,text=True,timeout=15)
                    self.assertEqual(result.returncode,0,result.stderr);self.assertIn('PYTHON36_OK',result.stdout)
                args=namespace_argv(['bun','/opt/hicode-eval/preflight.ts'],project,home,logs,control,workdir=workspace,
                                    environment=env,actor_release=release,actor_events=events)
                result=subprocess.run(args,preexec_fn=demote,env={**runtime_env,'HICODE_EVAL_SOURCE':release,'HICODE_EVAL_HOME':str(home/'.hicode')},capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode,0,result.stderr);self.assertIn('Sandbox ready',result.stdout)

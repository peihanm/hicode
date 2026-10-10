"""Offline service handoff in real Linux namespaces; no benchmark answers or models."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import stat
import http.server
import json
import shutil
import threading
from types import SimpleNamespace
from unittest.mock import patch
from protocol import namespace_argv
from service_bwrap import bwrap_argv
from service_namespace import ServiceNamespace,service_paths
from model_proxy import Gateway


class ServiceDeclarationTest(unittest.TestCase):
    def test_service_waits_for_owned_keeper_marker_after_root_setup(self):
        owner=ServiceNamespace('/eval/runs/1234567890abcdef',20000,[])
        owner.pid=42
        with patch.object(owner,'_check'),patch.object(Path,'lstat',side_effect=FileNotFoundError()):
            self.assertFalse(owner._ready())
        for mode,uid in [(stat.S_IFLNK|0o600,20000),(stat.S_IFREG|0o666,20000),(stat.S_IFREG|0o600,0)]:
            with patch.object(owner,'_check'),patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=mode,st_uid=uid,st_size=6)):
                with self.assertRaisesRegex(RuntimeError,'readiness marker'):owner._ready()
        info=SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=20000,st_size=6)
        with patch.object(owner,'_check'),patch.object(Path,'lstat',return_value=info),patch.object(Path,'read_bytes',return_value=b'ready\n'):
            self.assertTrue(owner._ready())
        with patch.object(owner,'_check'),patch.object(Path,'lstat',return_value=info),patch.object(Path,'read_bytes',return_value=b'wrong\n'):
            self.assertFalse(owner._ready())

    def test_model_socket_is_rebound_after_private_run_and_rejects_unsafe_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);owner=ServiceNamespace(root,20000,['/run'])
            socket=Path('/run/hicode-eval')/root.name/'model.sock'
            owner.mounts=['--bind','/private-run','/run']
            namespace=lambda args:['bwrap','--ro-bind',str(socket),str(socket),*args]
            for info in [SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=20000),
                         SimpleNamespace(st_mode=stat.S_IFSOCK|0o666,st_uid=20000),
                         SimpleNamespace(st_mode=stat.S_IFSOCK|0o600,st_uid=0)]:
                with patch.object(Path,'lstat',return_value=info),self.assertRaisesRegex(ValueError,'Invalid owned'):
                    owner.start(namespace,{},model_socket=socket)
                self.assertIsNone(owner.process)
            with patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFSOCK|0o600,st_uid=20000)),\
                    patch('service_namespace.subprocess.Popen',side_effect=RuntimeError('stop before spawn')) as spawn:
                with self.assertRaisesRegex(RuntimeError,'stop before spawn'):
                    owner.start(namespace,{},model_socket=socket)
            args=spawn.call_args.args[0]
            overlay=args.index('/private-run')
            bind=max(i for i,value in enumerate(args) if value==str(socket))
            self.assertGreater(bind,overlay)
            self.assertNotIn(str(socket.parent),[args[i+1] for i,value in enumerate(args[:-1]) if value=='--ro-bind'])

    def test_model_socket_cannot_come_from_another_control_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            owner=ServiceNamespace(Path(directory)/'owned-run',20000,['/run'])
            for socket in [Path('/tmp/model.sock'),Path('/run/hicode-eval/other-run/model.sock')]:
                with self.assertRaisesRegex(ValueError,'must belong'):
                    owner.start(lambda args:['bwrap',*args],{},model_socket=socket)
                self.assertIsNone(owner.process)

    def test_service_bwrap_keeps_only_the_uid_mapping_capability(self):
        self.assertEqual(bwrap_argv(['--version']),['/usr/bin/bwrap','--version'])
        self.assertEqual(bwrap_argv(['--unshare-user','--cap-drop','ALL','--proc','/proc']),
                         ['/usr/bin/bwrap','--unshare-user','--cap-drop','ALL','--cap-add','CAP_SETFCAP','--proc','/proc'])
        self.assertEqual(bwrap_argv(['--unshare-all','--cap-drop','ALL']),
                         ['/usr/bin/bwrap','--unshare-all','--cap-drop','ALL','--cap-add','CAP_SETFCAP'])
        for args in [['--unshare-user'],['--unshare-all','--cap-drop','ALL','--cap-add','ALL']]:
            with self.assertRaises(ValueError):bwrap_argv(args)

    def test_only_reviewed_terminal_paths_and_network_modes_are_accepted(self):
        self.assertEqual(service_paths({'dataset':'terminal-bench-2.1','network':'isolated',
                                        'service':{'writablePaths':['/etc','/var']}}),['/etc','/var'])
        self.assertEqual(service_paths({'dataset':'terminal-bench-2.1','network':'open','service':{'writablePaths':[]}}),[])
        for value in [
            {'dataset':'terminal-bench-2.1','network':'unknown','service':{'writablePaths':[]}},
            {'dataset':'deep-swe','network':'isolated','service':{'writablePaths':[]}},
            {'dataset':'terminal-bench-2.1','network':'isolated','service':{'writablePaths':['/proc']}},
            {'dataset':'terminal-bench-2.1','network':'isolated','service':{'writablePaths':['/etc','/etc']}},
        ]:
            with self.assertRaises(ValueError):service_paths(value)


@unittest.skipUnless(sys.platform=='linux' and os.environ.get('HICODE_EVAL_SERVICE_SMOKE')=='1',
                     'Requires a disposable Linux evaluation container')
class ServiceLinuxTest(unittest.TestCase):
    def test_service_survives_actor_exit_and_private_verifier_reaches_original_localhost(self):
        self.check_service_handoff(True)

    def test_open_service_survives_actor_exit_and_private_verifier_reaches_original_localhost(self):
        self.check_service_handoff(False)

    def check_service_handoff(self,isolated):
        release=os.environ['HICODE_EVAL_ACTOR_RELEASE']
        ssh_smoke=os.environ.get('HICODE_EVAL_SERVICE_SSH_SMOKE')=='1'
        with tempfile.TemporaryDirectory(dir='/eval',prefix='service-handoff-') as directory:
            root=Path(directory);os.chown(root,20000,20000)
            project=root/'project';home=root/'home';logs=root/'logs';control=Path('/run/hicode-eval')/root.name;events=root/'events';tests=root/'tests'
            control.parent.mkdir(parents=True,exist_ok=True)
            for path in [project,home,logs,control,events,tests]:
                path.mkdir();os.chown(path,20000,20000)
            (logs/'verifier').mkdir();os.chown(logs/'verifier',20000,20000)
            (tests/'secret.txt').write_text('HIDDEN_TEST_CANARY')
            if os.environ.get('HICODE_EVAL_SERVICE_PYPI_SMOKE')=='1':
                with zipfile.ZipFile(project/'fixtureprobe-0.1-py3-none-any.whl','w') as wheel:
                    wheel.writestr('fixtureprobe/__init__.py','value=7\n')
                    wheel.writestr('fixtureprobe-0.1.dist-info/METADATA','Metadata-Version: 2.1\nName: fixtureprobe\nVersion: 0.1\n')
                    wheel.writestr('fixtureprobe-0.1.dist-info/WHEEL','Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
                    wheel.writestr('fixtureprobe-0.1.dist-info/RECORD','')
            if os.environ.get('HICODE_EVAL_SERVICE_HF_SMOKE')=='1':
                (project/'flask_fixture.py').write_text('''from flask import Flask,jsonify
app=Flask(__name__)
@app.post('/sentiment')
def sentiment():return jsonify(sentiment='positive',confidence={'positive':1.0,'negative':0.0})
app.run(host='0.0.0.0',port=5000)
''')
            server='''import http.server,time
from pathlib import Path
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/simple/fixtureprobe/':payload=b'<a href="/fixtureprobe-0.1-py3-none-any.whl">fixtureprobe</a>'
  elif self.path=='/fixtureprobe-0.1-py3-none-any.whl':payload=Path('/app/fixtureprobe-0.1-py3-none-any.whl').read_bytes()
  else:payload=b'SERVICE_OK'
  self.send_response(200)
  self.send_header('Content-Type','text/html' if self.path.endswith('/') else 'application/octet-stream')
  self.end_headers();self.wfile.write(payload)
server=http.server.HTTPServer(('127.0.0.1',8080),Handler)
Path('/app/ready').touch();server.serve_forever()
'''
            (project/'server.py').write_text(server.replace("8080),Handler)","8081),Handler)") if ssh_smoke else server)
            env={'PATH':'/opt/python313/bin:'+os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8',
                 'HICODE_EVAL_SERVICE_NGINX_SMOKE':os.environ.get('HICODE_EVAL_SERVICE_NGINX_SMOKE',''),
                 'HICODE_EVAL_SERVICE_PYPI_SMOKE':os.environ.get('HICODE_EVAL_SERVICE_PYPI_SMOKE',''),
                 'HICODE_EVAL_SERVICE_HF_SMOKE':os.environ.get('HICODE_EVAL_SERVICE_HF_SMOKE',''),
                 'HICODE_EVAL_SERVICE_SSH_SMOKE':'1' if ssh_smoke else ''}
            if env['HICODE_EVAL_SERVICE_PYPI_SMOKE']=='1':
                env['PIP_USER']='1'
                env['PYTHONPATH']='/opt/hicode-terminal/verifier:'+str(home/'.local/lib/python3.13/site-packages')
            if env['HICODE_EVAL_SERVICE_HF_SMOKE']=='1':
                env['PYTHONPATH']='/opt/hicode-terminal/actor'
            class Provider(http.server.BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    self.rfile.read(int(self.headers['Content-Length']))
                    self.send_response(200);self.end_headers();self.wfile.write(b'data: [DONE]\n\n')
            provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
            thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
            gateway=Gateway(control/'model.sock',f'http://127.0.0.1:{provider.server_port}/v1','fixture','fixture')
            os.chown(control/'model.sock',20000,20000)
            settings=home/'model-settings.json';settings.write_text(json.dumps({'sources':{'fixture':{'baseUrl':'unused'}}}));os.chown(settings,20000,20000)
            def actor(args):return namespace_argv(args,project,home,logs,control,isolated_network=isolated,
                                                  actor_release=release,actor_events=events,model_gateway=True)
            owner=ServiceNamespace(root,20000,['/etc','/var','/run',*(['/home','/git'] if ssh_smoke else [])],network='isolated' if isolated else 'open')
            try:
                owner.prepare()
                try:owner.start(actor,env,model_socket=control/'model.sock')
                except Exception as error:
                    raise RuntimeError(str(error)+'; '+((root/'service-namespace.log').read_text()[-2000:] if (root/'service-namespace.log').exists() else 'before namespace spawn')) from error
                model_check="""import http.client,json,sys
from pathlib import Path
from urllib.parse import urlsplit
url=urlsplit(json.loads(Path(sys.argv[1]).read_text())['sources']['fixture']['baseUrl'])
c=http.client.HTTPConnection(url.hostname,url.port,timeout=5)
c.request('POST','/v1/chat/completions',body=json.dumps({'model':'fixture','stream':True,'messages':[{'role':'user','content':'fixture'}]}))
r=c.getresponse();assert r.status==200;assert b'[DONE]' in r.read();print('MODEL_GATEWAY_OK')
"""
                model_result=subprocess.run(owner.actor_argv(['python3','/opt/hicode-eval/network_entry.py',str(control/'model.sock'),str(settings),'python3','-c',model_check,str(settings)]),env=env,capture_output=True,text=True,timeout=15)
                self.assertEqual(model_result.returncode,0,model_result.stderr);self.assertIn('MODEL_GATEWAY_OK',model_result.stdout)
                code='''import subprocess,time,os
from pathlib import Path
assert 'TMUX' not in os.environ
assert os.getcwd()=='/app',repr(os.getcwd())
assert not Path('/tests/secret.txt').exists()
Path('/etc/service-fixture.conf').write_text('CONFIG_OK')
Path('/var/log/service-fixture.log').write_text('LOG_OK')
os.chown('/var/log/service-fixture.log',33,33)
subprocess.Popen(['python3','/app/server.py'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
if os.environ.get('HICODE_EVAL_SERVICE_HF_SMOKE')=='1':
 with open('/app/flask.log','w') as log:
  subprocess.Popen(['python3','/app/flask_fixture.py'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
for i in range(100):
 if Path('/app/ready').exists():break
 time.sleep(.01)
else:raise RuntimeError('Fixture service did not start')
'''
                result=subprocess.run(owner.actor_argv(['python3','-c',code]),env={**env,'TMUX':'forbidden'},capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertFalse(Path('/etc/service-fixture.conf').exists())
                hidden=subprocess.run(owner.actor_argv(['python3','-c',
                    'from pathlib import Path;import sys;assert not Path(sys.argv[1]).exists()',str(tests/'secret.txt')]),
                    env=env,capture_output=True,text=True,timeout=5)
                self.assertEqual(hidden.returncode,0,hidden.stderr)
                self.assertEqual(Path(f'/proc/{owner.pid}/root/etc/service-fixture.conf').read_text(),'CONFIG_OK')
                if os.environ.get('HICODE_EVAL_SERVICE_NGINX_SMOKE')=='1':
                    for args in [['nginx','-t'],['nginx']]:
                        nginx=subprocess.run(owner.actor_argv(args),env=env,capture_output=True,text=True,timeout=10)
                        self.assertEqual(nginx.returncode,0,nginx.stderr)
                if ssh_smoke:
                    setup='''set -eu
useradd -m -s /bin/bash user
mkdir -p /git/server /var/www/html /run/sshd /etc/nginx/conf.d
git init --bare /git/server
chown -R user:user /git /var/www/html
cat > /git/server/hooks/post-receive <<'HOOK'
#!/bin/sh
GIT_WORK_TREE=/var/www/html git checkout -f master
HOOK
chmod +x /git/server/hooks/post-receive
chown user:user /git/server/hooks/post-receive
cat > /etc/nginx/conf.d/git-site.conf <<'NGINX'
server { listen 8080; server_name localhost; root /var/www/html; location / { try_files $uri $uri/ =404; } }
NGINX
rm -f /etc/nginx/sites-enabled/default
ssh-keygen -A
nginx -t
nginx
'''
                    configured=subprocess.run(owner.actor_argv(['bash','-c',setup]),env=env,capture_output=True,text=True,timeout=15)
                    self.assertEqual(configured.returncode,0,configured.stderr+configured.stdout)
                    daemon='''import subprocess
with open('/app/sshd.log','w') as log:subprocess.Popen(['/usr/sbin/sshd','-D','-e'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
'''
                    launched=subprocess.run(owner.actor_argv(['python3','-c',daemon]),env=env,capture_output=True,text=True,timeout=5)
                    self.assertEqual(launched.returncode,0,launched.stderr)
                def verifier(args):
                    argv=namespace_argv(args,project,home,logs,control,tests,verifier_release=release)
                    if env['HICODE_EVAL_SERVICE_PYPI_SMOKE']=='1':
                        return argv[:-len(args)]+['--ro-bind','/opt/hicode-terminal/verifier','/opt/hicode-terminal/verifier']+args
                    return argv
                check='''import http.client,os
from pathlib import Path
assert Path('/tests/secret.txt').read_text()=='HIDDEN_TEST_CANARY'
assert Path('/etc/service-fixture.conf').read_text()=='CONFIG_OK'
assert Path('/var/log/service-fixture.log').stat().st_uid==33
c=http.client.HTTPConnection('127.0.0.1',8081 if os.environ.get('HICODE_EVAL_SERVICE_SSH_SMOKE')=='1' else 8080,timeout=2);c.request('GET','/');assert c.getresponse().read()==b'SERVICE_OK'
if os.environ.get('HICODE_EVAL_SERVICE_NGINX_SMOKE')=='1':
 c=http.client.HTTPConnection('127.0.0.1',80,timeout=2);c.request('GET','/');assert c.getresponse().status==200
if os.environ.get('HICODE_EVAL_SERVICE_PYPI_SMOKE')=='1':
 import subprocess,importlib
 subprocess.run(['python','-m','pip','install','--index-url','http://127.0.0.1:8080/simple','fixtureprobe==0.1'],check=True)
 importlib.invalidate_caches();import fixtureprobe;assert fixtureprobe.value==7
if os.environ.get('HICODE_EVAL_SERVICE_HF_SMOKE')=='1':
 import json,time
 for _ in range(50):
  try:
   c=http.client.HTTPConnection('127.0.0.1',5000,timeout=2);c.request('POST','/sentiment','{"text":"hello"}',{'Content-Type':'application/json'});r=c.getresponse();assert r.status==200;assert json.loads(r.read())['sentiment']=='positive';break
  except ConnectionRefusedError:time.sleep(.02)
 else:raise AssertionError('Flask service did not start')
if os.environ.get('HICODE_EVAL_SERVICE_SSH_SMOKE')=='1':
 import subprocess,shutil,pwd,time
 from pathlib import Path
 key=Path('/root/.ssh/id_ed25519');key.parent.mkdir(exist_ok=True)
 subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
 allowed=Path('/home/user/.ssh');allowed.mkdir(mode=0o700,exist_ok=True)
 shutil.copyfile(str(key)+'.pub',allowed/'authorized_keys')
 user=pwd.getpwnam('user');os.chown(allowed,user.pw_uid,user.pw_gid);os.chown(allowed/'authorized_keys',user.pw_uid,user.pw_gid)
 ssh='ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
 subprocess.run(['git','-c','core.sshCommand='+ssh,'clone','user@127.0.0.1:/git/server','/app/client'],check=True)
 Path('/app/client/hello.html').write_text('hello world')
 subprocess.run(['git','-C','/app/client','add','hello.html'],check=True)
 subprocess.run(['git','-C','/app/client','-c','user.email=test@example.com','-c','user.name=Test','commit','-m','smoke'],check=True)
 subprocess.run(['git','-C','/app/client','-c','core.sshCommand='+ssh,'push','origin','master'],check=True)
 c=http.client.HTTPConnection('127.0.0.1',8080,timeout=2);c.request('GET','/hello.html');assert c.getresponse().read()==b'hello world'
assert not Path('/opt/hicode-eval/runner.py').exists()
print('PRIVATE_VERIFIER_OK')
'''
                try:
                    result=subprocess.run(owner.verifier_argv(['python3','-c',check],verifier),env=env,capture_output=True,text=True,timeout=5)
                except subprocess.TimeoutExpired as error:
                    self.fail('Verifier stalled after: '+repr(error.stdout)+'; '+repr(error.stderr))
                detail=(project/'flask.log').read_text() if (project/'flask.log').exists() else ''
                self.assertEqual(result.returncode,0,result.stderr+result.stdout+detail);self.assertIn('PRIVATE_VERIFIER_OK',result.stdout)
                owner.snapshot();self.assertTrue((root/'service-system.tar').is_file())
                owner.close()
                with self.assertRaises(RuntimeError):owner.actor_argv(['true'])
            finally:
                owner.close();gateway.close();provider.shutdown();provider.server_close();thread.join(timeout=2);shutil.rmtree(control)

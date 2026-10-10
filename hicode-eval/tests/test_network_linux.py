"""Opt-in Linux smoke: real unprivileged Bubblewrap, no public network or model calls."""
from concurrent.futures import ThreadPoolExecutor
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from model_proxy import Gateway
from protocol import namespace_argv


@unittest.skipUnless(sys.platform == 'linux' and os.environ.get('HICODE_EVAL_NETWORK_SMOKE') == '1',
                     'Requires the dedicated Linux evaluation machine')
class LinuxNetworkTest(unittest.TestCase):
    def test_open_and_two_isolated_actors(self):
        worker = Path(sys.modules['model_proxy'].__file__).resolve().parent
        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200);self.end_headers();self.wfile.write(b'data: [DONE]\n\n')
        provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
        thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
        def trial(isolated):
            with tempfile.TemporaryDirectory(prefix='hicode-net-') as directory:
                root=Path(directory);root.chmod(0o755)
                home=root/'home';project=root/'project';logs=root/'logs';control=root/'control'
                for p in [home,project,logs,control,root/'actor-events']:p.mkdir();os.chown(p,65534,65534);p.chmod(0o700)
                settings=home/'settings.json';settings.write_text(json.dumps({'sources':{'fixture':{'baseUrl':'unused'}}}));os.chown(settings,65534,65534)
                actor=home/'actor.py'
                actor.write_text('''import http.client,json,socket,subprocess,sys
from pathlib import Path
from urllib.parse import urlsplit
settings,upstream,isolated=sys.argv[1:];isolated=isolated=='True'
s=socket.socket();s.settimeout(1)
try:s.connect(('127.0.0.1',int(upstream)));reachable=True
except OSError:reachable=False
finally:s.close()
assert reachable != isolated, (reachable,isolated)
if isolated:
 assert [n for _,n in socket.if_nameindex()]==['lo']
 assert subprocess.run(['curl','--noproxy','*','-sS','--max-time','2','http://198.51.100.1'],capture_output=True).returncode != 0
target=urlsplit(json.loads(Path(settings).read_text())['sources']['fixture']['baseUrl'])
c=http.client.HTTPConnection(target.hostname,target.port,timeout=5)
c.request('POST','/v1/chat/completions',body=json.dumps({'model':'fixture','stream':True,'messages':[{'role':'user','content':'fixture'}]}))
r=c.getresponse();assert r.status==200;assert b'[DONE]' in r.read();c.close()
code="const r=await fetch(process.argv[1]+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',stream:true,messages:[{role:'user',content:'fixture'}]})});if(!r.ok||!(await r.text()).includes('[DONE]'))process.exit(1)"
subprocess.run(['bun','-e',code,target.geturl()],check=True,timeout=5)
print('ISOLATED_OK' if isolated else 'OPEN_OK')
''');os.chown(actor,65534,65534)
                gateway=Gateway(control/'model.sock',f'http://127.0.0.1:{provider.server_port}/v1','fixture','fixture',{'effort':'default'})
                try:
                    if gateway:os.chown(control/'model.sock',65534,65534)
                    args=['python3',str(actor),str(settings),str(provider.server_port),str(isolated)]
                    args=['python3','/opt/hicode-eval/network_entry.py',str(control/'model.sock'),str(settings),*args]
                    argv=namespace_argv(args,project,home,logs,control,isolated_network=isolated,actor_release=os.environ['HICODE_EVAL_ACTOR_RELEASE'],actor_events=root/'actor-events',model_gateway=True)
                    def demote():os.setgroups([]);os.setgid(65534);os.setuid(65534)
                    result=subprocess.run(argv,env={'PATH':os.environ['PATH'],'HOME':str(home)},preexec_fn=demote,
                                          capture_output=True,text=True,timeout=20)
                    self.assertEqual(result.returncode,0,result.stderr)
                    return result.stdout.strip()
                finally:
                    if gateway:gateway.close()
        try:
            self.assertEqual(trial(False),'OPEN_OK')
            with ThreadPoolExecutor(max_workers=2) as pool:
                results=list(pool.map(trial,[True,True]))
            self.assertEqual(results,['ISOLATED_OK','ISOLATED_OK'])
        finally:provider.shutdown();provider.server_close();thread.join()

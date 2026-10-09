"""A bounded localhost fixture for the real runner; never connects upstream."""
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length','0'))
        if not 0<n<16*1024*1024:self.send_error(413);return
        request=json.loads(self.rfile.read(n))
        if request.get('model')!='offline-smoke':self.send_error(400);return
        delta={'id':'offline','object':'chat.completion.chunk','model':'offline-smoke','choices':[{'index':0,'delta':{'role':'assistant','content':'Environment smoke complete.'},'finish_reason':None}]}
        final={'id':'offline','object':'chat.completion.chunk','model':'offline-smoke','choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        self.wfile.write(('data: '+json.dumps(delta)+'\n\ndata: '+json.dumps(final)+'\n\ndata: [DONE]\n\n').encode())
    def log_message(self,*args):pass
HTTPServer(('127.0.0.1',18080),Handler).serve_forever()

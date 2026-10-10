"""Inside the actor net namespace: bridge loopback to its model-only Unix socket."""
import json
from pathlib import Path
import select
import signal
import socket
import socketserver
import subprocess
import sys
import threading


class Bridge(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.capacity.acquire(blocking=False):return
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        phase = 'connect'
        try:
            upstream.settimeout(30);upstream.connect(self.server.gateway)
            phase = 'relay'
            self.request.settimeout(30)
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 1)
                for source in readable:
                    data = source.recv(65536)
                    if not data:return
                    (upstream if source is self.request else self.request).sendall(data)
        except OSError as error:
            print(f'Model gateway {phase} failed (errno {error.errno})', file=sys.stderr, flush=True)
        finally:
            try:upstream.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            upstream.close()
            self.server.capacity.release()


def main():
    gateway, settings_path, *command = sys.argv[1:]
    if not command:raise ValueError('Missing actor command')
    server = Bridge(('127.0.0.1', 0), Relay)
    server.capacity = threading.BoundedSemaphore(16)
    server.gateway = gateway
    path = Path(settings_path)
    settings = json.loads(path.read_text())
    for source in settings['sources'].values():source['baseUrl'] = f'http://127.0.0.1:{server.server_address[1]}/v1'
    # The original credential is deliberately absent from the actor environment.
    path.write_text(json.dumps(settings))
    thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
    child = None
    def stop(signum, _):
        if child and child.poll() is None:child.send_signal(signum)
    signal.signal(signal.SIGTERM, stop);signal.signal(signal.SIGINT, stop)
    try:
        child = subprocess.Popen(command)
        return child.wait()
    finally:
        if child and child.poll() is None:child.terminate();child.wait(timeout=10)
        server.shutdown();server.server_close();thread.join(timeout=2)


if __name__ == '__main__':sys.exit(main())

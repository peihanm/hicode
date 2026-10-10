"""Run-owned Unix socket gateway to one configured chat-completions endpoint."""
import http.client
import http.server
import json
import os
import re
import select
import socket
import socketserver
import ssl
import threading
from urllib.parse import urlsplit

MAX_REQUEST = 16 * 1024 * 1024
FIELDS = {'model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options',
          'thinking', 'enable_thinking', 'preserve_thinking', 'reasoning', 'reasoning_effort',
          'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'parallel_tool_calls', 'provider'}


def validate_reasoning(value, policy):
    if 'enable_thinking' in value and type(value['enable_thinking']) is not bool:raise ValueError('Invalid thinking switch')
    if 'preserve_thinking' in value and type(value['preserve_thinking']) is not bool:raise ValueError('Invalid replay switch')
    thinking = value.get('thinking')
    if thinking is not None and (not isinstance(thinking, dict) or set(thinking) != {'type'} or thinking['type'] not in {'enabled', 'disabled'}):raise ValueError('Invalid thinking mode')
    effort = value.get('reasoning_effort')
    if effort is not None and (not isinstance(effort, str) or effort not in {'low', 'medium', 'high', 'xhigh', 'max'}):raise ValueError('Invalid reasoning effort')
    off = value.get('enable_thinking') is False or thinking == {'type': 'disabled'}
    if off and value.get('preserve_thinking') is True:raise ValueError('Disabled thinking cannot preserve reasoning')
    if off and effort is not None:raise ValueError('Disabled thinking cannot specify effort')
    if policy is None:return
    switch = policy.get('switch')
    if switch is None:
        if effort is not None:raise ValueError('Unknown model reasoning capability')
        return
    if 'reasoning' in value:raise ValueError('Unsupported reasoning protocol')
    if (switch == 'enable_thinking' and thinking is not None) or (switch == 'thinking' and 'enable_thinking' in value):raise ValueError('Wrong reasoning protocol')
    if effort is not None and effort not in policy['efforts']:raise ValueError('Unsupported model reasoning level')
    # Purpose is not trusted from the actor. The reviewed auxiliary policy permits off
    # or the lightest level for forced-thinking models; main calls retain the batch choice.
    selected = policy['effort']
    if off:
        if 'off' not in policy['efforts']:raise ValueError('This model requires thinking')
        return
    if selected == 'off':raise ValueError('This batch disabled reasoning')
    enabled = value.get('enable_thinking') is True if switch == 'enable_thinking' else thinking == {'type': 'enabled'}
    if not enabled:raise ValueError('Thinking must remain enabled')
    if effort == policy['reviewEffort']:return
    if selected == 'default' and effort is not None:raise ValueError('Default batch must omit reasoning effort')
    if selected not in {'default', 'off'} and (effort != selected or not enabled):raise ValueError('Reasoning differs from the frozen batch')


def validate_request(body, model, reasoning_policy=None):
    value = json.loads(body)
    if (not isinstance(value, dict) or set(value) - FIELDS or value.get('model') != model
            or value.get('stream') is not True or not isinstance(value.get('messages'), list)):
        raise ValueError('Only the configured streaming chat model is allowed')
    if any(not isinstance(t, dict) or t.get('type') != 'function' or set(t) != {'type', 'function'}
           for t in value.get('tools', [])):
        raise ValueError('Only local function tools are allowed')
    if 'provider' in value and value['provider'] != {'require_parameters': True}:
        raise ValueError('Unsupported provider options')
    choice = value.get('tool_choice', 'auto')
    if not (isinstance(choice, str) and choice in {'auto', 'none', 'required'} or
            isinstance(choice, dict) and choice.get('type') == 'function' and set(choice) == {'type', 'function'}):
        raise ValueError('Unsupported tool choice')
    validate_reasoning(value, reasoning_policy)
    for message in value['messages']:
        if not isinstance(message, dict):raise ValueError('Invalid message')
        content = message.get('content')
        if content is None or isinstance(content, str):continue
        if not isinstance(content, list):raise ValueError('Invalid message content')
        for part in content:
            if not isinstance(part, dict):raise ValueError('Invalid content part')
            if part.get('type') == 'text' and isinstance(part.get('text'), str):continue
            image = part.get('image_url')
            if (part.get('type') == 'image_url' and isinstance(image, dict) and isinstance(image.get('url'), str)
                    and image['url'].startswith(('data:image/png;base64,', 'data:image/jpeg;base64,',
                                                 'data:image/webp;base64,', 'data:image/gif;base64,'))):continue
            raise ValueError('Remote content and provider-side tools are not allowed')
    return value


class Gateway(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path, base_url, model, credential, reasoning_policy):
        if not isinstance(credential, str) or not credential or len(credential) > 8192 or any(ord(c) < 32 or ord(c) > 126 for c in credential):
            raise ValueError('Invalid model credential format')
        target = urlsplit(base_url)
        if target.scheme not in {'http', 'https'} or not target.hostname or target.username or target.password or target.query or target.fragment:
            raise ValueError('Invalid model gateway destination')
        self.target = target
        self.endpoint = target.path.rstrip('/')
        if not self.endpoint.endswith('/chat/completions'):self.endpoint += '/chat/completions'
        self.reasoning_policy = reasoning_policy
        self.model = model
        self.credential = credential
        self.active = set()
        self.active_lock = threading.Lock()
        self.capacity = threading.BoundedSemaphore(8)
        self.closed = False
        super().__init__(str(path), Handler)
        os.chmod(path, 0o600)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def track(self, connection):
        with self.active_lock:
            if self.closed:raise ConnectionError('Gateway closed')
            self.active.add(connection)

    def release(self, connection):
        with self.active_lock:self.active.discard(connection)
        connection.close()

    def close(self):
        with self.active_lock:
            self.closed = True
            for connection in self.active:
                try:connection.shutdown(socket.SHUT_RDWR)
                except OSError:pass
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)
        try:os.unlink(self.server_address)
        except FileNotFoundError:pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *_):pass

    def handle(self):
        if not self.server.capacity.acquire(blocking=False):return
        try:
            self.connection.settimeout(30)
            self.server.track(self.connection)
            super().handle()
        except (OSError, ValueError):pass
        finally:
            self.server.release(self.connection)
            self.server.capacity.release()

    def do_POST(self):
        if self.path != '/v1/chat/completions' or self.headers.get('Transfer-Encoding'):
            self.send_error(403, 'Only the fixed model endpoint is allowed');return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= MAX_REQUEST:
            self.send_error(413, 'Invalid model request size');return
        size = int(lengths[0]);body = self.rfile.read(size)
        try:
            if len(body) != size:raise ValueError('Incomplete request')
            validate_request(body, self.server.model, self.server.reasoning_policy)
        except (ValueError, TypeError):
            self.send_error(403, 'Unsupported model request');return
        target = self.server.target
        upstream = (http.client.HTTPSConnection(target.hostname, target.port, timeout=30, context=ssl.create_default_context())
                    if target.scheme == 'https' else http.client.HTTPConnection(target.hostname, target.port, timeout=30))
        finished = threading.Event()
        watcher = None
        upstream_socket = None
        headers_sent = False
        try:
            upstream.connect()
            upstream_socket = upstream.sock
            upstream_socket.settimeout(600)
            self.server.track(upstream_socket)
            def watch_disconnect():
                while not finished.wait(.1):
                    try:
                        readable, _, _ = select.select([self.connection], [], [], 0)
                        if readable and not self.connection.recv(1, socket.MSG_PEEK):
                            upstream_socket.shutdown(socket.SHUT_RDWR)
                            return
                    except OSError:return
            watcher = threading.Thread(target=watch_disconnect, daemon=True);watcher.start()
            upstream.request('POST', self.server.endpoint, body=body,
                             headers={'Content-Type':'application/json', 'Authorization':'Bearer '+self.server.credential,
                                      'Accept':'text/event-stream', 'Accept-Encoding':'identity'})
            response = upstream.getresponse()
            if 300 <= response.status < 400:
                self.send_error(502, 'Model endpoint redirects are not allowed');return
            if response.status >= 400:
                code = None
                try:
                    error = json.loads(response.read(65536)).get('error', {})
                    candidate = error.get('code') if isinstance(error, dict) else None
                    if isinstance(candidate, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',candidate) and candidate != self.server.credential:
                        code = candidate
                except (ValueError, AttributeError):pass
                payload = json.dumps({'error': {'message': f'Model service returned HTTP {response.status}', 'code': code}}).encode()
                self.send_response(response.status);self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(payload)));self.end_headers()
                headers_sent=True;self.wfile.write(payload);return
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'text/event-stream'))
            self.send_header('Connection', 'close')
            self.end_headers();headers_sent = True
            while True:
                chunk = response.read1(65536)
                if not chunk:break
                self.wfile.write(chunk);self.wfile.flush()
        except (OSError, ValueError, http.client.HTTPException):
            # Do not put credentials, request bodies or upstream exception text into logs.
            if not headers_sent:
                try:self.send_error(502, 'Model gateway connection failed')
                except OSError:pass
        finally:
            finished.set()
            if watcher:watcher.join(timeout=1)
            if upstream_socket:self.server.release(upstream_socket)
            upstream.close()

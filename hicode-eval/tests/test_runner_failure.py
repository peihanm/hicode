"""Exercise the real runner control flow with offline process/namespace fixtures."""
import contextlib
import builtins
import io
import json
import os
from pathlib import Path, PosixPath
import runpy
import subprocess
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).resolve().parents[1] / 'src/worker/runner.py'
RUN_ID = '1234567890abcdef'


class RunnerFailureTest(unittest.TestCase):
    def run_attempt(self, *, saved=True, pending=False, exits=True, handoff=True, completed=False, claimed_dependencies=False, isolated=False, timed_out=False, service=False):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'eval/runs' / RUN_ID
            logs = root / 'logs'
            logs.mkdir(parents=True)
            if claimed_dependencies:
                (root / 'project/.eval-verifier-python').mkdir(parents=True)
            config = {'dataset': 'terminal-bench-2.1', 'model': {'source': 'qwen', 'baseUrl': 'https://example.invalid',
                                'apiKeyEnv': 'EVAL_FIXTURE_KEY', 'model': 'fixture'},
                      'release': '/release', 'packages': [], 'verifierPackages': ['toml==0.10.2'],
                      'initializer': None, 'agentSeconds': 3600, 'verifierSeconds': 10,
                      'verifierPrelude': 'none'}
            config['network'] = 'isolated' if isolated else 'open'
            if service:config['service']={'writablePaths':[]}
            (root / 'job.json').write_text(json.dumps(config))
            (root / 'instruction.md').write_text('Offline fixture')
            events = [{'type': 'ready'}, {'type': 'agent_event', 'event': {'type': 'model_stream_start'}}]
            if pending:
                events.append({'type': 'agent_event', 'event': {'type': 'tool_call_start', 'toolCallId': 'pending'}})
            events += [{'type': 'agent_event', 'event': {'type': 'turn_end', 'input': {
                'session_id': 'fixture',
                'status': 'cancelled' if timed_out else 'completed' if completed else 'failed', 'reason': 'shutdown' if timed_out else 'completed' if completed else 'error',
                'persistence_status': 'saved' if saved else 'failed'}}},
                       {'type': 'state', 'busy': False, 'waitingForApproval': False}]
            if completed:
                events.append({'type': 'settled', 'reason': 'completed', 'runningAgents': 0,
                               'pendingAgentMessages': 0, 'sealed': True})
            (root/'actor-events').mkdir()
            (root/'actor-events/events.jsonl').write_text(''.join(json.dumps({
                'version': 1, 'sequence': i, 'sessionId': 'fixture', **event}) + '\n'
                for i, event in enumerate(events, 1)))
            prepared=base/'prepared-verifier';prepared.mkdir();(prepared/'toml.py').write_text('# offline package fixture')
            calls = []
            def terminate(fd,drain):
                calls.append('shutdown')
                if timed_out:
                    with (root/'actor-events/events.jsonl').open('a') as output:
                        output.write(json.dumps({'version':1,'sequence':len(events)+1,'sessionId':'fixture',
                            'type':'settled','reason':'shutdown','runningAgents':0,'pendingAgentMessages':0,'sealed':True})+'\n')
                    drain()
                return exits

            class FixturePath(PosixPath):
                def __new__(cls, *args):
                    value = PosixPath(*args)
                    if value == PosixPath('/eval') or value.is_relative_to('/eval') or value.is_relative_to('/run/hicode-eval'):
                        value = base / str(value).lstrip('/')
                    elif value == PosixPath('/opt/hicode-terminal/verifier'):
                        value = prepared
                    return super().__new__(cls, value)

            def execute(argv, **kwargs):
                if '--target' in argv:
                    self.assertNotIn('--unshare-net', argv)
                    self.assertIn('shutdown' if service else 'stop', calls)
                    self.assertIn('handoff', calls)
                    calls.append('install-verifier')
                if 'new-session' in argv:
                    self.assertEqual(kwargs['env']['EVAL_FIXTURE_KEY'], 'eval-isolated' if isolated else 'offline-fixture')
                return subprocess.CompletedProcess(argv, 0, stdout='', stderr='')

            def upload(*args):
                self.assertIn('shutdown' if service else 'stop', calls)
                calls.append('handoff')
                return handoff

            def grade(*args, **kwargs):
                self.assertIn('handoff', calls)
                calls.append('verify')
                return 'failed', 'Original verifier: missing output'

            actual_copytree=shutil.copytree
            def copytree(source,target,**kwargs):
                if str(source)=='/opt/hicode-terminal/verifier':
                    self.assertIn('stop',calls);self.assertIn('handoff',calls);calls.append('install-verifier')
                    return actual_copytree(prepared,target,**kwargs)
                return actual_copytree(source,target,**kwargs)

            output = io.StringIO()
            actual_open = builtins.open
            actual_import = builtins.__import__
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch('builtins.open', side_effect=lambda path, *args, **kwargs:
                    actual_open(FixturePath(path) if isinstance(path, (str, PosixPath)) else path, *args, **kwargs)))
                stack.enter_context(patch('builtins.__import__', side_effect=lambda name, globals=None, locals=None, fromlist=(), level=0:
                    SimpleNamespace(Path=FixturePath) if name == 'pathlib' and fromlist == ('Path',)
                    else actual_import(name, globals, locals, fromlist, level)))
                stack.enter_context(patch('sys.argv', [str(RUNNER), RUN_ID]))
                stack.enter_context(patch.dict(os.environ, {'EVAL_FIXTURE_KEY': 'offline-fixture'}))
                stack.enter_context(patch('pwd.getpwnam', side_effect=[KeyError(), SimpleNamespace(pw_gid=20001)]))
                stack.enter_context(patch('pwd.getpwuid', side_effect=KeyError()))
                stack.enter_context(patch('shutil.copytree',side_effect=copytree))
                stack.enter_context(patch('os.chown'))
                stack.enter_context(patch('os.close'))
                stack.enter_context(patch('signal.signal'))
                stack.enter_context(patch('subprocess.run', side_effect=execute))
                stack.enter_context(patch('cleanup.open_task_cli', return_value=7))
                stack.enter_context(patch('cleanup.terminate_task_cli', side_effect=terminate))
                stack.enter_context(patch('cleanup.stop_task_processes', side_effect=lambda *args: calls.append('stop')))
                stack.enter_context(patch('cleanup.finalize_task', side_effect=lambda *args: calls.append('finalize')))
                stack.enter_context(patch('recovery.process_start', return_value='fixture'))
                stack.enter_context(patch('protocol.actor_readonly_mounts',return_value=['--ro-bind','/usr','/usr']))
                stack.enter_context(patch('protocol.wait_verifier_handoff', side_effect=upload))
                if service:
                    owner=stack.enter_context(patch('service_namespace.ServiceNamespace')).return_value
                    owner.actor_argv.side_effect=lambda args:['service-actor',*args]
                    owner.verifier_argv.side_effect=lambda args,view:['service-verifier',*args]
                    def start_service(namespace, environment, *, model_socket=None):
                        self.assertEqual(model_socket, base/'run/hicode-eval'/RUN_ID/'model.sock' if isolated else None)
                        calls.append('service-start')
                    owner.start.side_effect=start_service
                    owner.snapshot.side_effect=lambda:calls.append('service-snapshot')
                    owner.close.side_effect=lambda:calls.append('service-close')
                stack.enter_context(patch('terminal.capture'))
                stack.enter_context(patch('terminal.settle', return_value=True))
                stack.enter_context(patch('terminal.submit_prompt'))
                stack.enter_context(patch('eval_datasets.terminal_bench.Path', FixturePath))
                stack.enter_context(patch('eval_datasets.terminal_bench.verify', side_effect=grade))
                gateway = stack.enter_context(patch('model_proxy.Gateway'))
                gateway.return_value.close.side_effect = lambda: calls.append('gateway-close')
                if timed_out:
                    clock=[0.0]
                    def elapsed():
                        clock[0]+=0.01 if 'shutdown' in calls else 10000
                        return clock[0]
                    stack.enter_context(patch('time.monotonic',side_effect=elapsed))
                    stack.enter_context(patch('time.sleep'))
                else:stack.enter_context(patch('time.sleep', side_effect=AssertionError('Failed turn must not wait for budget')))
                stack.enter_context(contextlib.redirect_stdout(output))
                runpy.run_path(str(RUNNER), run_name='__main__')
                if isolated:
                    self.assertEqual(gateway.call_args.args[1:], ('https://example.invalid', 'fixture', 'offline-fixture'))
                    launch=(base/'run/hicode-eval'/RUN_ID/'launch.sh').read_text()
                    self.assertIn('service-actor' if service else '--unshare-net',launch)
                    self.assertIn('network_entry.py',launch)
                    self.assertNotIn('offline-fixture',launch)
                    settings=json.loads((root/'home/.hicode/settings.json').read_text())
                    self.assertIn('web_fetch',settings['permissions']['deny'])
                    self.assertEqual(json.loads((root/'network.json').read_text())['mode'],'isolated')
            submitted=(root/'submitted-instruction.md').read_text()
            self.assertIn('60 分钟',submitted)
            self.assertIn('/app',submitted)
            self.assertEqual('当前外网不可用' in submitted,isolated)
            settings=json.loads((root/'home/.hicode/settings.json').read_text())
            self.assertIn(str(root/'actor-events'),settings['sandbox']['filesystem']['denyWrite'])
            packets = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertIn('finalize', calls)
            self.assertEqual(calls.count('shutdown'), 1 if service or not completed else 0)
            return packets[-1], calls, None if completed and not service else json.loads((root / 'shutdown.json').read_text())

    def test_completed_attempt_installs_verifier_only_after_sealing(self):
        result, calls, _ = self.run_attempt(completed=True)
        self.assertEqual(result['execution'], 'completed')
        self.assertEqual(calls, ['stop', 'handoff', 'verify', 'finalize'])

    def test_saved_shutdown_still_records_execution_timeout_without_false_cleanup_error(self):
        result,calls,receipt=self.run_attempt(timed_out=True)
        self.assertEqual(result['execution'],'timeout')
        self.assertEqual(result['grading'],'failed')
        self.assertEqual(receipt['reason'],'timeout')
        self.assertTrue(receipt['cliExited']);self.assertTrue(receipt['turnSaved'])
        self.assertEqual(receipt['pendingToolCallIds'],[]);self.assertIsNone(receipt['error'])
        self.assertIn('verify',calls)

    def test_saved_failure_stops_then_grades_without_waiting_for_budget(self):
        result, calls, receipt = self.run_attempt()
        self.assertEqual(result['execution'], 'failed')
        self.assertEqual(result['grading'], 'failed')
        self.assertEqual(calls, ['shutdown', 'stop', 'handoff', 'verify', 'finalize'])
        self.assertTrue(receipt['turnSaved'])

    def test_incomplete_shutdown_never_uploads_tests_or_installs_verifier(self):
        for options in [{'saved': False}, {'pending': True}, {'exits': False}]:
            with self.subTest(options=options):
                result, calls, receipt = self.run_attempt(**options)
                self.assertEqual(result['execution'], 'failed')
                self.assertEqual(result['grading'], 'unavailable')
                self.assertNotIn('handoff', calls)
                self.assertNotIn('install-verifier', calls)
                self.assertNotIn('verify', calls)

    def test_cancelled_handoff_does_not_install_or_grade(self):
        result, calls, _ = self.run_attempt(handoff=False)
        self.assertEqual(result['execution'], 'cancelled')
        self.assertEqual(result['grading'], 'unavailable')
        self.assertNotIn('install-verifier', calls)
        self.assertNotIn('verify', calls)

    def test_actor_cannot_prepopulate_the_verifier_dependency_directory(self):
        result, calls, _ = self.run_attempt(claimed_dependencies=True)
        self.assertEqual(result['grading'], 'unavailable')
        self.assertNotIn('install-verifier', calls)
        self.assertNotIn('verify', calls)

    def test_isolated_run_uses_gateway_placeholder_and_closes_before_grading(self):
        result,calls,_=self.run_attempt(isolated=True)
        self.assertEqual(result['execution'],'failed')
        self.assertEqual(calls.count('gateway-close'),1)
        self.assertLess(calls.index('gateway-close'),calls.index('handoff'))

    def test_service_handoff_keeps_namespace_through_verification_then_closes(self):
        result,calls,receipt=self.run_attempt(completed=True,isolated=True,service=True)
        self.assertEqual(result['execution'],'completed')
        self.assertEqual(result['grading'],'failed')
        self.assertTrue(receipt['cliExited'])
        self.assertLess(calls.index('shutdown'),calls.index('handoff'))
        self.assertLess(calls.index('handoff'),calls.index('verify'))
        self.assertLess(calls.index('verify'),calls.index('service-close'))
        self.assertLess(calls.index('service-close'),calls.index('finalize'))

    def test_incomplete_service_shutdown_never_exposes_hidden_tests(self):
        result,calls,receipt=self.run_attempt(pending=True,isolated=True,service=True)
        self.assertEqual(result['grading'],'unavailable')
        self.assertEqual(receipt['pendingToolCallIds'],['pending'])
        self.assertNotIn('handoff',calls)
        self.assertNotIn('verify',calls)
        self.assertLess(calls.index('service-close'),calls.index('finalize'))

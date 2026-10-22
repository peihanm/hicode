import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from continuation import restore_checkpoint
from deep_checkpoint import recover


class DeepCheckpointTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.run = self.base/'aaaaaaaaaaaaaaaa'
        self.evidence = self.run/'evidence'
        self.stage = self.base/'stage'
        self.stage.mkdir()
        self.project = self.evidence/'project'
        self.project.mkdir(parents=True)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline fixture')
        self.git('config', 'user.email', 'fixture@localhost')
        (self.project/'answer.py').write_text('committed answer')
        self.git('add', 'answer.py')
        self.git('commit', '-qm', 'saved answer')
        self.head = self.git('rev-parse', 'HEAD').strip()
        (self.project/'answer.py').write_text('uncommitted work')
        (self.project/'new.py').write_text('untracked work')
        self.write(self.run/'state.json', {'id': self.run.name, 'dataset': 'deep-swe', 'network': 'isolated',
                   'state': 'error', 'execution': 'timeout', 'collection': 'complete', 'budget': {'agentSeconds': 1800}})
        self.write(self.run/'job.json', {'dataset': 'deep-swe', 'network': 'isolated', 'service': None,
                   'model': {'source': 'qwen'}})
        self.write(self.run/'container-disposed.json', {'version': 1, 'runId': self.run.name})
        self.hashes = {}
        for name in ['runner.py', 'protocol.py', 'cleanup.py', 'eval_datasets/deep_swe.py']:
            path = self.run/'worker'/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('reviewed fixture module '+name)
            self.hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.write(self.evidence/'shutdown.json', {'reason': 'timeout', 'cliExited': True, 'turnSaved': True,
                   'pendingToolCallIds': [], 'eventStreamComplete': True, 'error': None})
        self.write(self.evidence/'home/.hicode/settings.json',
                   {'sources': {'qwen': {'baseUrl': 'http://127.0.0.1:49152/v1'}}})
        self.identity = self.evidence/'home/.hicode/projects/fixture/sessions/session-fixture/identity.json'
        self.write(self.identity, {'version': 1, 'sessionId': 'original-session', 'cwd': '/app'})
        self.write(self.identity.parent/'snapshot.json', {'fixture': 'persisted conversation'})
        for name in ['tests/private.py', 'verifier-project/private.py', 'verifier-home/private.txt', 'logs/verifier/private.txt']:
            path = self.evidence/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('hidden verification content')
        self.events = [
            {'type': 'ready'}, {'type': 'state', 'busy': True, 'waitingForApproval': False},
            {'type': 'agent_event', 'event': {'type': 'model_stream_start'}},
            {'type': 'agent_event', 'event': {'type': 'tool_call_start', 'toolCallId': 'tool-1'}},
            {'type': 'agent_event', 'event': {'type': 'tool_call_end', 'toolCallId': 'tool-1'}},
            {'type': 'agent_event', 'event': {'type': 'turn_end', 'input': {'session_id': 'original-session',
             'status': 'cancelled', 'reason': 'shutdown', 'persistence_status': 'saved'}}},
            {'type': 'settled', 'reason': 'shutdown', 'status': 'cancelled', 'persistenceStatus': 'saved',
             'runningAgents': 0, 'pendingAgentMessages': 0}]
        self.save_events()
        self.receipt()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.project), *args], text=True)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def save_events(self):
        path = self.evidence/'actor-events/events.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps({'version': 1, 'sequence': i+1, 'sessionId': 'original-session', **event})+'\n'
                                for i, event in enumerate(self.events)))

    def receipt(self):
        files = {}
        for path in self.evidence.rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                files[str(path.relative_to(self.evidence))] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        self.write(self.run/'collection.json', {'complete': True, 'files': files})

    def test_restores_git_worktree_and_original_session_without_verifier_material(self):
        value = recover(str(self.run), str(self.stage), self.hashes)
        target = self.base/'bbbbbbbbbbbbbbbb'
        target.mkdir()
        (target/'continuation-input.tar.gz').write_bytes((self.stage/'continuation.tar.gz').read_bytes())
        restore_checkpoint(target, value, None)
        self.assertEqual(value['sessionId'], 'original-session')
        self.assertEqual(value['elapsedSeconds'], 1800)
        self.assertEqual(subprocess.check_output(['git', '-C', str(target/'project'), 'rev-parse', 'HEAD'], text=True).strip(), self.head)
        self.assertEqual((target/'project/answer.py').read_text(), 'uncommitted work')
        self.assertEqual((target/'project/new.py').read_text(), 'untracked work')
        self.assertEqual(json.loads((target/'home/.hicode/projects/fixture/sessions/session-fixture/snapshot.json').read_text()),
                         {'fixture': 'persisted conversation'})
        self.assertEqual({p.name for p in target.iterdir()}, {'project', 'home'})

    def test_changed_actor_file_and_execution_module_rejected(self):
        for path in [self.project/'answer.py', self.run/'worker/runner.py']:
            original = path.read_bytes()
            path.write_text('changed')
            with self.subTest(path=path), self.assertRaises(ValueError):
                recover(str(self.run), str(self.stage), self.hashes)
            path.write_bytes(original)

    def test_shutdown_missing_tool_result_or_saved_observation_rejected(self):
        original = json.loads(json.dumps(self.events))
        variants = [original[:-1], original[:4]+original[5:],
                    original[:-1]+[{**original[-1], 'runningAgents': 1}],
                    original[:-1]+[{**original[-1], 'pendingAgentMessages': 1}],
                    original[:-1]+[{**original[-1], 'persistenceStatus': 'failed'}],
                    original+[{ 'type': 'state', 'busy': False, 'waitingForApproval': False}]]
        for events in variants:
            self.events = events
            self.save_events()
            self.receipt()
            with self.subTest(events=events), self.assertRaises(ValueError):
                recover(str(self.run), str(self.stage), self.hashes)

    def test_truncated_events_and_wrong_workspace_rejected(self):
        path = self.evidence/'actor-events/events.jsonl'
        path.write_bytes(path.read_bytes().rstrip(b'\n'))
        self.receipt()
        with self.assertRaises(ValueError): recover(str(self.run), str(self.stage), self.hashes)
        self.save_events()
        self.write(self.identity, {'sessionId': 'original-session', 'cwd': '/verifier'})
        self.receipt()
        with self.assertRaises(ValueError): recover(str(self.run), str(self.stage), self.hashes)

    def test_unsafe_collected_path_and_incomplete_shutdown_rejected(self):
        self.write(self.evidence/'shutdown.json', {'reason': 'timeout', 'cliExited': True, 'turnSaved': False,
                   'pendingToolCallIds': [], 'eventStreamComplete': True, 'error': None})
        self.receipt()
        with self.assertRaises(ValueError): recover(str(self.run), str(self.stage), self.hashes)

        self.write(self.evidence/'shutdown.json', {'reason': 'timeout', 'cliExited': True, 'turnSaved': True,
                   'pendingToolCallIds': [], 'eventStreamComplete': True, 'error': None})
        self.receipt()
        receipt = json.loads((self.run/'collection.json').read_text())
        receipt['files']['project/../../outside'] = {'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}
        self.write(self.run/'collection.json', receipt)
        with self.assertRaises(ValueError): recover(str(self.run), str(self.stage), self.hashes)

    def test_failed_start_reuses_original_input_only_before_any_agent_activity(self):
        checkpoint = recover(str(self.run), str(self.stage), self.hashes)
        rejected = self.base/'bbbbbbbbbbbbbbbb'
        state = json.loads((self.run/'state.json').read_text())
        state.update(id=rejected.name, execution='failed', grading='unavailable')
        self.write(rejected/'state.json', state)
        self.write(rejected/'container-disposed.json', {'version': 1, 'runId': rejected.name})
        self.write(rejected/'job.json', {'continuation': {'checkpoint': checkpoint}})
        path = rejected/'evidence/actor-events/events.jsonl'
        path.parent.mkdir(parents=True)
        def events(event):
            data = (json.dumps({'version': 1, 'sequence': 1, 'sessionId': 'original-session', **event})+'\n').encode()
            path.write_bytes(data)
            self.write(rejected/'collection.json', {'complete': True, 'files': {'actor-events/events.jsonl':
                       {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}})
        events({'type': 'state', 'busy': False, 'waitingForApproval': False})
        restored = recover(str(self.run), str(self.stage), self.hashes, str(rejected))
        self.assertEqual(restored['sessionId'], 'original-session')
        for event in [{'type': 'ready'}, {'type': 'agent_event', 'event': {'type': 'model_stream_start'}}]:
            events(event)
            with self.subTest(event=event), self.assertRaises(ValueError):
                recover(str(self.run), str(self.stage), self.hashes, str(rejected))


if __name__ == '__main__': unittest.main()

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from recovery import recover, process_start


class RecoveryTest(unittest.TestCase):
    def test_failed_import_recovers_without_actor_identity_or_model_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve()/('a'*16);root.mkdir()
            (root/'job.json').write_text(json.dumps({'dataset':'terminal-bench','release':'/opt/hicode/releases/'+'a'*64}))
            with patch('recovery.pwd.getpwall',return_value=[]),patch.object(Path,'iterdir',return_value=iter([])),patch('cleanup.stop_task_processes') as stop:
                result=recover(root)
            self.assertEqual(result,{'execution':'failed','grading':'unavailable','uid':20000})
            self.assertFalse((root/'identity.json').exists())
            self.assertEqual(json.loads((root/'startup-recovery.json').read_text())['actorStarted'],False)
            stop.assert_called_once_with(20000)

    def test_missing_identity_with_actor_evidence_or_account_stays_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve()/('a'*16);root.mkdir();(root/'home').mkdir()
            with self.assertRaisesRegex(ValueError,'initialization evidence'):recover(root)
            (root/'home').rmdir()
            with patch('recovery.pwd.getpwall',return_value=[SimpleNamespace(pw_name='eval-'+root.name,pw_uid=20000)]):
                with self.assertRaisesRegex(ValueError,'Actor account exists'):recover(root)
            self.assertFalse((root/'result.json').exists())

    def fixture(self, parent):
        root = Path(parent).resolve() / ('a' * 16)
        (root/'logs/verifier').mkdir(parents=True)
        (root/'actor-events').mkdir()
        identity = {'version':2,'run':root.name,'user':'eval-'+root.name,'uid':20001,'pid':12345,'runnerStart':'100'}
        outcome = {'execution':'completed','grading':'passed','uid':20001}
        (root/'identity.json').write_text(json.dumps(identity))
        (root/'outcome.json').write_text(json.dumps(outcome))
        (root/'job.json').write_text(json.dumps({'dataset':'terminal-bench'}))
        records = [
            {'type':'ready'},
            {'type':'agent_event','event':{'type':'turn_end','input':{'persistence_status':'saved'}}},
            {'type':'settled','reason':'completed','sealed':True,'runningAgents':0,'pendingAgentMessages':0},
            {'type':'state','busy':False,'waitingForApproval':False},
        ]
        (root/'actor-events/events.jsonl').write_text(''.join(json.dumps({'version':1,'sequence':i+1,'sessionId':'fixture',**r})+'\n' for i,r in enumerate(records)))
        summary={'tests':1,'passed':1,'failed':0,'skipped':0,'pending':0,'other':0}
        (root/'logs/verifier/ctrf.json').write_text(json.dumps({'results':{'summary':summary,'tests':[{'status':'passed'}]}}))
        (root/'logs/verifier/reward.txt').write_text('1\n')
        return root,outcome

    def test_recovery_is_idempotent_and_preserves_grade_and_original_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,outcome=self.fixture(tmp)
            with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes'):
                self.assertEqual(recover(root),outcome)
                before=(root/'recovery.json').read_bytes()
                self.assertEqual(recover(root),outcome)
                self.assertEqual((root/'recovery.json').read_bytes(),before)
            self.assertEqual(json.loads((root/'result.json').read_text()),outcome)

    def test_live_runner_or_changed_account_cannot_be_recovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,_=self.fixture(tmp)
            with patch('recovery.process_start',return_value='100'), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes') as stop:
                with self.assertRaisesRegex(RuntimeError,'still alive'):recover(root)
                stop.assert_not_called()
            with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20002)):
                with self.assertRaisesRegex(ValueError,'identity changed'):recover(root)

    def test_missing_mismatched_tampered_and_truncated_evidence_stays_blocked(self):
        mutations=[
            lambda root:(root/'outcome.json').unlink(),
            lambda root:(root/'logs/verifier/reward.txt').write_text('0'),
            lambda root:(root/'logs/verifier/ctrf.json').write_text('{}'),
            lambda root:(root/'result.json').write_text(json.dumps({'execution':'failed','grading':'unavailable','uid':20001})),
            lambda root:(root/'actor-events/events.jsonl').write_text((root/'actor-events/events.jsonl').read_text()+'{"partial":'),
            lambda root:(root/'actor-events/events.jsonl').write_text((root/'actor-events/events.jsonl').read_text().replace('"sealed": true','"sealed": false')),
        ]
        for mutate in mutations:
            with tempfile.TemporaryDirectory() as tmp:
                root,_=self.fixture(tmp);mutate(root)
                with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes') as stop:
                    with self.assertRaises((OSError,ValueError,KeyError)):recover(root)
                    stop.assert_not_called()
                self.assertFalse((root/'recovery.json').exists())

    def test_symlinked_evidence_and_cleanup_denial_do_not_finalize(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,_=self.fixture(tmp)
            (root/'real.json').write_bytes((root/'outcome.json').read_bytes())
            (root/'outcome.json').unlink();(root/'outcome.json').symlink_to(root/'real.json')
            with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)):
                with self.assertRaisesRegex(ValueError,'Symlinked'):recover(root)
            (root/'outcome.json').unlink();(root/'real.json').rename(root/'outcome.json')
            with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes',side_effect=PermissionError()):
                with self.assertRaises(PermissionError):recover(root)
            self.assertFalse((root/'result.json').exists())

    def test_reused_runner_pid_is_not_mistaken_for_original_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root,outcome=self.fixture(tmp)
            with patch('recovery.process_start',return_value='101'), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes'):
                self.assertEqual(recover(root),outcome)
        with patch('recovery.Path.read_text',side_effect=ProcessLookupError()):
            self.assertIsNone(process_start(12345))

    def failed_fixture(self, parent):
        root, outcome = self.fixture(parent)
        outcome['execution'] = 'failed'
        (root/'outcome.json').write_text(json.dumps(outcome))
        records = [{'type':'ready'}, {'type':'agent_event','event':{'type':'model_stream_start'}},
                   {'type':'agent_event','event':{'type':'turn_end','input':{
                       'session_id':'fixture','status':'failed','reason':'error','persistence_status':'saved'}}},
                   {'type':'state','busy':False,'waitingForApproval':False}]
        (root/'actor-events/events.jsonl').write_text(''.join(json.dumps({'version':1,'sequence':i+1,'sessionId':'fixture',**r})+'\n'
                                                   for i,r in enumerate(records)))
        (root/'shutdown.json').write_text(json.dumps({'version':1,'reason':'failed','cliExited':True,
            'turnSaved':True,'pendingToolCallIds':[],'eventStreamComplete':True,'error':None}))
        return root, outcome

    def test_failed_attempt_with_confirmed_shutdown_keeps_independent_grade(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, outcome = self.failed_fixture(tmp)
            with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes'):
                self.assertEqual(recover(root), outcome)
                self.assertEqual(recover(root), outcome)
            proof = json.loads((root/'recovery.json').read_text())['evidence']
            self.assertIn('shutdown.json', proof)
            self.assertIn('actor-events/events.jsonl', proof)

    def test_failed_attempt_without_shutdown_proof_cannot_recover_a_grade(self):
        for field,value in [('cliExited',False),('turnSaved',False),('pendingToolCallIds',['a']),
                            ('eventStreamComplete',False),('error','failed'),('reason','timeout')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                root, _ = self.failed_fixture(tmp)
                path=root/'shutdown.json';receipt=json.loads(path.read_text());receipt[field]=value;path.write_text(json.dumps(receipt))
                with patch('recovery.process_start',return_value=None), patch('recovery.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=20001)), patch('cleanup.stop_task_processes') as stop:
                    with self.assertRaisesRegex(ValueError,'confirmed shutdown'):recover(root)
                    stop.assert_not_called()

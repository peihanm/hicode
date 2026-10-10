import tempfile
import hashlib
import json
import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from dataset_runtime import TerminalBenchRuntime, SweBenchRuntime, dataset_runtime


class DatasetRuntimeTests(TestCase):
    def test_hidden_inputs_enter_only_grading_and_refuse_symlink_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);project=root/'project';project.mkdir();(root/'tests').mkdir();(root/'logs/verifier').mkdir(parents=True)
            (root/'tests/image.bin').write_bytes(b'original hidden fixture')
            config={'verifierPrelude':'none','verifierSeconds':90,'verifierInputs':[{'source':'tests/image.bin','target':'image.bin'}],
                    'verifierSetup':'setup.sh','verifierTestPaths':['/app/public-tests','/tests/test_outputs.py']}
            calls=[]
            def setup(args,**options):
                self.assertEqual((project/'image.bin').read_bytes(),b'original hidden fixture')
                calls.append(args)
            with patch('eval_datasets.terminal_bench.verify',return_value=('failed','no answer')) as grader:
                handler=dataset_runtime({'dataset':'terminal-bench-2.1'})
                handler.grade(root=root,config=config,uid=os.getuid(),gid=os.getgid(),project=project,
                              home=root/'home',logs=root/'logs',command=setup,namespace=lambda args,**kw:args,
                              demote=lambda:None,cancelled=lambda:False)
                self.assertEqual(calls,[['bash','/tests/setup.sh']])
                self.assertIn('/app/public-tests',grader.call_args.args[0])
            (project/'image.bin').unlink();(project/'image.bin').symlink_to(root/'secret')
            with self.assertRaisesRegex(ValueError,'symlink'):
                handler.grade(root=root,config=config,uid=os.getuid(),gid=os.getgid(),project=project,
                              home=root/'home',logs=root/'logs',command=setup,namespace=lambda args,**kw:args,
                              demote=lambda:None,cancelled=lambda:False)
            config['verifierInputs']=[{'source':'tests/../../secret','target':'image.bin'}]
            with self.assertRaisesRegex(ValueError,'path'):
                handler.grade(root=root,config=config,uid=os.getuid(),gid=os.getgid(),project=project,
                              home=root/'home',logs=root/'logs',command=setup,namespace=lambda args,**kw:args,
                              demote=lambda:None,cancelled=lambda:False)

    def test_release_selects_its_own_handler(self):
        self.assertIsInstance(dataset_runtime({'dataset': 'terminal-bench-2.1'}), TerminalBenchRuntime)
        self.assertIsInstance(dataset_runtime({'dataset': 'terminal-bench-2.1'}), TerminalBenchRuntime)
        self.assertIsInstance(dataset_runtime({'dataset': 'swe-bench-verified'}), SweBenchRuntime)
        with self.assertRaisesRegex(ValueError, 'Unsupported frozen dataset'):
            dataset_runtime({'dataset': 'unsupported'})

    def test_terminal_grading_dispatches_original_pytest_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'logs/verifier').mkdir(parents=True)
            config = {'verifierPrelude': 'none', 'verifierSeconds': 90, 'packages': [],
                      'verifierPackages': [], 'verifierEnvironment': {}}
            with patch('eval_datasets.terminal_bench.verify', return_value=('failed', 'original test failed')) as grader:
                result = dataset_runtime({'dataset': 'terminal-bench-2.1'}).grade(
                    root=root, config=config, uid=20000, gid=20000, project=root / 'project',
                    home=root / 'home', logs=root / 'logs', command=lambda *a, **kw: None,
                    namespace=lambda args, **kw: args, demote=lambda: None, cancelled=lambda: False)
            self.assertEqual(result, ('failed', 'original test failed'))
            self.assertGreater(grader.call_args.kwargs['timeout'], 89)
            self.assertLessEqual(grader.call_args.kwargs['timeout'], 90)
            self.assertIn('/tests/test_outputs.py', grader.call_args.args[0])

    def test_original_verifier_budget_does_not_restart_after_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'logs/verifier').mkdir(parents=True)
            config={'verifierPrelude':'none','verifierSeconds':5,'verifierSetup':'setup.sh'}
            with patch('eval_datasets.terminal_bench.time.monotonic',side_effect=[10,11,16]), \
                    patch('eval_datasets.terminal_bench.verify') as grader:
                with self.assertRaisesRegex(TimeoutError,'budget exhausted'):
                    TerminalBenchRuntime().grade(root=root,config=config,uid=os.getuid(),gid=os.getgid(),
                        project=root/'project',home=root/'home',logs=root/'logs',command=lambda *a,**kw:None,
                        namespace=lambda args,**kw:args,demote=lambda:None,cancelled=lambda:False)
                grader.assert_not_called()

    def test_writable_test_view_is_explicit_and_verifier_only(self):
        handler=TerminalBenchRuntime()
        self.assertFalse(handler.writable_tests({'verifierPrelude':'none'}))
        self.assertTrue(handler.writable_tests({'verifierPrelude':'none','verifierWritableTests':True}))
        with self.assertRaisesRegex(ValueError,'writable verifier'):
            handler.writable_tests({'verifierPrelude':'none','verifierWritableTests':'yes'})

    def test_swe_recovery_validates_collected_patch_before_accepting_score(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'logs/verifier').mkdir(parents=True)
            (root/'logs/verifier/report.json').write_text('{}')
            patch_text='diff --git a/x b/x\n'
            (root/'prediction.json').write_text(json.dumps({'instance_id':'case-1','model_patch':patch_text}))
            (root/'patch-manifest.json').write_text(json.dumps({'sha256':hashlib.sha256(patch_text.encode()).hexdigest()}))
            job={'dataset':'swe-bench-verified','swe':{'instanceId':'case-1'}}
            handler=dataset_runtime(job)
            with patch('swe.validate_swe_report') as validate:
                evidence=handler.recovery_evidence(root,job,'failed',lambda path,limit:path.read_bytes())
            validate.assert_called_once_with({},'case-1','failed')
            self.assertEqual(set(evidence),{'logs/verifier/report.json','prediction.json','patch-manifest.json'})
            (root/'prediction.json').write_text(json.dumps({'instance_id':'case-1','model_patch':'changed'}))
            with patch('swe.validate_swe_report'),self.assertRaisesRegex(ValueError,'patch changed'):
                handler.recovery_evidence(root,job,'failed',lambda path,limit:path.read_bytes())

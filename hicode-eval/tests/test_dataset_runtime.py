import tempfile
import hashlib
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from dataset_runtime import TerminalBenchRuntime, SweBenchRuntime, dataset_runtime


class DatasetRuntimeTests(TestCase):
    def test_release_selects_its_own_handler(self):
        self.assertIsInstance(dataset_runtime({'dataset': 'terminal-bench'}), TerminalBenchRuntime)
        self.assertIsInstance(dataset_runtime({'dataset': 'terminal-bench-2.1'}), TerminalBenchRuntime)
        self.assertIsInstance(dataset_runtime({'dataset': 'swe-bench-verified'}), SweBenchRuntime)
        with self.assertRaisesRegex(ValueError, 'Unsupported frozen dataset'):
            dataset_runtime({'dataset': 'deep-swe'})

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
            self.assertEqual(grader.call_args.kwargs['timeout'], 90)
            self.assertIn('/tests/test_outputs.py', grader.call_args.args[0])

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

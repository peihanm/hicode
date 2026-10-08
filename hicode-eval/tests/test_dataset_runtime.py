import tempfile
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

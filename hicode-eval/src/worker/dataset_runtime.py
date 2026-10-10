"""Select a reviewed dataset handler for one frozen run."""
from eval_datasets.terminal_bench import TerminalBenchRuntime
from eval_datasets.swe_bench import SweBenchRuntime
from eval_datasets.deep_swe import DeepSweRuntime


_RUNTIMES = {
    'terminal-bench-2.1': TerminalBenchRuntime,
    'deep-swe': DeepSweRuntime,
    'swe-bench-verified': SweBenchRuntime,
}


def dataset_runtime(config):
    try:
        return _RUNTIMES[config['dataset']]()
    except (KeyError, TypeError) as error:
        raise ValueError('Unsupported frozen dataset') from error

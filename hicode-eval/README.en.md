# HiCode Eval

An isolated public-task evaluator with separate execution and dashboard processes. Code and declaration validators belong here; all manifests, dependency recipes, Dockerfiles, tasks, environment receipts, settings and logs belong to one external evaluation root. The current evaluator rejects historical configurations and run formats.

Read the evaluation root's README before operations and after context compaction or recovery. It is the storage and cleanup contract. Its template is [templates/data-README.md](templates/data-README.md); the full workflow is documented in [README.md](README.md).

All commands require `--root DIR`. Initialize an empty root, register validated tasks, prepare environments, freeze the HiCode payload, then start worker (8879) and serve (8878). Submit explicit dataset/id pairs. Settings and the sole catalog live in state/; frozen tasks in datasets/; receipts in environments/; logs in runs/; reproducible build inputs in cache/.

The worker owns scheduling, credentials, containers, results and idle cleanup. Release initialization validates the frozen payload on the host; each attempt installs the release and runs isolation preflight in its own dataset image and Docker backend. It does not require another dataset’s preparation container or verifier Python. Offline mutation commands acquire the same service lease. The dashboard reads atomic records and forwards controls; polling never accesses Docker or scans task sources.

For already registered tasks, `prepare-environments --live --ids DATASET:ID,...` asks the owning worker to build sequentially in the background while unrelated attempts continue. Active or retained attempts cannot be rebuilt; tasks being built cannot be submitted. Progress is stored in state/preparation.json. Resource cleanup waits for builds, and worker shutdown waits for preparation to finish. Source registration and recipe review remain offline operations.

Passed tasks retain verified compressed evidence and small UI records. Their exclusive images and frozen source copies are reclaimed, while shared images needed by untested or unsuccessful tasks remain. Environment states distinguish unprepared, ready, evicted and failed. Docker engine failures never imply missing images. `gc` previews; `gc --apply --build-cache` reclaims resources and old BuildKit cache under an 8 GB default retention budget. Docker disks remain managed by Docker/Colima.

Use `bash hicode-eval/eval.sh --help` for current commands. Offline validation: `bun test hicode-eval/tests`, `bunx tsc --noEmit -p hicode-eval/tsconfig.json`, and Python unittest discovery with host/worker/datasets on PYTHONPATH. Real model evaluation requires an explicit submission; preparation and fake-model tests are not accepted scores.

Dataset declarations live in datasets/<dataset>/definition.json under the external root. Common runtime inputs live in environments/runtime. System packages are explicit systemPackages declarations; commands validate availability without inferring package names. Package mirrors belong in the external runtime Dockerfile. Add reviewed declarations incrementally; do not bulk copy the archived config tree.

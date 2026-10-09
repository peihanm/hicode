# HiCode Eval

[简体中文](README.md)

Run public programming tasks through HiCode in a fresh disposable Linux container for each attempt. Submit batches from the CLI, watch the full TUI in a browser, and automatically collect test results and logs. Each task gets one independent attempt, with no corrective follow-up prompts or automatic retries.

Reviewed tasks are listed in the [Terminal-Bench 2.0 manifest](config/terminal-bench.json) and the [Terminal-Bench 2.1 manifest](config/terminal-bench-2.1.json); SWE-bench Verified uses frozen task bundles. This is a development regression tool: the reviewed dependency recipes, ARM64 environment, and configurable time limits differ from official benchmark conditions. Results are not official leaderboard scores.

Query batch execution and scores with the CLI `status` command. Keep personal task reviews and environment preparation records outside the checkout.

## Directory and records

```text
src/
  cli.ts     Command-line entrypoint
  host/      Host scheduling, state, Linux transport, and payload preparation
  worker/    Linux execution, grading, terminal capture, and cleanup
  web/       Read-only dashboard and terminal component
config/      Task adapters, fixed regression groups, and configuration examples
tests/       Offline regression tests
skills/      Codex batch evaluation instructions
```

Task files, source payloads, credentials, and run records stay outside the checkout. `config/` contains shared declarations, fixed regression groups, and examples. Cumulative scores live in the external `catalog/catalog.json`; active submissions and evidence live under `<data-dir>/batches/` and `runs/`, and compacted evidence lives in `catalog/run-archive/`. Keep pending task selections in `../hicode-eval-data/operator/batch-configs/`, current operator notes in `operator/records/`, and temporary operator logs in `operator/logs/`. Delete those logs after use.

## 1. Prepare the environment and dataset

Run these commands from the **HiCode repository root**. The host needs Git, Bun 1.3+, Python 3.9+, and the Docker CLI. On macOS, first follow the [development container guide](../.devcontainer/README.en.md) to install Colima, Compose, and Buildx and create the `hicode` VM. Native Linux can use another Docker context, but requires the equivalent nested sandbox policy described in that guide.

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh engine-start
```

This starts only the Docker engine and loads the nested sandbox policy. Register bundles and build clean images, then create the preparation container using the steps below before starting the service. It mounts no host directories or old evaluation volumes. Task dependencies are installed only while building images.

Download the dataset outside this repository and pin the reviewed revision:

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`config/terminal-bench.json` verifies the full file hashes of supported tasks and rejects modified versions. Tasks and reference solutions are not distributed in this repository; follow the upstream dataset's license and usage conditions. Harbor is not required.

## 2. Configure a model and freeze the source

Run `bun run start`, configure a connection, API key, and model with `/providers`, select the default with `/model`, then exit. The evaluation service reads settings from **this checkout and `~/.hicode`**, not from task directories or another project.

Alternatively, copy [config/example.model.json](config/example.model.json) to `../hicode-eval-data/model.local.json`, fill in the model ID, endpoint, and API key environment variable name, and pass `--model-config ../hicode-eval-data/model.local.json` to `worker`. The JSON **does not contain the API key value**. Credentials are resolved from the process environment, this checkout's `.env`, then `~/.hicode/.env`; `/providers` can save them without putting a key in command-line arguments. Supported `source` values are `qwen`, `deepseek`, `glm`, and `openrouter`.

Freeze the version to evaluate:

```bash
bash hicode-eval/eval.sh prepare --payload ../hicode-eval-data/payload-v1
```

A clean worktree is required by default. Add `--snapshot-worktree` to include uncommitted changes under `src/` and to `package.json`, `bun.lock`, and `tsconfig.json`. The payload contains only those runtime inputs and records the commit, overlaid files, and archive hash. Use a new output directory for each version.

## 3. Register, prepare, and submit

First register reviewed bundles with `register-tasks --catalog FILE --tasks DIR` (or `--swe-tasks DIR`), then run `prepare-environments --catalog FILE --environments DIR`. Preparation defaults to unpassed and untested tasks; use `--ids DATASET:ID` or `--include-passed` for passed tasks. A dataset release and task ID jointly identify a task; dependency images can still be shared when their recipes match. Submission revalidates the selected task bundles, current recipes, and images before creating runs; stale bindings fail before a batch is published. Missing reviewed sources remain unprepared.

Images share a public base, dependency combinations and optional task preparation. Only attempts get disposable writable layers. The base is built from `config/clean-base.Dockerfile`, digest-pinned upstream images and the HiCode lockfile. No live cache-machine filesystem is imported. Reviewed SWE package and interpreter locks live in `config/environment-recipes/`; missing recipes remain unprepared. Version 2 receipts record recipe hashes and immutable images, with each build context retained. OS packages and common grading transitive dependencies are recorded after resolution, so cross-date byte-for-byte rebuilds are not yet guaranteed. Service defaults are isolated actor networking, 1 CPU and 4096 MiB per attempt; `--cpus` and `--memory-mb` override limits.

```bash
bash hicode-eval/eval.sh worker \
  --data-dir ../hicode-eval-data/runs \
  --catalog ../hicode-eval-data/catalog/catalog.json \
  --environments ../hicode-eval-data/environments \
  --payload ../hicode-eval-data/payload-v1 \
  --docker-context colima-hicode \
  --machine hicode-eval-clean \
  --concurrency 3
```

The execution worker listens on port 8879 by default and exclusively owns scheduling, model credentials, containers and score writes. It deploys the fixed release and reuses unchanged production dependencies. Start the dashboard in a separate terminal:

```bash
bash hicode-eval/eval.sh serve --data-dir ../hicode-eval-data/runs --port 8878 --worker-port 8879
```

Open **http://127.0.0.1:8878**. The dashboard reads atomic state, terminal and log records. Control requests are forwarded to the authenticated worker after verifying the same data directory. It never loads model keys or owns scheduler/catalog leases. Restarting or closing it leaves running tasks intact. Records remain readable when the worker is unavailable, while control requests fail closed. CLI commands use the dashboard by default:

```bash
bash hicode-eval/eval.sh catalog
bash hicode-eval/eval.sh submit --file hicode-eval/config/example.batch.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

Replace `BATCH_ID` with the ID returned on submission. One batch can contain different execution limits. Each task declares an `id` and an optional `agentSeconds`:

```json
{
  "name": "This test round",
  "tasks": [
    { "id": "cancel-async-tasks", "agentSeconds": 900 },
    { "id": "log-summary-date-ranges", "agentSeconds": 1800 }
  ],
  "concurrency": 3
}
```

Omitting `agentSeconds` uses the service default (1800 seconds); each task accepts 30–10800 seconds. Concurrency is capped at 4 and cannot exceed the service limit. The page displays each task's limit, and completed tasks automatically release their slots. Actual and original task budgets are recorded separately; extended budgets are development evaluation conditions. The fixed 15-task regression group is [regression15.json](config/regression15.json).

Use `--source` and `--model` together to override a configured model, or `--model-config` for an explicit connection. If changing the port, pass the same `--port` to every CLI command. Run only one service per evaluation machine, and do not deploy another version while tasks are active.

A person or an agent such as Codex can operate the CLI. **Scheduling and grading do not depend on Codex.** Real tasks incur usage charges from your configured model provider; offline tests do not call a model.

## Evaluation network modes

The service defaults to open networking. Use `serve --network isolated` to change the default, or set a mode per submitted batch:

```json
{"name":"Independent evaluation","network":"isolated","concurrency":3,"tasks":[{"id":"regex-log"}]}
```

- `open`: the Agent may use the network while solving the task.
- `isolated`: preparation and grading retain network access. During the attempt, curl, pip, Fetch and other processes cannot access the internet; model calls use a fixed model-only gateway. Prepared local dependency caches remain available.

An omitted mode inherits the service default. Each batch freezes its choice; active tasks are not switched and other batches are unaffected. Isolation failure stops preparation instead of falling back to open access. The real model credential stays outside the actor namespace. The gateway rejects arbitrary destinations, redirects and provider-side search tools. Actor mounts expose only this task, its runtime and its dependencies. Preparation caches, other tasks, grader inputs and terminal capture logs remain host-side; the task’s own HiCode storage and request logs remain available.

## Grading, logs, and shutdown

Database, image, and calendar inputs are copied individually from the reviewed `inputs` manifest in `config/terminal-bench.json` and verified by hash, rather than copying the entire task directory. The image task requires a model with explicit image input support.

Original tests are uploaded and run after execution finishes; the Agent does not receive tests or reference solutions during its attempt. The verifier preserves the original assertions and pytest arguments, moving installation steps from `test.sh` into environment preparation. `cancel-async-tasks` also retains the original test helper copy step.

When the model explicitly fails, the runner ends the attempt promptly and records an execution failure. Original grading runs separately only after processes stop and execution records close completely. Per-task verifierPackages are installed after the attempt, making those private dependencies unavailable while the Agent works.

The verifier can read task-installed Python dependencies, with pinned verifier packages taking priority. FEAL builds in a private verifier copy of the tests; Headless uses a private temporary root for its required paths. pytest caches go to writable logs. Displayed warnings are summarized; full output remains in `evidence/logs/verifier/output.txt`.

Explicitly public self-check helpers may have a separate read-only mount without exposing hidden tests. Path-tracing graders use a sealed workspace copy with `/app` and `/tmp` on one isolated mount. Chroot capability exists only inside the grader user namespace; system paths stay read-only. Startup checks pip entry points and required commands, and saves initializer output to `initializer.txt`. Terminal capture and web polling use approximately one-second intervals.

- `passed` / `failed`: the pytest exit code agrees with the current CTRF report, producing a valid score.
- Verifier timeout, startup failure, missing tests, or inconsistent reports: an infrastructure error with no valid score, not a fabricated zero.
- An execution timeout stops the Agent before grading; user cancellation skips grading. Execution and grading states are recorded separately.

```text
Host <data-dir>/
  config.json
  batches/<batch-id>.json
  runs/<run-id>/
    state.json / manifest.json
    task/ / task-files.json    Original task snapshot and hashes
    live/events.jsonl          Execution events
    live/screen.txt            Latest TUI screen
    preparation.log           Environment and execution diagnostics
    verification.txt          Test output summary (full output: evidence/logs/verifier/output.txt)
    evidence/                 Code, home directory, and logs
    collection.json           Export checksums
    evidence/outcome.json     Execution/grading facts before cleanup
    evidence/result.json      Final receipt after confirmed cleanup

Per-attempt container: /eval/runs/<run-id>/
Linux source releases and dependencies: /opt/hicode/
```

Events and screens stream back continuously and are persisted incrementally. Full evidence is exported at completion, outside the live event loop, so collection cannot block verifier handoff. Abrupt machine shutdown can lose evidence not yet exported; retain the affected container for inspection. Logs may contain source code, prompts, and tool output. Redact them before sharing.

Verifier handoff uses a dedicated request and atomic, run-scoped receipts: accepted, ready, or failed. The host acknowledges before uploading hidden tests. Acknowledgement has a 30-second deadline and the entire handoff has a 180-second deadline; cancellation ends the wait. Hidden tests are uploaded only after assignment processes have stopped.

Evidence records symlink targets without following them. Final export remains required before completion. Confirmed execution and grading facts survive an export failure, but no reward is published. The execution and grading panel shows failure summaries and collection diagnostics.

Closing the browser or stopping the `serve` dashboard does not stop tasks. Ctrl+C in the `worker` terminal cancels active tasks. After the service exits, use `docker --context colima-hicode stop hicode-eval-clean` to stop the preparation container; attempts use separate containers. Restarting the worker does not resume or rerun attempted tasks. Unstarted tasks without execution evidence remain queued; other unfinished evidence blocks scheduling until inspected. After recovery, use `bash hicode-eval/eval.sh resume --batch BATCH_ID` to explicitly continue queued scheduling. This command does not clear errors or rerun completed tasks.

Cancel a batch with `bash hicode-eval/eval.sh cancel --batch BATCH_ID`. After completion, optionally ask Codex to inspect the logs. `report --batch BATCH_ID --file report.md` stores an external analysis only; it does not call a model or change grading.

If cleanup or collection leaves a task in `needs_recovery`, keep the service running and execute:

```bash
bash hicode-eval/eval.sh recover --run RUN_ID
```

Recovery checks task identity, runner termination, completion events, and grading evidence. It cleans up only that task's remaining processes, exports evidence again, and reconciles the original record without invoking the model, rerunning the verifier, or stopping other tasks. Missing or inconsistent evidence blocks recovery and preserves the scene. Repeated calls do not repeat the attempt; successful recovery resumes existing queued work. The prior state is saved as `state.before-recovery.json`, and the evidence receipt as `evidence/recovery.json`. The first Docker handoff acknowledgement allows up to 25 seconds, and host command timeouts report their actual deadline. After a Docker handoff or similar execution error, the service briefly waits for the original runner to persist its outcome. A verified outcome is reconciled automatically so queued work resumes; missing or inconsistent evidence remains in `needs_recovery` for inspection.

The viewer fits the window, with separate scrolling for the task list and terminal history. Resizing changes visible terminal rows without replaying output.

## Extending and validating

Others can reuse the CLI, TUI monitoring, automated grading, and evidence collection workflow. The runner currently targets HiCode; supporting another agent requires an execution adapter and completion events.

Before adding a task, review its initialization, dependencies, paths, and verifier, implement the adapter and offline tests, then register full file hashes. Do not merely add a task ID or remove original tests to obtain a passing result.

Each attempt has a separate container, network, home directory, and `/app` mount. This is a trusted local development environment, not a hosted isolation service for untrusted users. An adapter may declare pinned Python packages, which preparation installs in the image and the runner copies into that task’s `/app/.eval-python`; adding dependencies changes the task environment, so diagnostic scores must be kept separate from the upstream environment. Tasks requiring system configuration changes, global package installation, or special hardware are not currently supported.

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

The Python runner helpers use only the standard library; verifier dependencies live in the evaluation image. `web/vendor/` includes xterm.js under the MIT license; retain its license file. Keep run data, payloads, datasets, and credentials outside the repository and out of Git.

Evaluation assignments use `full-access` inside their own UID and outer read-only mount namespace, allowing workspace Git writes without interactive approvals. This does not change normal HiCode permissions. Control files are read-only, and assignment processes stop before original tests are uploaded and executed. The outer boundary continues to protect system paths and other assignments.

Terminal packages are preinstalled in separate `/opt/hicode-terminal/actor` and `verifier` image directories and copied into each attempt. There is no shared wheel installer or runtime download fallback.

Prompt pasting and Enter are sent separately. Execution and the agent budget begin only after `model_stream_start`; a submission with no acknowledgment within 15 seconds fails as a startup error instead of idling through the task budget.

At the evaluation deadline, the runner sends SIGTERM to the identified HiCode CLI and allows up to 10 seconds for cancellation and persistence while draining events, then force-cleans remaining processes for that task UID. This window is for teardown, not continued solving: execution remains timeout even if grading passes. `evidence/shutdown.json` records CLI exit, saved-turn status, and pending tool calls; missing events are never fabricated.

## Additional public datasets

Terminal-Bench 2.0, the reviewed Terminal-Bench 2.1 tasks, and SWE-bench Verified share scheduling, task budgets, the TUI, cancellation and evidence collection. Dataset-specific handlers prepare inputs and grade outputs. `Run.dataset` and the task ID jointly identify a task; a submission with a reused ID must specify its dataset. The separate 2.1 manifest defines its supported tasks. Review each new task's original Dockerfile, public inputs and verifier dependencies even when 2.0 has a task with the same ID.

Register Terminal tasks from the pinned upstream checkout. SWE input is an externally reviewed frozen bundle, validated by `src/host/sweTasks.ts`. This evaluator does not download raw SWE datasets or generate bundles. Supply the original baseline, public problem, host-only grading material, source-version receipts and file hashes before registration.

```bash
bash hicode-eval/eval.sh register-tasks --catalog CATALOG --swe-tasks PREPARED_SWE_DIR
bash hicode-eval/eval.sh register-tasks --catalog CATALOG --tasks REVIEWED_TASKS --dataset terminal-bench-2.1
bash hicode-eval/eval.sh prepare-environments --catalog CATALOG --environments ENVIRONMENTS --ids terminal-bench-2.1:regex-log
```

`REVIEWED_TASKS` is the reviewed external frozen bundle directory, not the downloaded raw dataset.

Dependencies come only from reviewed recipes and optional task preparation layers. SWE combinations require reviewed recipes; add and validate new combinations incrementally. A registered bundle or historical passing score does not imply a prepared image.

The Actor receives only the public problem, original base code and public repository tests, with an independent writable Python environment at `/testbed`. Gold patches, hints, hidden test patches and scoring test lists are withheld. After completion/timeout, stop every Actor process, then export the actual tree against a protected prepared baseline using host-owned Git. This includes additions, deletions, binaries and executable modes without trusting Actor-controlled Git state or self-reported patches.

Save the official prediction fields in `prediction.json` and identity/hash receipts in `patch-manifest.json`. Replay that patch against clean code, dependencies and Home; only then expose hidden test material. Use upstream harness 4.1.0 repository-specific commands, log parsing and both FAIL_TO_PASS/PASS_TO_PASS rules. Keep `logs/verifier/output.txt` and `report.json`; no synthetic CTRF reports are produced. Incomplete grading is `unavailable`; genuine test failures are `failed`. Recovery validates existing evidence without rerunning anything.

This is **isolated-container development evaluation**, using venv instead of upstream Conda/instance images and recreating a Git baseline from the source archive. Environment activation and test-file reset commits are adapted accordingly; tests, assertions and grading rules stay upstream. These results are not official image/leaderboard reproductions. Bundle validation and available recipes determine support. Prepare and validate the selected images before running tasks.


### Task isolation and environment readiness

The Actor has a private filesystem root with explicit system/runtime mounts. Its event export is `actor-events/events.jsonl`; terminal capture and grading logs stay outside its view. The submitted prompt reports the exact resolved per-task time limit and actual public test paths, and claims no internet only for isolated runs.

HiCode `shutdown` is accepted as a saved cancellation reason while execution timeouts remain timeouts; event pairing, persistence and CLI exit checks still apply.

Xarray dependencies and compiler settings are declared in the recipe. Frozen bundles must contain genuine source-version and public-regression receipts, checked at registration; those input receipts do not prove a new image is valid. Actor and verifier environments are materialized separately. Only two verified non-strict ARM datetime XPASS results get faithful PASSED reporting; other XPASS and skipped results are unchanged.

### Recheck grading of an existing SWE prediction

For a fully collected, finished SWE run on the dedicated evaluation machine:

```bash
bun hicode-eval/src/cli.ts regrade --data-dir ../hicode-eval-data/runs --run RUN_ID
```

This verifies the archived model patch and frozen task identity, then runs the original verifier in a separate grading copy. It neither submits an Agent task nor calls a model. Results and test-validity evidence are stored under `runs/RUN_ID/rechecks/REVIEW_ID/`; the first score and logs remain intact. Missing or unexecuted original target tests produce `unavailable`, with details in `logs/verifier/validity.json`.


## Durable results and cleanup

The external `catalog.json` preserves passed/unpassed/untested results across run cleanup; running status is derived from live attempts. Results, evidence and catalog writes finish before container/network deletion. Collection failures retain the container for `recover`, without another model call.

`archive-runs --catalog FILE --data-dir DIR` previews finished batches; `--apply` preserves compact result/patch/grading evidence and hashes beside the catalog in `run-archive/`, then removes old workspaces and large logs. An interrupted cleanup can resume with the same command. Active or unresolved runs, input bundles and environment images are not removed.

Run a no-cost full-chain Docker smoke with `bun hicode-eval/tests/containerSmoke.ts --catalog FILE --environments DIR --payload DIR --task SWE_TASK_ID`. It uses a local fake model and an independent temporary catalog. Expected outcome: completed execution, failed grading (no repair), complete evidence, and removed container. Add `--cancel` to verify cancellation.


## Rerun one task

Click “重新运行” on a finished attempt, or use `bash hicode-eval/eval.sh retry --run RUN_ID`. This creates a linked single-task batch with a fresh container, keeping the original score and frozen task/model/payload/network/budget. Duplicate requests reuse the same child attempt, including after restart; rerun that child to create attempt 3.

Running attempts cannot be rerun. Retained evidence must be recovered first; recovery does not call the model, while rerun does. A changed service model or payload is rejected. `containerSmoke.ts --retry` validates the chain using a local fake model only.


## Create the preparation container

After prepare-environments has built the base, create a container from its immutable image ID. It has no mounts or imported evaluation volume. Set HE_ENVIRONMENTS to the same receipt directory used by the service.

```bash
HE_BASE_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageId"])' "$HE_ENVIRONMENTS/base.json")
docker --context colima-hicode create --name hicode-eval-clean --init --user root \
  --memory 2g --cpus 1 --pids-limit 1024 \
  --security-opt seccomp=unconfined --security-opt apparmor=hicode-development \
  --security-opt systempaths=unconfined \
  --label dev.hicode.role=eval --label dev.hicode.foundation=clean-v2 \
  "$HE_BASE_IMAGE" sleep infinity
docker --context colima-hicode start hicode-eval-clean
```

Check any existing container with the same name before creating one. Stop the service before switching the preparation container.

## DeepSWE 1.1 / AMD64

Register reviewed frozen tasks with `register-tasks --tasks DIR --dataset deep-swe --catalog FILE --ids deep-swe:ID,...`. The original contract collects committed `BASE..HEAD` changes only and runs the unchanged verifier in a pristine workspace with a new home. Both phases have no internet access; reference solutions and hidden checks are withheld from the Actor. Original limits are 10800 seconds for the agent, 1800 for verification, and 2 CPUs / 8192 MiB.

Both `worker` and `prepare-environments` accept `--dataset-backends FILE`, for example `{ "deep-swe": { "context": "YOUR_AMD64_CONTEXT", "cpus": 2, "memoryMb": 8192 } }`. One catalog and scheduler remain in use; deployment, cancellation, recovery and cleanup route to the task's engine. ARM hosts need a validated x86-64 Linux kernel environment; starting an emulated image alone is insufficient. Enable the same AppArmor policy and size concurrency to VM memory. Preparation optionally accepts `--build-proxy URL`, using Docker build proxy arguments only; the proxy is not persisted in image ENV or exposed to the Actor.

`tests/deepEnvironmentSmoke.ts` validates the prepared workspace and nested sandbox without model charges. `--runner` additionally uses a localhost fake provider and the original verifier; its baseline result is not a real task score.

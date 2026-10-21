# Codex app-server agent

Use `--agent codex-app-server` for AutoIllustrate's coding-agent tasks over a
local `codex app-server` stdio connection. Existing `--agent codex` still uses
Headless. No new npm dependency is required. This provider does not attach to
the Codex desktop app or expose a remote service.

## Setup and first run

Install the normal AutoIllustrate prerequisites (Node >= 22, Python, drawio),
then install a Codex CLI that implements the app-server v2 thread/turn protocol.
Configure its authentication before an unattended run:

```sh
codex --version
codex app-server --help
codex login
codex login status
npm run build
```

Existing Codex configuration and authentication, including `CODEX_HOME`, are
inherited. A supported custom model-provider/API-key configuration remains
Codex's responsibility. The adapter does not implement OAuth, extract tokens,
or turn a ChatGPT session into an API key.

A complete run needs no `OPENAI_API_KEY`: with this agent, the image restyle,
the vision audits and the unit tests also default to the ChatGPT subscription
through the run's [Codex broker](#codex-broker-audits-unit-tests-and-enhance).
The audits can also run keyless by hand or under other agents; see
[Without a pipeline run, and with other agents](#without-a-pipeline-run-and-with-other-agents).

```sh
node dist/cli.js /path/to/paper.tex \
  --prompt "Create an editable diagram of the method." \
  --agent codex-app-server --mode light
```

`--model <model-id>` overrides the thread model. `--effort low|medium|high|xhigh`
overrides turn reasoning effort, subject to the selected model's capabilities.
Omitting these flags uses Codex's configured defaults. Explicitly selecting
this provider does not inherit the preset's Claude-specific effort; the mode
still supplies correction-loop budgets.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOILLUSTRATE_CODEX_BIN` | `codex` | One executable path or PATH name, not shell arguments. |
| `AUTOILLUSTRATE_CODEX_RPC_TIMEOUT` | `30` | Seconds to await each `initialize`, `thread/start`, or `turn/start` response. |
| `AUTOILLUSTRATE_CODEX_NETWORK_ACCESS` | `1` | `0` requests disabled tool network access in the turn sandbox; `1` enables it. Broker-backed audits need `1`. |
| `AUTOILLUSTRATE_CODEX_VISION_MODEL` | Codex config | Model for the broker's audit/unit-test turns. |
| `AGENT_INVOKE_TIMEOUT` | `7200` | Overall sub-agent deadline, including startup. |

Timeouts must be positive, finite and within Node's timer range. RPC deadlines
are independent of the overall deadline and are not reset by notifications.
Export these settings; the existing `.env` loader only loads API credentials.
The network default preserves the original provider's behavior for tools that
call separate image/audit APIs, and lets the agent's scripts reach the loopback
broker. Preflight rejects `0` when sub-agents would need the broker.

Executable paths containing spaces are supported:

```sh
export AUTOILLUSTRATE_CODEX_BIN="/opt/codex tools/codex"
"$AUTOILLUSTRATE_CODEX_BIN" login status
node dist/cli.js doctor --agent codex-app-server
```

Doctor and runtime use the same executable resolver, resolving relative paths
before the child changes its working directory. An invalid override does not
fall back to another Codex installation. Doctor performs a bounded, five-second
`app-server --help` probe, not merely a PATH check. This proves neither account
authentication nor model access; the runtime handshake remains authoritative.

Doctor skips Headless and `OPENAI_API_KEY` for this provider, whose default
backends need no API key. Scoped pipeline preflight gates only the requested
backends; for broker backends it probes the app-server executable and checks
its `codex login status`.
`credentials` continues to check the default `codex` executable; use the custom
binary's `login status` directly when an override is configured.

## Pipeline integration and boundaries

The provider is selected at the shared `agentInvoke` boundary. Planning,
panel generation, inspection/refinement, composition corrections and verification
agent tasks retain their existing prompt files, run directories, environment,
artifact contracts, retry behavior and integer return codes. Transport ownership
lives in `codex-app-server-agent.ts`; the legacy Headless execution path is
unchanged. Parallel calls have independent processes, threads, logs and usage.
Do not share one log path between concurrent invocations.

`--enhance-model`, `--audit-vlm` and `--unit-test-vlm` stay independently
selectable. This agent only changes their defaults to `codex-app-server`,
`codex-app-server` and `auto`; an explicit flag or an exported `AUDIT_VLM` /
`UNIT_TEST_VLM` wins, and any agent may opt into the broker backends. The
custom executable override applies to the broker but does not retarget
`--enhance-model codex`, `--unit-test-vlm codex`, or legacy `--agent codex`.

## Codex broker (audits, unit tests and enhance)

The audits and the Phase 6 repair re-enhances run as Python scripts *inside*
the agent's workspace-write sandbox, where a nested `codex exec` cannot start
and where OAuth credentials must not be exposed. draw.io (Electron) also aborts
there (SIGABRT under Seatbelt on macOS). The orchestrator therefore starts a
broker for any run that selects a `codex-app-server` backend, and for every
`--agent codex-app-server` run (`src/codex-broker.ts`):

- It owns lazily started `codex app-server` stdio children outside the sandbox,
  one for vision and one for image generation, using your existing Codex login.
- It serves narrow operations on a `127.0.0.1` HTTP port guarded by a random
  capability token: a vision turn (ordered text/image input, optional JSON
  output schema), an image-generation turn, and — for a `codex-app-server`
  agent only — a draw.io export. `autoillustrate export` inside that agent
  (`AUTOILLUSTRATE_CODEX_BROKER` names the descriptor) delegates to it; the
  orchestrator runs the usual hardened exporter, accepting only an existing
  `.drawio` input and a `.png` output that resolve, after symlinks, inside the
  run workdir. The URL and token are in `<workdir>/.codex-broker.json` (mode
  0600, written exclusively), removed when the run ends or the process exits.
- Each request is a fresh ephemeral thread with `approvalPolicy: "never"`, a
  read-only no-network turn sandbox and an empty private working directory
  under `~/.cache/autoillustrate/codex-broker/` (outside the temp roots the
  agent can write). The children start with shell, unified exec, apps,
  plugins, browser, computer use, memories, multi-agent, hooks and MCP servers
  disabled, web search off and `tools.view_image=false`; the vision child also
  disables image generation and the code-mode host. Image generation needs the
  code-mode host, so the image child keeps it. Only feature names the binary
  reports in `codex features list` are passed (Codex exits on unknown names).
  In live checks both profiles refused to read files or view host images when
  prompted to. The token grants these operations only, never a general
  app-server connection. The children still use your `CODEX_HOME`
  configuration (model, provider, global instructions).
- Requests are bounded: 64 admitted at once (before the body is read), 64 MiB
  bodies, turn input within one 16 MiB app-server frame (else 413), 8
  concurrent turns, 4 concurrent exports, `AUTOILLUSTRATE_CODEX_RPC_TIMEOUT`
  for `initialize`, and one 15-minute deadline covering `thread/start`,
  `turn/start` and the turn (it sends `turn/interrupt`; a child that never
  answers is replaced). A client that disconnects interrupts its turn.
  Approval or input requests fail the request; nothing is approved.

`scripts/_codex_broker.py` is the standard-library client. Audits use strict
output schemas matching their validators and record usage to
`metrics/api_usage.jsonl` with `basis: "subscription"` (tokens shown, no
dollar cost). The broker is unrelated to any app-server you may already run
(for example `codex app-server --listen ws://…`); it never connects to one.

### Without a pipeline run, and with other agents

Run by hand, the scripts find no run broker (neither
`<workdir>/.codex-broker.json` nor `$AUTOILLUSTRATE_CODEX_BROKER`), so
`scripts/_codex_broker.py` starts a private one: `node dist/cli.js broker
--workdir <dir> --broker-descriptor <private temp file>`. It serves the
vision/image routes (no export) until the script exits, which closes its
stdin. Its descriptor stays outside the workdir, so concurrent scripts never
share one:

```sh
python scripts/inspect_panel.py --workdir runs/<run> --panel-id <panel> --audit-vlm codex-app-server
python scripts/verify.py --workdir runs/<run> --audit-vlm codex-app-server --unit-test-vlm auto \
    --reference runs/<run>/figures/full_figure.png --candidate runs/<run>/figures/full_figure_enhanced.png
```

With another agent (for example the default `claude`), a run that makes no
audit choice and finds no `OPENAI_API_KEY` uses `codex-app-server` for the
vision audits when the app-server executable is available, and says so in the
log. An explicit `--audit-vlm`, `--unit-test-vlm`, `AUDIT_VLM` or
`UNIT_TEST_VLM` always wins, and the restyle model is never switched.

Resume uses existing pipeline artifacts and a fresh Codex thread, not a resumed
Codex conversation. The agent transport has no connection pool, shared desktop
session or WebSocket transport; the only listener is the loopback broker above,
started for broker backends and for every `codex-app-server` agent run. `--tmux` is rejected for this
provider. POSIX process groups are required; native Windows is rejected with a
WSL recommendation.

## Protocol and lifecycle

Each invocation performs `initialize`, `initialized`, `thread/start` with an
ephemeral thread, and `turn/start` with the full prompt as text. Success requires
a matching `turn/completed` with status `completed`; a start acknowledgement or
process exit zero is insufficient. Failed/interrupted turns, non-retryable error
notifications, invalid protocol, premature EOF and requests for interactive
approval/input fail the invocation. Retryable errors do not end a live turn.
Thread and turn IDs gate lifecycle and usage events, including events arriving
before the `turn/start` response.

UTF-8 is decoded strictly. JSON lines and serialized prompts are capped at
16 MiB, with bounded input buffers and outbound write queues. Writes respect
back-pressure. A package-derived version identifies the client.

Timeout and programmatic `AbortSignal` cancellation send `turn/interrupt` when
a turn ID is available, then preserve return code 124 or 130 even if the server
later exits zero. Programmatic cancellation is exposed by the dedicated adapter;
CLI SIGINT/SIGTERM handling still uses AutoIllustrate's existing process registry.
Ordinary protocol failures return 1 and successful turns return 0. The surrounding
pipeline may map an adapter failure to its own phase/run exit status.

After a terminal result, queued writes are flushed before stdin closes. Stdout
continues draining so final usage after completion is retained. Shutdown sends
process-group TERM after one second, KILL after six, and closes inherited pipes
after 6.5 seconds if necessary. The group remains registered until cleanup.
This bounds ordinary client shutdown, including pipe-holding descendants and
blocked debug sinks; it cannot guarantee termination of uninterruptible OS I/O
or processes that deliberately leave the process group. Escaped descendants
require OS/container supervision. Success is not changed by cleanup signals.

## Permissions and data handling

Threads request `sandbox: "workspace-write"` and `approvalPolicy: "never"`.
Turns request `sandboxPolicy.type: "workspaceWrite"`, with the canonical run
directory as a writable root. Temporary-directory access is retained for render
tools. Explicitly conflicting effective thread cwd/approval/sandbox responses
are rejected; older responses omitting those fields remain accepted.

The adapter never automatically grants escalation or extra permissions.
Command/file approvals are declined; permission requests receive an empty grant;
MCP elicitation is declined; user-input requests receive no answers. Unsupported
server requests receive a method-not-found error, then the invocation fails.
Authentication and interactive configuration must be resolved before the run.
No unrestricted-execution fallback is attempted.

Workspace-write is not read isolation. Setting the network flag to `0` requests
a turn sandbox restriction, not a firewall around the app-server, its model
traffic or configured services. The child inherits the run environment and
Codex configuration. For untrusted documents, use a separate account/container,
least-privilege environment and mounted inputs. Do not test with sensitive data.

Raw server stdout/stderr remain in the regular agent log. New log and telemetry
files are created with mode 0600; existing files retain their permissions.
Logs may contain source text and model/tool output and need the same protection
as the inputs. They are not a tamper-resistant audit trail.

## Accounting

The `.stdout` sidecar contains only adapter-normalized result and usage records,
not the raw trace. It is atomically published after the main log closes, matching
the existing metrics reader's freshness checks. The main log also ends with the
normalized records, preserving the legacy fallback.

Counts use the latest valid cumulative snapshot, not a sum of repeated updates
or the last inference alone. Cached inputs are separated from uncached inputs;
malformed snapshots do not erase earlier valid counts. The shared phase collector
labels this route `native:codex-app-server`. Legacy source names are unchanged.
Missing usage and dollar pricing remain unknown, not zero. Subscription charges
are not inferred from API price tables. Terminal totals retain AutoIllustrate's
existing output-token convention.

## Tests and troubleshooting

The focused tests use a local fake JSON-RPC process, not a model or account:

```sh
node --import tsx --test tests/codex-app-server*.test.ts tests/codex-broker*.test.ts tests/codex_broker_py.test.ts
npm run check
```

The broker and Python tests bind loopback ports; run them where that is allowed.

Inspect `<workdir>/logs/` or use `--debug` for the raw trace. Authentication/model
errors come from Codex; unsupported methods/fields indicate a protocol mismatch.
Generate schemas from the installed executable to compare its API rather than
loosening sandbox policy:

```sh
codex app-server generate-ts --out ./codex-schema
codex app-server generate-json-schema --out ./codex-json-schema
```

Protocol references:
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [ThreadStartParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts)
- [TurnStartParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts)

Passing mock tests establishes adapter behavior, not live compatibility with
every Codex release, model, account, sandbox or local configuration.

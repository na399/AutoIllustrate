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

Start with the separate image-restyle and vision-audit phases disabled:

```sh
node dist/cli.js /path/to/paper.tex \
  --prompt "Create an editable diagram of the method." \
  --agent codex-app-server --mode light --skip-enhance
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
| `AUTOILLUSTRATE_CODEX_NETWORK_ACCESS` | `1` | `0` requests disabled tool network access in the turn sandbox; `1` enables it. |
| `AGENT_INVOKE_TIMEOUT` | `7200` | Overall sub-agent deadline, including startup. |

Timeouts must be positive, finite and within Node's timer range. RPC deadlines
are independent of the overall deadline and are not reset by notifications.
Export these settings; the existing `.env` loader only loads API credentials.
The network default preserves the original provider's behavior for tools that
call separate image/audit APIs.

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

Doctor skips Headless for this provider. Its other checks remain an inventory,
so it can still report missing API keys that an agent-only run does not need.
Scoped pipeline preflight continues to gate only the requested backends.
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

`--enhance-model`, `--audit-vlm` and `--unit-test-vlm` remain independent.
Selecting this coding agent does not reroute Python image/VLM API calls through
app-server or remove their credential requirements. In particular, the custom
executable override does not retarget `--enhance-model codex`,
`--unit-test-vlm codex`, or legacy `--agent codex`.

Resume uses existing pipeline artifacts and a fresh Codex thread, not a resumed
Codex conversation. There is no connection pool, shared desktop session,
WebSocket transport or new network listener. `--tmux` is rejected for this
provider. POSIX process groups are required; native Windows is rejected with a
WSL recommendation. macOS has not been live-tested for this integration.

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
node --import tsx --test tests/codex-app-server*.test.ts
npm run check
```

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

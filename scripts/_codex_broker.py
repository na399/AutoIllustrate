"""Client for the orchestrator's Codex broker (src/codex-broker.ts).

The `codex-app-server` backends of inspect_panel.py, verify.py and enhance.py
call this instead of an API SDK. The orchestrator runs ChatGPT-authenticated
`codex app-server` children outside the coding agent's sandbox and publishes a
loopback endpoint plus a capability token in ``<workdir>/.codex-broker.json``;
no API key or OAuth credential ever reaches these scripts. Run by hand, with
no pipeline broker around, a script starts a private broker
(``node dist/cli.js broker``) for its own lifetime instead. Standard library
only, so it works in every interpreter the pipeline may use.
"""
from __future__ import annotations

import atexit
import base64
import http.client
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Union

from _usage import record_usage  # type: ignore

BROKER_FILE = ".codex-broker.json"
VISION_SOURCE = "codex-app-server-vision"
IMAGE_SOURCE = "codex-app-server-image"
# The broker enforces its own per-turn deadline (15 min) once a request holds a
# turn slot; this socket bound also covers time queued behind other turns.
DEFAULT_TIMEOUT_SECS = 60 * 60

STANDALONE_START_SECS = 30
_TOOLKIT_CLI = Path(__file__).resolve().parent.parent / "dist" / "cli.js"
_standalone: Optional[tuple[subprocess.Popen, Path]] = None

# Loopback only: never route broker traffic (or its token) through a proxy.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

Part = Union[str, bytes]


class CodexBrokerError(RuntimeError):
    """The broker is unavailable or the Codex turn failed."""


def _read_descriptor(path: Path) -> tuple[str, str]:
    descriptor = json.loads(path.read_text())
    return str(descriptor["url"]), str(descriptor["token"])


def _stop_standalone() -> None:
    global _standalone
    if _standalone is None:
        return
    proc, private_dir = _standalone
    _standalone = None
    try:
        if proc.stdin:
            proc.stdin.close()  # EOF tells the broker to shut down cleanly
        proc.wait(timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        proc.kill()
    shutil.rmtree(private_dir, ignore_errors=True)


def _start_standalone(workdir: Union[str, Path]) -> Path:
    """Start a private broker for this process; return its descriptor path."""
    global _standalone
    node = shutil.which("node")
    if node is None or not _TOOLKIT_CLI.exists():
        raise CodexBrokerError(
            f"no Codex broker is running and a private one cannot start "
            f"(need `node` on PATH and the built {_TOOLKIT_CLI}; run "
            "`npm run build`). Inside a pipeline run, use --agent "
            "codex-app-server or a codex-app-server --audit-vlm/--enhance-model.")
    # Outside the workdir, so concurrent scripts there never share or clobber it.
    private_dir = Path(tempfile.mkdtemp(prefix="autoillustrate-broker-"))
    descriptor = private_dir / "broker.json"
    proc = subprocess.Popen(
        [node, str(_TOOLKIT_CLI), "broker", "--workdir", str(Path(workdir).resolve()),
         "--broker-descriptor", str(descriptor)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _standalone = (proc, private_dir)
    atexit.register(_stop_standalone)
    deadline = time.monotonic() + STANDALONE_START_SECS
    # The broker prints "ready <descriptor>" once it is serving.
    while time.monotonic() < deadline:
        line = proc.stdout.readline() if proc.stdout else ""
        if line.startswith("ready "):
            return descriptor
        if not line and proc.poll() is not None:
            break
    err = (proc.stderr.read() if proc.stderr and proc.poll() is not None else "")[-800:]
    _stop_standalone()
    raise CodexBrokerError(f"private Codex broker did not start: {err.strip() or 'timed out'}")


def _endpoint(workdir: Union[str, Path]) -> tuple[str, str]:
    """The run's broker (<workdir>/.codex-broker.json, or the descriptor the
    pipeline names in $AUTOILLUSTRATE_CODEX_BROKER), else a private one."""
    candidates = [Path(workdir) / BROKER_FILE]
    if os.environ.get("AUTOILLUSTRATE_CODEX_BROKER"):
        candidates.append(Path(os.environ["AUTOILLUSTRATE_CODEX_BROKER"]))
    for path in candidates:
        if path.exists():
            try:
                return _read_descriptor(path)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise CodexBrokerError(f"unusable Codex broker descriptor at {path} ({exc})") from exc
    descriptor = _standalone[1] / "broker.json" if _standalone else _start_standalone(workdir)
    return _read_descriptor(descriptor)


def _post(workdir: Union[str, Path], route: str, payload: dict, timeout: float) -> dict:
    url, token = _endpoint(workdir)
    request = urllib.request.Request(
        url + route, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict):
            raise CodexBrokerError(f"Codex broker {route} returned a non-object reply")
        return body
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode("utf-8")).get("error") or exc.reason
        except (ValueError, AttributeError):
            message = exc.reason
        raise CodexBrokerError(f"Codex broker {route} failed (HTTP {exc.code}): {message}") from exc
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
        raise CodexBrokerError(f"Codex broker {route} unreachable at {url}: {exc}") from exc


def _image(data: bytes) -> dict:
    mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    return {"mime": mime, "data": base64.b64encode(data).decode("ascii")}


def _record(workdir, *, phase: int, source: str, body: dict, started: float) -> None:
    usage = body.get("usage") or {}
    uncached, cached = usage.get("inputTokens"), usage.get("cacheReadTokens")
    # Mirror the API backends' prompt_tokens: total input, cached included.
    total_input = None if uncached is None and cached is None else (uncached or 0) + (cached or 0)
    record_usage(workdir, phase=phase, source=source,
                 model=f"{body.get('model') or 'codex default'} (codex app-server)",
                 duration_secs=time.perf_counter() - started,
                 # Billed to the ChatGPT subscription: tokens shown, no dollars.
                 basis="subscription",
                 input_tokens=total_input, output_tokens=usage.get("outputTokens"))


def ask_vision(workdir: Union[str, Path], *, parts: list[Part],
               instructions: Optional[str] = None, schema: Optional[dict] = None,
               effort: Optional[str] = None, phase: int,
               timeout: float = DEFAULT_TIMEOUT_SECS) -> str:
    """One read-only vision turn. ``parts`` interleave text (str) and images
    (PNG/JPEG bytes) in order. Returns the model's final message text."""
    payload: dict = {"input": [
        {"type": "text", "text": part} if isinstance(part, str) else {"type": "image", **_image(part)}
        for part in parts
    ]}
    if instructions:
        payload["instructions"] = instructions
    if schema is not None:
        payload["schema"] = schema
    if effort:
        payload["effort"] = effort
    started = time.perf_counter()
    body = _post(workdir, "/v1/vision", payload, timeout)
    _record(workdir, phase=phase, source=VISION_SOURCE, body=body, started=started)
    return str(body.get("text") or "")


def generate_image(workdir: Union[str, Path], *, prompt: str, image: Optional[bytes],
                   phase: int, timeout: float = DEFAULT_TIMEOUT_SECS) -> bytes:
    """One image-generation turn (optionally editing ``image``). Returns the
    generated image's bytes."""
    payload: dict = {"prompt": prompt}
    if image is not None:
        payload["image"] = _image(image)
    started = time.perf_counter()
    body = _post(workdir, "/v1/image", payload, timeout)
    _record(workdir, phase=phase, source=IMAGE_SOURCE, body=body, started=started)
    try:
        return base64.b64decode(body["png"], validate=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise CodexBrokerError(f"Codex broker returned no decodable image ({exc})") from exc

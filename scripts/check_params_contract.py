#!/usr/bin/env python3
"""Check a panel generator honours the Phase 4 compose contract.

Compose imports the generator and calls `build_params(bypass_warnings=True)`,
then reads `page_w`/`page_h` for layout. A valid `.drawio` proves neither, so
the orchestrator runs this gate after each panel and the panel agent runs it as
a self-test. Exit 0 + `OK:` on success; non-zero + a `CONTRACT:` line (and a
machine-readable `MISSING:page_w,page_h` for omitted keys) on failure.

Usage: check_params_contract.py <generate_PANEL.py>
"""

import importlib.util
import sys
from pathlib import Path


def fail(msg: str) -> None:
    print(f"CONTRACT: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <generate_PANEL.py>", file=sys.stderr)
        return 2
    generator = sys.argv[1]

    spec = importlib.util.spec_from_file_location("panelgen", generator)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["panelgen"] = mod  # let dataclasses resolve string annotations
    spec.loader.exec_module(mod)

    # Mirror compose.py:_get_params exactly.
    if hasattr(mod, "build_params"):
        try:
            params = mod.build_params(bypass_warnings=True)
        except TypeError as exc:
            if "bypass_warnings" in str(exc):
                fail("build_params() must accept `bypass_warnings` — keep the template "
                     "signature: def build_params(bypass_warnings: bool = False) -> dict")
            raise
    elif hasattr(mod, "params"):
        params = mod.params
    else:
        fail(f"{generator} exposes neither build_params() nor module-level params")

    missing = [k for k in ("page_w", "page_h") if k not in params]
    if missing:
        print("MISSING:" + ",".join(missing), file=sys.stderr)
        fail(f"build_params() omits {' / '.join(missing)} — compose needs them for layout")

    check_render(generator, mod, params)
    print(f"OK: build_params() returns page_w={params['page_w']} page_h={params['page_h']}")
    return 0


def check_render(generator: str, mod, params: dict) -> None:
    """Fill `<panel_id>.drawio.template` (beside the generator) with `params`
    and require the result to draw exactly the validated Rects / EdgePaths
    (`panel_geometry.check_rendered`; skipped for generators without
    build_elements / build_paths) and every label to fit its box
    (`panel_text.check_text_fit`; its warnings are printed, not fatal, as
    compose runs with bypass_warnings=True). Skipped without a template."""
    gen = Path(generator).resolve()
    template = gen.with_name(gen.stem.removeprefix("generate_") + ".drawio.template")
    if not template.exists():
        return
    sys.path.insert(0, str(gen.parent))
    try:
        xml = template.read_text().format(**params)
    except (KeyError, IndexError, ValueError) as exc:
        fail(f"{template.name} cannot be filled from build_params(): {exc!r}")
    try:
        from panel_geometry import check_rendered
    except ImportError:
        check_rendered = None  # a workdir staged before the render check existed
    if check_rendered is not None and hasattr(mod, "build_elements") and hasattr(mod, "build_paths"):
        containers = mod.build_containers() if hasattr(mod, "build_containers") else []
        errors = check_rendered(xml, mod.build_elements(), mod.build_paths(), containers)
        if errors:
            for e in errors:
                print(f"RENDER: {e}", file=sys.stderr)
            fail(f"the rendered {template.name} diverges from the validated geometry "
                 f"(see RENDER: lines); make the template's slots match build_elements() / "
                 f"build_paths() exactly")
    try:
        from panel_text import check_text_fit
    except ImportError:
        return  # a workdir staged before the text-fit check existed
    errors, warnings = check_text_fit(xml)
    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    if errors:
        for e in errors:
            print(f"TEXT: {e}", file=sys.stderr)
        fail(f"labels in the rendered {template.name} overflow their boxes (see TEXT: "
             f"lines); size those Rects with panel_text.label_size or shorten the text")

if __name__ == "__main__":
    raise SystemExit(main())

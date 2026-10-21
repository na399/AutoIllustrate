// Shared run context threaded through the phase modules — replaces the env
// var plumbing (WORKDIR, TOOLKIT_DIR, PLACEMENT, AGENT, ...) between run.sh
// and the phase scripts.

import type { AgentConfig } from "./agent.js";

// Keep in sync with MODEL_REGISTRY / resolve_model in scripts/enhance.py,
// the usage text, and docs/cli.md. Any model id is accepted: the aliases below
// map to their backends, a `gemini*` id goes to the Gemini API, and every
// other id is passed through to the OpenAI Images API.
export const DEFAULT_ENHANCE_MODEL = "gpt-image-2.5-sunburst";
// --enhance-quality: passed through to enhance.py --quality unvalidated —
// the accepted vocabulary is the image model's (gpt-image-2.5 takes
// low|medium|high|xhigh|max|auto, gpt-image-2 has no xhigh/max, the
// nanobanana models take the same ladder or a literal 1K|2K|4K, codex
// ignores it), so the backend is the one to reject a value.
export const DEFAULT_ENHANCE_QUALITY = "high";
export const GEMINI_ENHANCE_MODELS = ["nanobanana", "nanobanana-pro"];
export const CODEX_ENHANCE_MODEL = "codex";
// The ChatGPT-subscription backend served by the orchestrator's Codex broker
// (src/codex-broker.ts). The same id names the enhance model, the audit VLM
// and the unit-test VLM; none of them needs an API key.
export const CODEX_APP_SERVER_BACKEND = "codex-app-server";
export type EnhanceBackend = "openai" | "gemini" | "codex" | "codex-app-server";

// Which credential the Phase 5 preflight gates on: OPENAI_API_KEY,
// GEMINI_API_KEY, a ChatGPT-authenticated codex CLI, or the Codex broker.
export function enhanceBackend(model: string): EnhanceBackend {
  if (model === CODEX_ENHANCE_MODEL) return "codex";
  if (model === CODEX_APP_SERVER_BACKEND) return "codex-app-server";
  if (GEMINI_ENHANCE_MODELS.includes(model) || model.startsWith("gemini")) return "gemini";
  return "openai";
}

// Vision-audit VLM knobs, surfaced as --audit-vlm (the holistic content audit —
// Phase 3 panel inspect AND Phase 6 verify Stage A, one shared knob) and
// --unit-test-vlm (Phase 6 Stage B unit tests) on the orchestrator. The flags
// set $AUDIT_VLM / $UNIT_TEST_VLM, which the sub-agents inherit and
// inspect_panel.py / verify.py read as their defaults. Keep in sync with
// VLM_REGISTRY / UT_BACKEND_CHOICES in scripts/verify.py + inspect_panel.py.
export const AUDIT_VLMS = ["gpt-6-astra", "gpt-5.5", "gemini-3.1-pro", CODEX_APP_SERVER_BACKEND];
export const DEFAULT_AUDIT_VLM = "gpt-6-astra";
export const UNIT_TEST_VLMS = ["auto", "openai", "openai-single", "gemini", "gemini-single", "codex", CODEX_APP_SERVER_BACKEND];
export const DEFAULT_UNIT_TEST_VLM = "openai-single";

// --agent codex-app-server keeps the whole run on the ChatGPT subscription:
// unless overridden, the audits, unit tests and enhance also go through the
// Codex broker, so the run needs no OPENAI_API_KEY. Other agents keep the
// API-backed defaults.
export function agentBackendDefaults(agent: string): { enhanceModel: string; auditVlm: string; unitTestVlm: string } {
  return agent === CODEX_APP_SERVER_BACKEND
    ? { enhanceModel: CODEX_APP_SERVER_BACKEND, auditVlm: CODEX_APP_SERVER_BACKEND, unitTestVlm: "auto" }
    : { enhanceModel: DEFAULT_ENHANCE_MODEL, auditVlm: DEFAULT_AUDIT_VLM, unitTestVlm: DEFAULT_UNIT_TEST_VLM };
}

export type AuditBackend = "openai" | "gemini" | "codex-app-server";
export type UnitTestBackend = AuditBackend | "codex";
export interface ModelBackends {
  enhanceModel: string;
  auditVlm: string;
  unitTestVlm: string;
  enhanceBackend: EnhanceBackend;
  auditBackend: AuditBackend;
  unitTestBackend: UnitTestBackend;
}

// The effective choices — explicit value, else an already-exported env var,
// else the agent default — exactly as inspect_panel.py / verify.py resolve
// them. 'auto' unit tests follow the audit backend (verify.py). Keep the
// mapping in sync with VLM_REGISTRY / UT_BACKEND_CHOICES there.
export function resolveModelBackends(agent: string, env: NodeJS.ProcessEnv, enhanceModel?: string): ModelBackends {
  const defaults = agentBackendDefaults(agent);
  const model = enhanceModel ?? defaults.enhanceModel;
  const auditVlm = env.AUDIT_VLM ?? defaults.auditVlm;
  const unitTestVlm = env.UNIT_TEST_VLM ?? defaults.unitTestVlm;
  const auditBackend: AuditBackend = auditVlm === "gemini-3.1-pro" ? "gemini"
    : auditVlm === CODEX_APP_SERVER_BACKEND ? "codex-app-server" : "openai";
  const unitTestBackend: UnitTestBackend = unitTestVlm === "auto" ? auditBackend
    : unitTestVlm.startsWith("gemini") ? "gemini"
      : unitTestVlm === "codex" || unitTestVlm === CODEX_APP_SERVER_BACKEND ? unitTestVlm
        : "openai";
  return { enhanceModel: model, auditVlm, unitTestVlm, enhanceBackend: enhanceBackend(model), auditBackend, unitTestBackend };
}

export interface ModelNeeds {
  needsOpenai: boolean;
  needsGemini: boolean;
  needsCodexCli: boolean;
  needsCodexBroker: boolean;
  // Some brokered call is made by a sub-agent (Phase 3/6), i.e. from inside
  // the agent's sandbox, rather than by the orchestrator itself (Phase 5).
  codexBrokerFromAgents: boolean;
}

// Credentials/services the phases that actually run will consume. Phase 3
// inspect and Phase 6 Stage A use the audit VLM, Phase 6 Stage B the unit-test
// VLM, Phase 5 and the Phase 6 repair re-enhances the enhance model.
export function modelNeeds(
  b: ModelBackends,
  runs: { runsInspect: boolean; runsVerify: boolean; runsEnhance: boolean },
): ModelNeeds {
  const auditRuns = runs.runsInspect || runs.runsVerify;
  const uses = (backend: string): boolean =>
    (auditRuns && b.auditBackend === backend) || (runs.runsVerify && b.unitTestBackend === backend);
  const fromAgents = uses("codex-app-server") || (runs.runsVerify && b.enhanceBackend === "codex-app-server");
  return {
    needsOpenai: uses("openai") || (runs.runsEnhance && b.enhanceBackend === "openai"),
    needsGemini: uses("gemini") || (runs.runsEnhance && b.enhanceBackend === "gemini"),
    // Only Phase 5 enhance hard-requires the codex CLI: enhance.py aborts if it
    // is absent (no fallback). The codex *unit-test* backend is deliberately NOT
    // required — verify.py falls back to the audit backend when codex is
    // missing, and that fallback's credential is already mandated above.
    needsCodexCli: runs.runsEnhance && b.enhanceBackend === "codex",
    // The broker serves every brokered call, including the in-sandbox
    // Phase 6 repair re-enhances (so --resume-from 6 still needs it).
    needsCodexBroker: fromAgents || (runs.runsEnhance && b.enhanceBackend === "codex-app-server"),
    codexBrokerFromAgents: fromAgents,
  };
}

// Agent-orchestrated correction-loop budgets, substituted into the Phase 3 /
// Phase 6 dispatch prompts (authoritative over the reference docs the sub-agents
// read). Overridable via --panel-inspects / --enhancement-attempts.
// --panel-inspects: 1 inspect + (n-1) repairs; 0 skips Phase 3.
// --enhancement-attempts: n verify attempts + (n-1) repair passes over the
// Phase 5 enhance and its re-enhances; floor 1, where 1 skips Phase 6.
export const DEFAULT_PANEL_INSPECTS = 5; // Phase 3 per-panel inspect/refine
export const DEFAULT_ENHANCEMENT_ATTEMPTS = 3; // 3 verify attempts + 2 repair passes

// What a phase reports back to the orchestrator for its completion line:
// "completed · 4 panels · full-width · 2m 10s". A void return means completed
// with nothing to add; a sentinel skip returns status "skipped".
export interface PhaseResult {
  status: "completed" | "degraded" | "skipped";
  outcome?: string;
}

export interface RunContext {
  workdir: string;
  toolkitDir: string;
  source?: string; // absolute; required when phase 1 runs
  instructions?: string;
  placement: string; // half-width | full-width | infer (pre-phase-1 only)
  enhanceModel: string; // gpt-image-2.5-sunburst | gpt-image-2 | nanobanana | nanobanana-pro | codex | any image model id
  enhanceQuality: string; // model-specific vocabulary, e.g. low | medium | high | xhigh | max | auto
  mode?: string; // light | medium | full — the speed preset that set the budgets below
  agent: AgentConfig;
  panelInspects: number; // Phase 3 inspect/refine budget (default 5; 0 skips Phase 3)
  enhancementAttempts: number; // n verify attempts + (n-1) repair passes (default 3; 1 skips Phase 6)
  force: boolean;
  sequential: boolean;
  python: string; // venv interpreter, absolute
  env: NodeJS.ProcessEnv;
}

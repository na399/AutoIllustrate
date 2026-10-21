// Shared test harness: a real Codex broker in front of the fake multi-thread
// app-server (codex-broker-app-server.mjs), plus helpers to inspect what the
// fake received.
import type { TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_BROKER_FILE, startCodexBroker, type CodexBroker, type CodexBrokerOptions } from "../../src/codex-broker.js";

export type Message = Record<string, any>;

export interface FakeBroker {
  dir: string;
  workdir: string;
  broker: CodexBroker;
  descriptor: { url: string; token: string };
  env: NodeJS.ProcessEnv;
  call: (route: string, body: unknown, token?: string | null) => Promise<Response>;
  records: () => Message[];
}

export async function startFakeBroker(t: TestContext, mode = "ok", extraEnv: NodeJS.ProcessEnv = {},
  options: Partial<CodexBrokerOptions> = {}): Promise<FakeBroker> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate broker "));
  const executable = path.join(dir, "mock codex");
  const fixture = fs.readFileSync(fileURLToPath(new URL("./codex-broker-app-server.mjs", import.meta.url)), "utf8");
  fs.writeFileSync(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const workdir = options.workdir ?? path.join(dir, "run");
  fs.mkdirSync(workdir, { recursive: true });
  const recordFile = path.join(dir, "rpc.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOILLUSTRATE_CODEX_BIN: executable, CODEX_TEST_MODE: mode, CODEX_TEST_RECORD: recordFile, ...extraEnv };
  const broker = await startCodexBroker({ workdir, env, requestTimeoutMs: 5000, ...options });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const descriptor = JSON.parse(fs.readFileSync(path.join(workdir, CODEX_BROKER_FILE), "utf8"));
  const call = (route: string, body: unknown, token: string | null = descriptor.token) =>
    fetch(`${descriptor.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const records = (): Message[] => fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
  return { dir, workdir, broker, descriptor, env, call, records };
}

import { spawn } from "node:child_process";

// Thin wrapper over the locally-installed Claude Code CLI, using STREAMING output
// so callers can show live activity (which files a subagent reads, rate-limit
// backoff) instead of a black-box spinner. Execution stays LOCAL and
// credential-agnostic — an API key is passed via env (ANTHROPIC_API_KEY);
// otherwise the CLI uses the user's own Claude Code subscription login.

export interface RunOpts {
  model: string;
  cwd: string;
  system?: string;
  allowedTools?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Hard cap so a run can never hang for hours. Default 10 min. */
  timeoutMs?: number;
  /** Called with short, human-readable activity lines as the turn streams. */
  onActivity?: (msg: string) => void;
}

function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  if (name === "Read" && i.file_path) return `reading ${String(i.file_path)}`;
  if (name === "Grep" && i.pattern) return `searching "${String(i.pattern)}"`;
  if (name === "Glob" && i.pattern) return `listing ${String(i.pattern)}`;
  return name.toLowerCase();
}

interface Attempt {
  text: string;
  isError: boolean;
  stderr: string;
}

function looksLikeModelError(s: string): boolean {
  return /not_found|404|"?model"?:|model:\s/i.test(s);
}

/** One spawn of `claude -p` (streaming). Resolves with the result text + error flag. */
function attempt(prompt: string, model: string, opts: RunOpts): Promise<Attempt> {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    // Don't load the user's MCP servers — the audit only needs Read/Grep/Glob,
    // and connecting to MCP servers on startup (some slow/hung) can block init
    // for minutes, ×N parallel subagents. This keeps startup instant.
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  ];
  if (model) args.push("--model", model);
  if (opts.allowedTools && opts.allowedTools.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.system) args.push("--append-system-prompt", opts.system);

  return new Promise<Attempt>((resolve, reject) => {
    let child;
    try {
      child = spawn("claude", args, { cwd: opts.cwd, env: opts.env ?? process.env, signal: opts.signal });
    } catch (e) {
      reject(e);
      return;
    }
    const killer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* */ } }, opts.timeoutMs ?? 600_000);

    let result = "";
    let isError = false;
    let out = "";
    let errAll = "";
    let errBuf = "";

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let obj: { type?: string; subtype?: string; result?: string; is_error?: boolean; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } };
      try { obj = JSON.parse(s); } catch { return; }
      if (obj.type === "system" && obj.subtype === "init") {
        opts.onActivity?.("connecting to model…");
      } else if (obj.type === "assistant" && obj.message?.content) {
        for (const item of obj.message.content) {
          if (item.type === "tool_use" && item.name) opts.onActivity?.(describeTool(item.name, item.input));
        }
      } else if (obj.type === "result") {
        if (typeof obj.result === "string") result = obj.result;
        if (obj.is_error) isError = true;
      }
    };

    child.stdout.on("data", (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) { handleLine(out.slice(0, nl)); out = out.slice(nl + 1); }
    });
    // Surface rate-limit / retry backoff (Claude Code prints it to stderr).
    child.stderr.on("data", (d) => {
      const s = d.toString();
      errAll += s;
      errBuf += s;
      let nl;
      while ((nl = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (line && /retry|retrying|rate.?limit|overload|429|usage limit|please wait/i.test(line)) {
          opts.onActivity?.(`⏳ ${line.slice(0, 140)}`);
        }
      }
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(killer);
      reject(e.code === "ENOENT"
        ? new Error("`claude` CLI not found. Install Claude Code and sign in (or set an API key).")
        : e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (out.trim()) handleLine(out);
      if (code !== 0 && !result) isError = true;
      resolve({ text: result, isError, stderr: errAll });
    });
  });
}

/**
 * Run one Claude Code turn and return the assistant's final text. Self-heals: if
 * a specified model 404s, retries ONCE with the user's default model. Throws on a
 * real error so callers surface it (instead of silently treating it as "clean").
 */
export async function runClaude(prompt: string, opts: RunOpts): Promise<string> {
  let r = await attempt(prompt, opts.model, opts);
  if (r.isError && opts.model && looksLikeModelError(r.text + r.stderr)) {
    opts.onActivity?.(`model “${opts.model}” unavailable — retrying with your default…`);
    r = await attempt(prompt, "", opts);
  }
  if (r.isError) {
    throw new Error((r.text || r.stderr || "claude run failed").slice(0, 200));
  }
  return r.text;
}

/** Pull the first balanced JSON object out of a model response. */
export function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* */ }
  }
  return null;
}

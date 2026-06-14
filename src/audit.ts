import { runClaude, extractJson, RunOpts } from "./claude";

// Parallel "Code Audit": one cheap subagent per category runs concurrently
// (narrow context), then a single strong-tier synthesis pass. Speed from
// concurrency, lower cost from small contexts + model tiering. Emits structured
// events so the UI can show live, per-subagent progress.

export interface Finding {
  category: string;
  path: string;
  line: number;
  level: "notice" | "warning" | "failure" | string;
  comment: string;
}

export interface AuditItem {
  key: string;
  label: string;
}
export interface AuditCategory {
  key: string;
  title: string;
  defaultOn?: boolean;
  items: AuditItem[];
}
/** A resolved category to run: one subagent, prompt built from the picked items. */
export interface RunCategory {
  key: string;
  title: string;
  prompt: string;
}

// OFFLINE FALLBACK catalog only. The authoritative catalog is the cloud's
// single source of truth, fetched at runtime (see api.ts → fetchCatalog) so the
// extension shows the same list as the website. This is used only when offline
// or not connected.
export const FALLBACK_CATALOG: AuditCategory[] = [
  { key: "security", title: "Security", defaultOn: true, items: [
    { key: "injection", label: "SQL / command injection" },
    { key: "secrets", label: "Hardcoded secrets / keys" },
    { key: "authz", label: "Broken authn / authz" },
    { key: "ssrf", label: "SSRF & path traversal" },
    { key: "deser", label: "Unsafe deserialization" },
    { key: "input", label: "Missing input validation" },
  ] },
  { key: "tests", title: "Test coverage", defaultOn: true, items: [
    { key: "critical", label: "Untested critical logic" },
    { key: "errpaths", label: "Missing error-path tests" },
    { key: "shallow", label: "Shallow / over-mocked tests" },
    { key: "e2e", label: "No e2e for key flows" },
  ] },
  { key: "quality", title: "Code quality", defaultOn: true, items: [
    { key: "dead", label: "Dead / commented-out code" },
    { key: "big", label: "Oversized files / functions" },
    { key: "magic", label: "Magic numbers" },
    { key: "api", label: "Leaky public API surface" },
    { key: "errors", label: "Missing error handling" },
  ] },
  { key: "essentials", title: "Website essentials", defaultOn: true, items: [
    { key: "home", label: "Landing / home page" },
    { key: "nav", label: "Header & navigation" },
    { key: "footer", label: "Footer with key links" },
    { key: "hero", label: "Hero section + clear call-to-action" },
    { key: "pricing", label: "Pricing page (if SaaS)" },
    { key: "about", label: "About / contact page" },
    { key: "legal", label: "Privacy policy & terms" },
    { key: "notfound", label: "404 / error page" },
    { key: "favicon", label: "Favicon & app icons" },
    { key: "responsive", label: "Mobile responsiveness" },
    { key: "states", label: "Loading / empty / error states" },
  ] },
  { key: "deploy", title: "Deploy & CI/CD", defaultOn: true, items: [
    { key: "ci", label: "Missing CI" },
    { key: "env", label: "Undocumented env / secrets" },
    { key: "docker", label: "Broken Dockerfile / workflows" },
    { key: "committed", label: "Secrets committed to the repo" },
    { key: "health", label: "No healthcheck / rollback" },
  ] },
  { key: "auth", title: "Accounts & auth", items: [
    { key: "login", label: "Sign-up / login correctness" },
    { key: "session", label: "Session / cookie handling" },
    { key: "reset", label: "Password reset flow" },
    { key: "oauth", label: "OAuth / SSO correctness" },
    { key: "rbac", label: "RBAC on protected routes" },
  ] },
  { key: "payments", title: "Monetization", items: [
    { key: "stripe", label: "Stripe / payment integration" },
    { key: "webhook", label: "Webhook signature verification" },
    { key: "paywall", label: "Paywall / entitlement enforcement" },
    { key: "tiers", label: "Plan / tier gating" },
    { key: "refund", label: "Refund / cancel handling" },
  ] },
  { key: "perf", title: "Performance", items: [
    { key: "nplus1", label: "N+1 queries" },
    { key: "indexes", label: "Missing DB indexes" },
    { key: "loops", label: "Unbounded loops / payloads" },
    { key: "bundle", label: "Large client bundles" },
    { key: "cache", label: "Missing caching / pagination" },
  ] },
  { key: "a11y", title: "Accessibility", items: [
    { key: "alt", label: "Missing alt text" },
    { key: "labels", label: "Unlabeled form controls" },
    { key: "contrast", label: "Color-contrast issues" },
    { key: "keyboard", label: "Keyboard nav / traps" },
    { key: "aria", label: "Missing ARIA / roles" },
  ] },
  { key: "marketing", title: "Marketing site / SEO", items: [
    { key: "meta", label: "Meta / OG tags" },
    { key: "links", label: "Broken links" },
    { key: "sitemap", label: "Sitemap / robots.txt" },
    { key: "headings", label: "Heading structure" },
    { key: "lcp", label: "Slow LCP on landing" },
  ] },
  { key: "docs", title: "Documentation", items: [
    { key: "readme", label: "README present & current" },
    { key: "setup", label: "Setup / run instructions" },
    { key: "envdocs", label: "Documented env vars" },
    { key: "apidocs", label: "API docs" },
  ] },
];

// Output contract is always enforced locally; the rubric is fetched at runtime.
const OUTPUT_CONTRACT = `You are ONE parallel audit subagent responsible for a single category. Read only what you need (Read/Grep/Glob). Respond with ONLY JSON — no prose, no code fences:
{"findings":[{"path":"<repo-relative file>","line":<int>,"level":"notice|warning|failure","comment":"<issue + concrete fix>"}]}
Use "failure" only for genuinely exploitable/critical issues. Empty findings array if clean. Honor the repo's own CLAUDE.md / AGENTS.md conventions.`;

export type AuditEvent =
  | { type: "category-start"; key: string; title: string }
  | { type: "category-activity"; key: string; message: string }
  | { type: "category-done"; key: string; count: number }
  | { type: "category-error"; key: string; message: string }
  | { type: "findings"; findings: Finding[] };

export interface AuditArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerModel: string;
  synthModel: string;
  skill?: string | null;
  categories: RunCategory[];
  /** Max subagents running at once. Lower on a subscription to avoid rate-limit pauses. */
  maxParallel?: number;
  onEvent?: (e: AuditEvent) => void;
  signal?: AbortSignal;
}

/** Run fn over items with a bounded number in flight; preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

export async function runAudit(args: AuditArgs): Promise<{ findings: Finding[] }> {
  const cats = args.categories;
  const workerSystem = args.skill && args.skill.trim()
    ? `${args.skill.trim()}\n\n${OUTPUT_CONTRACT}`
    : OUTPUT_CONTRACT;
  const base: Omit<RunOpts, "model"> = {
    cwd: args.cwd,
    env: args.env,
    allowedTools: ["Read", "Grep", "Glob"],
    signal: args.signal,
  };

  // Fan out: one worker per category, up to maxParallel at a time.
  const perCategory = await mapLimit(
    cats,
    args.maxParallel ?? cats.length,
    async (c) => {
      args.onEvent?.({ type: "category-start", key: c.key, title: c.title });
      try {
        const text = await runClaude(
          `Audit this repository for ${c.title.toLowerCase()} — flag anything MISSING or not yet implemented as well as defects in what exists. Check specifically: ${c.prompt}. For something absent, report it (path "-", line 1) describing what to add.`,
          {
            ...base,
            model: args.workerModel,
            system: workerSystem,
            onActivity: (m) => args.onEvent?.({ type: "category-activity", key: c.key, message: m }),
          },
        );
        const json = extractJson(text) as { findings?: unknown } | null;
        const raw = Array.isArray(json?.findings) ? (json!.findings as Finding[]) : [];
        const findings = raw.filter((f) => f && f.path).map((f) => ({ ...f, category: c.title }));
        args.onEvent?.({ type: "category-done", key: c.key, count: findings.length });
        return findings;
      } catch (e) {
        args.onEvent?.({ type: "category-error", key: c.key, message: (e as Error).message });
        return [] as Finding[];
      }
    },
  );
  const findings = perCategory.flat();
  // Findings are the product. No local LLM "synthesis" pass (it was slow and
  // rate-limited) — the extension pushes these to the backend, which computes
  // stats and renders the full report on macrodeploy.com.
  args.onEvent?.({ type: "findings", findings });
  return { findings };
}

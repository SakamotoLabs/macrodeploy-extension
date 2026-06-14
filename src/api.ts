import { settings } from "./config";

// Client for the MacroDeploy backend. The proprietary audit rubrics ("skills")
// are NEVER bundled into the published extension — a .vsix is trivially unzipped.
// They're fetched in real-time, authenticated with the user's MacroDeploy API
// token, so they stay private and centrally updatable. If the fetch fails
// (offline / no token), the caller falls back to a minimal generic prompt.

export function baseUrl(): string {
  return (settings().get<string>("apiBaseUrl", "https://macrodeploy.com") || "https://macrodeploy.com").replace(/\/+$/, "");
}

// Only transmit credentials/tokens over HTTPS (or localhost for dev). Prevents
// a misconfigured http:// apiBaseUrl from leaking the token in cleartext.
function secure(u: string): boolean {
  return /^https:\/\//i.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u);
}

export interface ExchangeResult {
  token: string;
  email?: string;
  preferences?: { credential?: string; workerModel?: string; synthModel?: string };
  anthropic?: { apiKey?: string; oauth?: string; prefer?: string };
}

/** Exchange the one-time browser-onboarding code for the token + creds + prefs. */
export async function exchangeCode(code: string): Promise<ExchangeResult | null> {
  if (!secure(baseUrl())) return null;
  try {
    const res = await fetch(`${baseUrl()}/api/v1/connect/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ExchangeResult;
  } catch {
    return null;
  }
}

/** Push a completed audit to the user's account; returns the web report URL. */
export async function saveAudit(
  token: string,
  repo: string,
  findings: unknown[],
): Promise<{ id: string; url: string } | null> {
  if (!token || !secure(baseUrl())) return null;
  try {
    const res = await fetch(`${baseUrl()}/api/v1/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repo, findings }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string; url: string };
  } catch {
    return null;
  }
}

/** One audit category as served by the cloud (the single source of truth). */
export interface CatalogCategoryDTO {
  key: string;
  title: string;
  defaultOn?: boolean;
  prompt?: string;
  items: { label: string; severity?: string; analysis?: string }[];
}

/**
 * Fetch the audit catalog from the cloud so the extension shows the SAME list
 * the website does — instead of bundling its own copy. The per-category detail
 * ships only to authenticated clients here. Returns null offline/unauthenticated
 * (caller falls back to a minimal built-in catalog).
 */
export async function fetchCatalog(
  token: string,
  signal?: AbortSignal,
): Promise<CatalogCategoryDTO[] | null> {
  if (!token || !secure(baseUrl())) return null;
  try {
    const res = await fetch(`${baseUrl()}/api/v1/catalog`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { catalog?: CatalogCategoryDTO[] };
    return Array.isArray(data.catalog) && data.catalog.length ? data.catalog : null;
  } catch {
    return null;
  }
}

export async function fetchSkill(
  mode: string,
  opts: { token: string; checklist?: string; signal?: AbortSignal },
): Promise<string | null> {
  if (!opts.token || !secure(baseUrl())) return null;
  try {
    const res = await fetch(`${baseUrl()}/api/v1/skill`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode, checklist: opts.checklist ?? "" }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { skill?: string };
    return data.skill && data.skill.trim() ? data.skill : null;
  } catch {
    return null;
  }
}

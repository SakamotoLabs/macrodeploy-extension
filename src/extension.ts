import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveEnv } from "./credentials";
import { runAudit, FALLBACK_CATALOG, RunCategory, AuditCategory } from "./audit";
import { fetchSkill, fetchCatalog, saveAudit, CatalogCategoryDTO } from "./api";
import { AuditPanel, PanelTheme } from "./panel";
import { getApiKey, getMacroToken, settings, checkClaude, SECRET_API_KEY, SECRET_TOKEN } from "./config";
import { runSetup } from "./setup";
import { connectViaBrowser } from "./connect";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("macrodeploy.connect", () => connectViaBrowser(context)),
    vscode.commands.registerCommand("macrodeploy.setup", () => runSetup(context)),
    vscode.commands.registerCommand("macrodeploy.auditWorkspace", () => auditWorkspace(context)),
    vscode.commands.registerCommand("macrodeploy.resetOnboarding", async () => {
      await context.globalState.update("macrodeploy.setupDone", undefined);
      await context.secrets.delete(SECRET_API_KEY);
      await context.secrets.delete(SECRET_TOKEN);
      const p = await vscode.window.showInformationMessage(
        "MacroDeploy onboarding reset — saved key & token cleared. The welcome will show on next reload.",
        "Connect now",
      );
      if (p === "Connect now") void connectViaBrowser(context);
    }),
  );

  if (!context.globalState.get("macrodeploy.setupDone")) {
    void vscode.window
      .showInformationMessage(
        "MacroDeploy: audit, fix, and ship — on your own Claude credential. Connect your account to get started.",
        "Connect (browser)",
        "Enter manually",
        "Later",
      )
      .then((p) => {
        if (p === "Connect (browser)") void connectViaBrowser(context);
        else if (p === "Enter manually") void runSetup(context);
      });
  }
}

/** Map the cloud catalog DTO to the panel's category shape (synthesize item keys). */
function toAuditCategories(dto: CatalogCategoryDTO[]): AuditCategory[] {
  return dto.map((c) => ({
    key: c.key,
    title: c.title,
    defaultOn: c.defaultOn,
    items: c.items.map((it, i) => ({ key: `${c.key}-${i}`, label: it.label })),
  }));
}

async function auditWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = await pickFolder();
  if (!folder) return;
  const cwd = folder.uri.fsPath;

  if (!(await checkClaude())) {
    const p = await vscode.window.showErrorMessage("Claude Code CLI not found. MacroDeploy needs it to run locally.", "Connect");
    if (p === "Connect") void connectViaBrowser(context);
    return;
  }

  const cfg = settings();
  // Mutable target — the user can re-point it at a sub-project from the panel.
  let targetCwd = cwd;
  let repoRel = vscode.workspace.asRelativePath(cwd);
  const labelFor = async (): Promise<string> => {
    try {
      return resolveEnv(await getApiKey(context)).label;
    } catch {
      return "not set";
    }
  };

  const token = await getMacroToken(context);
  const notes: string[] = [];
  if (!token) notes.push("Not connected to MacroDeploy — results won't be saved. Run “MacroDeploy: Connect”.");

  // The audit catalog is the cloud's single source of truth — fetch it so the
  // extension shows the same list as the website. Fall back to the built-in
  // list only when offline / not connected.
  const catalogDto = token ? await fetchCatalog(token) : null;
  const cats: AuditCategory[] = catalogDto ? toAuditCategories(catalogDto) : FALLBACK_CATALOG;

  let ac: AbortController | undefined;
  const panel = new AuditPanel({
    repo: repoRel,
    credentialLabel: await labelFor(),
    notes,
    settings: {
      credential: cfg.get<string>("credential", "auto"),
      workerModel: cfg.get<string>("workerModel", "claude-haiku-4-5-20251001"),
      synthModel: cfg.get<string>("synthModel", "claude-opus-4-8"),
      theme: cfg.get<PanelTheme>("theme", "dark"),
    },
    categories: cats,
    onCancel: () => ac?.abort(),
    onSetting: async (key, value) => {
      await cfg.update(key, value, vscode.ConfigurationTarget.Global);
      if (key === "credential") panel.credential(await labelFor());
    },
    onPickFolder: async () => {
      const items: (vscode.QuickPickItem & { path: string })[] = findCandidates(cwd).map((c) => ({
        label: c.label,
        description: c.path === cwd ? "" : vscode.workspace.asRelativePath(c.path),
        path: c.path,
      }));
      items.push({ label: "$(folder-opened) Browse…", path: "" });
      const pick = await vscode.window.showQuickPick(items, { title: "Audit which folder?", matchOnDescription: true });
      if (!pick) return;
      let chosen = pick.path;
      if (!chosen) {
        const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Audit this folder" });
        if (!uri?.[0]) return;
        chosen = uri[0].fsPath;
      }
      targetCwd = chosen;
      repoRel = vscode.workspace.asRelativePath(chosen);
      panel.target(repoRel);
    },
    onRun: async (selection) => {
      // Build one subagent per category, prompt = the picked item labels.
      const chosen: RunCategory[] = [];
      for (const c of cats) {
        const picked = selection[c.key];
        if (!picked || !picked.length) continue;
        const labels = c.items.filter((it) => picked.includes(it.key)).map((it) => it.label);
        chosen.push({ key: c.key, title: c.title, prompt: labels.join("; ") });
      }
      if (!chosen.length) return;

      // Re-fetch the token NOW (not at panel-open) so a connect that happened
      // after this panel opened is picked up — no reopen needed.
      const runToken = await getMacroToken(context);
      const workerModel = cfg.get<string>("workerModel", "claude-haiku-4-5-20251001");
      const synthModel = cfg.get<string>("synthModel", "claude-opus-4-8");
      let env: NodeJS.ProcessEnv;
      let label: string;
      try {
        ({ env, label } = resolveEnv(await getApiKey(context)));
      } catch (e) {
        panel.fail((e as Error).message + " Set a key in Settings, or run MacroDeploy: Connect.");
        return;
      }
      panel.credential(label);
      const maxParallel = label.toLowerCase().includes("subscription") ? 2 : chosen.length;

      ac = new AbortController();
      try {
        const skill = await fetchSkill("audit", { token: runToken, signal: ac.signal });
        const { findings } = await runAudit({
          cwd: targetCwd, env, workerModel, synthModel, maxParallel, skill,
          categories: chosen, signal: ac.signal, onEvent: (e) => panel.event(e),
        });
        if (ac.signal.aborted) return; // cancelled — panel already shows it, don't save
        if (runToken) {
          const saved = await saveAudit(runToken, repoRel, findings);
          panel.saved(saved?.url ?? null);
        } else {
          panel.saved(null);
        }
      } catch (e) {
        if (ac?.signal.aborted) panel.fail("cancelled");
        else panel.fail((e as Error).message);
      }
    },
  });
}

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "requirements.txt", "pom.xml", "Gemfile"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".next", "vendor", ".venv", "__pycache__", "target"]);

function isProject(p: string): boolean {
  return PROJECT_MARKERS.some((m) => {
    try { return fs.existsSync(path.join(p, m)); } catch { return false; }
  });
}
function listDirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
/** Candidate folders to audit: the root plus any sub-projects (2 levels deep, e.g. repos/<proj>). */
function findCandidates(root: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [{ label: "$(root-folder) workspace root", path: root }];
  for (const a of listDirs(root)) {
    const ap = path.join(root, a);
    if (isProject(ap)) out.push({ label: a, path: ap });
    for (const b of listDirs(ap)) {
      const bp = path.join(ap, b);
      if (isProject(bp)) out.push({ label: `${a}/${b}`, path: bp });
    }
  }
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.path) ? false : seen.add(o.path))).slice(0, 200);
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    const open = await vscode.window.showErrorMessage("Open a folder to audit first.", "Open Folder");
    if (open) void vscode.commands.executeCommand("vscode.openFolder");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, folder: f })),
    { title: "Audit which folder?" },
  );
  return pick?.folder;
}

export function deactivate() {
  /* no-op */
}

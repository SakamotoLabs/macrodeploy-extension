import * as vscode from "vscode";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { baseUrl, exchangeCode } from "./api";
import { SECRET_API_KEY, SECRET_TOKEN, settings } from "./config";

// Browser-based onboarding (like `gh auth login`): open macrodeploy.com, the user
// authorizes (they're already signed in), the page mints a token + saves prefs
// and creds, and hands a one-time code back to a localhost callback. We exchange
// it for the token + credentials + preferences and store them locally.
export async function connectViaBrowser(ctx: vscode.ExtensionContext): Promise<boolean> {
  const state = randomBytes(16).toString("hex");
  const editor = vscode.env.appName || "your editor";

  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Connecting to MacroDeploy…", cancellable: true },
    (_progress, token) =>
      new Promise<string | null>((resolve) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const gotState = url.searchParams.get("state");
          const gotCode = url.searchParams.get("code");
          res.writeHead(200, { "content-type": "text/html" });
          res.end(CALLBACK_HTML(!!gotCode && gotState === state));
          cleanup();
          resolve(gotCode && gotState === state ? gotCode : null);
        });
        const cleanup = () => { try { server.close(); } catch { /* */ } };
        token.onCancellationRequested(() => { cleanup(); resolve(null); });
        // 5-min safety timeout.
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 5 * 60 * 1000);
        server.on("close", () => clearTimeout(timer));

        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          const redirect = `http://127.0.0.1:${port}/callback`;
          const connectUrl =
            `${baseUrl()}/connect/editor?state=${state}` +
            `&redirect=${encodeURIComponent(redirect)}&label=${encodeURIComponent(editor)}`;
          void vscode.env.openExternal(vscode.Uri.parse(connectUrl));
        });
      }),
  );

  if (!code) {
    vscode.window.showWarningMessage("MacroDeploy connect was cancelled or timed out.");
    return false;
  }

  const result = await exchangeCode(code);
  if (!result?.token) {
    vscode.window.showErrorMessage("MacroDeploy connect failed to exchange the code. Try again.");
    return false;
  }

  // Store everything locally.
  await ctx.secrets.store(SECRET_TOKEN, result.token);
  if (result.anthropic?.apiKey) await ctx.secrets.store(SECRET_API_KEY, result.anthropic.apiKey);

  const cfg = settings();
  const prefs = result.preferences ?? {};
  const credMode = prefs.credential || (result.anthropic?.prefer === "oauth" ? "subscription" : result.anthropic?.apiKey ? "apiKey" : "auto");
  await cfg.update("credential", credMode, vscode.ConfigurationTarget.Global);
  if (prefs.workerModel) await cfg.update("workerModel", prefs.workerModel, vscode.ConfigurationTarget.Global);
  if (prefs.synthModel) await cfg.update("synthModel", prefs.synthModel, vscode.ConfigurationTarget.Global);

  await ctx.globalState.update("macrodeploy.setupDone", true);
  const run = await vscode.window.showInformationMessage(
    `Connected to MacroDeploy as ${result.email ?? "your account"}.`,
    "Run a Code Audit",
  );
  if (run) void vscode.commands.executeCommand("macrodeploy.auditWorkspace");
  return true;
}

function CALLBACK_HTML(ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>MacroDeploy</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;background:#f7f9f8;color:#1a2b22;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:16px;padding:32px 40px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:18px;margin:14px 0 6px}p{color:#5b6b63;margin:0}</style>
<div class="card"><svg width="34" height="34" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#16a34a"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 25 L21 34 L38 13"/><path d="M30 13 L38 13 L38 21"/></g></svg>
<h1>${ok ? "Connected ✓" : "Something went wrong"}</h1>
<p>${ok ? "You can close this tab and return to your editor." : "Please return to your editor and try again."}</p></div>`;
}

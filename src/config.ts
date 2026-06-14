import * as vscode from "vscode";
import { spawn } from "node:child_process";

// Secrets live in VS Code SecretStorage (OS keychain), never in settings.json.
export const SECRET_API_KEY = "macrodeploy.anthropicApiKey";
export const SECRET_TOKEN = "macrodeploy.apiToken";

export async function getApiKey(ctx: vscode.ExtensionContext): Promise<string> {
  return (await ctx.secrets.get(SECRET_API_KEY)) ?? "";
}
export async function getMacroToken(ctx: vscode.ExtensionContext): Promise<string> {
  return (await ctx.secrets.get(SECRET_TOKEN)) ?? "";
}

export function settings() {
  return vscode.workspace.getConfiguration("macrodeploy");
}

/** Is the Claude Code CLI installed and runnable? */
export function checkClaude(): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", ["--version"]);
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

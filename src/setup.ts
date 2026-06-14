import * as vscode from "vscode";

import { SECRET_API_KEY, SECRET_TOKEN, settings, checkClaude } from "./config";

const INSTALL_DOCS = "https://docs.claude.com/en/docs/claude-code/setup";

// Guided, no-settings-JSON setup. Walks the user through: Claude Code presence,
// credential choice (subscription vs API key), and the optional MacroDeploy token
// that unlocks the private rubrics. Secrets go to SecretStorage (OS keychain).
export async function runSetup(ctx: vscode.ExtensionContext): Promise<void> {
  // 1) Claude Code present?
  if (!(await checkClaude())) {
    const pick = await vscode.window.showWarningMessage(
      "MacroDeploy runs on the Claude Code CLI, which isn't installed yet.",
      "Install instructions",
      "Install via npm",
      "I've installed it",
    );
    if (pick === "Install instructions") {
      void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
      return;
    }
    if (pick === "Install via npm") {
      const term = vscode.window.createTerminal("Install Claude Code");
      term.show();
      term.sendText("npm install -g @anthropic-ai/claude-code");
      vscode.window.showInformationMessage("After it finishes, run “MacroDeploy: Set Up” again.");
      return;
    }
    if (pick !== "I've installed it") return;
  }

  // 2) Credential choice.
  const cred = await vscode.window.showQuickPick(
    [
      {
        label: "$(account) Use my Claude subscription",
        description: "Pro/Max — no per-token API charges",
        detail: "Runs on your Claude Code login. We'll check you're signed in.",
        value: "subscription" as const,
      },
      {
        label: "$(key) Use an Anthropic API key",
        description: "Billed per token to your Anthropic account",
        detail: "Paste an sk-ant-… key; stored securely in your OS keychain.",
        value: "apiKey" as const,
      },
    ],
    { title: "MacroDeploy — which credential?", ignoreFocusOut: true, placeHolder: "Pick how Claude runs locally" },
  );
  if (!cred) return;

  await settings().update("credential", cred.value, vscode.ConfigurationTarget.Global);

  if (cred.value === "apiKey") {
    const key = await vscode.window.showInputBox({
      title: "Anthropic API key",
      prompt: "Paste your key (sk-ant-…). Stored in your OS keychain, never in settings.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith("sk-ant-") ? null : "Expected a key starting with sk-ant-"),
    });
    if (!key) return;
    await ctx.secrets.store(SECRET_API_KEY, key.trim());
  } else {
    const go = await vscode.window.showInformationMessage(
      "Make sure you're signed in to Claude Code. If not, run `claude` once (or `claude setup-token`) in a terminal.",
      "Open terminal",
      "I'm signed in",
    );
    if (go === "Open terminal") {
      const term = vscode.window.createTerminal("Claude sign-in");
      term.show();
      term.sendText("claude");
    }
  }

  // 3) Optional MacroDeploy token (unlocks private rubrics).
  const wantToken = await vscode.window.showQuickPick(
    [
      { label: "$(check) Add my MacroDeploy token", value: true },
      { label: "Skip for now (uses a generic rubric)", value: false },
    ],
    { title: "MacroDeploy token — unlock the full audit rubric?", ignoreFocusOut: true },
  );
  if (wantToken?.value) {
    const token = await vscode.window.showInputBox({
      title: "MacroDeploy API token",
      prompt: "From the dashboard → Account. Stored securely in your OS keychain.",
      password: true,
      ignoreFocusOut: true,
    });
    if (token?.trim()) await ctx.secrets.store(SECRET_TOKEN, token.trim());
  }

  await ctx.globalState.update("macrodeploy.setupDone", true);
  const run = await vscode.window.showInformationMessage("MacroDeploy is ready. ", "Run a Code Audit");
  if (run) void vscode.commands.executeCommand("macrodeploy.auditWorkspace");
}

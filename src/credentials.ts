import { settings } from "./config";

export type CredMode = "auto" | "apiKey" | "subscription";

// Resolve which credential to run on and return the env to spawn `claude` with.
// PRECEDENCE FOOTGUN: a set ANTHROPIC_API_KEY silently overrides the CLI's
// subscription login — so the subscription path must DELETE it from the env.
export function resolveEnv(apiKey: string): { env: NodeJS.ProcessEnv; label: string } {
  const mode = settings().get<CredMode>("credential", "auto");
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || "").trim();
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (mode === "subscription") {
    delete env.ANTHROPIC_API_KEY;
    return { env, label: "Claude subscription" };
  }
  if (mode === "apiKey") {
    if (!key) throw new Error("Credential is set to 'API key' but none is saved. Run “MacroDeploy: Set Up”.");
    env.ANTHROPIC_API_KEY = key;
    return { env, label: "Anthropic API key" };
  }
  // auto: prefer the API key (durable), else the subscription login.
  if (key) {
    env.ANTHROPIC_API_KEY = key;
    return { env, label: "Anthropic API key" };
  }
  delete env.ANTHROPIC_API_KEY;
  return { env, label: "Claude subscription" };
}

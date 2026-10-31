// Local-only startup measurement. No prompts, network calls, credential-store reads,
// dependency installation or OS cache flush. Run in a fresh Node process.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = process.env.VC_TEST_PI_DIR;
if (!prefix) throw new Error("Set VC_TEST_PI_DIR to the already-installed pinned pi prefix");
const pkg = join(prefix, "node_modules/@earendil-works/pi-coding-agent");
const root = mkdtempSync(join(tmpdir(), "vc-sdk-startup-"));
let session;
try {
  const start = performance.now();
  // The installed public dist/index.js currently has a missing pi-codemode
  // export. Measure the actual pinned bundle separately; do not repair the pin.
  const sdk = await import(pathToFileURL(join(pkg, "dist/bundle/index.js")).href);
  const imported = performance.now();
  const model = { id: "offline", name: "offline", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 };
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { local: { baseUrl: model.baseUrl, apiKey: "synthetic-no-calls", api: model.api, models: [model] } } }));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, "absent-auth.json"), modelsPath: join(root, "models.json") });
  const registered = performance.now();
  // Same factory export path used by server/mcp/filesystem.ts, not a copied tool.
  const tools = await import(pathToFileURL(join(pkg, "dist/core/tools/index.js")).href);
  const definitions = tools.createAllToolDefinitions(root);
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Local startup measurement", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, model, thinkingLevel: "off", modelRuntime, resourceLoader, tools: ["read", "bash", "edit", "write"], sessionManager: sdk.SessionManager.inMemory(root), settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }) }));
  const ready = performance.now();
  console.log(JSON.stringify({ sdkImportMs: Math.round(imported - start), localModelRuntimeMs: Math.round(registered - imported), factoryAndSessionMs: Math.round(ready - registered), totalInProcessMs: Math.round(ready - start), factoryTools: Object.keys(definitions), activeTools: session.getActiveToolNames(), modelCalls: 0, node: process.version }));
} finally {
  session?.dispose();
  rmSync(root, { recursive: true, force: true });
}

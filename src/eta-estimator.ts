import { generateText } from "ai";
import { buildModel, findModel, MODELS, type ProviderId } from "./providers";
import { machineSummary } from "./machine-info";

// Provider preference order when picking a "fast" model for the ETA call.
// Anthropic Haiku first since the app is Anthropic-default; then any
// available fast model by id pattern.
const FAST_PREF: ProviderId[] = ["anthropic", "google", "openai", "openrouter"];

export function pickFastModel(apiKeys: Partial<Record<ProviderId, string>>) {
  for (const p of FAST_PREF) {
    if (!apiKeys[p]) continue;
    const m =
      MODELS.find((x) => x.provider === p && /haiku|mini|flash/i.test(x.id)) ??
      MODELS.find((x) => x.provider === p);
    if (m) return { spec: m, apiKey: apiKeys[p]! };
  }
  // Last resort: try Haiku by id (anthropic key may be present under a
  // non-standard shape, though that's unlikely with the current store).
  const haiku = findModel("claude-haiku-4-5-20251001");
  if (haiku && apiKeys.anthropic) return { spec: haiku, apiKey: apiKeys.anthropic };
  return null;
}

const SYSTEM = `You estimate how long a shell command will take to execute on the user's machine, in seconds.

Reply with a single integer. No units, no words, no explanation. Just the number.

Calibration (adjust for the host machine described in the prompt — fewer cores / Windows / older hardware → push higher; many cores / Linux / SSD → push lower):
- Trivial commands (ls, pwd, echo, git status on a small repo): 1
- Quick git / small greps / single-file reads: 2-5
- Moderate work (small test run, light build): 10-30
- Package installs:
  - apt / brew small package: 10-60
  - pip install single package: 15-90
  - pip install large package (torch, tensorflow): 60-300
  - winget with RubyInstaller / Python / large dev toolchain: 300-1200 (Windows installers + post-install scripts like ridk install are slow)
  - npm install on a fresh project: 30-180
- Big builds (cargo build release, full test suite, docker build): 60-600
- Network downloads of large packages: 60-300

If you genuinely cannot guess, output 0.`;

export async function estimateBashEta(params: {
  command: string;
  apiKeys: Partial<Record<ProviderId, string>>;
  signal?: AbortSignal;
}): Promise<number | null> {
  const picked = pickFastModel(params.apiKeys);
  if (!picked) return null;
  try {
    const model = buildModel(picked.spec, picked.apiKey);
    const prompt = `Host: ${machineSummary()}\n\nCommand:\n${params.command.slice(0, 2000)}`;
    const res = await generateText({
      model,
      system: SYSTEM,
      prompt,
      abortSignal: params.signal,
    });
    const m = res.text.trim().match(/-?\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, 60 * 60);
  } catch {
    return null;
  }
}

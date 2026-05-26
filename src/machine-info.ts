// One-shot capture of the host machine's basics, used to give the ETA
// estimator (and anything else that wants it) a sense of "this box is
// fast / slow / Windows / Mac / etc." Browser APIs only — no Tauri
// plugin needed. Privacy-rounded values are fine for ETA priors.

export type MachineInfo = {
  os: string;
  arch: string;
  cpuThreads?: number;
  ramGb?: number;
};

let cached: MachineInfo | null = null;

function detectOs(ua: string): string {
  if (/Windows NT 10\.0.*?Win64/i.test(ua)) {
    // UA still says NT 10.0 for Win11 — we can't distinguish from JS
    // alone. Tauri webview doesn't expose Win build number. Call it
    // "Windows 10/11".
    return "Windows 10/11";
  }
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X (\d+)[._](\d+)/i.test(ua)) {
    const m = ua.match(/Mac OS X (\d+)[._](\d+)/i)!;
    return `macOS ${m[1]}.${m[2]}`;
  }
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

function detectArch(ua: string): string {
  if (/Win64|WOW64|x64|x86_64/i.test(ua)) return "x64";
  if (/arm64|aarch64/i.test(ua)) return "arm64";
  if (/i686|i386|x86/i.test(ua)) return "x86";
  return "unknown";
}

export function getMachineInfo(): MachineInfo {
  if (cached) return cached;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
  const nav = typeof navigator !== "undefined" ? (navigator as any) : {};
  cached = {
    os: detectOs(ua),
    arch: detectArch(ua),
    cpuThreads: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
    ramGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
  };
  return cached;
}

export function machineSummary(): string {
  const m = getMachineInfo();
  const parts: string[] = [m.os, m.arch];
  if (m.cpuThreads) parts.push(`${m.cpuThreads} threads`);
  if (m.ramGb) parts.push(`${m.ramGb}GB RAM`);
  return parts.join(", ");
}

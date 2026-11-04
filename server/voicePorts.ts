// Reused from ports-on-reset-startup-1031, with explicit test-instance ports.
function port(value: string | number, name: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be an integer in 1..65535`);
  return n;
}
export function voicePort(serverPort: number, explicit?: string, legacy?: string): number {
  port(serverPort, "VC_PORT");
  if (legacy !== undefined) {
    port(legacy, "VC_VOICE_PIPELINE_PORT");
    if (explicit !== undefined && port(explicit, "VC_VOICE_PORT") !== Number(legacy)) {
      throw new Error("VC_VOICE_PORT and VC_VOICE_PIPELINE_PORT must agree when both are set");
    }
  }
  explicit ??= legacy;
  // Only the installed default instance has a default voice port. Tests/dev must name their own.
  if (explicit === undefined && serverPort !== 8848) throw new Error("Set an explicit positive VC_VOICE_PORT for this instance");
  const p = explicit === undefined ? 8857 : port(explicit, "VC_VOICE_PORT");
  if (p === 8848) throw new Error("Voice port 8848 is reserved for live HTTP; choose VC_VOICE_PORT");
  if (p === serverPort) throw new Error("VC_VOICE_PORT must differ from the HTTP port");
  if (p === 8857 && serverPort !== 8848) throw new Error("Voice port 8857 is reserved for the live HTTP instance on 8848");
  return p;
}

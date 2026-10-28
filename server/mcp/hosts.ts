// Host/DNS-rebinding guard, not a second authentication system. The default
// comes from the local daemon, never from a request's Host/forwarding headers.
import { findTailscale, tailscaleDnsName } from "../devProxy";

export function externalMcpHosts(): ReadonlySet<string> {
  // An explicit override can restrict aliases/ports; explicit empty disables.
  if (process.env.VC_MCP_HOSTS !== undefined) {
    return new Set(process.env.VC_MCP_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  }
  const bin = findTailscale();
  const name = bin ? tailscaleDnsName(bin) : null;
  // Admit this machine only, never all *.ts.net and never loopback by default.
  if (!name || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(name)) return new Set();
  return new Set([name, `${name}:443`]);
}

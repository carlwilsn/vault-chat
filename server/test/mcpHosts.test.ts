import { afterEach, describe, expect, it, vi } from "vitest";
import { externalMcpHosts } from "../mcp/hosts";
import { findTailscale, tailscaleDnsName } from "../devProxy";
vi.mock("../devProxy", () => ({ findTailscale: vi.fn(), tailscaleDnsName: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("external MCP default private Host", () => {
  it("uses the local daemon's exact DNS name without a deployment opt-in", () => {
    vi.stubEnv("VC_MCP_HOSTS", undefined);
    vi.mocked(findTailscale).mockReturnValue("/local/tailscale");
    vi.mocked(tailscaleDnsName).mockReturnValue("thinkbox.tailbb647d.ts.net");
    expect([...externalMcpHosts()]).toEqual(["thinkbox.tailbb647d.ts.net", "thinkbox.tailbb647d.ts.net:443"]);
    expect(tailscaleDnsName).toHaveBeenCalledWith("/local/tailscale");
  });
  it("fails closed when discovery is unavailable or invalid", () => {
    vi.stubEnv("VC_MCP_HOSTS", undefined);
    vi.mocked(findTailscale).mockReturnValue(null);
    expect(externalMcpHosts().size).toBe(0);
    expect(tailscaleDnsName).not.toHaveBeenCalled();
    vi.mocked(findTailscale).mockReturnValue("/local/tailscale");
    for (const name of [null, "", "127.0.0.1", "*.ts.net", "https://box.ts.net", "evil.example"]) {
      vi.mocked(tailscaleDnsName).mockReturnValue(name);
      expect(externalMcpHosts().size).toBe(0);
    }
  });
  it("retains exact explicit aliases/ports and explicit disable without discovery", () => {
    vi.stubEnv("VC_MCP_HOSTS", " Home.Tailbb647d.ts.net,box.ts.net:8443 ");
    expect([...externalMcpHosts()]).toEqual(["home.tailbb647d.ts.net", "box.ts.net:8443"]);
    vi.stubEnv("VC_MCP_HOSTS", "");
    expect(externalMcpHosts().size).toBe(0);
    expect(findTailscale).not.toHaveBeenCalled();
  });
});

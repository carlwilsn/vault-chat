// The phone's side of live pages (src/liveBridge.ts): a JSON POST to the box, with the phone's own authentication.
import { installLiveBridge } from "../../src/liveBridge";

type Api = (path: string, opts?: RequestInit) => Promise<Response>;

export function installPhoneLiveBridge(api: Api): void {
  installLiveBridge({
    async post(path, body) {
      const r = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    },
  });
}

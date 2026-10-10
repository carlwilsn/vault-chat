// The network wall. Same-origin requests (Vite modules, fixtures) pass;
// model-provider requests are answered by llm.ts from the scenario's scripts;
// EVERYTHING else is refused loudly (console error + harness banner + log).
// The dev server also sends a CSP that blocks any other origin, so a request
// that slips past these wrappers (an <img src=https://…>) still never leaves.

import { answerModelRequest } from "./llm";
import { report } from "./overlay";

export const refused: Array<{ at: number; kind: string; url: string }> = [];

function refuse(kind: string, url: string): Error {
  refused.push({ at: Date.now(), kind, url });
  const msg = `[preview] outbound ${kind} refused: ${url}`;
  console.error(msg);
  report("refused", `${kind} ${url}`);
  return new TypeError(msg);
}

function classify(raw: string): { same: boolean; url: URL | null } {
  try {
    const u = new URL(raw, location.href);
    if (u.protocol === "data:" || u.protocol === "blob:") return { same: true, url: u };
    return { same: u.origin === location.origin, url: u };
  } catch {
    return { same: true, url: null };
  }
}

export function installNetworkGuard(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let raw: string;
    let req: Request | null = null;
    if (input instanceof Request) {
      req = input;
      raw = input.url;
    } else raw = String(input);
    const { same, url } = classify(raw);
    if (same || !url) return realFetch(input as RequestInfo, init);
    let effInit = init;
    if (req && !init) {
      effInit = { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text(), signal: req.signal };
    }
    const answered = await answerModelRequest(url, effInit);
    if (answered) return answered;
    throw refuse("fetch", url.href);
  };

  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, u: string | URL, ...rest: any[]) {
    const { same, url } = classify(String(u));
    if (!same && url) throw refuse("xhr", url.href);
    return (XO as any).call(this, method, u, ...rest);
  } as typeof XO;

  const RealWS = window.WebSocket;
  (window as any).WebSocket = function (u: string | URL, protocols?: string | string[]) {
    const { url } = classify(String(u));
    // Vite's HMR socket is same-host; everything else is refused.
    if (url && url.hostname === location.hostname) return new RealWS(u, protocols);
    throw refuse("websocket", String(u));
  } as any;
  (window as any).WebSocket.prototype = RealWS.prototype;
  Object.assign((window as any).WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const RealES = window.EventSource;
  if (RealES) {
    (window as any).EventSource = function (u: string | URL, cfg?: EventSourceInit) {
      const { same, url } = classify(String(u));
      if (!same && url) throw refuse("eventsource", url.href);
      return new RealES(u, cfg);
    } as any;
  }

  if (navigator.sendBeacon) {
    const real = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u: string | URL, data?: BodyInit | null) => {
      const { same, url } = classify(String(u));
      if (!same && url) {
        refuse("beacon", url.href);
        return false;
      }
      return real(u, data);
    };
  }

  window.addEventListener("securitypolicyviolation", (e) => {
    refuse(`csp:${e.effectiveDirective}`, e.blockedURI || "(inline)");
  });

  // window.open of an outside URL (links, "open in browser") → refused, but
  // without throwing into the app.
  const realOpen = window.open.bind(window);
  window.open = ((u?: string | URL, target?: string, features?: string) => {
    const { same, url } = classify(String(u ?? ""));
    if (!same && url) {
      refuse("window.open", url.href);
      return null;
    }
    return realOpen(u, target, features);
  }) as typeof window.open;
}

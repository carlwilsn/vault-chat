// Development-only native bridge: production App uses the existing realbox HTTP proxy.
import { BaseDirectory } from "@tauri-apps/api/path";
import type { Scenario } from "./types";
export const nativeShipmentAppScenario: Scenario = {
  id: "native-shipment-app", title: "Private native shipment history", group: "Proof",
  notes: "Synthetic conversations + private genuine Git, never installed acceptance or device evidence.",
  clock: new Date().toISOString(), build: () => {}, surfaces: ["desktop"],
  host: () => ({ sync: { box: { box: "http://realbox.localhost", vault: "fixture" }, reports: [{ configured: true, ok: true, message: "private fixture" }] } }),
  overrides: {
    "plugin:path|resolve_directory": (args: { directory?: number }) => {
      if (args.directory !== BaseDirectory.Home || Object.keys(args).length !== 1) throw Error("Only fixture Home allowed");
      return "/home/carl/";
    },
  },
};

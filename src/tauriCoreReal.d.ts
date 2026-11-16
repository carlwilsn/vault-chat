// The real `@tauri-apps/api/core`, under the name vite.config.ts gives it so src/tauriCoreGuarded.ts can wrap it.
declare module "vc-tauri-core-real" {
  export * from "@tauri-apps/api/core";
}

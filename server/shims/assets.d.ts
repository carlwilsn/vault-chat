declare module "*.md" {
  const s: string;
  export default s;
}
declare module "*.html" {
  const s: string;
  export default s;
}
declare module "*.png" {
  const b: Uint8Array;
  export default b;
}
declare module "*/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

/** The bundled phone app (server/build.mjs --phone-app): path → base64. */
declare module "vc:phone-app" {
  const files: Record<string, string>;
  export default files;
}

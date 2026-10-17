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

/** The bundled whiteboard app (server/build.mjs --board-app): path → base64. */
declare module "vc:board-app" {
  const files: Record<string, string>;
  export default files;
}

/** KaTeX's CSS with its fonts inlined (server/katexCssGen.mjs). */
declare module "vc:katex-css" {
  const css: string;
  export default css;
}

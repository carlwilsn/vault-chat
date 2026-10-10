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

declare module "*?url" {
  const url: string;
  export default url;
}

/** The board's build (vite.config.ts define): "<version>+<commit>", in every log batch. */
declare const __BOARD_VERSION__: string;

// The RecordUI child as the box runs it (`vault-chat-server.mjs record-ui`), for recordUI.test.ts (under tsx).
const { recordCli } = await import("../recordUI.ts");
await recordCli();

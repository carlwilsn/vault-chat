// Node stand-in for `@tauri-apps/api/app`.
import { SERVER_VERSION } from "../config";

export async function getVersion(): Promise<string> {
  return SERVER_VERSION;
}
export async function getName(): Promise<string> {
  return "vault-chat-server";
}

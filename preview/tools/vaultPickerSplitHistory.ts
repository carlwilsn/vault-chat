// Throwaway picker proof data only. Existing conversation/session writer; no engine/model call.
import { appendMessage, createConv } from "../../server/engine/convs";

export async function seedPickerHistory(vault: string): Promise<void> {
  await createConv(vault, { source: "main", title: "Main" }, "Main", "main");
  await appendMessage(vault, "main", { mid: "picker-main-user", role: "user", content: "Keep my Main history while I change vault folders." });
  await appendMessage(vault, "main", { mid: "picker-main-assistant", role: "assistant", content: "Main history stays in this conversation." });
  const id = "picker-older-history";
  await createConv(vault, { source: "manual", title: "Earlier picker fixture chat" }, "Earlier picker fixture chat", id);
  await appendMessage(vault, id, { mid: "picker-older-user", role: "user", content: "An earlier conversation with its own stable message IDs." });
  await appendMessage(vault, id, { mid: "picker-older-assistant", role: "assistant", content: "This populated history must remain unchanged too." });
}

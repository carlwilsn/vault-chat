// Transport/helper regression, not browser or native-Tauri proof.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { clipboardImageDataUrls, readChatImage } from "../../src/chatImage.ts";
const root = makeTempVault("vc-chat-origin-client-");
const fake = installFakeTauri(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { fetchBoxFile } = await import("../../src/boxChat.ts");
const link = { url: "http://127.0.0.1:1234", token: null, vault: "viewer-b" };
const rel = ".vault-chat/visuals/proof.mp4";
test("chat transport carries actual conversation id, while ordinary file callers remain viewer-scoped", async () => {
  const urls: URL[] = [];
  fake.setHandler("box_get_json", ({url}) => {
    urls.push(new URL(url));
    return {status:200, body:JSON.stringify({base64:btoa("OWNER-A")})};
  });
  assert.equal(new TextDecoder().decode(await fetchBoxFile(link, rel, "unrelated-project-id")), "OWNER-A");
  await fetchBoxFile(link, rel);
  assert.equal(urls[0]!.searchParams.get("convId"), "unrelated-project-id");
  assert.equal(urls[0]!.searchParams.get("vault"), "viewer-b");
  assert.equal(urls[0]!.searchParams.get("path"), rel);
  assert.equal(urls[1]!.searchParams.has("convId"), false);
});
test("box media never displays a same-basename local/viewer asset, including denial and missing responses", async () => {
  let localReads = 0;
  const local = async () => { localReads++; return [66]; };
  const viewer = "C:/Users/wada2/vc/vaults/school2";
  const files = [{name:"proof.mp4",path:viewer + "/" + rel,is_dir:false}];
  for (const outcome of ["ok", "missing", "denied"]) {
    const result = await readChatImage(rel, viewer, files, {
      local,
      box: async () => async p => {
        assert.equal(p, rel);
        if (outcome === "denied") throw Error("HTTP 403");
        return outcome === "missing" ? null : [65];
      },
    });
    assert.deepEqual(result, outcome === "ok" ? {path:rel,bytes:[65]} : null);
  }
  assert.equal(localReads, 0);
});
test("local-only media still uses the laptop root and existing bounded filename recovery", async () => {
  const reads: string[] = [];
  const path = "C:/Users/wada2/vc/vaults/school2";
  const result = await readChatImage("chart.png", path, [{name:"chart.png",path:path + "/figs/chart.png",is_dir:false}], {
    box: async () => null,
    local: async p => { reads.push(p); if (reads.length === 1) throw Error("missing"); return [1]; },
  });
  assert.deepEqual(reads, [path + "/chart.png", path + "/figs/chart.png"]);
  assert.deepEqual(result?.bytes, [1]);
});

test("Windows client public image stays a native read even in a globally owned box conversation", async () => {
  const path = "C:/Users/wada2/vc/vaults/school2/figures/plot.png";
  const result = await readChatImage(path, "C:/Users/wada2/vc/projects/vault-chat", [], {
    local: async p => { assert.equal(p, path); return [80, 78, 71]; },
    box: async () => { throw Error("must not send Windows path to Linux"); },
  });
  assert.deepEqual(result, { path, bytes: [80, 78, 71] });
});

test("pointer-only outgoing captures upload actual bytes and MIME; a failed read never sends text-only", async () => {
  const { boxImageAttachments } = await import("../../src/boxChat.ts");
  const reads: string[] = [];
  fake.setHandler("read_binary_file", ({path}) => { reads.push(path); return [137,80,78,71]; });
  const image = await boxImageAttachments([{imageDataUrl:"",capturedFilePath:".vault-chat/captures/pasted.png"}], "C:/Users/wada2/vc/vaults/school2");
  assert.equal(reads[0], "C:/Users/wada2/vc/vaults/school2/.vault-chat/captures/pasted.png");
  assert.deepEqual(image, [{name:"pasted.png",mime:"image/png",dataBase64:btoa(String.fromCharCode(137,80,78,71))}]);
  fake.setHandler("read_binary_file", () => { throw Error("missing"); });
  await assert.rejects(boxImageAttachments([{imageDataUrl:"",capturedFilePath:".vault-chat/captures/gone.png"}], root), /missing/);
});

test("native HTML image paste accepts only bounded supported inline pixels", () => {
  const png = "data:image/png;base64,iVBORw==";
  assert.deepEqual(clipboardImageDataUrls([png, png, "data:image/jpeg;base64,/9j/"]), [png, "data:image/jpeg;base64,/9j/"]);
  assert.deepEqual(clipboardImageDataUrls(["https://example.test/photo.png", "file:///tmp/photo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!", "data:image/png;base64," + "A".repeat(20 * 1024 * 1024)]), []);
});

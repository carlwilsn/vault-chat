// PNG encoding off the page's thread (view.ts: the agent's pictures of the board after every save). WebKit encodes
// a canvas's toBlob on the main thread — 300+ ms for a 1600 px overview, long enough to hold up a pen coming down —
// so the bitmap comes here and an OffscreenCanvas encodes it. Message in: {id, bitmap}; out: {id, png} (base64) or
// {id, error}.
type In = { id: number; bitmap: ImageBitmap };

self.onmessage = async (e: MessageEvent<In>) => {
  const { id, bitmap } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await c.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    (self as unknown as Worker).postMessage({ id, png: btoa(bin) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};

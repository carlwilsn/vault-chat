/** Some native webviews expose copied browser images as HTML instead of File
 * items. Keep only inline supported pixels; never load a clipboard URL. */
export function clipboardImageDataUrls(sources: readonly string[]): string[] {
  return [...new Set(sources.filter(src =>
    src.length <= 20 * 1024 * 1024 && /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(src)
  ))].slice(0, 8);
}

/** File-backed chat media. The supplied box reader is bound to this conversation's log owner;
 * proof paths already contain their original proof/call identity. */
export async function readChatImage(
  path: string, vault: string | null,
  files: readonly { name: string; path: string; is_dir: boolean }[],
  io: {
    local: (path: string) => Promise<ArrayLike<number>>;
    box: () => Promise<((path: string) => Promise<ArrayLike<number> | null>) | null>;
  },
): Promise<{ path: string; bytes: ArrayLike<number> } | null> {
  // An explicit Windows path names a client asset, never a Linux server path.
  // Keep the existing native read guard; never remap it to a box/private path.
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    try { return { path, bytes: await io.local(path) }; } catch { return null; }
  }
  // A box conversation's media is made on the box. Never read the laptop's
  // same-named file first, nor hide an HTTP denial by displaying another image.
  try {
    const box = await io.box();
    if (box) {
      const bytes = await box(path.replace(/^\.\/+/, ""));
      return bytes ? { path, bytes } : null;
    }
  } catch { return null; }
  const absolute = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(path);
  if (!absolute && !vault) return null;
  const primary = absolute ? path : `${vault}${vault?.includes("\\") ? "\\" : "/"}${path.replace(/^\.\/+/, "")}`;
  const candidates = [primary];
  // Basename recovery is only for local-only chat, never box proof identities.
  if (!absolute) {
    const name = path.split(/[\/\\]/).pop();
    for (const f of files.filter(f => !f.is_dir && f.name === name).slice(0, 5)) {
      if (!candidates.includes(f.path)) candidates.push(f.path);
    }
  }
  for (const candidate of candidates) {
    try { return { path: candidate, bytes: await io.local(candidate) }; } catch { /* next */ }
  }
  return null;
}

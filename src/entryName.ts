// A name typed for a file or folder is one path segment. A "/" or "\" in it
// (Carl typed a date, "11/5") would otherwise make the rename create folders,
// so each separator becomes "-". Null: nothing usable to rename to.
export function entryName(raw: string): string | null {
  const name = raw.trim().replace(/[\\/]+/g, "-").replace(/-{2,}/g, "-");
  if (!name || name === "." || name === "..") return null;
  return name;
}

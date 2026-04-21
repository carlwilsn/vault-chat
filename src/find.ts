// Walk a container's DOM, wrap every case-insensitive match of `query`
// in <mark class="vc-find-match">, and return the list of mark nodes in
// document order. Caller is responsible for calling clearMatches() before
// re-running with a new query.

const MARK_CLASS = "vc-find-match";
const CURRENT_CLASS = "vc-find-current";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "INPUT",
]);

export function clearMatches(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}`);
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    // Merge adjacent text nodes that our unwrapping just created so a
    // subsequent search can find matches spanning old mark boundaries.
    parent.normalize();
  });
}

function shouldSkip(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.tagName === "MARK" && el.classList.contains(MARK_CLASS)) return true;
  // Hidden elements: skip to avoid matching off-screen text.
  const anyEl = el as HTMLElement;
  if (anyEl.offsetParent === null && getComputedStyle(anyEl).position !== "fixed") {
    // offsetParent is null for display:none and disconnected nodes.
    if (getComputedStyle(anyEl).display === "none") return true;
  }
  return false;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return shouldSkip(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      const t = node as Text;
      if (!t.nodeValue || !t.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) out.push(n as Text);
  }
  return out;
}

export function findMatches(root: HTMLElement, query: string): HTMLElement[] {
  clearMatches(root);
  if (!query) return [];
  const needle = query.toLowerCase();
  const nodes = collectTextNodes(root);
  const results: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let from = 0;
    const pieces: (string | HTMLElement)[] = [];
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      if (idx > from) pieces.push(text.slice(from, idx));
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS;
      mark.textContent = text.slice(idx, idx + needle.length);
      pieces.push(mark);
      results.push(mark);
      from = idx + needle.length;
    }
    if (pieces.length === 0) continue;
    if (from < text.length) pieces.push(text.slice(from));
    const frag = document.createDocumentFragment();
    for (const p of pieces) {
      frag.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
    }
    node.parentNode?.replaceChild(frag, node);
  }
  return results;
}

export function setCurrent(
  matches: HTMLElement[],
  index: number,
  scroll: boolean = true,
): void {
  matches.forEach((m, i) => {
    if (i === index) m.classList.add(CURRENT_CLASS);
    else m.classList.remove(CURRENT_CLASS);
  });
  if (scroll && matches[index]) {
    matches[index].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }
}

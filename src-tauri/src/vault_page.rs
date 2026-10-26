// The `vcpage` protocol: a vault HTML page's own files, served so the page
// loads exactly as it would opened from its folder.
//
// HtmlView renders a vault page as a sandboxed srcdoc iframe (scripts run in
// an opaque origin, isolated from the app). A srcdoc document has no address
// of its own, so every relative URL the page builds at run time — `new
// Audio('clips/01.mp3')`, `fetch('data.json')`, a CSS `url(font.woff2)` —
// resolved against the app's own origin and missed. HtmlView now gives the
// page a `<base href>` on this protocol at the page's folder, and the browser
// resolves every relative URL (markup, CSS and script alike) the normal way.
//
// The wall:
//   * Only folders the app registered (`vault_page_root`, the open vault) are
//     served; URLs are `/<root index>/<path inside the root>`.
//   * No `..`, no hidden segment (`.git`, `.vault-chat`, `.env`), no drive or
//     stream syntax; the canonical path must stay under the canonical root
//     (a symlink out of the vault is refused).
//   * CORS is opened only to the opaque origin (`null`) the sandboxed page
//     runs in, so the page can load its fonts, modules and data; the app's own
//     origin gains nothing it did not have.
//   * Byte ranges, so audio and video seek and stream.
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "vcpage";

static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Largest body for one open-ended range (`bytes=N-`): media asks again.
const MAX_RANGE: u64 = 2 * 1024 * 1024;

fn canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Allow a folder (the open vault) to be served; returns its index in URLs.
#[tauri::command]
pub fn vault_page_root(root: String) -> Result<usize, String> {
    let dir = canonical(Path::new(&root)).ok_or_else(|| format!("no such folder: {root}"))?;
    if !dir.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let mut roots = ROOTS.lock().map_err(|e| e.to_string())?;
    if let Some(i) = roots.iter().position(|r| *r == dir) {
        return Ok(i);
    }
    roots.push(dir);
    Ok(roots.len() - 1)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `/<root>/<a>/<b>` → the file, if it is inside a registered root and
/// passes the wall; `None` otherwise.
pub fn resolve(url_path: &str) -> Option<PathBuf> {
    let mut parts = url_path.trim_start_matches('/').split('/');
    let idx: usize = parts.next()?.parse().ok()?;
    let root = ROOTS.lock().ok()?.get(idx)?.clone();
    let mut p = root.clone();
    let mut any = false;
    for raw in parts {
        let seg = percent_decode(raw)?;
        if seg.is_empty() {
            continue;
        }
        if seg.starts_with('.')
            || seg.contains(['/', '\\', ':', '\0'])
            || !matches!(Path::new(&seg).components().next(), Some(Component::Normal(_)))
        {
            return None;
        }
        p.push(seg);
        any = true;
    }
    if !any {
        return None;
    }
    let real = canonical(&p)?;
    if !real.starts_with(&root) || !real.is_file() {
        return None;
    }
    Some(real)
}

pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "vtt" => "text/vtt",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` → an inclusive (start, end) within `len`.
pub fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() {
        (start + MAX_RANGE - 1).min(len - 1)
    } else {
        b.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        // The sandboxed page's origin is opaque ("null"): only it may read.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, content-length, accept-ranges")
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-cache")
}

pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let empty = |s: StatusCode| base(s).body(Vec::new()).unwrap();
    if request.method() == tauri::http::Method::OPTIONS {
        return base(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range")
            .body(Vec::new())
            .unwrap();
    }
    let Some(path) = resolve(request.uri().path()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_for(&path);
    let head = request.method() == tauri::http::Method::HEAD;
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    if let Some(r) = range {
        let Some((start, end)) = parse_range(r, len) else {
            return base(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap();
        };
        let n = end - start + 1;
        let mut buf = Vec::new();
        if !head {
            buf = vec![0u8; n as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
        return base(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, n.to_string())
            .body(buf)
            .unwrap();
    }
    let mut buf = Vec::new();
    if !head && file.read_to_end(&mut buf).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    base(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string())
        .body(buf)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("bytes=0-", 10 * 1024 * 1024), Some((0, MAX_RANGE - 1)));
    }

    #[test]
    fn the_wall() {
        let tmp = std::env::temp_dir().join(format!("vcpage-test-{}", std::process::id()));
        let vault = tmp.join("vault");
        std::fs::create_dir_all(vault.join("Physics 135/audio")).unwrap();
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        std::fs::write(vault.join("Physics 135/audio/00.mp3"), b"ID3").unwrap();
        std::fs::write(vault.join(".git/config"), b"x").unwrap();
        std::fs::write(tmp.join("outside.txt"), b"x").unwrap();
        let i = vault_page_root(vault.to_string_lossy().into_owned()).unwrap();
        assert_eq!(vault_page_root(vault.to_string_lossy().into_owned()).unwrap(), i);
        assert!(resolve(&format!("/{i}/Physics%20135/audio/00.mp3")).is_some());
        assert!(resolve(&format!("/{i}/.git/config")).is_none());
        assert!(resolve(&format!("/{i}/../outside.txt")).is_none());
        assert!(resolve(&format!("/{i}/%2E%2E/outside.txt")).is_none());
        assert!(resolve(&format!("/{i}/Physics%20135%2F..%2F..%2Foutside.txt")).is_none());
        assert!(resolve(&format!("/{i}/Physics%20135")).is_none());
        assert!(resolve(&format!("/{}/x", i + 99)).is_none());
        assert_eq!(mime_for(Path::new("a/B.MP3")), "audio/mpeg");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

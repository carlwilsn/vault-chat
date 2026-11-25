//! Inline web pages in the chat (src/inlineWeb.ts, src/InlineWebPage.tsx).
//!
//! `![label](https://example.com/post)` in a reply shows that public page live in the chat. Most real sites refuse to
//! be framed (X-Frame-Options / CSP frame-ancestors), so the laptop does not use an iframe: it lays a native browser
//! view (WebView2 on Windows, WKWebView on macOS) over the placeholder the chat draws, and the chat moves and sizes it
//! as it scrolls (`web_embed_place`). A native view is a top-level browser, so framing rules do not apply to it.
//!
//! Isolation, by construction: the view is made with wry directly, NOT through Tauri's webview manager, so it carries
//! none of Tauri's IPC (no `__TAURI_INTERNALS__`, no invoke key, no `ipc://`), none of the app's custom protocols
//! (`asset://`, `tauri://`), and no wry IPC handler: the page cannot call the app. Every view shares one browser
//! profile of its own (WebView2 user data folder `<app local data>/web-embed`, never in a vault and never the app's own),
//! kept across restarts so a site Carl signed in to stays signed in; `web_profile_clear` ("Sign out of all sites", the
//! workspace noun's signOutOfSites) wipes its cookies and storage. Nothing of the profile (cookies, tokens) is reported.
//! Top-level navigations go only to public http(s) hosts (never loopback, private/tailnet addresses, `*.ts.net`, or
//! `*.localhost`); popups load in the same view. Downloads are saved to `<the vault open>/.vault-chat/downloads/<name>`
//! (`name (1).ext` when taken; the vault is told by `web_profile_vault`), refused while no vault is open.
//! One exception, asked for by name (`web_embed_open_dev`): a viewer pane showing the agent's dev server through the
//! box's tailnet proxy (server/devProxy.ts, https on a `*.ts.net` host): that view may also go anywhere on that one
//! origin, and nowhere else private.
//! The page's bytes come straight from the site: nothing is proxied through the box, no credentials are added.
//!
//! Every wry call happens on the main thread (wry views are not Send), in `EMBEDS`.
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

/// The app event the views report on: {id, kind: load|title|blocked|download|downloaded|gone, url?, title?, loading?,
/// name?, path?, size?, ok?}. `download`: one started (name and path when it is being saved; neither when refused, and
/// then url to open it in the browser); `downloaded`: it ended (ok, the file's path and size).
pub const EVENT: &str = "web-embed";

struct Embed {
    window: String,
    view: WebView,
    /// The one non-public origin this view may go to (a dev server through the box), or None.
    origin: Option<String>,
}

thread_local! {
    static EMBEDS: RefCell<HashMap<String, Embed>> = RefCell::new(HashMap::new());
    static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };
}

#[derive(Clone, Serialize)]
struct EmbedEvent {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
}

fn emit(app: &AppHandle, id: &str, kind: &'static str, url: Option<String>, title: Option<String>, loading: Option<bool>) {
    let _ = app.emit(EVENT, EmbedEvent { id: id.to_string(), kind, url, title, loading, name: None, path: None, size: None, ok: None });
}

/// The vault open on the laptop (`web_profile_vault`): downloads go to its `.vault-chat/downloads`.
static VAULT: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Downloads under way: their source url → the paths they were given (a name stays taken until its download ends).
static DOWNLOADING: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// Where downloads are saved, under a vault.
pub const DOWNLOADS_DIR: &str = ".vault-chat/downloads";

/// A file name for a download: the name the browser suggests (the site's), else the url's last segment, made safe
/// for every file system (no separators, reserved characters or names, trailing dots or spaces; at most 150 chars).
pub fn download_name(suggested: &Path, url: &str) -> String {
    let from_url = || {
        Url::parse(url)
            .ok()
            .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(|x| x.to_string())))
            .map(|x| percent_decode(&x))
            .unwrap_or_default()
    };
    let raw = suggested.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.trim().is_empty()).unwrap_or_else(from_url);
    let mut name: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).trim_start_matches('.').to_string();
    if name.chars().count() > 150 {
        let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().to_string()).filter(|e| e.len() <= 12);
        let keep: String = name.chars().take(150 - ext.as_ref().map_or(0, |e| e.len() + 1)).collect();
        name = match ext {
            Some(e) => format!("{keep}.{e}"),
            None => keep,
        };
    }
    if name.is_empty() {
        name = "download".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name = format!("_{name}");
    }
    name
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// `dir/name`, or `dir/stem (n).ext` with the first n that is free (`taken`: a file there, or a download under way).
pub fn unique_path(dir: &Path, name: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let p = Path::new(name);
    let (stem, ext) = match (p.file_stem(), p.extension()) {
        (Some(s), Some(e)) if !s.is_empty() => (s.to_string_lossy().to_string(), format!(".{}", e.to_string_lossy())),
        _ => (name.to_string(), String::new()),
    };
    for n in 1..10_000 {
        let next = dir.join(format!("{stem} ({n}){ext}"));
        if !taken(&next) {
            return next;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

/// Where the source (a url: only its host is said, never its query, which may carry a token).
fn source_host(url: &str) -> Option<String> {
    Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_string()))
}

/// A download starting in view `id`: the path it is saved to (true), or refused (false, no vault open).
fn download_started(app: &AppHandle, id: &str, from: String, path: &mut PathBuf) -> bool {
    let vault = VAULT.lock().ok().and_then(|v| v.clone());
    let Some(vault) = vault else {
        emit(app, id, "download", Some(from), None, None);
        return false;
    };
    let dir = vault.join(DOWNLOADS_DIR);
    if std::fs::create_dir_all(&dir).is_err() {
        emit(app, id, "download", Some(from), None, None);
        return false;
    }
    let name = download_name(path, &from);
    let Ok(mut busy) = DOWNLOADING.lock() else { return false };
    let to = unique_path(&dir, &name, |p| p.exists() || busy.iter().any(|(_, b)| b == p));
    busy.push((from.clone(), to.clone()));
    drop(busy);
    *path = to.clone();
    let saved = to.file_name().map(|n| n.to_string_lossy().to_string());
    let _ = app.emit(EVENT, EmbedEvent { id: id.to_string(), kind: "download", url: source_host(&from), title: None, loading: None, name: saved, path: Some(to.to_string_lossy().to_string()), size: None, ok: None });
    true
}

/// A download in view `id` ended: the file it left (its path and size), or that it failed.
fn download_ended(app: &AppHandle, id: &str, from: String, done: Option<PathBuf>, ok: bool) {
    let given = DOWNLOADING.lock().ok().and_then(|mut busy| busy.iter().position(|(u, _)| *u == from).map(|i| busy.remove(i).1));
    let Some(path) = done.or(given) else { return };
    let size = if ok { std::fs::metadata(&path).ok().map(|m| m.len()) } else { None };
    let name = path.file_name().map(|n| n.to_string_lossy().to_string());
    let _ = app.emit(EVENT, EmbedEvent { id: id.to_string(), kind: "downloaded", url: source_host(&from), title: None, loading: None, name, path: Some(path.to_string_lossy().to_string()), size, ok: Some(ok) });
}

/// The vault open on the laptop (None: none): where the views' downloads are saved from now on.
#[tauri::command]
pub fn web_profile_vault(vault: Option<String>) -> Result<(), String> {
    let next = match vault.map(PathBuf::from) {
        Some(p) if p.is_absolute() && p.is_dir() => Some(p),
        Some(_) => return Err("not a folder".into()),
        None => None,
    };
    *VAULT.lock().map_err(|_| "busy".to_string())? = next;
    Ok(())
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad embed id".into());
    }
    Ok(())
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || o[0] == 0
        || o[0] >= 240
        // 100.64.0.0/10: carrier-grade NAT, and every Tailscale address (the box, the laptop).
        || (o[0] == 100 && (o[1] & 0xc0) == 64))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s0 = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7 unique local (Tailscale's fd7a:115c:a1e0::/48 too), fe80::/10 link local.
        || (s0 & 0xfe00) == 0xfc00
        || (s0 & 0xffc0) == 0xfe80)
}

/// A page the inline view may show: http(s), no credentials in the URL, a public host. Not the laptop itself, the
/// local network, the tailnet (the box) or a single-label name.
pub fn public_web_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => public_v4(v4),
            IpAddr::V6(v6) => public_v6(v6),
        };
    }
    !(host.is_empty()
        || !host.contains('.')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
        || host.ends_with(".home.arpa")
        || host.ends_with(".ts.net"))
}

/// The box's dev server through its tailnet proxy (server/devProxy.ts): https, no credentials, a `*.ts.net` host.
pub fn box_dev_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            let h = h.trim_end_matches('.').to_ascii_lowercase();
            h.ends_with(".ts.net") && h.len() > ".ts.net".len()
        })
}

fn allowed_nav(raw: &str, origin: Option<&str>) -> bool {
    if raw == "about:blank" {
        return true;
    }
    let Ok(u) = Url::parse(raw) else { return false };
    public_web_url(&u) || origin.is_some_and(|o| u.origin().ascii_serialization() == o)
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x.max(0.0), y.max(0.0)).into(),
        size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
}

/// Runs `f` on the main thread (where the views live) and hands back its result.
async fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "the app's main thread dropped the request".to_string())?
}

fn with_embed<T>(id: &str, f: impl FnOnce(&Embed) -> Result<T, String>) -> Result<T, String> {
    EMBEDS.with(|m| match m.borrow().get(id) {
        Some(e) => f(e),
        None => Err("no such inline page".into()),
    })
}

/// Lays the page `id` over the chat in the calling window at (x, y, width, height) (logical px, the window's client
/// area): made the first time (showing `url`), moved and resized after that (its own navigation is kept).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn web_embed_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "not a web address".to_string())?;
    if !public_web_url(&parsed) {
        return Err("only public http(s) pages open inline".into());
    }
    open_embed(app, window, id, parsed, None, (x, y, width, height), visible).await
}

/// As `web_embed_open`, for the agent's dev server through the box's tailnet proxy (an https `*.ts.net` address,
/// server/devProxy.ts) in a viewer pane: the view may go anywhere on that origin, and to public pages.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn web_embed_open_dev(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "not a web address".to_string())?;
    if !box_dev_url(&parsed) {
        return Err("only a dev server through the box (https on its tailnet name) opens here".into());
    }
    let origin = parsed.origin().ascii_serialization();
    open_embed(app, window, id, parsed, Some(origin), (x, y, width, height), visible).await
}

async fn open_embed(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    parsed: Url,
    origin: Option<String>,
    (x, y, width, height): (f64, f64, f64, f64),
    visible: bool,
) -> Result<(), String> {
    check_id(&id)?;
    if cfg!(not(any(target_os = "windows", target_os = "macos"))) {
        // wry's child views need X11 on Linux (and would sit outside the GTK layout): the chat shows a link there.
        return Err("inline web pages need the Windows or macOS app".into());
    }
    let data_dir = profile_dir(&app)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let label = window.label().to_string();
        let exists = EMBEDS.with(|m| m.borrow().get(&id).map(|e| e.window == label));
        match exists {
            Some(true) => {
                return with_embed(&id, |e| {
                    e.view.set_bounds(bounds(x, y, width, height)).map_err(|e| e.to_string())?;
                    e.view.set_visible(visible).map_err(|e| e.to_string())
                })
            }
            // The same id in another window (the chat moved to its popout): start over there.
            Some(false) => {
                EMBEDS.with(|m| m.borrow_mut().remove(&id));
            }
            None => {}
        }
        let (a_nav, a_new, a_load, a_title, a_dl, a_done) = (app2.clone(), app2.clone(), app2.clone(), app2.clone(), app2.clone(), app2.clone());
        let (i_nav, i_new, i_load, i_title, i_dl, i_done) = (id.clone(), id.clone(), id.clone(), id.clone(), id.clone(), id.clone());
        let (o_nav, o_new) = (origin.clone(), origin.clone());
        let view = CONTEXT.with(|c| {
            let mut c = c.borrow_mut();
            let ctx = c.get_or_insert_with(|| WebContext::new(Some(data_dir)));
            // Not incognito: the profile in `data_dir` is kept, so sign-ins survive a restart (web_profile_clear wipes it).
            WebViewBuilder::new_with_web_context(ctx)
                .with_url(parsed.as_str())
                .with_bounds(bounds(x, y, width, height))
                .with_visible(visible)
                .with_devtools(false)
                .with_clipboard(true)
                .with_focused(false)
                .with_autoplay(false)
                .with_navigation_handler(move |to| {
                    let ok = allowed_nav(&to, o_nav.as_deref());
                    if !ok {
                        emit(&a_nav, &i_nav, "blocked", Some(to), None, None);
                    }
                    ok
                })
                // target=_blank links and window.open: the same view goes there (a public page only).
                .with_new_window_req_handler(move |to, _features| {
                    if allowed_nav(&to, o_new.as_deref()) {
                        let id3 = i_new.clone();
                        let _ = a_new.run_on_main_thread(move || {
                            let _ = with_embed(&id3, |e| e.view.load_url(&to).map_err(|e| e.to_string()));
                        });
                    } else {
                        emit(&a_new, &i_new, "blocked", Some(to), None, None);
                    }
                    NewWindowResponse::Deny
                })
                .with_on_page_load_handler(move |ev, at| {
                    emit(&a_load, &i_load, "load", Some(at), None, Some(matches!(ev, PageLoadEvent::Started)));
                })
                .with_document_title_changed_handler(move |title| {
                    emit(&a_title, &i_title, "title", None, Some(title), None);
                })
                .with_download_started_handler(move |from, path| download_started(&a_dl, &i_dl, from, path))
                .with_download_completed_handler(move |from, path, ok| download_ended(&a_done, &i_done, from, path, ok))
                .build_as_child(&window)
                .map_err(|e| e.to_string())
        })?;
        EMBEDS.with(|m| m.borrow_mut().insert(id, Embed { window: label, view, origin }));
        Ok(())
    })
    .await
}

/// The views' one browser profile: `<app local data>/web-embed` (never in a vault, never the app's own).
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("web-embed");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir)
}

thread_local! {
    /// A hidden view made only to reach the profile when no page is open (web_profile_clear), kept until it is done.
    static CLEARER: RefCell<Option<WebView>> = const { RefCell::new(None) };
}

/// "Sign out of all sites": wipes the views' profile (cookies, storage, cache, history) and reloads the pages open.
/// Returns how many pages were open. Nothing of what was there is read or reported.
#[tauri::command]
pub async fn web_profile_clear(app: AppHandle, window: tauri::WebviewWindow) -> Result<u32, String> {
    if cfg!(not(any(target_os = "windows", target_os = "macos"))) {
        return Err("web pages need the Windows or macOS app".into());
    }
    let data_dir = profile_dir(&app)?;
    let open = on_main(&app, move || {
        // Any open view reaches the whole profile; with none, a hidden blank one is made for it.
        let cleared = EMBEDS.with(|m| m.borrow().values().next().map(|e| e.view.clear_all_browsing_data().map_err(|e| e.to_string())));
        match cleared {
            Some(r) => r?,
            None => {
                let view = CONTEXT.with(|c| {
                    let mut c = c.borrow_mut();
                    let ctx = c.get_or_insert_with(|| WebContext::new(Some(data_dir)));
                    WebViewBuilder::new_with_web_context(ctx)
                        .with_url("about:blank")
                        .with_bounds(bounds(0.0, 0.0, 1.0, 1.0))
                        .with_visible(false)
                        .with_devtools(false)
                        .with_focused(false)
                        .build_as_child(&window)
                        .map_err(|e| e.to_string())
                })?;
                view.clear_all_browsing_data().map_err(|e| e.to_string())?;
                CLEARER.with(|c| *c.borrow_mut() = Some(view));
            }
        }
        Ok(EMBEDS.with(|m| m.borrow().len() as u32))
    })
    .await?;
    // The wipe finishes in the browser on its own: the hidden view stays a moment, then the pages show signed out.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    on_main(&app, || {
        CLEARER.with(|c| c.borrow_mut().take());
        EMBEDS.with(|m| {
            for e in m.borrow().values() {
                let _ = e.view.reload();
            }
        });
        Ok(())
    })
    .await?;
    Ok(open)
}

/// Moves / resizes / shows / hides a page already open. Unknown ids are not an error (the chat may race a close).
#[tauri::command]
pub async fn web_embed_place(app: AppHandle, id: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    check_id(&id)?;
    on_main(&app, move || {
        EMBEDS.with(|m| {
            if let Some(e) = m.borrow().get(&id) {
                if visible {
                    e.view.set_bounds(bounds(x, y, width, height)).map_err(|e| e.to_string())?;
                }
                e.view.set_visible(visible).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    })
    .await
}

/// back | forward | reload | focus | blur, or `load` with a new public `url`.
#[tauri::command]
pub async fn web_embed_go(app: AppHandle, id: String, action: String, url: Option<String>) -> Result<(), String> {
    check_id(&id)?;
    if action == "load" {
        let to = url.unwrap_or_default();
        return on_main(&app, move || {
            with_embed(&id, |e| {
                if !allowed_nav(&to, e.origin.as_deref()) {
                    return Err("only public http(s) pages open inline".into());
                }
                e.view.load_url(&to).map_err(|e| e.to_string())
            })
        })
        .await;
    }
    on_main(&app, move || {
        with_embed(&id, |e| {
            let r = match action.as_str() {
                "back" => e.view.evaluate_script("history.back()"),
                "forward" => e.view.evaluate_script("history.forward()"),
                "reload" => e.view.reload(),
                "focus" => e.view.focus(),
                "blur" => e.view.focus_parent(),
                _ => return Err("unknown action".into()),
            };
            r.map_err(|e| e.to_string())
        })
    })
    .await
}

/// The page's address now (after its own navigation), for "Open in browser".
#[tauri::command]
pub async fn web_embed_url(app: AppHandle, id: String) -> Result<String, String> {
    check_id(&id)?;
    on_main(&app, move || with_embed(&id, |e| e.view.url().map_err(|e| e.to_string()))).await
}

/// Closes one page (`id`), or with no id every page in the calling window (the chat starting over: a reload must
/// never leave a native view stranded on screen).
#[tauri::command]
pub async fn web_embed_close(app: AppHandle, window: tauri::WebviewWindow, id: Option<String>) -> Result<(), String> {
    if let Some(id) = &id {
        check_id(id)?;
    }
    let label = window.label().to_string();
    let app2 = app.clone();
    on_main(&app, move || {
        let gone: Vec<String> = EMBEDS.with(|m| {
            let mut m = m.borrow_mut();
            let ids: Vec<String> = match &id {
                Some(id) => m.contains_key(id).then(|| vec![id.clone()]).unwrap_or_default(),
                None => m.iter().filter(|(_, e)| e.window == label).map(|(k, _)| k.clone()).collect(),
            };
            for k in &ids {
                m.remove(k);
            }
            ids
        });
        for k in gone {
            emit(&app2, &k, "gone", None, None, None);
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        public_web_url(&Url::parse(s).unwrap())
    }

    #[test]
    fn public_pages_only() {
        assert!(ok("https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html"));
        assert!(ok("http://example.com/"));
        assert!(ok("https://93.184.215.14/"));
        for bad in [
            "http://localhost:5173/",
            "http://127.0.0.1/",
            "http://0x7f.1/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://172.20.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.101.102.103/",
            "http://[fd7a:115c:a1e0::1]/",
            "https://thinkbox.tail1234.ts.net/p/x.html",
            "http://tauri.localhost/",
            "http://asset.localhost/C:/x",
            "http://printer.local/",
            "http://intranet/",
            "https://user:pw@example.com/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
        ] {
            assert!(!allowed_nav(bad, None), "{bad} must be refused");
        }
        assert!(allowed_nav("about:blank", None));
    }

    #[test]
    fn a_dev_server_through_the_box() {
        let dev = Url::parse("https://thinkbox.tail1234.ts.net:5173/").unwrap();
        assert!(box_dev_url(&dev));
        let origin = dev.origin().ascii_serialization();
        assert!(allowed_nav("https://thinkbox.tail1234.ts.net:5173/x?y=1", Some(&origin)));
        assert!(allowed_nav("https://example.com/", Some(&origin)));
        assert!(!allowed_nav("https://thinkbox.tail1234.ts.net:8848/", Some(&origin)));
        assert!(!allowed_nav("http://localhost:5173/", Some(&origin)));
        for bad in ["http://thinkbox.tail1234.ts.net:5173/", "https://ts.net/", "https://user:pw@thinkbox.tail1234.ts.net/", "https://example.com/"] {
            assert!(!box_dev_url(&Url::parse(bad).unwrap()), "{bad} is not a dev server through the box");
        }
    }

    #[test]
    fn download_names() {
        let none = Path::new("");
        assert_eq!(download_name(Path::new("C:/Users/c/Downloads/Lecture 3.pdf"), "https://x.com/a?token=s"), "Lecture 3.pdf");
        assert_eq!(download_name(none, "https://x.com/files/My%20Notes.pdf?sig=abc"), "My Notes.pdf");
        assert_eq!(download_name(none, "https://x.com/"), "download");
        assert_eq!(download_name(Path::new("a:b*c?.txt"), ""), "a_b_c_.txt");
        assert_eq!(download_name(Path::new("..."), ""), "download");
        assert_eq!(download_name(Path::new("con.txt"), ""), "_con.txt");
        assert_eq!(download_name(Path::new(".hidden "), ""), "hidden");
        let long = format!("{}.pdf", "a".repeat(300));
        let n = download_name(Path::new(&long), "");
        assert_eq!(n.chars().count(), 150);
        assert!(n.ends_with(".pdf"));
    }

    #[test]
    fn unique_names() {
        let dir = Path::new("/v/.vault-chat/downloads");
        let taken = [dir.join("a.pdf"), dir.join("a (1).pdf"), dir.join("README")];
        let t = |p: &Path| taken.iter().any(|x| x == p);
        assert_eq!(unique_path(dir, "b.pdf", t), dir.join("b.pdf"));
        assert_eq!(unique_path(dir, "a.pdf", t), dir.join("a (2).pdf"));
        assert_eq!(unique_path(dir, "README", t), dir.join("README (1)"));
        assert_eq!(source_host("https://drive.google.com/x?token=abc").as_deref(), Some("drive.google.com"));
    }

    #[test]
    fn ids() {
        assert!(check_id("w-abc123").is_ok());
        assert!(check_id("").is_err());
        assert!(check_id("../x").is_err());
    }
}

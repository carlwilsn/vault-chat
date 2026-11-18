//! The macOS menu bar. Tauri's default one has Window > Minimize on Cmd+M, and a
//! menu accelerator is taken by AppKit before the webview sees the key, so the
//! app's own Cmd+M (capture a region, src/shortcuts.ts `edit.marquee`) only ever
//! minimized the window. This is the default menu (app, Edit, View, Window) with
//! Minimize still there but on no key; every other app shortcut (Cmd+K, Cmd+L,
//! Cmd+Shift+F, …) was free of the default menu already. The Edit menu stays:
//! WKWebView's Cmd+C/V/X/Z/A come from it.
//!
//! Wired in lib.rs on macOS only; compiled everywhere so a Linux check builds it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

/// The id of Window > Minimize (no accelerator; its click minimizes the focused window).
pub const MINIMIZE_ID: &str = "vc-minimize";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let minimize = MenuItem::with_id(app, MINIMIZE_ID, "Minimize", true, None::<&str>)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &minimize,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() != MINIMIZE_ID {
        return;
    }
    for (_, w) in app.webview_windows() {
        if w.is_focused().unwrap_or(false) {
            let _ = w.minimize();
            return;
        }
    }
}

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    // The commit the baked frontend was built from, and its time (src-tauri/src/core_loader.rs): a box-built core bundle
    // no newer than this is never taken over the installer's own. CI builds a version-bump commit ("vX.Y.Z [skip ci]")
    // on top of the accepted main commit: that main commit is the one the box built its bundles from.
    let mut rev = "HEAD".to_string();
    if let Some(subject) = git(&["log", "-1", "--format=%s", "HEAD"]) {
        let s = subject.trim();
        if s.starts_with('v') && s.ends_with(" [skip ci]") {
            rev = "HEAD^".to_string();
        }
    }
    if let Some(line) = git(&["log", "-1", "--format=%H %ct", &rev]) {
        let mut it = line.split_whitespace();
        if let (Some(h), Some(t)) = (it.next(), it.next()) {
            println!("cargo:rustc-env=VC_BAKED_COMMIT={h}");
            println!("cargo:rustc-env=VC_BAKED_TIME={t}");
        }
    }
    tauri_build::build()
}

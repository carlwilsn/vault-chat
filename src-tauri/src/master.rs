//! The vault-chat folder on this laptop (src/master.ts; the box's is server/master.ts):
//! `<folder>/vaults/<name>` and `<folder>/projects/<name>`, each its own git repo, synced with the box by the
//! one box-sync cycle (box_sync.rs, one per repo). Here: making a repo there (a new vault, or one the box has
//! that this laptop lacks, from the box's hub), and the migration's copy + verify (the original is only read).

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::{run_git, run_git_timeout};

fn full(o: &str, e: &str, c: i32, what: &str) -> String {
    format!("{} failed (exit {}): {}{}", what, c, e.trim(), if o.trim().is_empty() { String::new() } else { format!("\n{}", o.trim()) })
}

fn git_ok(dir: &str, args: &[&str], what: &str) -> Result<String, String> {
    let (o, e, c) = run_git(dir, args)?;
    if c != 0 {
        return Err(full(&o, &e, c, what));
    }
    Ok(o.trim().to_string())
}

/// Make `dest` a repo synced with the box (idempotent): `git init` on `branch`, remote `box` at `remote_url`
/// (fetching only its `box` branch), the box's content checked out when the hub has it, and `origin` set to the
/// project's own remote when it has one. Returns what it did.
pub fn repo_init(dest: &str, remote_url: &str, branch: &str, origin_url: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(dest);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    let fresh = !p.join(".git").exists();
    if fresh {
        git_ok(dest, &["init", "-q", "-b", branch], "git init")?;
    }
    if remote_url.trim().is_empty() {
        // No box yet: a repo here only; the folder's file names the box later.
        return Ok(if fresh { format!("new, empty, on {} (no box yet)", branch) } else { "already here".into() });
    }
    let (cur, _, c) = run_git(dest, &["config", "--get", "remote.box.url"])?;
    if c != 0 {
        git_ok(dest, &["remote", "add", "box", remote_url], "git remote add box")?;
    } else if cur.trim() != remote_url {
        git_ok(dest, &["remote", "set-url", "box", remote_url], "git remote set-url box")?;
    }
    let _ = run_git(dest, &["config", "--replace-all", "remote.box.fetch", "+refs/heads/box:refs/remotes/box/box"]);
    if let Some(o) = origin_url.filter(|o| !o.trim().is_empty()) {
        let (cur, _, c) = run_git(dest, &["config", "--get", "remote.origin.url"])?;
        if c != 0 {
            git_ok(dest, &["remote", "add", "origin", o], "git remote add origin")?;
        } else if cur.trim() != o {
            git_ok(dest, &["remote", "set-url", "origin", o], "git remote set-url origin")?;
        }
    }
    if !fresh {
        return Ok("already here".into());
    }
    let (_, e, c) = run_git_timeout(dest, &["fetch", "--no-tags", "box"], 600)?;
    if c != 0 && !e.contains("couldn't find remote ref") {
        return Err(full("", &e, c, "git fetch box"));
    }
    let has_box = matches!(run_git(dest, &["rev-parse", "--verify", "-q", "refs/remotes/box/box"]), Ok((_, _, 0)));
    if has_box {
        git_ok(dest, &["checkout", "-q", "-B", branch, "refs/remotes/box/box"], "git checkout")?;
        return Ok(format!("cloned from the box on {}", branch));
    }
    Ok(format!("new, empty, on {}", branch))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CopyCheck {
    pub ok: bool,
    pub files: [u64; 2],
    pub bytes: [u64; 2],
    pub head: [Option<String>; 2],
    pub branch: [Option<String>; 2],
    pub problems: Vec<String>,
}

fn count(dir: &Path, files: &mut u64, bytes: &mut u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            count(&e.path(), files, bytes);
        } else {
            *files += 1;
            if !ft.is_symlink() {
                *bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
}

fn head_of(dir: &str) -> (Option<String>, Option<String>) {
    let h = run_git(dir, &["rev-parse", "HEAD"]).ok().filter(|r| r.2 == 0).map(|r| r.0.trim().to_string());
    let b = run_git(dir, &["symbolic-ref", "--short", "HEAD"]).ok().filter(|r| r.2 == 0).map(|r| r.0.trim().to_string());
    (h, b)
}

/// The copy against the original: the same files (count and bytes), HEAD and branch.
pub fn verify_copy(from: &str, to: &str) -> CopyCheck {
    let (mut fa, mut ba, mut fb, mut bb) = (0, 0, 0, 0);
    count(Path::new(from), &mut fa, &mut ba);
    count(Path::new(to), &mut fb, &mut bb);
    let (ha, bra) = head_of(from);
    let (hb, brb) = head_of(to);
    let mut problems = Vec::new();
    if fa != fb {
        problems.push(format!("{} files in the original, {} in the copy", fa, fb));
    }
    if ba != bb {
        problems.push(format!("{} bytes in the original, {} in the copy", ba, bb));
    }
    if ha.is_none() || ha != hb {
        problems.push(format!("HEAD {:?} in the original, {:?} in the copy", ha, hb));
    }
    if bra != brb {
        problems.push(format!("branch {:?} in the original, {:?} in the copy", bra, brb));
    }
    CopyCheck { ok: problems.is_empty(), files: [fa, fb], bytes: [ba, bb], head: [ha, hb], branch: [bra, brb], problems }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {}", to.display(), e))?;
    for e in std::fs::read_dir(from).map_err(|e| format!("{}: {}", from.display(), e))?.flatten() {
        let ft = e.file_type().map_err(|e| e.to_string())?;
        let dst = to.join(e.file_name());
        if ft.is_dir() {
            copy_dir(&e.path(), &dst)?;
        } else if ft.is_symlink() {
            // Kept as a link where the system allows it; else its target's bytes.
            let target = std::fs::read_link(e.path()).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &dst).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            {
                let _ = target;
                std::fs::copy(e.path(), &dst).map_err(|e| e.to_string())?;
            }
        } else {
            std::fs::copy(e.path(), &dst).map_err(|e| format!("{}: {}", e, dst.display()))?;
        }
    }
    Ok(())
}

/// Copy a repo whole (every file, `.git` and its history) to `to`, then verify. Never over an existing folder;
/// the original is only read.
pub fn copy_repo(from: &str, to: &str) -> Result<CopyCheck, String> {
    let f = PathBuf::from(from);
    let t = PathBuf::from(to);
    if !f.join(".git").exists() {
        return Err(format!("{} is not a git repo", from));
    }
    if t.exists() {
        return Err(format!("{} already exists: refusing to copy over it (nothing was changed)", to));
    }
    copy_dir(&f, &t)?;
    Ok(verify_copy(from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn copy_verifies_and_never_overwrites() {
        let base = std::env::temp_dir().join(format!("vc_master_copy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("school2");
        std::fs::create_dir_all(src.join("notes")).unwrap();
        std::fs::write(src.join("notes/a.md"), "a\n").unwrap();
        git_ok(&s(&src), &["init", "-q", "-b", "master"], "init").unwrap();
        git_ok(&s(&src), &["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], "add").unwrap();
        git_ok(&s(&src), &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"], "commit").unwrap();
        std::fs::write(src.join("draft.md"), "uncommitted\n").unwrap();
        let dst = base.join("vc/vaults/school2");
        let c = copy_repo(&s(&src), &s(&dst)).unwrap();
        assert!(c.ok, "{:?}", c.problems);
        assert_eq!(c.head[0], c.head[1]);
        assert_eq!(std::fs::read_to_string(dst.join("draft.md")).unwrap(), "uncommitted\n");
        assert!(copy_repo(&s(&src), &s(&dst)).unwrap_err().contains("already exists"));
        assert!(src.join("notes/a.md").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

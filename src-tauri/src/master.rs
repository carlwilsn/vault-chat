//! The vault-chat folder on this laptop (src/master.ts; the box's is server/master.ts):
//! `<folder>/vaults/<name>` and `<folder>/projects/<name>`, each its own git repo, synced with the box by the
//! one box-sync cycle (box_sync.rs, one per repo). Here: making a repo there (a new vault, or one the box has
//! that this laptop lacks, from the box's hub).

use std::path::PathBuf;

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

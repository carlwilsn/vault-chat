// Projects as a vault folder, laptop side. The layout is src/agentProjects.ts's
// (the box server does the same in server/context/projects.ts; a server test
// holds these strings equal to the TypeScript ones):
//
// - projects live in `<vault>/agent-projects/<slug>/`;
// - they used to live in `<vault>/.vault-chat/projects/<slug>/`: move them,
//   never overwriting (a project not there yet moves whole; otherwise file by
//   file — a missing file moves, an identical one is dropped, a different one
//   stays put and is reported). The box makes the same moves from the same
//   files, so git sees one rename on both sides and the sync merges cleanly;
// - the first time a vault has the folder, `agent-projects` joins the hide list
//   (`.vaultchatignore`, the file tree's "Hidden files") and is recorded in
//   `.vault-chat/hidden-by-default`; once recorded it is never hidden again, so
//   unhiding it in the Hidden files modal sticks.

use serde::Serialize;
use std::path::Path;

pub(crate) const AGENT_PROJECTS_DIR: &str = "agent-projects";
pub(crate) const LEGACY_PROJECTS_DIR: &str = ".vault-chat/projects";
pub(crate) const HIDE_DEFAULTS_FILE: &str = ".vault-chat/hidden-by-default";
const HIDE_DEFAULTS_HEADER: &str = "# Hidden by default once by vault-chat; unhiding one keeps it shown.\n";

#[derive(Serialize, Default, Debug)]
pub(crate) struct Prepared {
    pub moved: Vec<String>,
    pub kept: Vec<String>,
    pub hidden: bool,
}

fn entries(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.replace('\\', "/").trim_matches('/').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn with_nl(mut s: String) -> String {
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn move_merge(src: &Path, dst: &Path, rel: &str, out: &mut Prepared) -> std::io::Result<()> {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(src, dst)?;
        out.moved.push(rel.to_string());
    } else if src.is_dir() && dst.is_dir() {
        for e in std::fs::read_dir(src)? {
            let name = e?.file_name().to_string_lossy().to_string();
            move_merge(&src.join(&name), &dst.join(&name), &format!("{rel}/{name}"), out)?;
        }
        if std::fs::read_dir(src)?.next().is_none() {
            std::fs::remove_dir(src)?;
        }
    } else if src.is_file() && dst.is_file() && std::fs::read(src)? == std::fs::read(dst)? {
        std::fs::remove_file(src)?;
        out.moved.push(format!("{rel} (already there)"));
    } else {
        out.kept.push(rel.to_string());
    }
    Ok(())
}

/// Move `.vault-chat/projects/*` into `agent-projects/`. Idempotent.
pub(crate) fn migrate(vault: &Path, out: &mut Prepared) -> std::io::Result<()> {
    let legacy = vault.join(LEGACY_PROJECTS_DIR);
    if !legacy.is_dir() {
        return Ok(());
    }
    let mut names: Vec<String> = std::fs::read_dir(&legacy)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    for name in names {
        move_merge(&legacy.join(&name), &vault.join(AGENT_PROJECTS_DIR).join(&name), &name, out)?;
    }
    if std::fs::read_dir(&legacy)?.next().is_none() {
        std::fs::remove_dir(&legacy)?;
    }
    Ok(())
}

/// Hide `agent-projects` once (see the header). True when it was added to the hide list now.
pub(crate) fn hide_once(vault: &Path, hide_file: &str) -> std::io::Result<bool> {
    if !vault.join(AGENT_PROJECTS_DIR).is_dir() {
        return Ok(false);
    }
    let rec_path = vault.join(HIDE_DEFAULTS_FILE);
    let record = std::fs::read_to_string(&rec_path).unwrap_or_default();
    if entries(&record).iter().any(|e| e == AGENT_PROJECTS_DIR) {
        return Ok(false);
    }
    let hide_path = vault.join(hide_file);
    let hide = std::fs::read_to_string(&hide_path).unwrap_or_default();
    let add = !entries(&hide).iter().any(|e| e == AGENT_PROJECTS_DIR);
    if add {
        std::fs::write(&hide_path, format!("{}{}\n", with_nl(hide), AGENT_PROJECTS_DIR))?;
    }
    let record = if record.is_empty() { HIDE_DEFAULTS_HEADER.to_string() } else { with_nl(record) };
    if let Some(parent) = rec_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&rec_path, format!("{record}{AGENT_PROJECTS_DIR}\n"))?;
    Ok(add)
}

pub(crate) fn prepare(vault: &Path, hide_file: &str) -> Result<Prepared, String> {
    let mut out = Prepared::default();
    migrate(vault, &mut out).map_err(|e| format!("moving projects: {e}"))?;
    out.hidden = hide_once(vault, hide_file).map_err(|e| format!("hiding agent-projects: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vc-agent-projects-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(d.join(".vault-chat")).unwrap();
        d
    }

    fn write(p: PathBuf, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    #[test]
    fn moves_legacy_projects_hides_once_and_is_idempotent() {
        let v = tmp("move");
        write(v.join(".vault-chat/projects/coconut/project.md"), "# Coconut\n");
        write(v.join(".vault-chat/projects/coconut/memory.md"), "# Memory\n");
        write(v.join(".vault-chat/projects/coconut/.keep"), "");
        write(v.join(".vaultchatignore"), "private/notes.md");
        let r = prepare(&v, ".vaultchatignore").unwrap();
        assert_eq!(r.moved, vec!["coconut"]);
        assert!(r.kept.is_empty());
        assert!(r.hidden);
        assert_eq!(fs::read_to_string(v.join("agent-projects/coconut/project.md")).unwrap(), "# Coconut\n");
        assert!(v.join("agent-projects/coconut/.keep").exists());
        assert!(!v.join(".vault-chat/projects").exists(), "nothing left behind");
        assert_eq!(fs::read_to_string(v.join(".vaultchatignore")).unwrap(), "private/notes.md\nagent-projects\n");
        assert_eq!(
            fs::read_to_string(v.join(HIDE_DEFAULTS_FILE)).unwrap(),
            format!("{HIDE_DEFAULTS_HEADER}agent-projects\n")
        );
        // Again: nothing to do.
        let r2 = prepare(&v, ".vaultchatignore").unwrap();
        assert!(r2.moved.is_empty() && !r2.hidden);
        assert_eq!(fs::read_to_string(v.join(".vaultchatignore")).unwrap(), "private/notes.md\nagent-projects\n");
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn unhidden_stays_unhidden() {
        let v = tmp("unhide");
        fs::create_dir_all(v.join("agent-projects/alpha")).unwrap();
        assert!(prepare(&v, ".vaultchatignore").unwrap().hidden);
        // Carl unhides it in the Hidden files modal.
        fs::write(v.join(".vaultchatignore"), "").unwrap();
        assert!(!prepare(&v, ".vaultchatignore").unwrap().hidden);
        assert_eq!(fs::read_to_string(v.join(".vaultchatignore")).unwrap(), "");
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn no_folder_no_hide_entry() {
        let v = tmp("none");
        let r = prepare(&v, ".vaultchatignore").unwrap();
        assert!(!r.hidden && r.moved.is_empty());
        assert!(!v.join(".vaultchatignore").exists());
        assert!(!v.join(HIDE_DEFAULTS_FILE).exists());
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn never_overwrites_merges_file_by_file() {
        let v = tmp("merge");
        write(v.join(".vault-chat/projects/beta/project.md"), "# Beta\n");
        write(v.join(".vault-chat/projects/beta/memory.md"), "# old memory\n");
        write(v.join(".vault-chat/projects/beta/plan.md"), "# Plan\n");
        write(v.join("agent-projects/beta/project.md"), "# Beta\n");
        write(v.join("agent-projects/beta/memory.md"), "# new memory\n");
        let r = prepare(&v, ".vaultchatignore").unwrap();
        assert_eq!(r.kept, vec!["beta/memory.md"]);
        assert!(r.moved.contains(&"beta/plan.md".to_string()));
        assert!(r.moved.contains(&"beta/project.md (already there)".to_string()));
        assert_eq!(fs::read_to_string(v.join("agent-projects/beta/memory.md")).unwrap(), "# new memory\n");
        assert_eq!(fs::read_to_string(v.join(".vault-chat/projects/beta/memory.md")).unwrap(), "# old memory\n");
        assert!(!v.join(".vault-chat/projects/beta/plan.md").exists());
        let _ = fs::remove_dir_all(&v);
    }
}

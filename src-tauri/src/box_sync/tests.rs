//! Box sync on real temp repos: a bare repo stands in for the box's
//! `<box>/git/<vault>.git`, a second clone plays the box's working copy on
//! branch `box`, and a third bare repo stands in for GitHub.

use super::*;
use crate::run_git;
use std::path::{Path, PathBuf};

struct Rig {
    base: PathBuf,
    laptop: PathBuf,
    boxwc: PathBuf,
    bare: PathBuf,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let (o, e, c) = run_git(&s(dir), args).expect("spawn git");
    assert_eq!(c, 0, "git {:?} in {} failed:\n{}\n{}", args, dir.display(), e, o);
    o.trim().to_string()
}

fn git_code(dir: &Path, args: &[&str]) -> i32 {
    run_git(&s(dir), args).expect("spawn git").2
}

fn write(dir: &Path, rel: &str, body: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn read(dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(dir.join(rel)).unwrap_or_default()
}

fn ident(dir: &Path) {
    git(dir, &["config", "user.name", "t"]);
    git(dir, &["config", "user.email", "t@t"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn sync_json(boxhost: &Path) -> String {
    format!("{{\"hub\":\"laptop\",\"box\":\"{}\",\"vault\":\"school2\"}}\n", s(boxhost))
}

/// Laptop on master with a first sync done; box working copy on `box`.
fn rig(name: &str) -> Rig {
    let base = std::env::temp_dir().join(format!("vc_boxsync_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let boxhost = base.join("boxhost");
    let bare = boxhost.join("git").join("school2.git");
    let laptop = base.join("laptop");
    let boxwc = base.join("boxwc");
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::create_dir_all(&laptop).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "master"]);
    git(&laptop, &["init", "-q", "-b", "master"]);
    ident(&laptop);
    write(&laptop, ".vault-chat/sync.json", &sync_json(&boxhost));
    write(&laptop, "note.md", "line one\nline two\nline three\n");
    write(
        &laptop,
        ".vault-chat/conversations/chat1.jsonl",
        "{\"id\":\"chat1\",\"source\":\"manual\"}\n{\"role\":\"user\",\"content\":\"hi\"}\n",
    );
    git(&laptop, &["add", "-A"]);
    git(&laptop, &["commit", "-q", "-m", "seed"]);
    let r = box_sync_cycle(&s(&laptop));
    assert!(r.configured);
    assert!(r.error.is_none(), "first cycle: {:?}", r.error);
    // The box's working copy: a clone on branch `box`.
    git(&base, &["clone", "-q", &s(&bare), "boxwc"]);
    ident(&boxwc);
    git(&boxwc, &["checkout", "-q", "-b", "box"]);
    git(&boxwc, &["push", "-q", "origin", "box"]);
    Rig { base, laptop, boxwc, bare }
}

impl Rig {
    fn box_commit(&self, files: &[(&str, &str)], msg: &str) {
        for (rel, body) in files {
            write(&self.boxwc, rel, body);
        }
        git(&self.boxwc, &["add", "-A"]);
        git(&self.boxwc, &["commit", "-q", "-m", msg]);
        git(&self.boxwc, &["push", "-q", "origin", "box"]);
    }
    fn laptop_commit(&self, files: &[(&str, &str)], msg: &str) {
        for (rel, body) in files {
            write(&self.laptop, rel, body);
        }
        git(&self.laptop, &["add", "-A"]);
        git(&self.laptop, &["commit", "-q", "-m", msg]);
    }
    fn cycle(&self) -> BoxSyncReport {
        box_sync_cycle(&s(&self.laptop))
    }
    fn head(&self) -> String {
        git(&self.laptop, &["rev-parse", "HEAD"])
    }
    fn done(self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn no_sidecars(dir: &Path) {
    for e in walkdir::WalkDir::new(dir).into_iter().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        assert!(!n.ends_with(".conflict"), "sidecar written: {}", e.path().display());
    }
}

#[test]
fn reads_sync_json_and_builds_the_remote_url() {
    let base = std::env::temp_dir().join(format!("vc_boxsync_cfg_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    write(
        &base,
        ".vault-chat/sync.json",
        "{\"hub\":\"laptop\",\"box\":\"https://thinkbox.tailbb647d.ts.net/\",\"vault\":\"school2\"}",
    );
    let c = box_config(&s(&base)).expect("config");
    assert_eq!(c.remote_url(), "https://thinkbox.tailbb647d.ts.net/git/school2.git");
    write(&base, ".vault-chat/sync.json", "{\"hub\":\"laptop\"}");
    assert!(box_config(&s(&base)).is_none(), "no box key = old mode");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn pushes_only_master_and_fetches_box() {
    let r = rig("pushonly");
    git(&r.laptop, &["branch", "laptop-only"]);
    r.box_commit(&[("from-box.md", "box\n")], "box work");
    let before_box = git(&r.bare, &["rev-parse", "refs/heads/box"]);
    r.laptop_commit(&[("from-laptop.md", "laptop\n")], "laptop work");
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    // The bare has master (= laptop's) and box (= the box's, untouched); no
    // other laptop branch was pushed.
    let heads = git(&r.bare, &["for-each-ref", "--format=%(refname)", "refs/heads"]);
    let mut heads: Vec<&str> = heads.lines().collect();
    heads.sort();
    assert_eq!(heads, vec!["refs/heads/box", "refs/heads/master"]);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/box"]), before_box, "laptop never writes box");
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head());
    // box was fetched into refs/remotes/box/box only.
    assert_eq!(git(&r.laptop, &["rev-parse", BOX_REF]), before_box);
    assert_eq!(rep.changes_waiting, 0);
    r.done();
}

#[test]
fn clean_merge_brings_box_into_master() {
    let r = rig("clean");
    r.box_commit(
        &[
            ("from-box.md", "box\n"),
            (
                ".vault-chat/conversations/chat1.jsonl",
                "{\"id\":\"chat1\",\"source\":\"manual\"}\n{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"user\",\"content\":\"from the phone\"}\n",
            ),
        ],
        "box work",
    );
    // Uncommitted laptop edits: the cycle commits them first, then merges.
    write(&r.laptop, "note.md", "line one\nline two\nline three\nlaptop line\n");
    write(
        &r.laptop,
        ".vault-chat/conversations/chat1.jsonl",
        "{\"id\":\"chat1\",\"source\":\"manual\"}\n{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"user\",\"content\":\"from the laptop\"}\n",
    );
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    assert!(rep.committed && rep.merged, "{:?}", rep);
    assert!(rep.conflict.is_none());
    assert_eq!(read(&r.laptop, "from-box.md"), "box\n");
    assert!(read(&r.laptop, "note.md").contains("laptop line"));
    let chat = read(&r.laptop, ".vault-chat/conversations/chat1.jsonl");
    assert!(chat.contains("from the phone") && chat.contains("from the laptop"), "union keeps both: {}", chat);
    assert_eq!(git_code(&r.laptop, &["merge-base", "--is-ancestor", BOX_REF, "HEAD"]), 0);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head(), "merge pushed");
    assert_eq!(git(&r.laptop, &["status", "--porcelain"]), "");
    r.done();
}

#[test]
fn conflict_closes_the_gate_and_leaves_master_alone() {
    let r = rig("conflict");
    r.box_commit(&[("note.md", "line one\nBOX two\nline three\n")], "box edit");
    r.laptop_commit(&[("note.md", "line one\nLAPTOP two\nline three\n")], "laptop edit");
    let head = r.head();
    let rep = r.cycle();
    assert_eq!(rep.conflict.as_ref().map(|c| c.files.clone()), Some(vec!["note.md".to_string()]));
    assert!(!rep.merged);
    assert_eq!(r.head(), head, "master untouched");
    assert_eq!(read(&r.laptop, "note.md"), "line one\nLAPTOP two\nline three\n");
    assert!(!r.laptop.join(".git/MERGE_HEAD").exists(), "no merge left behind");
    assert_eq!(git(&r.laptop, &["status", "--porcelain"]), "", "working tree clean");
    no_sidecars(&r.laptop);
    // master itself still reaches the box (push is not gated).
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), head);
    // The gate stays closed on the next cycle, with the same `since`.
    let since = rep.conflict.unwrap().since;
    let rep2 = r.cycle();
    assert_eq!(rep2.conflict.map(|c| c.since), Some(since));
    assert_eq!(r.head(), head);
    r.done();
}

#[test]
fn gate_reopens_after_resolution_and_never_aborts_a_hand_merge() {
    let r = rig("resolve");
    r.box_commit(&[("note.md", "line one\nBOX two\nline three\n")], "box edit");
    r.laptop_commit(&[("note.md", "line one\nLAPTOP two\nline three\n")], "laptop edit");
    assert!(r.cycle().conflict.is_some());
    // Someone starts resolving by hand: a cycle must not abort it.
    assert_ne!(git_code(&r.laptop, &["merge", BOX_REF]), 0);
    assert!(r.laptop.join(".git/MERGE_HEAD").exists());
    let mid = r.cycle();
    assert!(r.laptop.join(".git/MERGE_HEAD").exists(), "hand merge survived: {:?}", mid);
    // Resolve: keep both lines, commit.
    write(&r.laptop, "note.md", "line one\nLAPTOP two\nBOX two\nline three\n");
    git(&r.laptop, &["add", "note.md"]);
    git(&r.laptop, &["commit", "-q", "--no-edit"]);
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    assert!(rep.conflict.is_none(), "gate reopened");
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head());
    // And it keeps merging afterwards.
    r.box_commit(&[("later.md", "later\n")], "box later");
    let rep = r.cycle();
    assert!(rep.merged && rep.conflict.is_none(), "{:?}", rep);
    assert_eq!(read(&r.laptop, "later.md"), "later\n");
    r.done();
}

#[test]
fn mission_zone_is_never_written_by_the_laptop() {
    let r = rig("zone");
    let mission = "{\"id\":\"m1\",\"source\":\"mission\",\"missionState\":\"RUNNING\"}\n{\"role\":\"assistant\",\"content\":\"box turn\"}\n";
    r.box_commit(
        &[
            (".vault-chat/conversations/m1.jsonl", mission),
            (".vault-chat/supervisor/mind.md", "epoch 17\n"),
            (".vault-chat/schedules.jsonl", "{\"id\":\"s1\"}\n"),
        ],
        "box mission state",
    );
    let rep = r.cycle();
    assert!(rep.merged, "{:?}", rep);
    // The laptop scribbles on the zone, and edits a note.
    write(
        &r.laptop,
        ".vault-chat/conversations/m1.jsonl",
        "{\"id\":\"m1\",\"source\":\"mission\",\"missionState\":\"DONE\"}\n{\"role\":\"user\",\"content\":\"laptop steer\"}\n",
    );
    write(&r.laptop, ".vault-chat/supervisor/mind.md", "epoch 3 STALE\n");
    write(&r.laptop, ".vault-chat/schedules.jsonl", "{\"id\":\"s1\"}\n{\"id\":\"laptop\"}\n");
    write(&r.laptop, "note.md", "line one\nline two\nline three\nnote edit\n");
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    for p in [".vault-chat/conversations/m1.jsonl", ".vault-chat/supervisor/mind.md", ".vault-chat/schedules.jsonl"] {
        assert_eq!(
            git(&r.bare, &["show", &format!("master:{}", p)]),
            git(&r.bare, &["show", &format!("box:{}", p)]),
            "{} on master must be the box's",
            p
        );
    }
    assert!(git(&r.bare, &["show", "master:note.md"]).contains("note edit"), "content still flows");

    // conversations_write_all in box mode never writes a mission thread.
    let v = s(&r.laptop);
    let lines = vec![
        "{\"id\":\"m1\",\"source\":\"mission\",\"missionState\":\"KILLED\",\"messages\":[]}".to_string(),
        "{\"id\":\"chat2\",\"source\":\"manual\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}".to_string(),
    ];
    tauri::async_runtime::block_on(crate::conversations_write_all(v.clone(), lines)).unwrap();
    assert_eq!(read(&r.laptop, ".vault-chat/conversations/m1.jsonl"), mission);
    assert!(r.laptop.join(".vault-chat/conversations/chat2.jsonl").exists());
    assert_eq!(crate::vault_sync_role(v), "follower", "box mode = follower: no local scheduler/missions");

    // A zone-only conflict (a stale laptop commit that bypassed the sanitize)
    // resolves to the box's side instead of closing the gate.
    r.laptop_commit(&[(".vault-chat/supervisor/mind.md", "laptop wrote this\n")], "stale zone");
    r.box_commit(&[(".vault-chat/supervisor/mind.md", "epoch 18\n")], "box epoch");
    let rep = r.cycle();
    assert!(rep.conflict.is_none() && rep.merged, "{:?}", rep);
    assert_eq!(read(&r.laptop, ".vault-chat/supervisor/mind.md"), "epoch 18\n");
    r.done();
}

#[test]
fn files_over_50mb_stay_out_of_git() {
    let r = rig("big");
    let f = std::fs::File::create(r.laptop.join("data.bin")).unwrap();
    f.set_len(BOX_MAX_FILE_BYTES + 1).unwrap();
    drop(f);
    write(&r.laptop, "small.md", "small\n");
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    assert_eq!(rep.big_files.iter().map(|b| b.path.as_str()).collect::<Vec<_>>(), vec!["data.bin"]);
    assert_ne!(git_code(&r.laptop, &["cat-file", "-e", "HEAD:data.bin"]), 0, "big file not committed");
    assert_eq!(git_code(&r.laptop, &["cat-file", "-e", "HEAD:small.md"]), 0);
    assert!(read(&r.laptop, ".git/info/exclude").contains("/data.bin"));
    // A tracked file that grows past the limit is left unstaged, not committed.
    r.laptop_commit(&[("grows.bin", "tiny")], "tiny");
    let f = std::fs::OpenOptions::new().write(true).open(r.laptop.join("grows.bin")).unwrap();
    f.set_len(BOX_MAX_FILE_BYTES + 10).unwrap();
    drop(f);
    let rep = r.cycle();
    assert!(rep.big_files.iter().any(|b| b.path == "grows.bin"), "{:?}", rep.big_files);
    assert_eq!(git(&r.laptop, &["show", "HEAD:grows.bin"]), "tiny");
    // The agent's commit path obeys the same rule.
    let committed = tauri::async_runtime::block_on(crate::git_commit_all(s(&r.laptop), "agent turn".into(), Some(true))).unwrap();
    assert!(committed.is_none(), "nothing committable: {:?}", committed);
    assert_eq!(git(&r.laptop, &["show", "HEAD:grows.bin"]), "tiny");
    // Once it shrinks again, the exclude entry goes away and it syncs.
    std::fs::write(r.laptop.join("data.bin"), "now small\n").unwrap();
    std::fs::write(r.laptop.join("grows.bin"), "small again").unwrap();
    let rep = r.cycle();
    assert!(rep.big_files.is_empty(), "{:?}", rep.big_files);
    assert!(!read(&r.laptop, ".git/info/exclude").contains("data.bin"));
    assert_eq!(git(&r.bare, &["show", "master:data.bin"]), "now small");
    r.done();
}

#[test]
fn nested_repo_automation_is_off() {
    let r = rig("nested");
    let nested = r.laptop.join("proj");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q", "-b", "main"]);
    ident(&nested);
    write(&nested, "a.txt", "a\n");
    git(&nested, &["add", "-A"]);
    git(&nested, &["commit", "-q", "-m", "nested"]);
    let nested_head = git(&nested, &["rev-parse", "HEAD"]);
    write(&nested, "a.txt", "a\nedited\n");
    let _ = r.cycle();
    assert_eq!(git(&nested, &["rev-parse", "HEAD"]), nested_head, "no commit inside the nested repo");
    assert_ne!(git(&nested, &["status", "--porcelain"]), "", "its edit is left alone");
    assert_eq!(git(&nested, &["remote"]), "", "no remote/fork created for it");
    assert_eq!(git(&r.laptop, &["config", "--get", "fetch.recurseSubmodules"]), "false");
    r.done();
}

#[test]
fn github_backup_pushes_master_and_box_and_only_warns() {
    let r = rig("github");
    let gh = r.base.join("github.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "master"]);
    git(&r.laptop, &["remote", "add", "github", &s(&gh)]);
    r.box_commit(&[("from-box.md", "box\n")], "box work");
    let rep = r.cycle();
    assert!(rep.ok && rep.github_warning.is_none(), "{:?} {:?}", rep.error, rep.github_warning);
    assert!(rep.github_pushed_at.is_some());
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/master"]), r.head());
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/box"]), git(&r.bare, &["rev-parse", "refs/heads/box"]));
    r.done();

    // A broken github remote is a warning; the sync itself still succeeds.
    let r = rig("githubfail");
    git(&r.laptop, &["remote", "add", "github", &s(&r.base.join("nope.git"))]);
    write(&r.laptop, "x.md", "x\n");
    let rep = r.cycle();
    assert!(rep.ok && rep.error.is_none(), "{:?}", rep.error);
    assert!(rep.github_warning.is_some());
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head());
    r.done();
}

#[test]
fn box_unreachable_reports_full_error_and_changes_waiting() {
    let r = rig("unreach");
    write(&r.laptop, ".vault-chat/sync.json", &sync_json(&r.base.join("no-such-box")));
    write(&r.laptop, "a.md", "a\n");
    let rep = r.cycle();
    assert!(!rep.ok);
    assert_eq!(rep.error_kind.as_deref(), Some("unreachable"), "{:?}", rep.error);
    assert!(rep.error.as_deref().unwrap_or("").contains("git fetch box failed"));
    assert!(rep.changes_waiting >= 1, "{:?}", rep);
    assert_eq!(git_code(&r.laptop, &["cat-file", "-e", "HEAD:a.md"]), 0, "still committed locally");
    r.done();
}

#[test]
fn without_sync_json_nothing_changes() {
    let base = std::env::temp_dir().join(format!("vc_boxsync_old_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    git(&base, &["init", "-q", "-b", "master"]);
    ident(&base);
    write(&base, "a.md", "a\n");
    let v = s(&base);
    let rep = box_sync_cycle(&v);
    assert!(!rep.configured && !rep.committed);
    assert_eq!(git(&base, &["remote"]), "", "no box remote added");
    assert_ne!(git_code(&base, &["rev-parse", "--verify", "HEAD"]), 0, "nothing committed");
    assert_eq!(crate::vault_sync_role(v.clone()), "writer");
    // Mission threads are still written (this machine may host missions).
    let lines = vec!["{\"id\":\"m9\",\"source\":\"mission\",\"messages\":[]}".to_string()];
    tauri::async_runtime::block_on(crate::conversations_write_all(v, lines)).unwrap();
    assert!(base.join(".vault-chat/conversations/m9.jsonl").exists());
    let _ = std::fs::remove_dir_all(&base);
}

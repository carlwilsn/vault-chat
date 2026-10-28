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
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    assert!(rep.committed && rep.merged, "{:?}", rep);
    assert!(rep.conflict.is_none());
    assert_eq!(read(&r.laptop, "from-box.md"), "box\n");
    assert!(read(&r.laptop, "note.md").contains("laptop line"));
    // An older box commit of a conversation file still merges like any file (nothing is deleted).
    assert!(read(&r.laptop, ".vault-chat/conversations/chat1.jsonl").contains("from the phone"));
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

    let v = s(&r.laptop);
    assert_eq!(crate::vault_sync_role_sync(v), "follower", "box mode = follower: no local scheduler/missions");

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
    let committed = tauri::async_runtime::block_on(crate::git_commit_all(s(&r.laptop), "agent turn".into(), Some(true), None, None, None)).unwrap();
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
    // The backup runs in the background, after the box push; the next cycle reports it.
    assert!(rep.github_pushed_at.is_none(), "not on the cycle's critical path");
    wait_github_backup(&s(&r.laptop));
    let rep = r.cycle();
    assert!(rep.github_pushed_at.is_some() && rep.github_warning.is_none(), "{:?}", rep.github_warning);
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/master"]), r.head());
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/box"]), git(&r.bare, &["rev-parse", "refs/heads/box"]));
    r.done();

    // A broken github remote is a warning; the sync itself still succeeds.
    let r = rig("githubfail");
    git(&r.laptop, &["remote", "add", "github", &s(&r.base.join("nope.git"))]);
    write(&r.laptop, "x.md", "x\n");
    let rep = r.cycle();
    assert!(rep.ok && rep.error.is_none(), "{:?}", rep.error);
    wait_github_backup(&s(&r.laptop));
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
    assert_eq!(crate::vault_sync_role_sync(v.clone()), "writer");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn github_failure_stays_reported_between_debounced_attempts() {
    let r = rig("githubsticky");
    git(&r.laptop, &["remote", "add", "github", &s(&r.base.join("nope.git"))]);
    r.cycle();
    wait_github_backup(&s(&r.laptop));
    let first = r.cycle();
    assert!(first.github_warning.is_some());
    // Within the 10-minute window: no new attempt, but the warning is still there.
    write(&r.laptop, "y.md", "y\n");
    let second = r.cycle();
    assert!(second.ok);
    assert_eq!(second.github_warning, first.github_warning);
    r.done();
}

/// [phase 2] Box mode: the box authors EVERY conversation (the laptop has no
/// conversations writer), a delete is a tombstone only, and a stray laptop
/// edit to a chat is reset to the box's before the commit.
#[test]
fn box_mode_never_writes_conversations() {
    let r = rig("convs");
    let chat = "{\"id\":\"c9\",\"source\":\"manual\",\"title\":\"box chat\"}\n{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"assistant\",\"content\":\"from the box\"}\n";
    r.box_commit(&[(".vault-chat/conversations/c9.jsonl", chat)], "box chat turn");
    let rep = r.cycle();
    assert!(rep.merged, "{:?}", rep);
    assert_eq!(read(&r.laptop, ".vault-chat/conversations/c9.jsonl"), chat);
    let v = s(&r.laptop);

    // 2. A delete is a tombstone only; the file stays for the box to remove.
    tauri::async_runtime::block_on(crate::conversation_delete(v.clone(), "c9".to_string())).unwrap();
    assert!(r.laptop.join(".vault-chat/conversations/c9.jsonl").exists());
    assert!(read(&r.laptop, ".vault-chat/conversations-deleted.jsonl").contains("\"c9\""));

    // 3. Conversations never go through git from here: a stray edit to a
    //    conversation file is never staged (kept on disk, never deleted), and the
    //    box's log, were it here, is never committed. The tombstone still flows.
    let stray = "{\"id\":\"c9\",\"source\":\"manual\"}\n{\"role\":\"user\",\"content\":\"stray\"}\n";
    write(&r.laptop, ".vault-chat/conversations/c9.jsonl", stray);
    write(&r.laptop, ".vault-chat/events/c9.jsonl", "{\"seq\":1}\n");
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    assert_eq!(
        git(&r.bare, &["show", "master:.vault-chat/conversations/c9.jsonl"]),
        git(&r.bare, &["show", "box:.vault-chat/conversations/c9.jsonl"]),
    );
    assert_eq!(read(&r.laptop, ".vault-chat/conversations/c9.jsonl"), stray);
    assert_eq!(git(&r.laptop, &["ls-files", ".vault-chat/events"]), "");
    assert!(git(&r.bare, &["show", "master:.vault-chat/conversations-deleted.jsonl"]).contains("\"c9\""));

    no_sidecars(&r.laptop);
    r.done();
}

#[test]
fn connect_writes_sync_json_and_keeps_other_fields() {
    let out = sync_json_with_box(Some("{\"extra\":1,\"box\":\"https://old.example\"}"), "https://thinkbox.tailbb647d.ts.net/", "school2", "thinkbox").unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["hub"], "laptop");
    assert_eq!(v["box"], "https://thinkbox.tailbb647d.ts.net");
    assert_eq!(v["vault"], "school2");
    assert_eq!(v["name"], "thinkbox");
    assert_eq!(v["extra"], 1);
    // No file yet, no name: just the three fields.
    let v: serde_json::Value = serde_json::from_str(&sync_json_with_box(None, "https://b.example", "a_b-c.1", " ").unwrap()).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 3);
    // Bad addresses and names are refused.
    assert!(sync_json_with_box(None, "thinkbox", "school2", "").is_err());
    for bad in ["", "..", ".hidden", "a/b", r"a\b", "x.git", "has space", &"x".repeat(65)] {
        assert!(sync_json_with_box(None, "https://b.example", bad, "").is_err(), "{bad:?} accepted");
    }
}

#[test]
fn disconnect_removes_only_the_box() {
    let out = sync_json_without_box("{\"hub\":\"laptop\",\"box\":\"https://b.example\",\"vault\":\"school2\",\"name\":\"b\",\"extra\":true}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("box").is_none() && v.get("hub").is_none() && v.get("name").is_none());
    assert_eq!(v["vault"], "school2");
    assert_eq!(v["extra"], true);
    // Garbage in → an empty object, never a panic.
    assert_eq!(sync_json_without_box("not json").trim(), "{}");
}

#[test]
fn connect_then_disconnect_flips_box_mode_at_once() {
    let base = std::env::temp_dir().join(format!("vc_boxsync_connect_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let v = s(&base);
    assert!(!box_mode_cached(&v));
    connect_box(&v, "https://thinkbox.tailbb647d.ts.net", "school2", "thinkbox").unwrap();
    let c = box_config(&v).expect("connected");
    assert_eq!(c.remote_url(), "https://thinkbox.tailbb647d.ts.net/git/school2.git");
    assert_eq!(c.name.as_deref(), Some("thinkbox"));
    assert!(box_mode_cached(&v), "the cache forgets on connect");
    disconnect_box(&v).unwrap();
    assert!(box_config(&v).is_none());
    assert!(!box_mode_cached(&v), "the cache forgets on disconnect");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn discovery_parses_tailscale_status_and_health() {
    let status = r#"{"Self":{"HostName":"laptop","DNSName":"laptop.t.ts.net.","Online":true},
      "Peer":{"k1":{"HostName":"thinkbox","DNSName":"thinkbox.t.ts.net.","Online":true},
              "k2":{"HostName":"tower","DNSName":"tower.t.ts.net.","Online":false},
              "k3":{"HostName":"phone","DNSName":"","Online":true}}}"#;
    assert_eq!(online_peers(status), vec![("thinkbox".to_string(), "https://thinkbox.t.ts.net".to_string())]);
    assert!(online_peers("garbage").is_empty());
    let b = parse_health("thinkbox", "https://thinkbox.t.ts.net", r#"{"ok":true,"app":"vault-chat-server","name":"thinkbox","version":"1.2.0","hasKey":false}"#).unwrap();
    assert_eq!((b.name.as_str(), b.version.as_deref(), b.online, b.has_key), ("thinkbox", Some("1.2.0"), true, false));
    // An older server (no app field) still counts; its key comes from keys.openrouter.
    let old = parse_health("tb", "https://tb", r#"{"ok":true,"version":"1.0.0","keys":{"openrouter":true}}"#).unwrap();
    assert!(old.has_key && old.name == "tb");
    assert!(parse_health("x", "https://x", r#"{"status":"ok"}"#).is_none());
    assert!(parse_health("x", "https://x", "<html>").is_none());
}

#[test]
fn tailscale_state_from_status_json() {
    assert_eq!(tailscale_backend_state(r#"{"BackendState":"Running","Peer":{}}"#).as_deref(), Some("Running"));
    let up = tailscale_state_of(true, r#"{"Version":"1.80.0","BackendState":"Running","Self":{}}"#);
    assert!(up.installed && up.connected && up.state == "Running");
    // Disconnected in the app: the CLI still prints JSON (and exits non-zero).
    for s in ["Stopped", "NeedsLogin", "Starting", "NoState"] {
        let st = tailscale_state_of(true, &format!(r#"{{"BackendState":"{}"}}"#, s));
        assert!(st.installed && !st.connected && st.state == s, "{s}");
    }
    // The service isn't running: nothing on stdout.
    let down = tailscale_state_of(true, "");
    assert!(down.installed && !down.connected && down.state == "NoService");
    assert!(!tailscale_state_of(true, "garbage").connected);
    // Not installed: say nothing about Tailscale.
    let none = tailscale_state_of(false, "");
    assert!(!none.installed && !none.connected && !none.can_open);
    assert_eq!(up.can_open, cfg!(any(windows, target_os = "macos")));
}

/// vault_changed's pull: the box's commit is merged here, nothing is pushed
/// yet (the next full cycle does it).
#[test]
fn pull_cycle_merges_without_pushing() {
    let r = rig("pull");
    let master_on_box = git(&r.bare, &["rev-parse", "refs/heads/master"]);
    r.box_commit(&[("dog.svg", "<svg fill=\"purple\"/>\n")], "voice edit");
    r.laptop_commit(&[("mine.md", "laptop\n")], "laptop work");
    let rep = box_pull_cycle(&s(&r.laptop));
    assert!(rep.ok, "pull: {:?}", rep.error);
    assert!(rep.merged);
    assert_eq!(rep.merged_paths, vec!["dog.svg".to_string()]);
    assert_eq!(read(&r.laptop, "dog.svg"), "<svg fill=\"purple\"/>\n");
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), master_on_box, "no push in a pull");
    let full = r.cycle();
    assert!(full.ok, "full: {:?}", full.error);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head(), "the next full cycle pushes");
    r.done();
}

#[test]
fn status_v2_and_config_z_parse() {
    let out = "# branch.oid 1234\0# branch.head master\0\
1 .M N... 100644 100644 100644 aaa bbb notes/a b.md\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.md\0old.md\0\
u UU N... 100644 100644 100644 100644 a b c both.md\0\
? Ad Hoc/new file.md\0";
    let st = parse_status_v2(out);
    assert_eq!(st.branch.as_deref(), Some("master"));
    let paths: Vec<(&str, char, bool)> = st.entries.iter().map(|e| (e.path.as_str(), e.x, e.untracked)).collect();
    assert_eq!(
        paths,
        vec![("notes/a b.md", '.', false), ("new.md", 'R', false), ("both.md", 'U', false), ("Ad Hoc/new file.md", '?', true)]
    );
    assert_eq!(parse_status_v2("# branch.oid (initial)\0# branch.head (detached)\0").branch, None);

    let cfg = parse_config_z("remote.box.url\nhttps://b/git/v.git\0remote.box.fetch\n+refs/heads/box:refs/remotes/box/box\0user.name\nA\0user.name\nCarl\0");
    assert_eq!(cfg.get("remote.box.url"), Some("https://b/git/v.git"));
    assert_eq!(cfg.all("remote.box.fetch"), vec!["+refs/heads/box:refs/remotes/box/box"]);
    assert_eq!(cfg.identity().0, "Carl", "the last value wins, as in git config --get");
    assert_eq!(cfg.identity().1, APP_GIT_EMAIL);
}

/// Git LFS installs hooks that run ~10 git processes per commit and per push.
/// The sync skips them only while they are LFS's alone and LFS holds nothing.
#[test]
fn lfs_hooks_are_skipped_only_while_lfs_is_unused() {
    let r = rig("lfshooks");
    let v = s(&r.laptop);
    let hooks = r.laptop.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let marker = r.base.join("hook-ran");
    let lfs_hook = format!(
        "#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || {{ echo >&2 \"no lfs\"; exit 2; }}\ngit lfs post-commit \"$@\"\n"
    );
    std::fs::write(hooks.join("post-commit"), &lfs_hook).unwrap();
    assert!(is_lfs_hook(&lfs_hook));
    r.cycle();
    assert!(sync_hooks_skippable(&v), "only LFS hooks, no LFS objects");
    // LFS objects appear: the hooks run again (the pre-push must upload them).
    std::fs::create_dir_all(r.laptop.join(".git/lfs/objects/ab")).unwrap();
    assert!(!sync_hooks_skippable(&v));
    std::fs::remove_dir_all(r.laptop.join(".git/lfs")).unwrap();
    // A hook of the user's own: never skipped.
    std::fs::write(
        hooks.join("post-merge"),
        format!("#!/bin/sh\necho ran > '{}'\n", s(&marker)),
    )
    .unwrap();
    assert!(!sync_hooks_skippable(&v));
    r.done();
}

/// A cycle with nothing to do asks git as little as it can: no push when the
/// box already has master, no commit, still the fetch (and so still merges).
#[test]
fn idle_cycle_skips_the_push_and_still_merges() {
    let r = rig("idle");
    let first = r.cycle();
    assert!(first.ok, "{:?}", first.error);
    let master = git(&r.bare, &["rev-parse", "refs/heads/master"]);
    let idle = r.cycle();
    assert!(idle.ok && !idle.committed && !idle.merged && idle.changes_waiting == 0, "{:?}", idle);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), master);
    // The box writes: the next idle cycle merges it.
    r.box_commit(&[("voice.md", "from the box\n")], "voice note");
    let rep = r.cycle();
    assert!(rep.ok && rep.merged, "{:?}", rep);
    assert_eq!(rep.merged_paths, vec!["voice.md".to_string()]);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head(), "the merge is pushed");
    // A local edit: committed and pushed in the same cycle.
    write(&r.laptop, "mine.md", "laptop\n");
    let rep = r.cycle();
    assert!(rep.ok && rep.committed, "{:?}", rep);
    assert_eq!(git(&r.bare, &["rev-parse", "refs/heads/master"]), r.head());
    assert_eq!(rep.changes_waiting, 0);
    r.done();
}

/// Timing of real cycles on a scratch copy of a vault (never a real one):
/// `VC_BENCH_VAULT=<copy> VC_BENCH_BOXWC=<clone of its box bare on branch box>
/// cargo test --lib bench_box_sync -- --ignored --nocapture`. Prints the
/// first cycle in this process, idle cycles, and a typical cycle (a few notes
/// changed on each side).
#[test]
#[ignore]
fn bench_box_sync() {
    let (Ok(v), Ok(bw)) = (std::env::var("VC_BENCH_VAULT"), std::env::var("VC_BENCH_BOXWC")) else {
        eprintln!("set VC_BENCH_VAULT and VC_BENCH_BOXWC");
        return;
    };
    let vault = PathBuf::from(&v);
    let boxwc = PathBuf::from(&bw);
    let time = |label: &str| {
        let t = Instant::now();
        let r = box_sync_cycle(&v);
        let ms = t.elapsed().as_millis();
        eprintln!("{:<28} {:>6} ms  ok={} committed={} merged={} paths={:?} err={:?}", label, ms, r.ok, r.committed, r.merged, r.merged_paths, r.error);
        (ms, r)
    };
    time("first cycle (fresh process)");
    for i in 1..=3 {
        time(&format!("idle cycle {}", i));
    }
    for i in 1..=2 {
        let stamp = now_ms();
        let notes = vault.join(".vault-chat/notes.jsonl");
        let mut cur = std::fs::read_to_string(&notes).unwrap_or_default();
        cur.push_str(&format!("{{\"id\":\"bench-l{}\",\"text\":\"laptop note\"}}\n", stamp));
        std::fs::write(&notes, cur).unwrap();
        write(&vault, &format!("Ad Hoc/bench-{}.md", stamp), "a laptop note\n");
        // The box adds a note of its own (a voice note).
        git(&boxwc, &["pull", "-q", "--no-rebase", "origin", "box"]);
        let bnotes = boxwc.join("bench-box.md");
        let mut b = std::fs::read_to_string(&bnotes).unwrap_or_default();
        b.push_str(&format!("box line {}\n", stamp));
        std::fs::write(&bnotes, b).unwrap();
        git(&boxwc, &["add", "-A"]);
        git(&boxwc, &["-c", "core.hooksPath=NUL", "commit", "-q", "-m", "box note"]);
        git(&boxwc, &["-c", "core.hooksPath=NUL", "push", "-q", "origin", "box"]);
        let (_, r) = time(&format!("typical cycle {}", i));
        assert!(r.ok && r.committed && r.merged, "{:?}", r);
        time(&format!("idle after typical {}", i));
    }
}

#[test]
fn github_problem_reads_the_push_errors_in_plain_kinds() {
    // The laptop's push of school2's backlog on 2026-10-23 (129 commits, 212 MB packed).
    let carl = "GitHub backup (git push github) failed (exit 1):\nerror: RPC failed; curl 55 Send failure: Connection was aborted\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\nEverything up-to-date";
    assert_eq!(github_problem(carl), "too_big");
    assert_eq!(github_problem("remote: fatal: pack exceeds maximum allowed size\n! [remote rejected] master -> master (unpacker error)"), "too_big");
    assert_eq!(github_problem("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"), "offline");
    assert_eq!(github_problem("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'"), "auth");
    assert_eq!(github_problem(" ! [rejected]        master -> master (fetch first)"), "rejected");
    assert_eq!(github_problem("fatal: something else"), "other");
}

#[test]
fn github_steps_cut_a_backlog_by_bytes() {
    let m = |v: &[(&str, u64)]| v.iter().map(|(c, n)| (c.to_string(), *n)).collect::<Vec<_>>();
    let steps = github_steps(&m(&[("a", 10), ("b", 10), ("c", 10), ("d", 25), ("e", 0), ("f", 5)]), 20);
    assert_eq!(steps, vec!["b", "c", "d", "f"]);
    // A commit over the budget is a step of its own; merges (0 bytes) ride along.
    assert_eq!(github_steps(&m(&[("m", 0), ("big", 99), ("n", 0)]), 20), vec!["big", "n"]);
    assert_eq!(github_steps(&m(&[("a", 1), ("b", 1)]), 20), vec!["b"]);
    assert!(github_steps(&[], 20).is_empty());
}

/// Bytes that do not compress (a binary file, an archive).
fn noise(seed: u64, n: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

#[test]
fn github_backup_uploads_a_backlog_in_steps_when_one_push_is_cut_off() {
    let r = rig("githubsteps");
    let gh = r.base.join("github.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "master"]);
    // GitHub stand-in that refuses any upload over 700 KB (as the connection cut off the real one).
    git(&gh, &["config", "receive.maxInputSize", "700000"]);
    for i in 0..6u64 {
        std::fs::create_dir_all(r.laptop.join("bin")).unwrap();
        std::fs::write(r.laptop.join("bin").join(format!("f{}.bin", i)), noise(i + 1, 300_000)).unwrap();
        git(&r.laptop, &["add", "-A"]);
        git(&r.laptop, &["commit", "-q", "-m", &format!("binary {}", i)]);
    }
    git(&r.laptop, &["remote", "add", "github", &s(&gh)]);
    // One push of everything (~1.8 MB) is refused: the backup goes up in steps on its own.
    let all = run_git(&s(&r.laptop), &["push", "--porcelain", "github", "master:refs/heads/probe"]).unwrap();
    assert_ne!(all.2, 0, "the stand-in must refuse one big upload");
    assert_eq!(github_problem(&format!("{}\n{}", all.0, all.1)), "too_big", "{}\n{}", all.0, all.1);
    let rep = r.cycle();
    assert!(rep.ok, "{:?}", rep.error);
    wait_github_backup(&s(&r.laptop));
    let rep = r.cycle();
    assert!(rep.github_warning.is_none(), "{:?}", rep.github_warning);
    assert!(rep.github_pushed_at.is_some());
    assert_eq!(rep.github_pending, Some(0));
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/master"]), r.head());
    assert_eq!(git(&gh, &["rev-parse", "refs/heads/box"]), git(&r.bare, &["rev-parse", "refs/heads/box"]));
    assert_ne!(git_code(&gh, &["rev-parse", "--verify", "-q", "refs/heads/vault-chat-upload"]), 0, "the upload branch is gone");
    r.done();
}

#[test]
fn github_backup_names_one_change_too_big_to_upload() {
    let r = rig("githubonebig");
    let gh = r.base.join("github.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "master"]);
    git(&gh, &["config", "receive.maxInputSize", "200000"]);
    std::fs::write(r.laptop.join("one.bin"), noise(7, 400_000)).unwrap();
    git(&r.laptop, &["add", "-A"]);
    git(&r.laptop, &["commit", "-q", "-m", "one big"]);
    git(&r.laptop, &["remote", "add", "github", &s(&gh)]);
    r.cycle();
    wait_github_backup(&s(&r.laptop));
    let rep = r.cycle();
    assert!(rep.ok, "the sync itself is fine: {:?}", rep.error);
    assert_eq!(rep.github_problem.as_deref(), Some("too_big"), "{:?}", rep.github_warning);
    assert!(rep.github_warning.as_deref().unwrap_or("").contains("pack exceeds maximum allowed size"), "{:?}", rep.github_warning);
    assert!(rep.github_pending.unwrap_or(0) >= 1);
    assert!(rep.github_next_try_at.is_some(), "it retries on its own");
    r.done();
}

// ---------- the vault-chat folder: several repos, a project with its own remote ----------

/// `<base>/vc` with its file naming the stand-in box (`<base>/boxhost`); each repo's box side is a clone of its hub.
struct MasterRig {
    base: PathBuf,
    master: PathBuf,
    boxhost: PathBuf,
}

fn master_rig(name: &str) -> MasterRig {
    let base = std::env::temp_dir().join(format!("vc_master_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let boxhost = base.join("boxhost");
    let master = base.join("vc");
    std::fs::create_dir_all(master.join("vaults")).unwrap();
    std::fs::create_dir_all(master.join("projects")).unwrap();
    write(&master, MASTER_FILE, &format!("{{\"box\":\"{}\",\"projects\":{{\"site\":{{\"branch\":\"main\"}}}}}}\n", s(&boxhost)));
    MasterRig { base, master, boxhost }
}

/// A hub on the stand-in box with a box-side clone that publishes `box`.
fn hub_with_box(base: &Path, hub: &Path, wc: &Path, branch: &str, seed: &[(&str, &str)]) {
    std::fs::create_dir_all(hub).unwrap();
    git(hub, &["init", "-q", "--bare", "-b", branch]);
    git(base, &["clone", "-q", &s(hub), &s(wc)]);
    ident(wc);
    git(wc, &["checkout", "-q", "-b", branch]);
    for (rel, body) in seed {
        write(wc, rel, body);
    }
    git(wc, &["add", "-A"]);
    git(wc, &["commit", "-q", "-m", "box seed"]);
    git(wc, &["push", "-q", "origin", &format!("{}:box", branch)]);
}

#[test]
fn a_repo_in_the_vault_chat_folder_gets_its_box_from_the_folder() {
    let m = master_rig("cfg");
    let v = m.master.join("vaults").join("physics");
    let p = m.master.join("projects").join("site");
    let c = box_config(&s(&v)).expect("a vault in the folder");
    assert_eq!((c.branch.as_str(), c.project), ("master", false));
    assert_eq!(c.remote_url(), format!("{}/git/physics.git", s(&m.boxhost)));
    let c = box_config(&s(&p)).expect("a project in the folder");
    assert_eq!((c.branch.as_str(), c.project), ("main", true));
    assert_eq!(c.remote_url(), format!("{}/git/projects/site.git", s(&m.boxhost)));
    assert!(box_config(&s(&m.base.join("elsewhere").join("x"))).is_none());
    // A vault in the folder whose committed sync.json names another box (a copy of the live vault in a test
    // folder): the folder's box wins, never the one sync.json names.
    write(&v, ".vault-chat/sync.json", "{\"hub\":\"laptop\",\"box\":\"https://live-box.example\",\"vault\":\"school2\"}");
    let c = box_config(&s(&v)).unwrap();
    assert_eq!(c.remote_url(), format!("{}/git/physics.git", s(&m.boxhost)));
    let _ = std::fs::remove_dir_all(&m.base);
}

#[test]
fn a_two_vaults_and_a_project_sync_both_ways_and_a_kept_change_reaches_github_from_the_laptop() {
    let m = master_rig("multi");
    // The box's side: two vaults and a project, each with its hub.
    let boxes = m.base.join("boxside");
    std::fs::create_dir_all(&boxes).unwrap();
    for v in ["school2", "physics"] {
        hub_with_box(&m.base, &m.boxhost.join("git").join(format!("{}.git", v)), &boxes.join(v), "box", &[("box.md", v)]);
    }
    // "GitHub" for the project; the box's project working copy is on main.
    let gh = m.base.join("github").join("site.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "main"]);
    let phub = m.boxhost.join("git").join("projects").join("site.git");
    hub_with_box(&m.base, &phub, &boxes.join("site"), "main", &[("index.html", "<h1>v1</h1>\n")]);
    git(&boxes.join("site"), &["push", "-q", &s(&gh), "main:main"]);

    // The laptop makes each repo from the box's hub (as Settings does for what it lacks).
    for (kind, name, branch) in [("vaults", "school2", "master"), ("vaults", "physics", "master"), ("projects", "site", "main")] {
        let dest = m.master.join(kind).join(name);
        let url = box_config(&s(&dest)).unwrap().remote_url();
        let origin = if kind == "projects" { Some(s(&gh)) } else { None };
        let what = crate::master::repo_init(&s(&dest), &url, branch, origin.as_deref()).unwrap();
        assert!(what.contains("cloned from the box"), "{}", what);
        ident(&dest);
        let rep = box_sync_cycle(&s(&dest));
        assert!(rep.ok, "{} first cycle: {:?}", name, rep.error);
    }
    // The project keeps its own .gitignore: no vault rules were written into it.
    assert!(!m.master.join("projects/site/.gitignore").exists());
    assert!(m.master.join("vaults/physics/.gitignore").exists());
    // Laptop to box: each repo's laptop branch is in its hub.
    write(&m.master.join("vaults/physics"), "laptop.md", "from the laptop\n");
    write(&m.master.join("projects/site"), "notes.md", "laptop notes\n");
    for (kind, name, branch, hub) in [
        ("vaults", "physics", "master", m.boxhost.join("git/physics.git")),
        ("projects", "site", "main", phub.clone()),
    ] {
        let dest = m.master.join(kind).join(name);
        let rep = box_sync_cycle(&s(&dest));
        assert!(rep.ok && rep.committed, "{}: {:?}", name, rep.error);
        assert_eq!(git(&hub, &["rev-parse", &format!("refs/heads/{}", branch)]), git(&dest, &["rev-parse", "HEAD"]));
    }
    assert_eq!(git(&m.boxhost.join("git/physics.git"), &["show", "master:laptop.md"]), "from the laptop");
    // The laptop's own autosave in the project did not go to GitHub: nothing came from the box yet.
    assert_eq!(git(&gh, &["rev-parse", "main"]), git(&boxes.join("site"), &["rev-parse", "main"]));

    // Box to laptop: a box edit in school2, and a kept change in the project (Keep merged agent/v2 into the box's
    // main; its sync pushed it to the hub as `box`). The box cannot push to GitHub.
    let sb = boxes.join("school2");
    write(&sb, "agent.md", "the agent wrote this\n");
    git(&sb, &["add", "-A"]);
    git(&sb, &["commit", "-q", "-m", "[agent] box autosave"]);
    git(&sb, &["push", "-q", "origin", "box:box"]);
    let pb = boxes.join("site");
    git(&pb, &["fetch", "-q", "origin", "main"]);
    git(&pb, &["merge", "-q", "--no-edit", "origin/main"]);
    git(&pb, &["checkout", "-q", "-b", "agent/v2"]);
    write(&pb, "index.html", "<h1>v2</h1>\n");
    git(&pb, &["commit", "-q", "-am", "v2"]);
    git(&pb, &["checkout", "-q", "main"]);
    git(&pb, &["merge", "-q", "--ff-only", "agent/v2"]);
    git(&pb, &["push", "-q", "origin", "main:box"]);

    let rep = box_sync_cycle(&s(&m.master.join("vaults/school2")));
    assert!(rep.ok && rep.merged, "{:?}", rep.error);
    assert_eq!(read(&m.master.join("vaults/school2"), "agent.md"), "the agent wrote this\n");
    assert!(rep.origin_push.is_none(), "a vault has no origin push");
    let site = m.master.join("projects/site");
    let rep = box_sync_cycle(&s(&site));
    assert!(rep.ok && rep.merged, "{:?}", rep.error);
    assert_eq!(read(&site, "index.html").replace("\r\n", "\n"), "<h1>v2</h1>\n");
    assert_eq!(rep.origin_push.as_deref(), Some("pushed main to origin (the box has no credentials)"), "{:?}", rep.origin_warning);
    assert_eq!(git(&gh, &["rev-parse", "main"]), git(&site, &["rev-parse", "main"]));
    assert_eq!(git(&gh, &["show", "main:index.html"]), "<h1>v2</h1>");
    // Nothing owed any more: the next cycle pushes nothing.
    let rep = box_sync_cycle(&s(&site));
    assert!(rep.ok && rep.origin_push.is_none(), "{:?}", rep.origin_push);
    let _ = std::fs::remove_dir_all(&m.base);
}

#[test]
fn a_failed_origin_push_is_said_and_owed_until_it_goes() {
    let m = master_rig("owed");
    let gh = m.base.join("github").join("site.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "main"]);
    let phub = m.boxhost.join("git").join("projects").join("site.git");
    let pb = m.base.join("boxside").join("site");
    std::fs::create_dir_all(pb.parent().unwrap()).unwrap();
    hub_with_box(&m.base, &phub, &pb, "main", &[("a.txt", "a\n")]);
    let site = m.master.join("projects/site");
    let url = box_config(&s(&site)).unwrap().remote_url();
    crate::master::repo_init(&s(&site), &url, "main", Some(&s(&gh))).unwrap();
    ident(&site);
    // GitHub refuses (as without credentials).
    write(&gh, "hooks/pre-receive", "#!/bin/sh\necho 'Authentication failed' >&2\nexit 1\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(gh.join("hooks/pre-receive"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write(&pb, "b.txt", "b\n");
    git(&pb, &["add", "-A"]);
    git(&pb, &["commit", "-q", "-m", "kept"]);
    git(&pb, &["push", "-q", "origin", "main:box"]);
    let rep = box_sync_cycle(&s(&site));
    assert!(rep.ok && rep.merged, "{:?}", rep.error);
    assert!(rep.origin_warning.as_deref().unwrap_or("").contains("Authentication failed"), "{:?}", rep.origin_warning);
    std::fs::remove_file(gh.join("hooks/pre-receive")).unwrap();
    let rep = box_sync_cycle(&s(&site));
    assert_eq!(rep.origin_push.as_deref(), Some("pushed main to origin (the box has no credentials)"), "{:?}", rep.origin_warning);
    assert_eq!(git(&gh, &["rev-parse", "main"]), git(&site, &["rev-parse", "main"]));
    let _ = std::fs::remove_dir_all(&m.base);
}

/// Against a real box instance (the throwaway one, never live): VC_E2E_BOX = its URL (an SSH tunnel to its
/// loopback port), VC_E2E_DIR = an empty folder on this laptop. The laptop's own engine makes school2 and the
/// project `site` from the box's hubs, syncs both ways, and pushes a change the box kept to the project's
/// "GitHub" (a bare repo here) since the box has no credentials. Run by hand:
///   VC_E2E_BOX=http://127.0.0.1:18858 VC_E2E_DIR=… cargo test --lib e2e_master -- --ignored --nocapture
#[test]
#[ignore]
fn e2e_master_against_a_box() {
    let (Ok(boxurl), Ok(dir)) = (std::env::var("VC_E2E_BOX"), std::env::var("VC_E2E_DIR")) else {
        panic!("set VC_E2E_BOX and VC_E2E_DIR");
    };
    let base = PathBuf::from(dir);
    let master = base.join("vc");
    std::fs::create_dir_all(master.join("vaults")).unwrap();
    std::fs::create_dir_all(master.join("projects")).unwrap();
    write(&master, MASTER_FILE, &format!("{{\"box\":\"{}\",\"projects\":{{\"site\":{{\"branch\":\"main\"}}}}}}\n", boxurl));
    let gh = base.join("github").join("site.git");
    std::fs::create_dir_all(&gh).unwrap();
    git(&gh, &["init", "-q", "--bare", "-b", "main"]);
    for (kind, name, branch) in [("vaults", "school2", "master"), ("projects", "site", "main")] {
        let dest = master.join(kind).join(name);
        let url = box_config(&s(&dest)).unwrap().remote_url();
        let origin = if kind == "projects" { Some(s(&gh)) } else { None };
        let t = Instant::now();
        let what = crate::master::repo_init(&s(&dest), &url, branch, origin.as_deref()).unwrap();
        println!("{}: {} ({} ms) from {}", name, what, t.elapsed().as_millis(), url);
        ident(&dest);
        let rep = box_sync_cycle(&s(&dest));
        println!("{} first cycle: ok={} merged={} msg={} err={:?}", name, rep.ok, rep.merged, rep.message, rep.error);
        assert!(rep.ok, "{:?}", rep.error);
    }
    let files = walkdir::WalkDir::new(master.join("vaults/school2")).into_iter().flatten().filter(|e| e.file_type().is_file()).count();
    println!("school2 here: {} files, HEAD {}", files, git(&master.join("vaults/school2"), &["rev-parse", "--short", "HEAD"]));
    // Laptop → box: a file in each.
    let stamp = format!("{}", now_ms());
    write(&master.join("vaults/school2"), "e2e/from-laptop.md", &format!("laptop {}\n", stamp));
    write(&master.join("projects/site"), "from-laptop.md", &format!("laptop {}\n", stamp));
    for (kind, name) in [("vaults", "school2"), ("projects", "site")] {
        let rep = box_sync_cycle(&s(&master.join(kind).join(name)));
        println!("{} push: ok={} committed={} msg={} err={:?}", name, rep.ok, rep.committed, rep.message, rep.error);
        assert!(rep.ok && rep.committed, "{:?}", rep.error);
    }
    println!("STAMP {}", stamp);
    write(&base, "stamp", &stamp);
    // The box side runs next (the caller commits a Keep there and writes a file), then VC_E2E_PHASE=2 checks it.
    if std::env::var("VC_E2E_WAIT").is_ok() {
        let flag = base.join("box-done");
        let _ = std::fs::remove_file(&flag);
        println!("waiting for {}", flag.display());
        let end = Instant::now() + Duration::from_secs(600);
        while !flag.exists() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(flag.exists(), "the box side never said it was done");
        let site = master.join("projects/site");
        let mut rep = box_sync_cycle(&s(&site));
        for _ in 0..20 {
            if rep.merged {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
            rep = box_sync_cycle(&s(&site));
        }
        println!("site after Keep: ok={} merged={} origin_push={:?} origin_warning={:?}", rep.ok, rep.merged, rep.origin_push, rep.origin_warning);
        assert!(rep.merged);
        assert_eq!(rep.origin_push.as_deref(), Some("pushed main to origin (the box has no credentials)"));
        assert_eq!(git(&gh, &["rev-parse", "main"]), git(&site, &["rev-parse", "main"]));
        println!("GitHub stand-in main: {} ({})", git(&gh, &["rev-parse", "--short", "main"]), git(&gh, &["log", "-1", "--format=%s", "main"]));
        let sv = master.join("vaults/school2");
        for _ in 0..30 {
            let rep = box_sync_cycle(&s(&sv));
            println!("school2 cycle: ok={} merged={} paths={:?} err={:?}", rep.ok, rep.merged, rep.merged_paths, rep.error);
            if read(&sv, "e2e/from-box.md").contains(&stamp) {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        assert!(read(&sv, "e2e/from-box.md").contains(&stamp), "the box's write never arrived");
        println!("school2 has the box's write: {}", read(&sv, "e2e/from-box.md").trim());
    }
}

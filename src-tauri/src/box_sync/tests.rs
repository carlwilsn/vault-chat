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
    assert_eq!(crate::vault_sync_role_sync(v.clone()), "writer");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn github_failure_stays_reported_between_debounced_attempts() {
    let r = rig("githubsticky");
    git(&r.laptop, &["remote", "add", "github", &s(&r.base.join("nope.git"))]);
    let first = r.cycle();
    assert!(first.github_warning.is_some());
    // Within the 2-minute window: no new attempt, but the warning is still there.
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

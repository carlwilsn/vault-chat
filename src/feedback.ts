import { invoke } from "@tauri-apps/api/core";
import type { NoteAnchor } from "./notes";
import { anchorImages } from "./notes";

// In-app feedback. Ctrl+G or Settings "Send feedback" → files a GitHub
// issue on vault-chat with label `auto-fix:queued`. A scheduled cloud
// agent picks queued issues up daily and lands fixes on main with a
// verification comment back on the issue.

export const VAULT_CHAT_OWNER = "carlwilsn";
export const VAULT_CHAT_REPO = "vault-chat";

export const FEEDBACK_LABEL_QUEUED = "auto-fix:queued";
export const FEEDBACK_LABEL_AWAITING = "auto-fix:awaiting-verification";
export const FEEDBACK_LABEL_NEEDS_REVIEW = "auto-fix:needs-review";

export type FeedbackSubmission = {
  text: string;
  anchors: NoteAnchor[];
};

export type CreatedIssue = { number: number; url: string };

export type IssueLabel = { name: string; color: string };

export type IssueSummary = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | string;
  labels: IssueLabel[];
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
};

export type IssueComment = {
  id: number;
  body: string;
  author: string;
  created_at: string;
};

/** Sanity-check a PAT by calling /user. Returns the GitHub login on
 *  success, or throws the API error string. */
export async function testGithubToken(token: string): Promise<string> {
  return invoke<string>("gh_test_token", { token });
}

/** File a feedback issue. Uploads any captured images first, then
 *  creates the issue with inline image links and label
 *  `auto-fix:queued`. */
export async function submitFeedback(
  token: string,
  s: FeedbackSubmission,
): Promise<CreatedIssue> {
  const images = s.anchors
    .flatMap((a) => anchorImages(a))
    .map((data_url) => ({ data_url }));

  const title = deriveTitle(s.text);
  const body = renderBody(s);

  return invoke<CreatedIssue>("gh_create_feedback_issue", {
    token,
    owner: VAULT_CHAT_OWNER,
    repo: VAULT_CHAT_REPO,
    title,
    body,
    labels: [FEEDBACK_LABEL_QUEUED],
    images,
  });
}

/** Fetch every issue on vault-chat carrying any `auto-fix:*` label,
 *  open or closed. Sorted newest-updated first. */
export async function listFeedbackIssues(token: string): Promise<IssueSummary[]> {
  return invoke<IssueSummary[]>("gh_list_feedback_issues", {
    token,
    owner: VAULT_CHAT_OWNER,
    repo: VAULT_CHAT_REPO,
  });
}

/** Fetch the comment thread for an issue. */
export async function getIssueComments(
  token: string,
  number: number,
): Promise<IssueComment[]> {
  return invoke<IssueComment[]>("gh_get_issue_comments", {
    token,
    owner: VAULT_CHAT_OWNER,
    repo: VAULT_CHAT_REPO,
    number,
  });
}

/** Map an issue's label set to a single conceptual status. */
export type FeedbackStatus =
  | "queued"
  | "awaiting-verification"
  | "needs-review"
  | "closed"
  | "unknown";

export function feedbackStatusOf(issue: IssueSummary): FeedbackStatus {
  if (issue.state === "closed") return "closed";
  const names = new Set(issue.labels.map((l) => l.name));
  if (names.has(FEEDBACK_LABEL_AWAITING)) return "awaiting-verification";
  if (names.has(FEEDBACK_LABEL_NEEDS_REVIEW)) return "needs-review";
  if (names.has(FEEDBACK_LABEL_QUEUED)) return "queued";
  return "unknown";
}

function deriveTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no description)";
  const firstLine = trimmed.split(/\r?\n/)[0]!;
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + "…";
}

function renderBody(s: FeedbackSubmission): string {
  const parts: string[] = [];
  parts.push(s.text.trim() || "_(no description)_");

  const refs = s.anchors.filter((a) => a.source_path);
  if (refs.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push("**Context the user was looking at:**");
    parts.push("");
    for (const a of refs) {
      const tag = a.primary ? " (primary)" : "";
      const anchorBit = a.source_anchor ? ` · \`${a.source_anchor}\`` : "";
      parts.push(`- \`${a.source_path}\`${anchorBit}${tag}`);
      if (a.source_selection && a.source_selection.trim().length > 0) {
        const snippet = a.source_selection.trim().slice(0, 600);
        parts.push("");
        parts.push("  ```");
        for (const line of snippet.split(/\r?\n/)) parts.push(`  ${line}`);
        parts.push("  ```");
      }
    }
  }

  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(
    "_Filed via in-app feedback (Ctrl+G). The cloud auto-fix agent will pick this up on its next run; once it lands a fix it will comment with verification steps and re-label `auto-fix:awaiting-verification`._",
  );

  return parts.join("\n");
}

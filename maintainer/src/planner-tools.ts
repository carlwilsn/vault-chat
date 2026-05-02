// Tool definitions and execution for the Planner agent.
//
// The Planner is read-mostly: 6 read tools that pull from the GitHub
// API + raw.githubusercontent, plus one write tool (`file_issue`)
// that's the bridge to the implementer agent. Everything else
// happens via filed issues, never directly from the chat.

import {
  type Issue,
  type Release,
  type WorkflowRun,
  listIssuesByLabel,
  listIssueComments,
  listReleases,
  listWorkflowRuns,
  createIssue,
  setIssueLabels,
  postIssueComment,
  ghJson,
  OWNER,
  REPO,
} from "./github";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const PLANNER_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description:
      "List files and directories under a path in the vault-chat repo (default branch: main). Use this to explore the codebase structure before reading specific files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path within the repo, relative to the root. Use empty string or '/' for the root. Examples: 'src', 'maintainer/src', 'src-tauri/src'.",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file in the vault-chat repo (main branch). Returns the file as text. Use sparingly — prefer `grep` to find specific code patterns first.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path within the repo, relative to the root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search the codebase for a regex pattern. Returns matching lines with file paths. Use this to find where a function is defined, where a string appears, etc.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Search query — GitHub code-search syntax. e.g. 'function sendMessage', 'language:typescript onClick'.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_issues",
    description:
      "List GitHub issues filtered by label and state. Common labels: 'auto-fix:queued' (waiting for implementer), 'auto-fix:awaiting-verification' (waiting for user to verify), 'auto-fix:needs-review' (implementer got stuck), 'task:in-progress' (long-running tasks).",
    input_schema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Label to filter by. Required.",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Issue state. Defaults to 'open'.",
        },
      },
      required: ["label"],
    },
  },
  {
    name: "read_issue",
    description: "Read an issue's full body and all its comments.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue number." },
      },
      required: ["number"],
    },
  },
  {
    name: "list_workflow_runs",
    description:
      "List recent runs of a GitHub Actions workflow. Useful for checking if recent ships have succeeded or failed.",
    input_schema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          description:
            "Workflow filename, e.g. 'ship.yml' or 'ship-maintainer.yml'. Defaults to 'ship.yml'.",
        },
        limit: { type: "number", description: "How many runs to return. Defaults to 10." },
      },
    },
  },
  {
    name: "list_releases",
    description: "List the most recent GitHub releases (main app + maintainer).",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return. Defaults to 10." },
      },
    },
  },
  {
    name: "file_issue",
    description:
      "File a new GitHub issue. This is your ONLY write tool — use it to hand work to the implementer agent. Always confirm with the user before filing. Pick the right type: 'bug' (small one-shot fix, picked up by the auto-fix routine), 'feature' (long-running task, lives in Tasks tab), 'maintainer-task' (touches the maintainer app's own code).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise issue title." },
        body: {
          type: "string",
          description:
            "Detailed description in markdown. Include acceptance criteria, files affected if known, and any constraints.",
        },
        type: {
          type: "string",
          enum: ["bug", "feature", "maintainer-task"],
          description: "Issue category — controls which agent picks it up.",
        },
      },
      required: ["title", "body", "type"],
    },
  },
  {
    name: "run_task_now",
    description:
      "Manually queue a task issue (one labelled task:in-progress) for immediate execution by the implementer agent. Use this when Carl says things like 'run task #28 now', 'kick off the chat-polish task', or 'start that one'. The issue gets re-labelled from task:in-progress to auto-fix:queued, which moves it from the Tasks tab into the Triage tab where the cloud loop picks it up on its next run. Always confirm the issue number with Carl before calling this tool — and only use it on issues currently labelled task:in-progress (verify with read_issue first if unsure).",
    input_schema: {
      type: "object",
      properties: {
        issue_number: {
          type: "number",
          description: "Issue number of the task to queue.",
        },
      },
      required: ["issue_number"],
    },
  },
];

// ----- execution -----

export type ToolInput = Record<string, unknown>;

export async function executeTool(
  token: string,
  name: string,
  input: ToolInput,
): Promise<string> {
  switch (name) {
    case "list_files":
      return listFilesImpl((input.path as string) ?? "", token);
    case "read_file":
      return readFileImpl(input.path as string);
    case "grep":
      return grepImpl(token, input.pattern as string);
    case "list_issues":
      return listIssuesImpl(
        token,
        input.label as string,
        (input.state as "open" | "closed" | "all") ?? "open",
      );
    case "read_issue":
      return readIssueImpl(token, input.number as number);
    case "list_workflow_runs":
      return listWorkflowRunsImpl(
        token,
        (input.workflow as string) ?? "ship.yml",
        (input.limit as number) ?? 10,
      );
    case "list_releases":
      return listReleasesImpl(token, (input.limit as number) ?? 10);
    case "file_issue":
      return fileIssueImpl(
        token,
        input.title as string,
        input.body as string,
        input.type as "bug" | "feature" | "maintainer-task",
      );
    case "run_task_now":
      return runTaskNowImpl(token, input.issue_number as number);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function listFilesImpl(path: string, token: string): Promise<string> {
  const cleaned = path.replace(/^\/+|\/+$/g, "");
  const url = cleaned
    ? `/repos/${OWNER}/${REPO}/contents/${cleaned}`
    : `/repos/${OWNER}/${REPO}/contents`;
  try {
    const data = await ghJson<Array<{ name: string; type: string; size: number }>>(url, token);
    const lines = data.map((e) => `${e.type === "dir" ? "d " : "  "}${e.name}${e.type === "file" ? ` (${e.size}b)` : "/"}`);
    return lines.join("\n") || "(empty)";
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function readFileImpl(path: string): Promise<string> {
  const cleaned = path.replace(/^\/+/, "");
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${cleaned}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return `Error: HTTP ${res.status} (${res.statusText})`;
    const text = await res.text();
    // Cap at 200KB so a runaway request can't blow the agent's context.
    if (text.length > 200_000) {
      return text.slice(0, 200_000) + "\n\n... [truncated at 200KB]";
    }
    return text;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function grepImpl(token: string, pattern: string): Promise<string> {
  const q = `${pattern} repo:${OWNER}/${REPO}`;
  try {
    const data = await ghJson<{
      total_count: number;
      items: Array<{
        path: string;
        text_matches?: Array<{ fragment: string }>;
        html_url: string;
      }>;
    }>(`/search/code?q=${encodeURIComponent(q)}&per_page=20`, token);
    if (data.total_count === 0) return "(no matches)";
    const lines = [`Total matches: ${data.total_count} (showing top ${data.items.length})`, ""];
    for (const item of data.items) {
      lines.push(`### ${item.path}`);
      if (item.text_matches) {
        for (const m of item.text_matches.slice(0, 3)) {
          lines.push("```");
          lines.push(m.fragment.trim());
          lines.push("```");
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function listIssuesImpl(
  token: string,
  label: string,
  state: "open" | "closed" | "all",
): Promise<string> {
  try {
    // The github helper only supports state=open|closed, not "all" — fall through.
    let issues: Issue[];
    if (state === "all") {
      const [o, c] = await Promise.all([
        listIssuesByLabel(token, label, "open"),
        listIssuesByLabel(token, label, "closed"),
      ]);
      issues = [...o, ...c];
    } else {
      issues = await listIssuesByLabel(token, label, state);
    }
    if (issues.length === 0) return `(no ${state} issues with label "${label}")`;
    const lines = issues.map(
      (i) =>
        `#${i.number} [${i.state}] ${i.title}\n  ${i.html_url}\n  updated ${i.updated_at}`,
    );
    return lines.join("\n\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function readIssueImpl(token: string, number: number): Promise<string> {
  try {
    const issue = await ghJson<Issue>(`/repos/${OWNER}/${REPO}/issues/${number}`, token);
    const comments = await listIssueComments(token, number);
    const lines = [
      `# #${issue.number} ${issue.title}`,
      `state: ${issue.state} · author: ${issue.user.login} · created: ${issue.created_at}`,
      `labels: ${issue.labels.map((l) => l.name).join(", ") || "(none)"}`,
      "",
      "## Body",
      "",
      issue.body ?? "(empty)",
      "",
    ];
    if (comments.length > 0) {
      lines.push(`## Comments (${comments.length})`);
      for (const c of comments) {
        lines.push("");
        lines.push(`### ${c.user.login} · ${c.created_at}`);
        lines.push("");
        lines.push(c.body);
      }
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function listWorkflowRunsImpl(
  token: string,
  workflow: string,
  limit: number,
): Promise<string> {
  try {
    const runs: WorkflowRun[] = await listWorkflowRuns(token, workflow, limit);
    if (runs.length === 0) return "(no recent runs)";
    return runs
      .map(
        (r) =>
          `${r.created_at} · ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""} · ${r.event} · ${r.head_sha.slice(0, 7)}`,
      )
      .join("\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function listReleasesImpl(token: string, limit: number): Promise<string> {
  try {
    const releases: Release[] = await listReleases(token, limit);
    return releases
      .map((r) => `${r.tag_name} · ${r.published_at}${r.prerelease ? " · prerelease" : ""}`)
      .join("\n");
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function fileIssueImpl(
  token: string,
  title: string,
  body: string,
  type: "bug" | "feature" | "maintainer-task",
): Promise<string> {
  const labelMap: Record<typeof type, string> = {
    bug: "auto-fix:queued",
    feature: "task:in-progress",
    "maintainer-task": "task:in-progress",
  };
  const fullBody =
    type === "maintainer-task"
      ? `${body}\n\n[allow maintainer scope]\n\n_Filed by the Planner agent on Carl's behalf._`
      : `${body}\n\n_Filed by the Planner agent on Carl's behalf._`;
  try {
    const created = await createIssue(token, title, fullBody, [labelMap[type]]);
    return `✅ Filed as #${created.number}: ${created.html_url}`;
  } catch (e) {
    return `Error filing issue: ${(e as Error).message}`;
  }
}

async function runTaskNowImpl(token: string, issueNumber: number): Promise<string> {
  try {
    const issue = await ghJson<Issue>(
      `/repos/${OWNER}/${REPO}/issues/${issueNumber}`,
      token,
    );
    const current = issue.labels.map((l) => l.name);
    if (current.includes("auto-fix:queued")) {
      return `Issue #${issueNumber} is already queued (label auto-fix:queued is set). The cloud agent will pick it up on its next run.`;
    }
    if (!current.includes("task:in-progress")) {
      return `Issue #${issueNumber} is not labelled task:in-progress (current labels: ${current.join(", ") || "none"}). Refusing to queue — verify with read_issue first.`;
    }
    // Swap labels: drop task:in-progress, add auto-fix:queued. Preserve
    // any other labels (e.g. trust markers) that may be present.
    const next = current.filter((l) => l !== "task:in-progress");
    if (!next.includes("auto-fix:queued")) next.push("auto-fix:queued");
    await setIssueLabels(token, issueNumber, next);
    await postIssueComment(
      token,
      issueNumber,
      "🚀 Queued by Carl from the Planner chat. The cloud agent will pick this up on its next run.",
    );
    return `✅ Queued #${issueNumber} ("${issue.title}"). It moved from the Tasks tab to the Triage tab — the implementer will start work shortly and post back when there's a fix to verify.`;
  } catch (e) {
    return `Error queueing task: ${(e as Error).message}`;
  }
}

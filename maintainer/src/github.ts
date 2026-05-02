// Minimal GitHub REST client. Only the endpoints the maintainer
// actually needs. Uses the user's PAT (read from the OS keychain via
// the Rust shim — see App.tsx onMount) — same token vault-chat main
// uses for filing feedback. Token must have `repo` and `workflow`
// scopes.

export const OWNER = "carlwilsn";
export const REPO = "vault-chat";

const API = "https://api.github.com";

async function ghFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

export async function ghJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await ghFetch(path, token, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export type Release = {
  id: number;
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: Array<{ id: number; name: string; browser_download_url: string; size: number }>;
};

export async function listReleases(token: string, perPage = 20): Promise<Release[]> {
  return ghJson<Release[]>(`/repos/${OWNER}/${REPO}/releases?per_page=${perPage}`, token);
}

export type WorkflowRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  event: string;
  head_sha: string;
};

export async function listWorkflowRuns(
  token: string,
  workflow: string,
  perPage = 10,
): Promise<WorkflowRun[]> {
  const data = await ghJson<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${OWNER}/${REPO}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`,
    token,
  );
  return data.workflow_runs;
}

export async function dispatchWorkflow(
  token: string,
  workflow: string,
  ref = "main",
): Promise<void> {
  const res = await ghFetch(
    `/repos/${OWNER}/${REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    token,
    { method: "POST", body: JSON.stringify({ ref }) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dispatch ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function cancelWorkflowRun(token: string, runId: number): Promise<void> {
  const res = await ghFetch(
    `/repos/${OWNER}/${REPO}/actions/runs/${runId}/cancel`,
    token,
    { method: "POST" },
  );
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cancel ${res.status}: ${text.slice(0, 200)}`);
  }
}

export type IssueLabel = { name: string };
export type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | string;
  labels: IssueLabel[];
  html_url: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: number;
};

export async function listIssuesByLabel(
  token: string,
  label: string,
  state: "open" | "closed" | "all" = "open",
): Promise<Issue[]> {
  return ghJson<Issue[]>(
    `/repos/${OWNER}/${REPO}/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=50`,
    token,
  );
}

export type IssueComment = {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
};

export async function listIssueComments(
  token: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  return ghJson<IssueComment[]>(
    `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments?per_page=100`,
    token,
  );
}

export async function postIssueComment(
  token: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const res = await ghFetch(
    `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
    token,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Comment ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function setIssueLabels(
  token: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  const res = await ghFetch(
    `/repos/${OWNER}/${REPO}/issues/${issueNumber}/labels`,
    token,
    { method: "PUT", body: JSON.stringify({ labels }) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Labels ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function getMe(token: string): Promise<{ login: string }> {
  return ghJson<{ login: string }>(`/user`, token);
}

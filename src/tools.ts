import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export function buildTools(vault: string, tavilyKey?: string) {
  const base = {
    Read: tool({
      description:
        "Read a UTF-8 text file. Use absolute paths. Returns the file contents.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file."),
      }),
      execute: async ({ path }) => {
        return await invoke<string>("read_text_file", { path });
      },
    }),

    Write: tool({
      description:
        "Write a UTF-8 text file. Creates parent directories as needed. Overwrites existing files. Use absolute paths.",
      inputSchema: z.object({
        path: z.string(),
        contents: z.string(),
      }),
      execute: async ({ path, contents }) => {
        await invoke("write_text_file", { path, contents });
        return `wrote ${path}`;
      },
    }),

    Delete: tool({
      description:
        "Delete a file or directory at the given absolute path. Directories are removed recursively. Irreversible — only use when the user has asked for deletion.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file or directory to delete."),
      }),
      execute: async ({ path }) => {
        await invoke("delete_file", { path });
        return `deleted ${path}`;
      },
    }),

    Edit: tool({
      description:
        "Replace a string in a file. old_string must be unique in the file unless replace_all is true. Fails if old_string is not found or is not unique (without replace_all). Prefer Edit over Write for small changes to large files.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        return await invoke<string>("edit_text_file", {
          path,
          oldString: old_string,
          newString: new_string,
          replaceAll: replace_all ?? false,
        });
      },
    }),

    Glob: tool({
      description:
        "Find files matching a glob pattern (e.g., '**/*.md', 'lectures/**/notes.md'). Relative patterns resolve from the vault root. Returns paths sorted by modification time (newest first).",
      inputSchema: z.object({
        pattern: z.string(),
      }),
      execute: async ({ pattern }) => {
        const results = await invoke<string[]>("glob_files", {
          pattern,
          cwd: vault,
        });
        return results.length ? results.join("\n") : "(no matches)";
      },
    }),

    Grep: tool({
      description:
        "Search file contents with a regular expression. Returns matching lines as 'path:line: text'. Use glob_filter like '*.md' to restrict file types.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().describe("Directory or file to search. Defaults to vault root."),
        glob_filter: z.string().optional().describe("Filename glob, e.g. '*.md'"),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().optional(),
      }),
      execute: async ({ pattern, path, glob_filter, case_insensitive, max_results }) => {
        const results = await invoke<{ path: string; line: number; text: string }[]>(
          "grep_files",
          {
            pattern,
            path: path ?? vault,
            globFilter: glob_filter ?? null,
            caseInsensitive: case_insensitive ?? false,
            maxResults: max_results ?? 500,
          }
        );
        if (!results.length) return "(no matches)";
        return results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n");
      },
    }),

    Bash: tool({
      description:
        "Execute a shell command. Runs with the vault as the working directory by default. Returns stdout, stderr, and exit code. Use for git, pytest, scripts, etc. Default timeout 120s.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional().describe("Working directory. Defaults to vault root."),
        timeout_ms: z.number().int().optional(),
      }),
      execute: async ({ command, cwd, timeout_ms }) => {
        const result = await invoke<{
          stdout: string;
          stderr: string;
          code: number;
          timed_out: boolean;
        }>("bash_exec", {
          command,
          cwd: cwd ?? vault,
          timeoutMs: timeout_ms ?? 120_000,
        });
        const parts: string[] = [];
        parts.push(`exit: ${result.code}${result.timed_out ? " (TIMED OUT)" : ""}`);
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        return parts.join("\n");
      },
    }),

    ListDir: tool({
      description: "List the immediate contents of a directory (non-recursive). Returns files and subdirectories.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        const entries = await invoke<{ path: string; name: string; is_dir: boolean }[]>(
          "list_dir",
          { path }
        );
        return entries.map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}`).join("\n");
      },
    }),

    WebFetch: tool({
      description:
        "Fetch a URL over HTTPS and return the body as text. HTML is stripped to readable text. Use for documentation, articles, and API responses. Follows redirects. Output is truncated at ~120k chars.",
      inputSchema: z.object({
        url: z.string().describe("Fully-qualified URL starting with http:// or https://"),
        max_chars: z.number().int().optional().describe("Cap on returned text length. Default 120000."),
      }),
      execute: async ({ url, max_chars }) => {
        return await invoke<string>("http_fetch", { url, maxChars: max_chars ?? null });
      },
    }),
  };

  if (!tavilyKey) return base;

  return {
    ...base,
    WebSearch: tool({
      description:
        "Search the web and return the top results (title, URL, snippet) plus a synthesized answer. Use this when the user asks a question that requires current information, or when you don't know a specific URL. Prefer WebFetch if you already know the URL.",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
        max_results: z.number().int().optional().describe("Default 5, max 10."),
      }),
      execute: async ({ query, max_results }) => {
        return await invoke<string>("tavily_search", {
          query,
          apiKey: tavilyKey,
          maxResults: max_results ?? null,
          includeAnswer: true,
        });
      },
    }),
  };
}

export type ToolName = keyof ReturnType<typeof buildTools>;

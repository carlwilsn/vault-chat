// Spend per project: the sum of costUsd over the conversations tagged with it.
import { conversationObjects as readConversationObjects } from "../engine/convs";
import { ctxConfig } from "./config";
import { findProject } from "./projects";
import type { ContextConv } from "./types";

export type ProjectCost = {
  slug: string;
  name: string;
  totalUsd: number;
  /** Model calls with no cost reported, summed (a total is never silently partial). */
  missingCalls: number;
  parts: { id: string; title: string; costUsd: number; missingCalls: number }[];
};

/**
 * Cost{project}. `convs` defaults to every conversation in the vault.
 * Returns null when no such project exists.
 */
export function projectCost(nameOrSlug: string, convs?: ContextConv[]): ProjectCost | null {
  const p = findProject(nameOrSlug);
  if (!p) return null;
  const all = convs ?? (readConversationObjects(ctxConfig().vault) as ContextConv[]);
  const parts = all
    .filter((c) => c.project === p.slug)
    .map((c) => ({
      id: c.id,
      title: c.title ?? "",
      costUsd: typeof c.costUsd === "number" ? c.costUsd : 0,
      missingCalls: typeof c.costMissingCalls === "number" ? c.costMissingCalls : 0,
    }));
  const total = parts.reduce((s, x) => s + x.costUsd, 0);
  return {
    slug: p.slug,
    name: p.name,
    totalUsd: Math.round(total * 1e6) / 1e6,
    missingCalls: parts.reduce((s, x) => s + x.missingCalls, 0),
    parts,
  };
}

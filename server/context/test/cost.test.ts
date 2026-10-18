import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, projectCost } from "../index";
import { tempVault, writeConv } from "./helpers";

let vault: string;
let cleanup: () => void;
beforeEach(() => ({ vault, cleanup } = tempVault()));
afterEach(() => cleanup());

describe("cost by project", () => {
  it("sums costUsd over the conversations tagged with the project (read from the vault)", async () => {
    createProject("Coconut");
    createProject("Thesis");
    writeConv(vault, { id: "a", title: "train", project: "coconut", costUsd: 1.25, costMissingCalls: 1, createdAt: 1, lastActivityAt: 1 }, [
      { role: "user", content: "go" },
    ]);
    writeConv(vault, { id: "b", title: "eval", project: "coconut", costUsd: 0.5, createdAt: 1, lastActivityAt: 1 });
    writeConv(vault, { id: "c", title: "chapter 2", project: "thesis", costUsd: 9, createdAt: 1, lastActivityAt: 1 });
    writeConv(vault, { id: "d", title: "untagged", costUsd: 4, createdAt: 1, lastActivityAt: 1 });
    writeConv(vault, { id: "e", title: "no cost yet", project: "coconut", createdAt: 1, lastActivityAt: 1 });

    const c = projectCost("Coconut")!;
    expect(c.slug).toBe("coconut");
    expect(c.totalUsd).toBe(1.75);
    expect(c.missingCalls).toBe(1);
    expect(c.parts.map((p) => p.id).sort()).toEqual(["a", "b", "e"]);
    expect(projectCost("thesis")!.totalUsd).toBe(9);
    expect(projectCost("nope")).toBeNull();

    // With conversations ENGINE already holds in memory.
    expect(projectCost("coconut", [{ id: "x", project: "coconut", costUsd: 0.1 }, { id: "y", project: "coconut", costUsd: 0.2 }])!.totalUsd).toBe(0.3);
  });
});

import { create } from "zustand";

export type Tab = "activity" | "tasks" | "system" | "triage";

type State = {
  tab: Tab;
  setTab: (t: Tab) => void;

  // GitHub PAT pulled from the Rust shim's `keychain_get` command on
  // boot. Same secret the main app uses; we never write it back from
  // here. If null after boot, user has no token configured.
  githubPat: string | null;
  setGithubPat: (t: string | null) => void;

  // Logged-in GitHub username, used to render comment authorship.
  ghLogin: string | null;
  setGhLogin: (s: string | null) => void;
};

export const useStore = create<State>((set) => ({
  // Activity is the morning-briefing default — open the maintainer
  // and you see what happened today, no clicks needed.
  tab: "activity",
  setTab: (t) => set({ tab: t }),
  githubPat: null,
  setGithubPat: (t) => set({ githubPat: t }),
  ghLogin: null,
  setGhLogin: (s) => set({ ghLogin: s }),
}));

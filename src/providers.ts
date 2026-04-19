import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "openai" | "google";

export type ModelSpec = {
  provider: ProviderId;
  id: string;
  label: string;
};

export const MODELS: ModelSpec[] = [
  { provider: "anthropic", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { provider: "anthropic", id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
  { provider: "openai", id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "google", id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-7";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

export function buildModel(spec: ModelSpec, apiKey: string): LanguageModel {
  switch (spec.provider) {
    case "anthropic": {
      const a = createAnthropic({ apiKey, headers: { "anthropic-dangerous-direct-browser-access": "true" } });
      return a(spec.id);
    }
    case "openai": {
      const o = createOpenAI({ apiKey });
      return o(spec.id);
    }
    case "google": {
      const g = createGoogleGenerativeAI({ apiKey });
      return g(spec.id);
    }
  }
}

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  findProvider,
  isPresetModel,
  modelSupportsVision,
  resolveProviderId,
} from "./ai-providers";

describe("resolveProviderId", () => {
  it("keeps a declared provider that still exists", () => {
    expect(resolveProviderId("OpenAI", "https://whatever/v1")).toBe("openai");
  });

  it("falls back to a URL match for configs saved before providers existed", () => {
    expect(resolveProviderId("", "https://api.deepseek.com/v1/")).toBe("deepseek");
    expect(resolveProviderId(undefined, "https://api.moonshot.cn/v1")).toBe("moonshot");
  });

  it("lands on the custom card for unknown hosts and empty configs", () => {
    expect(resolveProviderId("", "https://my-gateway.internal/v1")).toBe(CUSTOM_PROVIDER_ID);
    expect(resolveProviderId("", "")).toBe(CUSTOM_PROVIDER_ID);
  });

  it("ignores provider ids that no longer exist", () => {
    expect(resolveProviderId("retired-vendor", "http://127.0.0.1:11434/v1")).toBe("ollama");
  });
});

describe("model helpers", () => {
  it("only reports preset models as preset", () => {
    expect(isPresetModel("openai", "gpt-4o-mini")).toBe(true);
    expect(isPresetModel("openai", "my-finetune-01")).toBe(false);
    expect(isPresetModel("openai", "   ")).toBe(false);
  });

  it("flags text-only presets without blocking custom models", () => {
    expect(modelSupportsVision("deepseek", "deepseek-chat")).toBe(false);
    expect(modelSupportsVision("openai", "gpt-4o-mini")).toBe(true);
    // 未收录的模型无法判断，按可用处理，不误伤自建接口。
    expect(modelSupportsVision("openai", "my-finetune-01")).toBe(true);
    expect(modelSupportsVision(CUSTOM_PROVIDER_ID, "anything")).toBe(true);
  });

  it("gives every preset a usable base url except the custom card", () => {
    for (const preset of AI_PROVIDERS) {
      if (preset.custom) {
        expect(preset.baseUrl).toBe("");
        continue;
      }
      expect(preset.baseUrl.startsWith("http")).toBe(true);
      expect(preset.models.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the custom card for unknown ids", () => {
    expect(findProvider("nope").id).toBe(CUSTOM_PROVIDER_ID);
  });
});

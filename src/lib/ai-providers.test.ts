import { describe, expect, it } from "vitest";
import type { ProfileLike } from "./ai-providers";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  findProvider,
  isPresetModel,
  maskApiKey,
  modelSupportsVision,
  newProfileId,
  pickActiveProfile,
  profileLabel,
  providerApiKey,
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
    expect(isPresetModel("openai", "gpt-6.1-terra")).toBe(true);
    expect(isPresetModel("openai", "my-finetune-01")).toBe(false);
    expect(isPresetModel("openai", "   ")).toBe(false);
  });

  it("flags text-only presets without blocking custom models", () => {
    expect(modelSupportsVision("deepseek", "deepseek-v4-pro")).toBe(false);
    expect(modelSupportsVision("openai", "gpt-6.1-terra")).toBe(true);
    // 未收录的模型无法判断，按可用处理，不误伤自建接口。
    expect(modelSupportsVision("openai", "my-finetune-01")).toBe(true);
    expect(modelSupportsVision(CUSTOM_PROVIDER_ID, "anything")).toBe(true);
  });

  it("keeps provider ids unique and base urls distinct", () => {
    const ids = AI_PROVIDERS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const urls = AI_PROVIDERS.filter((preset) => !preset.custom).map((preset) => preset.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
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

function profile(overrides: Partial<ProfileLike>): ProfileLike {
  return {
    id: "p1",
    name: "",
    provider: "openai",
    model: "gpt-6.1-terra",
    apiKey: "sk-aaaa1111",
    ...overrides,
  };
}

describe("profile helpers", () => {
  it("labels a profile by its note, else by provider and model", () => {
    expect(profileLabel(profile({ name: "打标用" }))).toBe("打标用");
    expect(profileLabel(profile({ name: "  " }))).toBe("OpenAI · gpt-6.1-terra");
    expect(profileLabel(profile({ model: "" }))).toBe("OpenAI · 未选模型");
  });

  it("masks keys without hiding the parts that tell accounts apart", () => {
    expect(maskApiKey("sk-1234567890abcd")).toBe("sk-…abcd");
    expect(maskApiKey("  ")).toBe("无 Key");
    expect(maskApiKey("short")).toBe("short");
  });

  it("reuses the newest key saved for the same provider only", () => {
    const profiles = [
      profile({ id: "a", provider: "openai", apiKey: "sk-old" }),
      profile({ id: "b", provider: "deepseek", apiKey: "sk-ds" }),
      profile({ id: "c", provider: "openai", apiKey: "sk-new" }),
    ];
    expect(providerApiKey(profiles, "openai")).toBe("sk-new");
    expect(providerApiKey(profiles, "openai", "c")).toBe("sk-old");
    expect(providerApiKey(profiles, "deepseek")).toBe("sk-ds");
    // 没有该服务商的档案时返回空，调用方据此清空输入框而不是沿用旧 Key。
    expect(providerApiKey(profiles, "moonshot")).toBe("");
  });

  it("picks the active profile and falls back to the first one", () => {
    const profiles = [profile({ id: "a" }), profile({ id: "b" })];
    expect(pickActiveProfile({ activeProfileId: "b", profiles })?.id).toBe("b");
    expect(pickActiveProfile({ activeProfileId: "gone", profiles })?.id).toBe("a");
    expect(pickActiveProfile({ activeProfileId: "a", profiles: [] })).toBeNull();
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProfileId()));
    expect(ids.size).toBe(50);
  });
});

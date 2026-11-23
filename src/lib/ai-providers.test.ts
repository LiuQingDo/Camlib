import { describe, expect, it } from "vitest";
import type { ProfileLike } from "./ai-providers";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  PROVIDER_CATEGORIES,
  consoleHost,
  filterProviderPresets,
  findProvider,
  maskApiKey,
  newProfileId,
  pickActiveProfile,
  pickerPresets,
  profileLabel,
  profileModels,
  profileSummary,
  profileTitle,
  providerApiKey,
  providerCategory,
  providerEndpoints,
  providerRegions,
  providersInCategory,
  regionForBaseUrl,
  resolveProviderId,
} from "./ai-providers";

describe("resolveProviderId", () => {
  it("keeps a declared provider that still exists", () => {
    expect(resolveProviderId("OpenAI", "https://whatever/v1")).toBe("openai");
  });

  it("falls back to a URL match for configs saved before providers existed", () => {
    expect(resolveProviderId("", "https://api.deepseek.com/v1/")).toBe(CUSTOM_PROVIDER_ID);
    expect(resolveProviderId("", "https://api.deepseek.com")).toBe("deepseek");
    expect(resolveProviderId(undefined, "https://api.moonshot.cn/v1")).toBe("moonshot");
  });

  it("matches every region of a multi-region vendor", () => {
    expect(resolveProviderId("", "https://api.moonshot.ai/v1")).toBe("moonshot");
    expect(resolveProviderId("", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("qwen");
    expect(resolveProviderId("", "https://api.z.ai/api/paas/v4")).toBe("zhipu");
  });

  it("lands on the custom card for unknown hosts and empty configs", () => {
    expect(resolveProviderId("", "https://my-gateway.internal/v1")).toBe(CUSTOM_PROVIDER_ID);
    expect(resolveProviderId("", "")).toBe(CUSTOM_PROVIDER_ID);
  });

  it("ignores provider ids that no longer exist", () => {
    expect(resolveProviderId("retired-vendor", "http://127.0.0.1:11434/v1")).toBe("ollama");
  });
});

describe("provider presets", () => {
  it("no longer ships a model list", () => {
    // 模型一律由「获取模型」按密钥现取，预设里留一份必然过期的清单只会误导用户。
    for (const preset of AI_PROVIDERS) {
      expect("models" in preset).toBe(false);
    }
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
    }
  });

  it("falls back to the custom card for unknown ids", () => {
    expect(findProvider("nope").id).toBe(CUSTOM_PROVIDER_ID);
  });

  it("gives every preset a brand tint and a known category", () => {
    const categories = new Set(PROVIDER_CATEGORIES.map((item) => item.id));
    for (const preset of AI_PROVIDERS) {
      expect(preset.tint).toMatch(/^#[0-9a-f]{6}$/i);
      expect(categories.has(preset.category)).toBe(true);
    }
  });

  it("keeps the custom card inside the API category", () => {
    expect(providerCategory(CUSTOM_PROVIDER_ID)).toBe("api");
    expect(providersInCategory("api").some((preset) => preset.custom)).toBe(true);
  });
});

describe("region and endpoint helpers", () => {
  it("gives single-region vendors one synthetic region", () => {
    const regions = providerRegions(findProvider("deepseek"));
    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe("default");
    expect(regions[0].baseUrl).toBe("https://api.deepseek.com");
  });

  it("derives the active region from the saved base url", () => {
    expect(regionForBaseUrl(findProvider("moonshot"), "https://api.moonshot.ai/v1").id).toBe("intl");
    expect(regionForBaseUrl(findProvider("moonshot"), "https://api.moonshot.cn/v1/").id).toBe("cn");
    // 手改过地址或地址已下线时不至于没有区域可选。
    expect(regionForBaseUrl(findProvider("moonshot"), "https://example.com/v1").id).toBe("cn");
  });

  it("lists endpoints in protocol order and only when documented", () => {
    const deepseek = providerEndpoints(findProvider("deepseek"), "default").map((item) => item.protocol);
    expect(deepseek).toEqual(["openai", "anthropic"]);
    const zhipu = providerEndpoints(findProvider("zhipu"), "cn").map((item) => item.protocol);
    expect(zhipu).toEqual(["openai", "responses", "anthropic"]);
    const openai = providerEndpoints(findProvider("openai"), "default");
    expect(openai[0].url).toBe("https://api.openai.com/v1");
    // 海外站只登记了官方文档写明的端点。
    const zai = providerEndpoints(findProvider("zhipu"), "global");
    expect(zai.map((item) => item.protocol)).toEqual(["openai", "anthropic"]);
  });

  it("always shows the openai-compatible endpoint first", () => {
    for (const preset of AI_PROVIDERS) {
      for (const region of providerRegions(preset)) {
        const endpoints = providerEndpoints(preset, region.id);
        expect(endpoints[0].protocol).toBe("openai");
        expect(endpoints[0].url).toBe(region.baseUrl);
      }
    }
  });

  it("turns console urls into a hostname for the header link", () => {
    expect(consoleHost("https://console.anthropic.com/settings/keys")).toBe("console.anthropic.com");
    expect(consoleHost("https://www.volcengine.com/docs/82379")).toBe("volcengine.com");
    expect(consoleHost(undefined)).toBe("");
    expect(consoleHost("not a url")).toBe("");
  });

  it("ships only vendor APIs in the picker, custom last", () => {
    const picker = pickerPresets();
    expect(picker.some((preset) => preset.id === "siliconflow")).toBe(false);
    expect(picker.some((preset) => preset.id === "ollama")).toBe(false);
    expect(picker[picker.length - 1].custom).toBe(true);
    // 国内厂商必须都在，这是本应用的主要使用场景。
    for (const id of ["deepseek", "moonshot", "zhipu", "qwen", "volcengine", "minimax", "qianfan", "hunyuan"]) {
      expect(picker.some((preset) => preset.id === id)).toBe(true);
    }
  });
});

describe("provider categories", () => {
  it("groups presets by category without losing any", () => {
    const grouped = PROVIDER_CATEGORIES.flatMap((item) => providersInCategory(item.id));
    expect(grouped.length).toBe(AI_PROVIDERS.length);
    expect(new Set(grouped.map((preset) => preset.id)).size).toBe(AI_PROVIDERS.length);
  });

  it("leaves the subscription tab empty in this version", () => {
    expect(providersInCategory("subscription")).toEqual([]);
  });

  it("separates relay aggregators from local servers", () => {
    expect(providersInCategory("relay").map((preset) => preset.id)).toEqual(["siliconflow", "openrouter"]);
    expect(providersInCategory("local").map((preset) => preset.id)).toEqual(["ollama", "lmstudio"]);
    expect(providerCategory("deepseek")).toBe("api");
  });

  it("searches by vendor name, id and model id", () => {
    const api = providersInCategory("api");
    expect(filterProviderPresets(api, "deep").map((preset) => preset.id)).toEqual(["deepseek"]);
    expect(filterProviderPresets(api, "KIMI").map((preset) => preset.id)).toEqual(["moonshot"]);
    expect(filterProviderPresets(api, "glm").some((preset) => preset.id === "zhipu")).toBe(true);
    // 空查询原样返回全部，避免添加面板刚打开就空着。
    expect(filterProviderPresets(api, "   ").length).toBe(api.length);
    expect(filterProviderPresets(api, "no-such-vendor")).toEqual([]);
  });
});

function profile(overrides: Partial<ProfileLike>): ProfileLike {
  return {
    id: "p1",
    name: "",
    provider: "openai",
    visionModel: "gpt-6.1-terra",
    chatModel: "gpt-6.1-terra",
    apiKey: "sk-aaaa1111",
    baseUrl: "https://api.openai.com/v1",
    ...overrides,
  };
}

describe("profile helpers", () => {
  it("labels a profile by its note, else by provider and model", () => {
    expect(profileLabel(profile({ name: "打标用" }))).toBe("打标用");
    expect(profileLabel(profile({ name: "  " }))).toBe("OpenAI · gpt-6.1-terra");
    expect(profileLabel(profile({ visionModel: "", chatModel: "" }))).toBe("OpenAI · 未选模型");
    // 两个角色不同时都标出来，避免误以为只有一个模型在跑。
    expect(profileLabel(profile({ visionModel: "gpt-vision", chatModel: "gpt-chat" }))).toBe(
      "OpenAI · 识图 gpt-vision · 对话 gpt-chat",
    );
  });

  it("summarizes both role models", () => {
    expect(profileModels(profile({}))).toBe("gpt-6.1-terra");
    expect(profileModels(profile({ visionModel: "gpt-vision", chatModel: "gpt-chat" }))).toBe(
      "识图 gpt-vision · 对话 gpt-chat",
    );
    expect(profileModels(profile({ visionModel: " only ", chatModel: "" }))).toBe("only");
    expect(profileModels(profile({ visionModel: "", chatModel: "" }))).toBe("");
  });

  it("titles a list row with the note or the vendor name", () => {
    expect(profileTitle(profile({ name: "小号" }))).toBe("小号");
    // 备注名与厂商同名时不重复显示，直接当标题用。
    expect(profileTitle(profile({ name: "OpenAI" }))).toBe("OpenAI");
    expect(profileTitle(profile({ name: "" }))).toBe("OpenAI");
  });

  it("summarizes a row as model plus masked key", () => {
    expect(profileSummary(profile({}))).toBe("gpt-6.1-terra · sk-…1111");
    expect(profileSummary(profile({ apiKey: "" }))).toBe("gpt-6.1-terra");
    expect(profileSummary(profile({ visionModel: "  ", chatModel: "", apiKey: "" }))).toBe("未选模型");
    expect(profileSummary(profile({ visionModel: "v", chatModel: "c", apiKey: "" }))).toBe("识图 v · 对话 c");
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

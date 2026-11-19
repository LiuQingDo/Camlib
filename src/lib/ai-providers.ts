/**
 * AI 服务商预设：设置页只让用户「选厂商」，模型一律现取。
 *
 * 收录原则：只放「厂商自己的 API」（models 厂商直连），不放中转聚合与本机服务；
 * 已添加的旧配置里若还有中转 / 本机的 id，仍然能凭预设回显，只是不再出现在添加
 * 面板里。国内厂商排在前面，因为本应用的主要用户在国内，直连可用、付款方便。
 *
 * 模型不写死：各厂商在售型号几个月就换一轮，硬编码的清单很快就变成过期答案。
 * 配置页改成一个「获取模型」按钮，用当前地址与密钥问上游 `GET /models`，把真实
 * 可用的名字列给用户挑（见 `api/ai.ts` 的 `listAiModels`）。
 *
 * 端点分协议登记：本应用自己只走 OpenAI 兼容的 Chat Completions（`baseUrl` 后拼
 * `/chat/completions`），Responses 与 Anthropic 两个协议端点照官方文档一并登记，
 * 界面上标成「仅展示」——写清楚能力边界，比只显示一个地址更不容易让人误以为能用。
 *
 * 维护说明：地址一律以各家官方文档为准，`baseUrl` 填到客户端 SDK 的 base_url 这一
 * 级（不要带 `/chat/completions`）。核查时间：2026-11。
 */

/** 供应商面板顶部的一级分类；本版本只展示 `api`。 */
export type ProviderCategory = "subscription" | "api" | "relay" | "local";

/** 供应商面板的三段式视图：已添加列表 → 添加（厂商网格）→ 单个配置。 */
export type AiPanelView = "list" | "picker" | "edit";

export interface ProviderCategoryMeta {
  id: ProviderCategory;
  label: string;
  /** 分类页签下方的一句话说明。 */
  hint: string;
}

export const PROVIDER_CATEGORIES: ProviderCategoryMeta[] = [
  { id: "subscription", label: "订阅", hint: "登录已有账号，无需密钥" },
  { id: "api", label: "API 供应商", hint: "厂商预设，粘贴密钥即用" },
  { id: "relay", label: "中转", hint: "聚合平台与代理服务" },
  { id: "local", label: "本机", hint: "跑在本机的模型服务" },
];

export const DEFAULT_PROVIDER_CATEGORY: ProviderCategory = "api";

/** 接口协议。应用只实现 `openai`，其余仅作信息展示。 */
export type AiProtocol = "openai" | "responses" | "anthropic";

export interface AiProtocolMeta {
  id: AiProtocol;
  /** 端点行左侧的协议名。 */
  label: string;
  /** 悬停说明。 */
  note: string;
}

export const AI_PROTOCOLS: AiProtocolMeta[] = [
  { id: "openai", label: "OpenAI", note: "Chat Completions 协议，本应用正在使用" },
  { id: "responses", label: "Responses", note: "OpenAI Responses 协议，本版本未接入" },
  { id: "anthropic", label: "Anthropic", note: "Anthropic Messages 协议，本版本未接入" },
];

/** 一个区域的接口地址组；不填的协议表示该区域没有这个端点。 */
export interface AiProviderRegion {
  id: string;
  label: string;
  /** OpenAI 兼容 base（应用在其后拼 `/chat/completions`）。 */
  baseUrl: string;
  responsesUrl?: string;
  anthropicUrl?: string;
}

/** 配置页「端点」区的一行。 */
export interface AiEndpoint {
  protocol: AiProtocol;
  url: string;
}

export interface AiProviderPreset {
  id: string;
  name: string;
  /** 卡片副标题，说明是云端、本地还是按量计费。 */
  hint: string;
  /** 卡片左上角的短徽标（1–2 字符）。 */
  mark: string;
  /** 徽标底色：各家品牌色，做浅淡处理，避免整屏灰。 */
  tint: string;
  /** 所属分类；添加面板只列 `api`。 */
  category: ProviderCategory;
  /** 默认区域（首个区域）的 OpenAI 兼容地址；自定义厂商留空。 */
  baseUrl: string;
  /** 默认区域的 Responses 地址。 */
  responsesUrl?: string;
  /** 默认区域的 Anthropic 地址。 */
  anthropicUrl?: string;
  /** 多区域厂商（中国 / 国际 / 海外站）；只登记有官方文档背书的区域。 */
  regions?: AiProviderRegion[];
  keyPlaceholder: string;
  /** 本地服务通常不需要 Key。 */
  keyOptional?: boolean;
  /** 自定义服务商：连接口地址也要手填（模型一律现取或手填）。 */
  custom?: boolean;
  /** 「获取密钥」跳转的厂商控制台；没有可跳的页面时留空。 */
  keyUrl?: string;
  /** 官方文档首页，配置页副标题里的「文档」用它。 */
  docsUrl?: string;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "国内直连",
    mark: "DS",
    tint: "#4d6bfe",
    category: "api",
    baseUrl: "https://api.deepseek.com",
    anthropicUrl: "https://api.deepseek.com/anthropic",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com",
  },
  {
    id: "moonshot",
    name: "Kimi",
    hint: "月之暗面",
    mark: "K",
    tint: "#1f2328",
    category: "api",
    baseUrl: "https://api.moonshot.cn/v1",
    regions: [
      { id: "cn", label: "中国", baseUrl: "https://api.moonshot.cn/v1" },
      { id: "intl", label: "国际", baseUrl: "https://api.moonshot.ai/v1" },
    ],
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    docsUrl: "https://platform.moonshot.cn/docs",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    hint: "国内直连 · 原生多模态",
    mark: "智",
    tint: "#3a5cf0",
    category: "api",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    responsesUrl: "https://open.bigmodel.cn/api/v1",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    regions: [
      {
        id: "cn",
        label: "中国",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        responsesUrl: "https://open.bigmodel.cn/api/v1",
        anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      },
      {
        id: "global",
        label: "海外 · z.ai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        anthropicUrl: "https://api.z.ai/api/anthropic",
      },
    ],
    keyPlaceholder: "API Key（id.secret）",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://docs.bigmodel.cn",
  },
  {
    id: "qwen",
    name: "通义千问",
    hint: "阿里云百炼",
    mark: "通",
    tint: "#6f5bf0",
    category: "api",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    regions: [
      { id: "cn", label: "中国 · 北京", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "intl", label: "新加坡", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    ],
    keyPlaceholder: "sk-…",
    keyUrl: "https://bailian.console.aliyun.com/",
    docsUrl: "https://help.aliyun.com/zh/model-studio/",
  },
  {
    id: "volcengine",
    name: "火山方舟",
    hint: "豆包 Seed",
    mark: "豆",
    tint: "#1664ff",
    category: "api",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyPlaceholder: "ARK API Key",
    keyUrl: "https://console.volcengine.com/ark",
    docsUrl: "https://www.volcengine.com/docs/82379",
  },
  {
    id: "minimax",
    name: "MiniMax",
    hint: "国内直连 · 多模态",
    mark: "MM",
    tint: "#ff5a1f",
    category: "api",
    baseUrl: "https://api.minimaxi.com/v1",
    regions: [
      { id: "cn", label: "中国", baseUrl: "https://api.minimaxi.com/v1" },
      { id: "intl", label: "国际", baseUrl: "https://api.minimax.io/v1" },
    ],
    keyPlaceholder: "API Key",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    docsUrl: "https://platform.minimaxi.com/docs",
  },
  {
    id: "qianfan",
    name: "百度千帆",
    hint: "文心 ERNIE",
    mark: "千",
    tint: "#2932e1",
    category: "api",
    baseUrl: "https://qianfan.baidubce.com/v2",
    keyPlaceholder: "API Key（bce-v3/…）",
    keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    docsUrl: "https://cloud.baidu.com/doc/qianfan-api",
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    hint: "腾讯云 TokenHub",
    mark: "混",
    tint: "#0f6bff",
    category: "api",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyPlaceholder: "TokenHub API Key",
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    docsUrl: "https://cloud.tencent.com/document/product/1729",
  },
  {
    id: "stepfun",
    name: "阶跃星辰",
    hint: "Step 系列",
    mark: "阶",
    tint: "#2f6bff",
    category: "api",
    baseUrl: "https://api.stepfun.com/v1",
    anthropicUrl: "https://api.stepfun.com",
    keyPlaceholder: "API Key",
    keyUrl: "https://platform.stepfun.com/interface-key",
    docsUrl: "https://platform.stepfun.com/docs",
  },
  {
    id: "longcat",
    name: "LongCat",
    hint: "美团 · 龙猫",
    mark: "LC",
    tint: "#f5a623",
    category: "api",
    baseUrl: "https://api.longcat.chat/openai/v1",
    anthropicUrl: "https://api.longcat.chat/anthropic",
    keyPlaceholder: "API Key",
    keyUrl: "https://longcat.chat/platform/api-keys",
    docsUrl: "https://longcat.chat/platform/docs",
  },
  {
    id: "mimo",
    name: "小米 MiMo",
    hint: "按量付费 · 多模态",
    mark: "MI",
    tint: "#ff6900",
    category: "api",
    baseUrl: "https://api.xiaomimimo.com/v1",
    anthropicUrl: "https://api.xiaomimimo.com/anthropic",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.xiaomimimo.com/",
    docsUrl: "https://platform.xiaomimimo.com/docs",
  },
  {
    id: "custom",
    name: "自定义",
    hint: "任意兼容接口",
    mark: "＋",
    tint: "#8a8a8a",
    category: "api",
    baseUrl: "",
    keyPlaceholder: "sk-…（可留空）",
    custom: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    hint: "官方 API",
    mark: "O",
    tint: "#0f9d7a",
    category: "api",
    baseUrl: "https://api.openai.com/v1",
    responsesUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Claude",
    mark: "A",
    tint: "#c96442",
    category: "api",
    baseUrl: "https://api.anthropic.com/v1",
    anthropicUrl: "https://api.anthropic.com",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://platform.claude.com/docs",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "官方兼容层",
    mark: "G",
    tint: "#1a73e8",
    category: "api",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: "xai",
    name: "Grok",
    hint: "xAI 官方",
    mark: "X",
    tint: "#111111",
    category: "api",
    baseUrl: "https://api.x.ai/v1",
    keyPlaceholder: "xai-…",
    keyUrl: "https://console.x.ai/",
    docsUrl: "https://docs.x.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    hint: "欧洲 · 官方 API",
    mark: "M",
    tint: "#fa520f",
    category: "api",
    baseUrl: "https://api.mistral.ai/v1",
    keyPlaceholder: "API Key",
    keyUrl: "https://console.mistral.ai/api-keys",
    docsUrl: "https://docs.mistral.ai",
  },
  {
    id: "groq",
    name: "Groq",
    hint: "超快推理",
    mark: "9",
    tint: "#f55036",
    category: "api",
    baseUrl: "https://api.groq.com/openai/v1",
    keyPlaceholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs",
  },
  // ── 以下为旧版本已收录的聚合 / 本机服务：不再出现在添加面板，仅用于回显旧配置 ──
  {
    id: "siliconflow",
    name: "硅基流动",
    hint: "多模型聚合",
    mark: "SF",
    tint: "#7c5cff",
    category: "relay",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyPlaceholder: "sk-…",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "聚合网关",
    mark: "OR",
    tint: "#5b6470",
    category: "relay",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    name: "Ollama",
    hint: "本地运行",
    mark: "OL",
    tint: "#111111",
    category: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyPlaceholder: "本地服务无需填写",
    keyOptional: true,
    keyUrl: "https://ollama.com/download",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    hint: "本地运行",
    mark: "LM",
    tint: "#6b5bff",
    category: "local",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyPlaceholder: "本地服务无需填写",
    keyOptional: true,
    keyUrl: "https://lmstudio.ai/",
  },
];

export const CUSTOM_PROVIDER_ID = "custom";

/**
 * 按 id 取预设；未知 id 一律落到「自定义」。
 *
 * 不能用「数组最后一项」当兜底：分类重排后最后一项变成了本机服务，未知厂商
 * 会被静默指向 127.0.0.1。这里显式找 custom。
 */
export function findProvider(id: string): AiProviderPreset {
  return (
    AI_PROVIDERS.find((preset) => preset.id === id) ?? AI_PROVIDERS.find((preset) => preset.custom) ?? AI_PROVIDERS[0]
  );
}

/** 某个分类下的全部预设；订阅类本版本为空。 */
export function providersInCategory(category: ProviderCategory): AiProviderPreset[] {
  return AI_PROVIDERS.filter((preset) => preset.category === category);
}

/** 添加面板的厂商清单：只要厂商 API，自定义排在最后。 */
export function pickerPresets(): AiProviderPreset[] {
  const api = providersInCategory("api");
  return [...api.filter((preset) => !preset.custom), ...api.filter((preset) => preset.custom)];
}

export function categoryMeta(category: ProviderCategory): ProviderCategoryMeta {
  return PROVIDER_CATEGORIES.find((item) => item.id === category) ?? PROVIDER_CATEGORIES[1];
}

/** 已有配置落在哪个分类：用于列表里的归类标签。 */
export function providerCategory(providerId: string): ProviderCategory {
  return findProvider(providerId).category;
}

/**
 * 添加面板的搜索：厂商名、副标题与 id 参与匹配。
 * 空查询原样返回，不做无谓过滤。
 */
export function filterProviderPresets(presets: readonly AiProviderPreset[], query: string): AiProviderPreset[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...presets];
  return presets.filter((preset) => {
    if (preset.name.toLowerCase().includes(needle)) return true;
    if (preset.hint.toLowerCase().includes(needle)) return true;
    return preset.id.toLowerCase().includes(needle);
  });
}

// ── 区域与端点 ──────────────────────────────────────────────────────────────

/** 预设的全部区域；单区域厂商补一条默认区域，界面逻辑不用分支。 */
export function providerRegions(preset: AiProviderPreset): AiProviderRegion[] {
  if (preset.regions && preset.regions.length > 0) return preset.regions;
  return [
    {
      id: "default",
      label: "默认",
      baseUrl: preset.baseUrl,
      ...(preset.responsesUrl ? { responsesUrl: preset.responsesUrl } : {}),
      ...(preset.anthropicUrl ? { anthropicUrl: preset.anthropicUrl } : {}),
    },
  ];
}

/**
 * 当前 baseUrl 落在哪个区域。
 * 旧配置里手改过地址、或地址已被厂商下线时，退回首个区域——界面总得有东西可填。
 */
export function regionForBaseUrl(preset: AiProviderPreset, baseUrl: string): AiProviderRegion {
  const regions = providerRegions(preset);
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const hit = regions.find((region) => region.baseUrl.replace(/\/+$/, "").toLowerCase() === normalized);
  return hit ?? regions[0];
}

/** 该区域登记过的协议端点，按 OpenAI → Responses → Anthropic 顺序。 */
export function providerEndpoints(preset: AiProviderPreset, regionId?: string): AiEndpoint[] {
  const regions = providerRegions(preset);
  const region = regions.find((item) => item.id === regionId) ?? regions[0];
  const endpoints: AiEndpoint[] = [{ protocol: "openai", url: region.baseUrl }];
  if (region.responsesUrl) endpoints.push({ protocol: "responses", url: region.responsesUrl });
  if (region.anthropicUrl) endpoints.push({ protocol: "anthropic", url: region.anthropicUrl });
  return endpoints;
}

/** 协议中文名，编辑器端点行左侧用。 */
export function protocolMeta(protocol: AiProtocol): AiProtocolMeta {
  return AI_PROTOCOLS.find((item) => item.id === protocol) ?? AI_PROTOCOLS[0];
}

/** 控制台链接的域名，配置页右上角显示「console.anthropic.com ↗」这种形态。 */
export function consoleHost(url: string | undefined): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 回显时决定高亮哪张卡片：配置里的 provider 优先；旧配置没有该字段时按接口
 * 地址反查（含多区域厂商的每个区域地址），仍对不上则落到「自定义」。
 */
export function resolveProviderId(provider: string | undefined, baseUrl: string): string {
  const declared = (provider ?? "").trim().toLowerCase();
  if (declared && AI_PROVIDERS.some((preset) => preset.id === declared)) return declared;
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return CUSTOM_PROVIDER_ID;
  const byUrl = AI_PROVIDERS.find((preset) => {
    const urls = providerRegions(preset).map((region) => region.baseUrl);
    return urls.some((url) => url.trim().replace(/\/+$/, "").toLowerCase() === normalized);
  });
  return byUrl?.id ?? CUSTOM_PROVIDER_ID;
}

// ── 模型档案（每个服务商可多条，Key 各自独立） ──────────────────────────────

/** 档案的最小结构；与 `AiProfileDto` 兼容但不反向依赖 api 层。 */
export interface ProfileLike {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** 生成档案 id：优先 UUID，非安全上下文退化为时间戳+随机数。 */
export function newProfileId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前生效的档案：按 activeProfileId 取，找不到时退回第一条。 */
export function pickActiveProfile<T extends ProfileLike>(config: {
  activeProfileId: string;
  profiles: readonly T[];
}): T | null {
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? config.profiles[0] ?? null;
}

/** 按 id 取档案（编辑页用），不做「退回第一条」的兜底。 */
export function findProfile<T extends ProfileLike>(profiles: readonly T[], id: string): T | null {
  return profiles.find((profile) => profile.id === id) ?? null;
}

/** 档案展示名：优先用户备注，其次「服务商 · 模型」。 */
export function profileLabel(profile: Pick<ProfileLike, "name" | "provider" | "model">): string {
  const named = profile.name.trim();
  if (named) return named;
  const providerName = findProvider(profile.provider).name;
  const model = profile.model.trim();
  return model ? `${providerName} · ${model}` : `${providerName} · 未选模型`;
}

/** 列表行的名称：一律用服务商名，备注名单独作为副标题显示。 */
export function profileTitle(profile: Pick<ProfileLike, "name" | "provider">): string {
  const providerName = findProvider(profile.provider).name;
  const named = profile.name.trim();
  return named && named !== providerName ? named : providerName;
}

/** 列表行的副标题：模型 + 掩码 Key，一眼分清同厂商的两个账号。 */
export function profileSummary(profile: Pick<ProfileLike, "provider" | "model" | "apiKey">): string {
  const model = profile.model.trim() || "未选模型";
  const key = maskApiKey(profile.apiKey);
  return key === "无 Key" ? model : `${model} · ${key}`;
}

/**
 * Key 掩码：只露头尾几位，用于在同服务商的多条档案之间区分账号。
 * 空 Key（本地服务）显示「无 Key」。
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "无 Key";
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

/**
 * 取该服务商已保存的 Key（最近添加的档案优先）。
 *
 * 只在「添加同服务商第二条档案」时作为预填值使用：Key 仍写进目标档案自己
 * 的字段，不会共享同一个存储位置，因此删改任一条都不影响其它条。
 */
export function providerApiKey(
  profiles: readonly ProfileLike[],
  providerId: string,
  excludeProfileId?: string,
): string {
  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    const profile = profiles[index];
    if (!profile) continue;
    if (profile.id === excludeProfileId) continue;
    if (profile.provider !== providerId) continue;
    if (profile.apiKey.trim()) return profile.apiKey.trim();
  }
  return "";
}

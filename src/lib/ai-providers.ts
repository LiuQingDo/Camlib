/**
 * AI 服务商预设：设置页只让用户「选」而不是「填」。
 *
 * 每个预设固化了 OpenAI 兼容接口地址与当前在售的模型清单，选中卡片后模型下拉
 * 即可切换；需要私有部署或尚未收录的模型时选「自定义」再手填。打标与看图对话
 * 要求模型支持图片输入，`vision: false` 的条目只适合对话与查询解析，界面会显式
 * 提示。
 *
 * 维护说明：接口地址一律填到 `/v1` 这一级（应用自己拼 `/chat/completions`），
 * 清单以各家官方文档为准，只收录能走 Chat Completions 且支持 `image_url`
 * （data URL）的模型；纯 OCR / 图像生成的模型不放进来。核查时间：2026-11。
 */

export interface AiModelOption {
  /** 请求体里的 `model` 字段原样值。 */
  id: string;
  /** 下拉里显示的名字。 */
  label: string;
  /** 是否支持图片输入（自动打标必需）。 */
  vision: boolean;
  /** 一句话定位，例如「推荐」「便宜快」「本地」。 */
  note?: string;
}

export interface AiProviderPreset {
  id: string;
  name: string;
  /** 卡片副标题，说明是云端还是本地。 */
  hint: string;
  /** 卡片左上角的短徽标（1–2 字符）。 */
  mark: string;
  baseUrl: string;
  models: AiModelOption[];
  keyPlaceholder: string;
  /** 本地服务通常不需要 Key。 */
  keyOptional?: boolean;
  /** 自定义服务商：接口地址与模型名都手填。 */
  custom?: boolean;
}

/** 模型下拉里代表「手填模型名」的值。 */
export const CUSTOM_MODEL_ID = "__custom__";

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    hint: "官方 API",
    mark: "O",
    baseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "gpt-6.1-terra", label: "gpt-6.1-terra", vision: true, note: "推荐 · 视觉推理，便宜" },
      { id: "gpt-6-luna", label: "gpt-6-luna", vision: true, note: "最便宜 · 高并发" },
      { id: "gpt-6.1-sol", label: "gpt-6.1-sol", vision: true, note: "效果更强" },
      { id: "gpt-6-astra", label: "gpt-6-astra", vision: true, note: "旗舰 · 最贵" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra", vision: true, note: "上一代" },
    ],
  },
  {
    id: "qwen",
    name: "通义千问",
    hint: "阿里云百炼",
    mark: "通",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "qwen4-max", label: "qwen4-max", vision: true, note: "推荐 · 最新旗舰" },
      { id: "qwen3.8-max", label: "qwen3.8-max", vision: true, note: "看图强" },
      { id: "qwen3.8-flash", label: "qwen3.8-flash", vision: true, note: "便宜快" },
      { id: "qwen3-vl-plus", label: "qwen3-vl-plus", vision: true, note: "纯视觉 · 细描述" },
      { id: "qwen3-vl-flash", label: "qwen3-vl-flash", vision: true, note: "纯视觉 · 更便宜" },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    hint: "国内直连",
    mark: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyPlaceholder: "API Key",
    models: [
      { id: "glm-5.3-flash", label: "glm-5.3-flash", vision: true, note: "推荐 · 原生多模态" },
      { id: "glm-5.3-flashx", label: "glm-5.3-flashx", vision: true, note: "更快" },
      { id: "glm-5v-turbo", label: "glm-5v-turbo", vision: true, note: "视觉推理 · 支持 PDF" },
      { id: "glm-4.6v-flash", label: "glm-4.6v-flash", vision: true, note: "免费额度" },
      { id: "glm-5.3", label: "glm-5.3", vision: false, note: "仅文本 · 旗舰" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    hint: "Kimi",
    mark: "K",
    baseUrl: "https://api.moonshot.cn/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "kimi-k3.1-pro", label: "kimi-k3.1-pro", vision: true, note: "推荐 · 支持图片" },
      { id: "kimi-k3.1-pro-highspeed", label: "kimi-k3.1-pro-highspeed", vision: true, note: "同款 · 更快" },
      { id: "kimi-k2.6", label: "kimi-k2.6", vision: true, note: "便宜 · 支持图片" },
      { id: "kimi-k2.7-code", label: "kimi-k2.7-code", vision: false, note: "仅文本 · 代码" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "国内直连",
    mark: "DS",
    baseUrl: "https://api.deepseek.com/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "deepseek-flash", label: "deepseek-flash", vision: true, note: "推荐 · 支持图片" },
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro", vision: false, note: "仅文本 · 推理" },
    ],
  },
  {
    id: "volcengine",
    name: "豆包 · 方舟",
    hint: "火山引擎",
    mark: "豆",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyPlaceholder: "ARK API Key",
    models: [
      { id: "doubao-seed-2-1-pro-260915", label: "doubao-seed-2.1-pro", vision: true, note: "推荐 · 多模态理解" },
      { id: "doubao-seed-2-1-turbo-260628", label: "doubao-seed-2.1-turbo", vision: true, note: "快" },
      { id: "doubao-seed-2-1-lite-260915", label: "doubao-seed-2.1-lite", vision: true, note: "便宜 · 高并发" },
      { id: "doubao-seed-evolving", label: "doubao-seed-evolving", vision: true, note: "快速迭代版" },
    ],
  },
  {
    id: "qianfan",
    name: "百度千帆",
    hint: "文心 ERNIE",
    mark: "千",
    baseUrl: "https://qianfan.baidubce.com/v2",
    keyPlaceholder: "API Key（bce-v3/…）",
    models: [
      { id: "ernie-5.1", label: "ernie-5.1", vision: true, note: "推荐 · 多模态" },
      { id: "ernie-4.5-turbo-vl", label: "ernie-4.5-turbo-vl", vision: true, note: "看图 · 便宜" },
      { id: "ernie-5.5-flash-preview", label: "ernie-5.5-flash-preview", vision: false, note: "仅文本 · 预览" },
    ],
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    hint: "TokenHub",
    mark: "混",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyPlaceholder: "API Key",
    models: [
      { id: "hy4", label: "hy4", vision: true, note: "推荐 · 支持图片" },
      { id: "hy4-flash", label: "hy4-flash", vision: true, note: "便宜快" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    hint: "国内直连",
    mark: "MM",
    baseUrl: "https://api.minimaxi.com/v1",
    keyPlaceholder: "API Key",
    models: [
      { id: "MiniMax-M3", label: "MiniMax-M3", vision: true, note: "推荐 · 支持图片" },
      { id: "MiniMax-M3.1-Flash", label: "MiniMax-M3.1-Flash", vision: true, note: "便宜" },
    ],
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    hint: "多模型聚合",
    mark: "SF",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "Qwen/Qwen3-VL-32B-Instruct", label: "Qwen3-VL-32B", vision: true, note: "推荐 · 看图" },
      { id: "Qwen/Qwen3-VL-30B-A3B-Instruct", label: "Qwen3-VL-30B-A3B", vision: true, note: "性价比" },
      { id: "Qwen/Qwen3-VL-8B-Instruct", label: "Qwen3-VL-8B", vision: true, note: "便宜快" },
      { id: "Qwen/Qwen3.8-27B", label: "Qwen3.8-27B", vision: true, note: "新代多模态" },
      { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek-V4-Pro", vision: false, note: "仅文本" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "聚合网关",
    mark: "OR",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-…",
    models: [
      { id: "openai/gpt-6.1-terra", label: "gpt-6.1-terra", vision: true, note: "推荐" },
      { id: "google/gemini-4-argon", label: "gemini-4-argon", vision: true, note: "旗舰" },
      { id: "qwen/qwen4-max", label: "qwen4-max", vision: true, note: "国产旗舰" },
      { id: "moonshotai/kimi-k3.1-pro", label: "kimi-k3.1-pro", vision: true },
      { id: "deepseek/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", vision: true, note: "便宜" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "官方兼容层",
    mark: "G",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza…",
    models: [
      { id: "gemini-4-argon", label: "gemini-4-argon", vision: true, note: "推荐 · 旗舰" },
      { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen", vision: true, note: "最新" },
      { id: "gemini-3.8-flash", label: "gemini-3.8-flash", vision: true, note: "便宜快" },
    ],
  },
  {
    id: "xai",
    name: "Grok",
    hint: "xAI 官方",
    mark: "X",
    baseUrl: "https://api.x.ai/v1",
    keyPlaceholder: "xai-…",
    models: [
      { id: "grok-4.7", label: "grok-4.7", vision: true, note: "推荐 · 支持图片" },
      { id: "grok-4.6", label: "grok-4.6", vision: true, note: "上一代" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    hint: "本地运行",
    mark: "OL",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyPlaceholder: "本地服务无需填写",
    keyOptional: true,
    models: [
      { id: "qwen3-vl:8b", label: "qwen3-vl:8b", vision: true, note: "推荐 · 中文看图" },
      { id: "qwen3-vl:4b", label: "qwen3-vl:4b", vision: true, note: "小体积" },
      { id: "qwen3-vl:30b-a3b", label: "qwen3-vl:30b-a3b", vision: true, note: "效果更好" },
      { id: "qwen3.8:27b", label: "qwen3.8:27b", vision: true, note: "新代多模态" },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    hint: "本地运行",
    mark: "LM",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyPlaceholder: "本地服务无需填写",
    keyOptional: true,
    models: [
      { id: "qwen/qwen3-vl-8b", label: "qwen3-vl-8b", vision: true, note: "推荐 · 以本地已下载的 ID 为准" },
      { id: "qwen/qwen3-vl-4b", label: "qwen3-vl-4b", vision: true, note: "小体积" },
    ],
  },
  {
    id: "custom",
    name: "自定义",
    hint: "兼容接口",
    mark: "＋",
    baseUrl: "",
    keyPlaceholder: "sk-…（可留空）",
    custom: true,
    models: [],
  },
];

export const CUSTOM_PROVIDER_ID = "custom";

export function findProvider(id: string): AiProviderPreset {
  return AI_PROVIDERS.find((preset) => preset.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

/**
 * 回显时决定高亮哪张卡片：配置里的 provider 优先；旧配置没有该字段时按接口
 * 地址反查，仍对不上则落到「自定义」。
 */
export function resolveProviderId(provider: string | undefined, baseUrl: string): string {
  const declared = (provider ?? "").trim().toLowerCase();
  if (declared && AI_PROVIDERS.some((preset) => preset.id === declared)) return declared;
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return CUSTOM_PROVIDER_ID;
  const byUrl = AI_PROVIDERS.find((preset) => preset.baseUrl && preset.baseUrl.toLowerCase() === normalized);
  return byUrl?.id ?? CUSTOM_PROVIDER_ID;
}

/** 模型名是否命中预设清单；未命中时下拉应停在「自定义模型」。 */
export function isPresetModel(provider: string, model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  return findProvider(provider).models.some((option) => option.id === trimmed);
}

/** 当前模型是否支持图片输入——打标前用它给出提示，不阻断保存。 */
export function modelSupportsVision(provider: string, model: string): boolean {
  const trimmed = model.trim();
  const preset = findProvider(provider);
  if (preset.custom) return true;
  const option = preset.models.find((item) => item.id === trimmed);
  return option ? option.vision : true;
}

// ── 模型档案（每个服务商可多条，Key 各自独立） ──────────────────────────────

/** 档案的最小结构；与 `AiProfileDto` 兼容但不反向依赖 api 层。 */
export interface ProfileLike {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
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

/** 档案展示名：优先用户备注，其次「服务商 · 模型」。 */
export function profileLabel(profile: Pick<ProfileLike, "name" | "provider" | "model">): string {
  const named = profile.name.trim();
  if (named) return named;
  const providerName = findProvider(profile.provider).name;
  const model = profile.model.trim();
  return model ? `${providerName} · ${model}` : `${providerName} · 未选模型`;
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
 * 只在「切换服务商 / 新建同服务商档案」时作为预填值使用：Key 仍写进目标档案
 * 自己的字段，不会共享同一个存储位置，因此删改任一条都不影响其它条。
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

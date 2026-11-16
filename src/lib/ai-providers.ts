/**
 * AI 服务商预设：设置页只让用户「选」而不是「填」。
 *
 * 每个预设固化了 OpenAI 兼容接口地址与常用模型清单，选中卡片后模型下拉即可切换；
 * 需要私有部署或尚未收录的模型时选「自定义」再手填。打标与看图对话要求模型支持
 * 图片输入，`vision: false` 的条目只适合对话与查询解析，界面会显式提示。
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
      { id: "gpt-4o-mini", label: "gpt-4o-mini", vision: true, note: "推荐 · 便宜快" },
      { id: "gpt-4o", label: "gpt-4o", vision: true, note: "效果最好" },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini", vision: true },
      { id: "gpt-4.1", label: "gpt-4.1", vision: true },
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
      { id: "qwen-vl-max", label: "qwen-vl-max", vision: true, note: "推荐 · 看图强" },
      { id: "qwen-vl-plus", label: "qwen-vl-plus", vision: true, note: "便宜" },
      { id: "qwen-max", label: "qwen-max", vision: false },
      { id: "qwen-plus", label: "qwen-plus", vision: false },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    hint: "国内直连",
    mark: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyPlaceholder: "密钥（id.secret）",
    models: [
      { id: "glm-4v-plus", label: "glm-4v-plus", vision: true, note: "推荐 · 看图" },
      { id: "glm-4v-flash", label: "glm-4v-flash", vision: true, note: "免费额度" },
      { id: "glm-4-plus", label: "glm-4-plus", vision: false },
      { id: "glm-4-flash", label: "glm-4-flash", vision: false },
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
      { id: "kimi-latest", label: "kimi-latest", vision: true, note: "推荐 · 支持图片" },
      { id: "moonshot-v1-8k-vision-preview", label: "moonshot-v1-8k-vision-preview", vision: true },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k", vision: false },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "纯文本",
    mark: "DS",
    baseUrl: "https://api.deepseek.com/v1",
    keyPlaceholder: "sk-…",
    models: [
      { id: "deepseek-chat", label: "deepseek-chat", vision: false, note: "仅对话" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner", vision: false, note: "仅对话 · 推理" },
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
      { id: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen2.5-VL-72B", vision: true, note: "推荐 · 看图" },
      { id: "Qwen/Qwen2-VL-7B-Instruct", label: "Qwen2-VL-7B", vision: true, note: "便宜" },
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek-V3", vision: false, note: "仅对话" },
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
      { id: "openai/gpt-4o-mini", label: "gpt-4o-mini", vision: true, note: "推荐" },
      { id: "google/gemini-2.5-flash", label: "gemini-2.5-flash", vision: true, note: "便宜快" },
      { id: "qwen/qwen2.5-vl-72b-instruct", label: "qwen2.5-vl-72b", vision: true },
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
      { id: "qwen2.5vl:7b", label: "qwen2.5vl:7b", vision: true, note: "推荐 · 中文看图" },
      { id: "llava:7b", label: "llava:7b", vision: true },
      { id: "gemma3:4b", label: "gemma3:4b", vision: true, note: "小体积" },
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
      { id: "qwen2.5-vl-7b-instruct", label: "qwen2.5-vl-7b-instruct", vision: true, note: "推荐" },
      { id: "llava-v1.6-mistral-7b", label: "llava-v1.6-mistral-7b", vision: true },
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

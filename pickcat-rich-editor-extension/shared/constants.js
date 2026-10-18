/**
 * 共享常量：服务商预设、默认提示词、选择器、默认配置。
 * 供 background / options / popup 以 ES module 方式导入；
 * 内容脚本（ai/content.js）为经典脚本，不导入本文件，仅按配置值工作。
 */

// ============================ 1. 服务商预设 ============================
// 全部走 OpenAI 兼容协议（/chat/completions），仅 baseUrl / 模型名不同。
// keyless：本地服务无需 API Key（如 Ollama）。
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '按量计费、价格极低，国内直连稳定',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'doubao',
    name: '豆包 · 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'],
    note: '新用户赠送免费额度；部分模型需填写控制台里的「接入点 ID」',
    keyUrl: 'https://console.volcengine.com/ark'
  },
  {
    id: 'qwen',
    name: '通义千问 · 阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    note: '百炼平台新用户有免费额度',
    keyUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k'],
    note: '长上下文见长',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    note: 'glm-4-flash 为免费模型',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat'],
    note: '提供多款免费模型（模型名需带组织前缀）',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    note: '带 :free 后缀的模型免费（有速率限制）',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'llama3.2'],
    note: '本地运行、无需 API Key；需先 ollama serve',
    keyless: true
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    note: '填写任意兼容 /chat/completions 的 Base URL'
  }
];

/** 按 id 取预设 */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

// ============================ 2. 默认提示词与选项 ============================

/** 默认用户提示词模板，{{xxx}} 为占位符，由内容脚本替换 */
export const DEFAULT_USER_PROMPT =
  '请阅读下面的帖子，提炼它的核心信息，并直接用 Markdown 排版输出。{{lang}}{{length}}\n\n标题：{{title}}\n\n正文：\n{{content}}';

/** 默认系统提示词（留空则用这句） */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个严谨的阅读助手。只依据用户提供的帖子内容作答，不要编造原文没有的信息。'
  + '所有回答都必须用 Markdown 排版：可用小标题（##）、要点列表（-）、**加粗**关键词；不要输出 HTML 或整段无格式纯文本。';

/** 输出长度 → 提示语句 */
export const LENGTH_HINTS = {
  short: '控制在 3 行以内，只给结论。',
  medium: '用 5-8 条要点分点说明，重点突出。',
  long: '用不超过 12 条要点分点说明，可加小标题分节。'
};

/** 输出语言 → 提示语句 */
export const LANG_HINTS = {
  auto: '',
  zh: '请使用简体中文输出。',
  en: 'Please respond in English.'
};

/** 触发方式 */
export const TRIGGERS = [
  { id: 'manual', name: '手动点击「总结」' },
  { id: 'auto', name: '打开帖子即自动总结' }
];

export const LENGTHS = [
  { id: 'short', name: '短（结论式）' },
  { id: 'medium', name: '中（5-8 条要点）' },
  { id: 'long', name: '长（分节要点）' }
];

export const LANGS = [
  { id: 'auto', name: '跟随原文' },
  { id: 'zh', name: '简体中文' },
  { id: 'en', name: 'English' }
];

// ============================ 3. 站点选择器（集中管理 + 多级降级） ============================
export const SELECTORS = {
  // 帖子详情页根节点
  article: 'article.relative',
  // 头像 + 操作头行（站点未用 <hr>，分隔线其实是它的 border-bottom）
  header: 'div[aria-label="作者与帖子操作"]',
  // 正文
  body: '.markdown-body',
  // 评论输入框（本版本不使用，预留给后续插件）
  replyInput: 'textarea.reply-composer-input'
};

// ============================ 4. 默认配置 ============================
export const DEFAULT_CONFIG = {
  enabled: true,            // 详情页 AI 面板总开关
  provider: 'deepseek',      // 服务商预设 id
  baseUrl: '',               // 自定义 Base URL（预设为空时用预设值）
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  maxTokens: 1200,
  systemPrompt: '',          // 留空用 DEFAULT_SYSTEM_PROMPT
  userPrompt: '',            // 留空用 DEFAULT_USER_PROMPT
  lang: 'auto',
  length: 'medium',
  trigger: 'manual',
  // 自动总结的最小字数门槛：本地统计正文去掉空白后的字符数，低于此值直接跳过（过滤水贴 / 空帖），0 表示不限制
  minChars: 100,
  stream: true
};

// ============================ 5. 存储键与缓存 ============================
export const STORAGE_KEYS = {
  config: 'pcai_config',
  cache: 'pcai_cache'
};

/** 缓存上限（条），超出按最早写入淘汰 */
export const CACHE_LIMIT = 60;

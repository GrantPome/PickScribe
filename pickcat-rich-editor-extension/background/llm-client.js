/**
 * OpenAI 兼容 LLM 客户端：负责 fetch 请求与 SSE 流式解析。
 * 只跑在 Background Service Worker 里，绕开页面 CSP / CORS，并集中管理 API Key。
 */

/** 统一错误对象：带上可读文案与错误码，便于内容脚本分类提示 */
export class LLMError extends Error {
  constructor(message, code = 'unknown', status = 0) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}

/** 拼接 /chat/completions 地址（兼容 baseUrl 是否带 /v1、是否带尾斜杠） */
export function buildEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LLMError('未配置接口地址', 'no_base_url');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

/** 把 HTTP 错误翻译成用户能看懂的中文提示 */
function httpError(status, bodyText) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = (j.error && (j.error.message || j.error.code)) || j.message || '';
  } catch (_) {
    detail = String(bodyText || '').slice(0, 200);
  }
  const map = {
    400: '请求参数有误（模型名或参数不正确）',
    401: 'API Key 无效或未授权',
    402: '账户余额不足，请先充值或改用带免费额度的模型',
    403: '无权访问该模型（可能是 Key 未开通）',
    404: '接口地址或模型名不存在',
    429: '请求过于频繁或额度已用尽，请稍后再试',
    500: '服务商内部错误',
    502: '服务商网关错误',
    503: '服务暂时不可用'
  };
  const msg = map[status] || `请求失败（HTTP ${status}）`;
  return new LLMError(detail ? `${msg}：${detail}` : msg, 'http_' + status, status);
}

/**
 * 流式对话（异步生成器，逐段 yield 文本增量）。
 * @param {object} opts
 * @param {string} opts.baseUrl     服务地址
 * @param {string} opts.apiKey      密钥（keyless 时可为空）
 * @param {string} opts.model       模型名
 * @param {Array}  opts.messages    [{role, content}]
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @param {AbortSignal} opts.signal 中断信号
 */
export async function* streamChat(opts) {
  const { baseUrl, apiKey, model, messages, temperature, maxTokens, signal } = opts;
  const endpoint = buildEndpoint(baseUrl);
  if (!model) throw new LLMError('未配置模型名', 'no_model');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: Number.isFinite(temperature) ? temperature : 0.3,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1200,
        stream: true
      }),
      signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new LLMError('已取消', 'aborted');
    throw new LLMError('网络请求失败，请检查网络或接口地址：' + (e && e.message ? e.message : e), 'network');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw httpError(res.status, text);
  }

  // 个别服务商在 stream=true 时仍返回整段 JSON，这里做兼容
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ''
      : '';
    if (text) yield text;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 按行处理 SSE：一行以 data: 开头
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (_) {
        continue; // 心跳 / 非 JSON 行直接跳过
      }
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};
      // 推理模型（如 deepseek-reasoner）会先给 reasoning_content，这里正常输出正文
      const piece = delta.content;
      if (piece) yield piece;
    }
  }
}

/** 非流式：把流式结果聚合为整段文本（供「测试连接」等场景） */
export async function chat(opts) {
  let text = '';
  for await (const piece of streamChat(opts)) text += piece;
  return text;
}

/**
 * 配置与缓存读写封装（chrome.storage.local）。
 * 供 background / options / popup 以 ES module 方式导入。
 */
import { DEFAULT_CONFIG, STORAGE_KEYS, CACHE_LIMIT } from './constants.js';

/** 读取配置（与默认值合并，保证新增字段有兜底） */
export async function getConfig() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.config);
  return { ...DEFAULT_CONFIG, ...(raw[STORAGE_KEYS.config] || {}) };
}

/** 局部更新配置 */
export async function patchConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: next });
  return next;
}

/** 整体覆盖配置 */
export async function setConfig(config) {
  const next = { ...DEFAULT_CONFIG, ...config };
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: next });
  return next;
}

/** 监听配置变化，返回取消函数 */
export function onConfigChange(handler) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.config]) {
      handler({ ...DEFAULT_CONFIG, ...(changes[STORAGE_KEYS.config].newValue || {}) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ============================ 缓存 ============================

async function readCache() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.cache);
  return raw[STORAGE_KEYS.cache] || {};
}

/** 读一条缓存，返回 { text, model, at } 或 null */
export async function getCached(key) {
  const cache = await readCache();
  return cache[key] || null;
}

/** 写一条缓存（带容量上限与 LRU 淘汰） */
export async function putCached(key, value) {
  const cache = await readCache();
  cache[key] = { ...value, at: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys
      .sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach((k) => delete cache[k]);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
}

/** 清空缓存，返回清掉的条数 */
export async function clearCache() {
  const cache = await readCache();
  const n = Object.keys(cache).length;
  await chrome.storage.local.set({ [STORAGE_KEYS.cache]: {} });
  return n;
}

// ============================ Token 用量统计 ============================

const EMPTY_USAGE = { prompt: 0, completion: 0, total: 0, calls: 0, models: {}, updated: 0 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 累加一次请求的 Token 用量（只统计真实调用，缓存命中不计入） */
export async function recordUsage(usage, model) {
  if (!usage) return null;
  const prompt = num(usage.prompt);
  const completion = num(usage.completion);
  const total = num(usage.total) || prompt + completion;
  if (!prompt && !completion && !total) return null;

  const raw = await chrome.storage.local.get(STORAGE_KEYS.usage);
  const cur = raw[STORAGE_KEYS.usage] || EMPTY_USAGE;
  const models = { ...(cur.models || {}) };
  const key = String(model || 'default');
  const item = models[key] || { prompt: 0, completion: 0, total: 0, calls: 0 };
  models[key] = {
    prompt: num(item.prompt) + prompt,
    completion: num(item.completion) + completion,
    total: num(item.total) + total,
    calls: num(item.calls) + 1
  };

  const next = {
    prompt: num(cur.prompt) + prompt,
    completion: num(cur.completion) + completion,
    total: num(cur.total) + total,
    calls: num(cur.calls) + 1,
    models,
    updated: Date.now()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: next });
  return next;
}

/** 读取累计用量（无数据时返回 0 结构） */
export async function getUsageStats() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.usage);
  const cur = raw[STORAGE_KEYS.usage] || EMPTY_USAGE;
  return {
    prompt: num(cur.prompt),
    completion: num(cur.completion),
    total: num(cur.total),
    calls: num(cur.calls),
    models: cur.models || {},
    updated: num(cur.updated)
  };
}

/** 清空用量统计 */
export async function clearUsageStats() {
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: { ...EMPTY_USAGE, models: {} } });
  return true;
}

/** 导出全部数据（配置 + 缓存） */
export async function exportAll() {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.config, STORAGE_KEYS.cache]);
  return {
    version: 1,
    config: raw[STORAGE_KEYS.config] || {},
    cache: raw[STORAGE_KEYS.cache] || {}
  };
}

/** 导入数据 */
export async function importAll(data) {
  const patch = {};
  if (data && data.config) patch[STORAGE_KEYS.config] = { ...DEFAULT_CONFIG, ...data.config };
  if (data && data.cache) patch[STORAGE_KEYS.cache] = data.cache;
  await chrome.storage.local.set(patch);
}

/**
 * 设置页逻辑：读取 / 保存配置、测试连接、缓存与配置导入导出。
 * 依赖 shared/constants.js 的预设与默认值，以及 background/llm-client.js 的请求能力。
 */
import {
  PROVIDERS, getProvider, LENGTHS, LANGS, TRIGGERS,
  DEFAULT_CONFIG, DEFAULT_USER_PROMPT, DEFAULT_SYSTEM_PROMPT
} from '../shared/constants.js';
import { getConfig, setConfig, clearCache, exportAll, importAll } from '../shared/storage.js';
import { chat } from '../background/llm-client.js';
import {
  BEHAVIOR_OPTIONS, ON_UNFAVORITE_OPTIONS, SYNC_FREQ_OPTIONS, DENSITY_OPTIONS,
  SORT_OPTIONS, THEME_OPTIONS,
  getSettings as getFavSettings, patchSettings as patchFavSettings,
  exportJSON as exportFavJSON, exportCSV as exportFavCSV, exportMarkdown as exportFavMD,
  importJSON as importFavJSON, resetFavorites, getCounts as getFavCounts
} from '../shared/favorites.js';

const $ = (id) => document.getElementById(id);

// ============================ 初始化 ============================

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}

function fillSelect(el, items, value) {
  el.innerHTML = items.map((it) => '<option value="' + it.id + '">' + it.name + '</option>').join('');
  el.value = value;
}

function initSelects() {
  fillSelect($('provider'), PROVIDERS, DEFAULT_CONFIG.provider);
  fillSelect($('lang'), LANGS, DEFAULT_CONFIG.lang);
  fillSelect($('length'), LENGTHS, DEFAULT_CONFIG.length);
  fillSelect($('trigger'), TRIGGERS, DEFAULT_CONFIG.trigger);
}

/** 切换服务商时，带出默认 Base URL 与候选模型 */
function applyProvider(id, keepBaseUrl) {
  const p = getProvider(id);
  const isCustom = id === 'custom';
  if (!keepBaseUrl) $('baseUrl').value = isCustom ? ($('baseUrl').value || '') : p.baseUrl;

  $('model-list').innerHTML = (p.models || []).map((m) => '<option value="' + m + '"></option>').join('');
  if (!keepBaseUrl && p.models && p.models.length && !$('model').value) $('model').value = p.models[0];

  $('provider-note').textContent = p.note || '';
  $('apiKey').placeholder = p.keyless ? '本地服务无需密钥' : 'sk-...';
  $('key-help').innerHTML = p.keyUrl
    ? '获取密钥：<a href="' + p.keyUrl + '" target="_blank" rel="noopener">' + p.keyUrl + '</a>'
    : (p.keyless ? '本地 Ollama 无需 API Key，但需要先在本机运行 ollama serve。' : '');
}

async function load() {
  const c = { ...DEFAULT_CONFIG, ...(await getConfig()) };
  initSelects();
  $('provider').value = c.provider;
  applyProvider(c.provider, true);
  $('baseUrl').value = c.baseUrl || getProvider(c.provider).baseUrl;
  $('apiKey').value = c.apiKey || '';
  $('model').value = c.model || '';
  $('temperature').value = c.temperature;
  $('maxTokens').value = c.maxTokens;
  $('systemPrompt').value = c.systemPrompt || '';
  $('userPrompt').value = c.userPrompt || '';
  $('lang').value = c.lang;
  $('length').value = c.length;
  $('trigger').value = c.trigger;
  $('minChars').value = c.minChars;
  $('stream').checked = !!c.stream;
  $('enabled').checked = !!c.enabled;
}

// ============================ 读写表单 ============================

function readForm() {
  return {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value),
    systemPrompt: $('systemPrompt').value.trim(),
    userPrompt: $('userPrompt').value.trim(),
    lang: $('lang').value,
    length: $('length').value,
    trigger: $('trigger').value,
    minChars: Number($('minChars').value) || 0,
    stream: $('stream').checked,
    enabled: $('enabled').checked
  };
}

/**
 * 申请接口域名的访问权限。
 * manifest 只声明了可选权限（optional_host_permissions），
 * 首次保存 / 测试时点按钮授权，之后不再弹窗。
 * 注意：必须在用户点击的同步栈里调用，否则会丢失手势导致授权失败。
 */
function ensureOrigin(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [origin + '/*'] });
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ============================ 测试连接 ============================

function sampleMessages(c) {
  return [
    { role: 'system', content: c.systemPrompt || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: '请用一句话回复：连接正常。' }
  ];
}

// ============================ 事件绑定 ============================

$('provider').addEventListener('change', (e) => {
  applyProvider(e.target.value, false);
});

$('toggleKey').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
});

$('saveBtn').addEventListener('click', async () => {
  const values = readForm();               // 同步读取，保住用户手势
  const granted = await ensureOrigin(values.baseUrl);
  if (!granted) {
    setStatus('未获得该接口域名的访问权限，保存已取消', 'err');
    return;
  }
  if (values.apiKey === '' && values.provider !== 'ollama') {
    setStatus('已保存，但还没填 API Key，总结会失败', 'err');
  } else {
    setStatus('已保存', 'ok');
  }
  await setConfig(values);
});

$('testBtn').addEventListener('click', async () => {
  const values = readForm();
  const granted = await ensureOrigin(values.baseUrl);
  if (!granted) {
    setStatus('未获得该接口域名的访问权限', 'err');
    return;
  }
  $('testBtn').disabled = true;
  setStatus('正在测试连接…');
  try {
    const text = await chat({
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
      model: values.model,
      messages: sampleMessages(values),
      temperature: 0.2,
      maxTokens: 64
    });
    setStatus('连接成功：' + String(text).trim().slice(0, 40), 'ok');
  } catch (e) {
    setStatus('连接失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    $('testBtn').disabled = false;
  }
});

$('clearCache').addEventListener('click', async () => {
  const n = await clearCache();
  setStatus('已清空 ' + n + ' 条缓存', 'ok');
});

$('exportBtn').addEventListener('click', async () => {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pickscribe-ai-config.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('已导出配置', 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await importAll(data);
    await load();
    setStatus('已导入配置', 'ok');
  } catch (err) {
    setStatus('导入失败：文件格式不正确', 'err');
  }
  e.target.value = '';
});

// ============================ 启动 ============================

load().catch((e) => setStatus('读取配置失败：' + e.message, 'err'));

// 提示：用户在模板里删空了会用默认模板
$('userPrompt').placeholder = DEFAULT_USER_PROMPT;

// ============================ 起始页浮层设置（即时生效） ============================

/** 起始页设置键，与 home/content.js 保持一致 */
const HOME_KEY = 'pcr_home';

async function loadHomeSetting() {
  const raw = await chrome.storage.local.get(HOME_KEY);
  const s = raw[HOME_KEY] || {};
  $('homeEnabled').checked = s.enabled === true;   // 默认关闭，仅显式开启后勾选
}

$('homeEnabled').addEventListener('change', async (e) => {
  const raw = await chrome.storage.local.get(HOME_KEY);
  const cur = raw[HOME_KEY] || {};
  await chrome.storage.local.set({ [HOME_KEY]: { ...cur, enabled: e.target.checked } });
  setStatus(e.target.checked ? '已开启起始页浮层' : '已关闭起始页自动显示', 'ok');
});

loadHomeSetting().catch((e) => setStatus('读取起始页设置失败：' + e.message, 'err'));

// ============================ 收藏夹 Plus 设置（改动即时生效） ============================

/** 触发浏览器下载 */
function download(filename, text, type) {
  const blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function setFavStatus(text) {
  const el = $('favStats');
  if (el) el.textContent = text;
}

/** 刷新本地数据占用展示（SET-03 数据与隐私） */
async function refreshFavStats() {
  const c = await getFavCounts();
  setFavStatus('当前本地数据：' + c.all + ' 条收藏、' + Object.keys(c.byGroup).length + ' 个分组，其中未分组 ' + c.inbox + ' 条。');
}

function initFavSelects() {
  fillSelect($('favBehavior'), BEHAVIOR_OPTIONS, 'panel');
  fillSelect($('favUnfavorite'), ON_UNFAVORITE_OPTIONS, 'keep');
  fillSelect($('favSyncFreq'), SYNC_FREQ_OPTIONS, 'popup');
  fillSelect($('favDensity'), DENSITY_OPTIONS, 'grid');
  fillSelect($('favSort'), SORT_OPTIONS, 'time-desc');
  fillSelect($('favTheme'), THEME_OPTIONS, 'system');
}

async function loadFav() {
  const s = await getFavSettings();
  initFavSelects();
  $('favBehavior').value = s.behavior;
  $('favUnfavorite').value = s.onUnfavorite;
  $('favSyncFreq').value = s.syncFreq;
  $('favDensity').value = s.density;
  $('favSort').value = s.sort;
  $('favTheme').value = s.theme;
  $('favEnabled').checked = !!s.enabled;
  $('favSiteInject').checked = !!s.siteInject;
  $('favAllowExternal').checked = !!s.allowExternal;
  await refreshFavStats();
}

/** 下拉与开关改动后立即写回 */
function bindFavSetting(id, key, isCheck) {
  $(id).addEventListener('change', async (e) => {
    await patchFavSettings({ [key]: isCheck ? e.target.checked : e.target.value });
    setFavStatus('收藏夹设置已保存');
    await refreshFavStats();
  });
}

bindFavSetting('favBehavior', 'behavior');
bindFavSetting('favUnfavorite', 'onUnfavorite');
bindFavSetting('favSyncFreq', 'syncFreq');
bindFavSetting('favDensity', 'density');
bindFavSetting('favSort', 'sort');
bindFavSetting('favTheme', 'theme');
bindFavSetting('favEnabled', 'enabled', true);
bindFavSetting('favSiteInject', 'siteInject', true);
bindFavSetting('favAllowExternal', 'allowExternal', true);

// 导出（SYN-03）：JSON 完整备份 / CSV 多值列 / Markdown 人读
$('favExportJson').addEventListener('click', async () => {
  const data = await exportFavJSON();
  download('pickscribe-favorites.json', JSON.stringify(data, null, 2));
  setFavStatus('已导出收藏夹 JSON');
});
$('favExportCsv').addEventListener('click', async () => {
  download('pickscribe-favorites.csv', await exportFavCSV(), 'text/csv;charset=utf-8');
  setFavStatus('已导出收藏夹 CSV');
});
$('favExportMd').addEventListener('click', async () => {
  download('pickscribe-favorites.md', await exportFavMD(), 'text/markdown;charset=utf-8');
  setFavStatus('已导出收藏夹 Markdown');
});

// 导入合并（SYN-04）：以帖子 ID 判重
$('favImportBtn').addEventListener('click', () => $('favImportFile').click());
$('favImportFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await importFavJSON(data);
    if (r && r.error) { setFavStatus('导入失败：' + r.error); return; }
    setFavStatus('已导入合并：新增 ' + r.added + ' 条、更新 ' + r.merged + ' 条');
    await refreshFavStats();
  } catch (err) {
    setFavStatus('导入失败：文件格式不正确');
  }
  e.target.value = '';
});

// 清空本地数据（SYN-05）：二次确认，且明确不影响站点收藏
$('favClear').addEventListener('click', async () => {
  const yes = confirm('将清空插件本地的分组、标签与备注，站点上的收藏不受影响，且此操作不可恢复。\n\n确认清空请输入「清空收藏夹」：');
  if (!yes) { setFavStatus('已取消，未清空任何数据'); return; }
  const word = prompt('请输入「清空收藏夹」以确认：');
  if (word !== '清空收藏夹') { setFavStatus('确认词不匹配，已取消清空'); return; }
  const n = await resetFavorites();
  setFavStatus('已清空本地收藏数据（' + n + ' 条），站点收藏未受影响');
  await refreshFavStats();
});

loadFav().catch((e) => setFavStatus('读取收藏夹设置失败：' + e.message));

// ============================ 侧栏导航：滚动时高亮当前分区 ============================

(function navSpy() {
  const links = Array.from(document.querySelectorAll('.nav-item'));
  const items = links
    .map((a) => ({ a, sec: document.querySelector(a.getAttribute('href')) }))
    .filter((it) => it.sec);
  if (!items.length) return;

  function update() {
    const line = window.scrollY + 90;
    let cur = items[0];
    items.forEach((it) => { if (it.sec.offsetTop <= line) cur = it; });
    links.forEach((a) => a.classList.toggle('is-active', a === cur.a));
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
})();

// ============================ 主题切换（跟随系统 / 亮色 / 暗色） ============================

/** 与 theme-init.js 保持同一个 key */
const THEME_KEY = 'pco_theme';
const THEME_MODES = ['system', 'light', 'dark'];
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = 'system';

function resolvedTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return themeMedia.matches ? 'dark' : 'light';
}

/** 把当前模式映射到 <html data-theme>，并同步菜单勾选态 */
function paintTheme() {
  document.documentElement.dataset.theme = resolvedTheme(themeMode);
  document.querySelectorAll('#themeMenu [data-theme]').forEach((btn) => {
    const on = btn.dataset.theme === themeMode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

function setTheme(mode, persist) {
  themeMode = THEME_MODES.includes(mode) ? mode : 'system';
  paintTheme();
  if (persist) chrome.storage.local.set({ [THEME_KEY]: themeMode });
}

const themeBtn = $('themeBtn');
const themeMenu = $('themeMenu');

function toggleThemeMenu(show) {
  const next = show === undefined ? themeMenu.hidden : show;
  themeMenu.hidden = !next;
  themeBtn.setAttribute('aria-expanded', String(next));
}

themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu(themeMenu.hidden);
});

themeMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme]');
  if (!btn) return;
  setTheme(btn.dataset.theme, true);
  toggleThemeMenu(false);
  themeBtn.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme')) toggleThemeMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !themeMenu.hidden) {
    toggleThemeMenu(false);
    themeBtn.focus();
  }
});

// 跟随系统时，系统主题变化要即时反映
themeMedia.addEventListener('change', () => {
  if (themeMode === 'system') paintTheme();
});

chrome.storage.local.get(THEME_KEY).then((raw) => {
  setTheme((raw && raw[THEME_KEY]) || 'system', false);
}).catch(() => setTheme('system', false));

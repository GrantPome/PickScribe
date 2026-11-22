/**
 * Popup：AI 助手快捷面板。
 *   - 沿用原有开关与服务商 / 模型快速切换；
 *   - 主题与设置页保持一致（pco_theme，system 跟随系统）。
 */
import { getProvider, DEFAULT_CONFIG } from '../shared/constants.js';
import { getConfig, patchConfig } from '../shared/storage.js';

const $ = (id) => document.getElementById(id);

let config = { ...DEFAULT_CONFIG };

// ============================ 主题 ============================

/** 与设置页同一个主题键（pco_theme），system 时跟随操作系统深色偏好 */
async function applyTheme() {
  try {
    const raw = await chrome.storage.local.get('pco_theme');
    const mode = raw && raw.pco_theme;
    document.documentElement.dataset.theme = mode === 'light' || mode === 'dark' ? mode : 'system';
  } catch (e) {
    // 非扩展环境读不到设置时保持跟随系统
    document.documentElement.dataset.theme = 'system';
  }
}

/** Luma·Gran 外观：与设置页 / 站点共用 pcr_luma_skin，默认开启 */
async function applyLuma() {
  try {
    const raw = await chrome.storage.local.get('pcr_luma_skin');
    const v = raw && raw.pcr_luma_skin;
    if (v !== false && v !== '0') document.documentElement.dataset.luma = 'on';
    else delete document.documentElement.dataset.luma;
  } catch (e) {
    document.documentElement.dataset.luma = 'on';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pco_theme) applyTheme();
  if (area === 'local' && changes.pcr_luma_skin) applyLuma();
});

// ============================ AI 区 ============================

function render() {
  const preset = getProvider(config.provider);
  $('provider').textContent = preset.name;
  $('enabled').checked = config.aiEnabled !== false && !!config.enabled;
  $('enabled').disabled = config.aiEnabled === false;

  const models = (preset.models || []).slice();
  if (config.model && !models.includes(config.model)) models.unshift(config.model);
  $('model').innerHTML = models.length
    ? models.map((m) => '<option value="' + m + '">' + m + '</option>').join('')
    : '<option value="">（在设置页填写）</option>';
  $('model').value = config.model || '';

  $('tip').textContent = config.aiEnabled === false
    ? 'AI 功能总开关已关闭，可在设置页重新开启。'
    : (config.enabled
      ? '在 Pickcat 帖子详情页的分隔线下方会显示 AI 总结面板。'
      : '已在帖子详情页关闭 AI 总结面板。');
}

$('enabled').addEventListener('change', async (e) => {
  if (config.aiEnabled === false) return;
  config = await patchConfig({ enabled: e.target.checked });
  render();
});

$('model').addEventListener('change', async (e) => {
  config = await patchConfig({ model: e.target.value });
});

$('openPluginOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  await applyTheme();
  await applyLuma();
  config = { ...DEFAULT_CONFIG, ...(await getConfig()) };
  render();
})();

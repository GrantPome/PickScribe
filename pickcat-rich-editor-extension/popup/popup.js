/**
 * Popup：分区切换「AI 助手 / 收藏 Plus」。
 *   - AI 区：沿用原有开关与服务商 / 模型快速切换；
 *   - 收藏 Plus 区：挂载与标签页工作台完全相同的管理台（favorites/console.js），
 *     弹窗宽度按 PRD 4.3 以 790px 设计基准向下自适应，切回 AI 区恢复窄宽度。
 */
import { PROVIDERS, getProvider, DEFAULT_CONFIG } from '../shared/constants.js';
import { getConfig, patchConfig } from '../shared/storage.js';
import { mountConsole } from '../favorites/console.js';

const $ = (id) => document.getElementById(id);

let config = { ...DEFAULT_CONFIG };

// ============================ AI 区 ============================

function render() {
  const preset = getProvider(config.provider);
  $('provider').textContent = preset.name;
  $('enabled').checked = !!config.enabled;

  const models = (preset.models || []).slice();
  if (config.model && !models.includes(config.model)) models.unshift(config.model);
  $('model').innerHTML = models.length
    ? models.map((m) => '<option value="' + m + '">' + m + '</option>').join('')
    : '<option value="">（在设置页填写）</option>';
  $('model').value = config.model || '';

  $('tip').textContent = config.enabled
    ? '在 Pickcat 帖子详情页的分隔线下方会显示 AI 总结面板。'
    : '已在帖子详情页关闭 AI 总结面板。';
}

(async () => {
  config = { ...DEFAULT_CONFIG, ...(await getConfig()) };
  render();
})();

$('enabled').addEventListener('change', async (e) => {
  config = await patchConfig({ enabled: e.target.checked });
  render();
});

$('model').addEventListener('change', async (e) => {
  config = await patchConfig({ model: e.target.value });
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// ============================ 分区切换 ============================

let consoleApi = null;
let consoleReady = false;

async function showSection(sec) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('is-on', b.getAttribute('data-sec') === sec);
  });
  $('sec-ai').hidden = sec !== 'ai';
  $('sec-fav').hidden = sec !== 'fav';
  document.body.classList.toggle('wide', sec === 'fav');

  if (sec === 'fav' && !consoleReady) {
    consoleReady = true;
    consoleApi = mountConsole($('favRoot'), {
      mode: 'popup',
      onOpenTab: () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('favorites/favorites.html') });
        window.close();
      }
    });
    await consoleApi.init();
  } else if (sec === 'fav' && consoleApi) {
    // 每次切回都刷新，保证在站点上的改动能即时反映
    await consoleApi.refresh();
  }
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => showSection(b.getAttribute('data-sec')));
});

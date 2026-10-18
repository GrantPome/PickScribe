/**
 * 收藏夹 Plus 标签页工作台入口（UI-06）
 * 承载需要连续操作或较长停留的任务（拖拽排序、批量整理、标签全局重命名），
 * 打开时自动携带弹窗当前的分组与筛选条件（共用 pcf_ui）。
 * 复用与弹窗完全相同的管理台模块 favorites/console.js，仅 mode 不同。
 */
import { mountConsole } from './console.js';
import { getSettings } from '../shared/favorites.js';

const root = document.getElementById('favRoot');

/** 按设置选择主题（system 跟随系统；浅色 / 深色锁定） */
async function applyTheme() {
  const s = await getSettings();
  document.documentElement.dataset.theme = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system';
}

(async () => {
  await applyTheme();
  const consoleApi = mountConsole(root, { mode: 'tab' });
  await consoleApi.init();
})();

document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 设置变化时同步主题
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pcf_settings) applyTheme();
});

/**
 * 桌面模式桥（Pickcat Desktop 联动）
 *
 * 桌面壳在每个 iframe 中注入自己的壳，并通过 window.postMessage 广播
 * { source: 'pickcat-desktop', type: 'desktop-state', enabled, linkMode }。
 * 本脚本把状态写入扩展隔离世界的全局变量，供同扩展的其他 content script 读取。
 *
 * 约定：
 *   1. 顶层（window.top === window.self）不记录，桌面模式只对窗口 iframe 生效；
 *   2. 消息只接受同源来源，避免其他站点伪造状态；
 *   3. 默认关闭，未安装桌面壳时 PickScribe 行为完全不变。
 */

(() => {
  'use strict';

  const state = {
    enabled: false,
    linkMode: 'new'
  };

  // 同扩展、同隔离世界的其他脚本通过 window.__PCS_DESKTOP__ 读取
  try {
    Object.defineProperty(window, '__PCS_DESKTOP__', {
      value: state,
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (_) { /* 已存在时忽略 */ }

  // 动画速度：与帖子浮层共用 pco_config.animSpeed，广播给桌面壳让窗口开合动画保持同一节奏
  let currentSpeed = 1;

  const readSpeed = (cfg) => {
    const n = Number(cfg && cfg.animSpeed);
    return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
  };

  const announceSpeed = (speed) => {
    currentSpeed = speed;
    try {
      window.top.postMessage({ source: 'pickcat-desktop', type: 'anim-speed', speed }, location.origin);
    } catch (_) { /* 跨域或页面已关闭时忽略 */ }
  };

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data) return;
    // 桌面壳晚于本脚本启动时，主动索取一次当前动画速度
    if (data.source === 'pcw-host' && data.type === 'ask-anim-speed') {
      announceSpeed(currentSpeed);
      return;
    }
    if (data.source !== 'pickcat-desktop' || data.type !== 'desktop-state') return;
    state.enabled = !!data.enabled;
    state.linkMode = data.linkMode === 'current' ? 'current' : 'new';
  });

  try {
    chrome.storage.local.get('pco_config', (raw) => {
      if (chrome.runtime.lastError) return;
      announceSpeed(readSpeed(raw && raw.pco_config));
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.pco_config) return;
      announceSpeed(readSpeed(changes.pco_config.newValue));
    });
  } catch (_) { /* 非扩展环境忽略 */ }
})();

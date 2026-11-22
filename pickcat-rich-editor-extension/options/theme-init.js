/**
 * 设置页主题预置：在样式表生效前决定浅色 / 深色。
 * 必须在 <head> 里、options.css 之前同步执行，否则已选「亮色模式」的用户
 * 在深色系统上会先闪一下深色界面。
 */
(function () {
  var root = document.documentElement;
  var KEY = 'pco_theme';
  var LUMA_KEY = 'pcr_luma_skin';

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  root.dataset.theme = resolve('system');

  try {
    chrome.storage.local.get([KEY, LUMA_KEY], function (raw) {
      root.dataset.theme = resolve(raw && raw[KEY]);
      // Luma·Gran 外观默认开启；与 options.js / luma/content.js 判断保持一致
      if (raw && raw[LUMA_KEY] !== false && raw[LUMA_KEY] !== '0') root.dataset.luma = 'on';
      else delete root.dataset.luma;
    });
  } catch (e) {
    /* 本地预览或缺 chrome 环境时保持跟随系统 */
  }
})();

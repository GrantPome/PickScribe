/**
 * 设置页主题预置：在样式表生效前决定浅色 / 深色。
 * 必须在 <head> 里、options.css 之前同步执行，否则已选「亮色模式」的用户
 * 在深色系统上会先闪一下深色界面。
 */
(function () {
  var root = document.documentElement;
  var KEY = 'pco_theme';

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  root.dataset.theme = resolve('system');

  try {
    chrome.storage.local.get(KEY, function (raw) {
      root.dataset.theme = resolve(raw && raw[KEY]);
    });
  } catch (e) {
    /* 本地预览或缺 chrome 环境时保持跟随系统 */
  }
})();

/**
 * 跨页「镜头推进」接力 —— 内容脚本（document_start）
 *
 * 起始页点击发帖磁贴时，磁贴会放大到铺满全屏，再把它的纯色写进 sessionStorage
 * 并整页跳转发帖页。这里在发帖页首帧之前就把同色幕布铺上，等页面加载完再淡出，
 * 两页之间不会闪白，观感上就是「磁贴铺满屏幕 → 下一页浮现」的连续镜头。
 *
 * 只在顶层页面运行；记录超过 10 秒（如用户手动刷新）时不再铺幕布。
 */
(() => {
  'use strict';

  const KEY = 'pcs_zoom_transition';
  const MAX_AGE = 10000;

  let data = null;
  try { data = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { data = null; }
  if (!data || !data.color || Date.now() - Number(data.at || 0) > MAX_AGE) {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* noop */ }
    return;
  }
  try { sessionStorage.removeItem(KEY); } catch (e) { /* noop */ }

  // 只接受写进来的纯色值，避免把任意字符串拼进样式
  const color = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()/i.test(String(data.color))
    ? String(data.color)
    : '#e0603a';

  const veil = document.createElement('div');
  veil.id = 'pcs-zoom-veil';
  veil.setAttribute('aria-hidden', 'true');
  veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'background:' + color + ';opacity:1;' +
    'transition:opacity .42s cubic-bezier(.22,1,.36,1);';
  document.documentElement.appendChild(veil);

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    requestAnimationFrame(() => {
      veil.style.opacity = '0';
      setTimeout(() => {
        if (veil.parentNode) veil.parentNode.removeChild(veil);
      }, 480);
    });
  };

  if (document.readyState === 'complete') reveal();
  else window.addEventListener('load', reveal, { once: true });
  setTimeout(reveal, 1200);   // 兜底：页面加载过慢时也不能一直挡着
})();

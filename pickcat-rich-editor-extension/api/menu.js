/**
 * 头像菜单入口：在站点「打开账号菜单」的下拉里补一项「PickScribe 设置」。
 *
 * 站点菜单是运行时渲染的，所以这里不保存 DOM 引用，而是：
 *   1. 用 MutationObserver 监听菜单出现；
 *   2. 每次按当前结构重新查找「设置 / 退出登录」作为锚点；
 *   3. 插入前先检查 data-pcr-settings-entry，保证同一菜单里不会重复；
 *   4. 结构变化、找不到锚点或插入失败都静默跳过，不抛错影响站点。
 *
 * 点击后复用 background 已有的 open-options 消息打开扩展设置页。
 */

(() => {
  'use strict';

  const ENTRY_ATTR = 'data-pcr-settings-entry';
  const TRIGGER_SELECTOR = '[aria-label="打开账号菜单"]';
  const SETTINGS_LABELS = ['设置', '偏好设置'];
  const LOGOUT_LABELS = ['退出登录', '登出'];

  let scheduled = false;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'open-options' }, () => {
        // 扩展被重载后上下文会失效，吞掉预期内的噪音
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 非扩展环境忽略 */
    }
  }

  function findOpenMenu() {
    // 1) 优先用触发按钮的 aria-controls 精确找菜单
    const triggers = document.querySelectorAll(TRIGGER_SELECTOR);
    for (const trigger of triggers) {
      const expanded = trigger.getAttribute('aria-expanded');
      const state = trigger.getAttribute('data-state');
      if (expanded !== 'true' && state !== 'open') continue;
      const id = trigger.getAttribute('aria-controls');
      if (id) {
        const menu = document.getElementById(id);
        if (menu && isVisible(menu)) return menu;
      }
    }

    // 2) 兜底：页面上可见、且包含「退出登录」的 role=menu
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
    for (const menu of menus) {
      if ((menu.textContent || '').indexOf('退出登录') >= 0) return menu;
    }
    return null;
  }

  function findItem(menu, labels) {
    const preferred = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const pool = preferred.length
      ? preferred
      : Array.from(menu.querySelectorAll('a, button, [role="button"]'));
    for (const el of pool) {
      if (el.hasAttribute(ENTRY_ATTR)) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (labels.some((label) => text === label || text.indexOf(label) === 0)) return el;
    }
    return null;
  }

  /** 只替换文字节点，保留站点原有的图标与排版 */
  function replaceLabel(item, labels, next) {
    const walker = document.createTreeWalker(item, 4);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue.trim();
      if (text && labels.some((label) => text === label || text.indexOf(label) === 0)) {
        node.nodeValue = node.nodeValue.replace(text, next);
        return true;
      }
      node = walker.nextNode();
    }
    return false;
  }

  /** 菜单里用于分组的空节点 / 分隔线 */
  function isSeparator(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'HR' || el.getAttribute('role') === 'separator') return true;
    if ((el.textContent || '').trim()) return false;
    const style = getComputedStyle(el);
    return parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
  }

  /**
   * 从相邻原生项读取真实布局参数，逐个属性对齐克隆节点。
   * 站点的菜单样式常带 data-v 作用域或 :first-child / :last-child 选择器，
   * 克隆节点在插入位置可能落进不同的规则里，这里直接按计算值补齐，不做估算。
   *
   * 只对齐「项自身」的排版参数；外边距与上下边框交给站点按兄弟顺序生成的规则，
   * 强行覆盖反而会破坏原生项之间的间距与分隔线。
   */
  const ALIGN_PROPS = [
    'display', 'boxSizing', 'alignItems', 'justifyContent', 'flexWrap',
    'height', 'minHeight', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'gap', 'columnGap', 'rowGap',
    'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing',
    'borderRadius'
  ];

  function alignToNative(source, target) {
    if (!source || !target) return;
    const a = getComputedStyle(source);
    const b = getComputedStyle(target);
    ALIGN_PROPS.forEach((prop) => {
      const value = a[prop];
      if (!value || value === b[prop]) return;
      target.style[prop] = value;
    });

    // 图标尺寸与图标-文字间距同样按原生项实测值对齐
    const srcIcon = source.querySelector('svg, img');
    const dstIcon = target.querySelector('svg, img');
    if (srcIcon && dstIcon) {
      const ai = getComputedStyle(srcIcon);
      const bi = getComputedStyle(dstIcon);
      ['width', 'height', 'marginLeft', 'marginRight', 'flexShrink'].forEach((prop) => {
        if (ai[prop] && ai[prop] !== bi[prop]) dstIcon.style[prop] = ai[prop];
      });
    }
  }

  /**
   * 键盘聚焦的兜底可见反馈：站点若只用 :hover 强调，克隆项聚焦时没有变化；
   * 这里只补一条轮廓，颜色取站点主题变量，不写死色值。
   */
  function ensureFocusStyle() {
    if (document.getElementById('pcr-menu-entry-style')) return;
    const style = document.createElement('style');
    style.id = 'pcr-menu-entry-style';
    style.textContent =
      '[' + ENTRY_ATTR + ']:focus-visible{' +
        'outline:2px solid var(--ui-primary, var(--ui-text, currentColor));' +
        'outline-offset:-2px;' +
      '}';
    (document.head || document.documentElement).appendChild(style);
  }

  /** 站点用 data-highlighted 标记当前高亮项，克隆节点需要自己维护这个状态 */
  function wireHighlight(item) {
    const on = () => item.setAttribute('data-highlighted', '');
    const off = () => item.removeAttribute('data-highlighted');
    item.addEventListener('pointerenter', on);
    item.addEventListener('pointerdown', on);
    item.addEventListener('pointerleave', off);
    item.addEventListener('focus', on);
    item.addEventListener('blur', off);
  }

  function buildEntry(menu) {
    const settings = findItem(menu, SETTINGS_LABELS);
    const logout = findItem(menu, LOGOUT_LABELS);
    const source = settings || logout;
    if (!source) return null;

    const item = source.cloneNode(true);
    item.setAttribute(ENTRY_ATTR, '1');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    if (item.tagName === 'A') item.removeAttribute('href');
    // 克隆会把站点用于状态判断的属性一起带过来，清掉避免触发原生逻辑
    ['id', 'aria-controls', 'aria-checked', 'aria-expanded', 'data-state', 'data-highlighted']
      .forEach((name) => item.removeAttribute(name));

    const labels = settings ? SETTINGS_LABELS : LOGOUT_LABELS;
    if (!replaceLabel(item, labels, 'PickScribe 设置')) {
      item.textContent = 'PickScribe 设置';
    }

    wireHighlight(item);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOptions();
    }, true);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        openOptions();
      }
    }, true);

    return { item, settings, logout };
  }

  /**
   * 把克隆来的齿轮图标换成插件 LOGO。
   * 用 mask + currentColor 上色，既跟随菜单文字色与深色模式，也不会带入 LOGO 自带的颜色。
   */
  function applyLogoIcon(item) {
    const icon = item.querySelector('svg, img');
    if (!icon) return;
    const rect = icon.getBoundingClientRect();
    const cs = getComputedStyle(icon);
    const logo = document.createElement('span');
    logo.className = 'pcr-menu-logo';
    logo.setAttribute('aria-hidden', 'true');
    let url = 'icons/logo.svg';
    try {
      if (chrome && chrome.runtime && chrome.runtime.getURL) url = chrome.runtime.getURL('icons/logo.svg');
    } catch (e) { /* 非扩展环境忽略 */ }
    logo.style.cssText =
      'display:inline-block;flex:none;background-color:currentColor;' +
      '-webkit-mask:url("' + url + '") center/contain no-repeat;' +
      'mask:url("' + url + '") center/contain no-repeat;' +
      'width:' + (Math.round(rect.width) || 16) + 'px;' +
      'height:' + (Math.round(rect.height) || 16) + 'px;' +
      'margin-left:' + cs.marginLeft + ';' +
      'margin-right:' + cs.marginRight + ';';
    icon.replaceWith(logo);
  }

  function insertEntry() {
    const menu = findOpenMenu();
    if (!menu) return;
    if (menu.querySelector('[' + ENTRY_ATTR + ']')) return;

    const built = buildEntry(menu);
    if (!built) return;
    const { item, settings, logout } = built;

    try {
      if (settings && settings.parentNode) {
        // 插到「设置」后；若紧跟分隔线，则插在分隔线之前，保持原来的分组关系
        const next = settings.nextElementSibling;
        if (next && isSeparator(next)) {
          settings.parentNode.insertBefore(item, next);
        } else {
          settings.parentNode.insertBefore(item, settings.nextSibling);
        }
      } else if (logout && logout.parentNode) {
        logout.parentNode.insertBefore(item, logout);
      } else {
        menu.appendChild(item);
      }
    } catch (e) {
      /* 菜单结构变化时放弃本次插入，下次出现再试 */
      return;
    }

    // 插入后立刻按相邻原生项对齐（此时双方都已参与布局）
    ensureFocusStyle();
    alignToNative(settings || logout, item);
    applyLogoIcon(item);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try { insertEntry(); } catch (e) { /* 静默 */ }
    });
  }

  // 菜单通过 portal 动态挂载，body 的 childList 变化足以覆盖打开 / 重渲染
  try {
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-expanded']
    });
  } catch (e) {
    /* 忽略 */
  }

  // 点击头像后菜单可能延迟一帧才挂载，补一次检查
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    if (target.closest(TRIGGER_SELECTOR)) setTimeout(schedule, 30);
  }, true);

  schedule();
})();

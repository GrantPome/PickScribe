/**
 * 帖子浮层预览 —— 内容脚本（命名空间 pco）
 *
 * 目标：在信息流（首页 / 论坛 / 分类 / 搜索）里点开帖子时，不切换页面，
 *      像小红书一样在当前页直接铺开一层帖子详情浮层；关闭后原地回到信息流。
 *
 * 做法：
 *   1. 在文档捕获阶段拦下 /forum/post/<id> 链接的普通左键点击，阻止站点路由跳转；
 *   2. 用被点击卡片的位置做 FLIP 展开动画：卡片原地放大成浮层，四周压暗并虚化；
 *   3. 数据走站点自己的公开接口 GET /api/v1/topics/{id} 与 /posts，
 *      正文直接使用接口返回的 cookedHtml，不发额外请求、不碰站点业务逻辑；
 *   4. 头像与点赞 / 评论 / 收藏 / 分享 / 更多放在正文与回复之间的分割线上（竖排操作栏）；
 *   5. 右侧回复区支持排序筛选（最热 / 最新 / 最早）、关键词筛选与直接发表回复；
 *   6. 浮层两侧提供左右切换按钮，按当前栏目（关注 / 推荐 / 最新 / 板块）的列表顺序
 *      切换上一个 / 下一个帖子，并提前预取相邻帖子的正文与回复；
 *   7. pushState 记一条历史，浏览器后退 / Esc / 点遮罩都能播放反向动画后关闭；
 *   8. 正文与回复里的图片点击后铺开大图，与站点原生的查看大图体验一致。
 *
 * 工程约定与站内其他模块一致：经典内容脚本、pco- 前缀、复用站点 --ui-* 设计令牌、
 * 路由变化立即收起；按住 Ctrl / Cmd / Shift / Alt 或中键时保持站点原生行为。
 */

(() => {
  'use strict';

  // 扩展被重载 / 更新后，旧内容脚本里的异步 chrome.* 调用会以
  // "Extension context invalidated" 拒绝；这是预期内的噪音，直接吞掉。
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  // ============================ 0. 常量 ============================

  /** 视为「信息流」的路径：只有这些页面才把帖子点击转成浮层 */
  const FEED_PATH = /^\/$|^\/forum(?:\/category\/[^/?#]+)?$|^\/search$/;
  const POST_HREF = /\/forum\/post\/([^/?#]+)/;
  /** 浮层里最多展示的回复条数（完整讨论交给原帖） */
  const COMMENT_LIMIT = 24;
  /** 详情数据内存缓存：重复打开同一帖秒开 */
  const CACHE_TTL = 5 * 60 * 1000;
  /** 关闭动画时长（与 overlay.css 的 0.48s 对齐） */
  const CLOSE_MS = 460;
  /** 设置键：浮窗模式默认开启，用户在设置里显式关闭后不再拦截帖子点击 */
  const SETTINGS_KEY = 'pco_config';
  /** 站点外观里的「点击图片查看大图」开关，与设置页保持同一个键 */
  const IMAGE_ZOOM_KEY = 'pcr_image_zoom';
  /** 浮层打开时页面后退的缩放比例，营造前后景空间层次 */
  const PAGE_SCALE = 0.955;

  /**
   * 图标全部沿用站点原生的一套（Mingcute）：
   * 点赞 / 评论 / 收藏 / 分享 / 更多 直接取自帖子详情页按钮的 SVG，
   * 其余（关闭、外链、搜索、表情、图片、AI、返回箭头）使用同系列的 Mingcute 图形，
   * 保证浮层里的图标风格与站点完全一致。
   */
  const ICONS = {
    close: '<path fill="currentColor" d="M10.586 12.001L4.929 6.344c-.359-.41-.404-1.01 0-1.414c.404-.405 1.005-.359 1.414 0L12 10.586l5.657-5.656c.409-.359 1.01-.404 1.414 0s.359 1.005 0 1.414l-5.657 5.657l5.657 5.656c.359.41.404 1.011 0 1.415s-1.005.359-1.414 0L12 13.415l-5.657 5.657c-.409.359-1.01.404-1.414 0s-.359-1.005 0-1.414Z"/>',
    external: '<path fill="currentColor" d="M5.006 8.006v10.988h10.988l.006-.051V13c.042-.639.603-1.142 1.259-.966c.453.122.711.515.741.966v6c-.029.799-.474 1.524-1.224 1.84c-.247.104-.509.15-.776.16H5c-.569-.021-1.103-.239-1.487-.667C3.18 19.961 3.018 19.494 3 19V8c.01-.267.056-.529.16-.776C3.476 6.474 4.201 6.029 5 6h6c.451.03.844.288.966.741c.176.656-.327 1.217-.966 1.259H5.057ZM17.586 5H15c-1.204-.079-1.357-1.672-.259-1.966L15 3h5c.271.018.511.096.707.293c.197.196.275.436.293.707v5l-.034.259c-.294 1.098-1.887.945-1.966-.259V6.414l-8.293 8.293c-.409.359-1.01.404-1.414 0s-.359-1.005 0-1.414Z"/>',
    heart: '<path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" d="M12 5.705c-3.692-3.947-9.114-.478-8.998 4.666q.102 4.59 7.19 8.8c.274.163.706.41 1.08.62a1.48 1.48 0 0 0 1.457 0c.373-.21.805-.457 1.08-.62q7.085-4.21 7.19-8.8c.115-5.144-5.307-8.613-8.999-4.666Z"/>',
    chat: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 11h6m-6 4h3m-8 6h8a9 9 0 1 0-9-9v8a1 1 0 0 0 1 1"/>',
    eye: '<path fill="currentColor" d="M15.446 12.237c-.837 1.246-1.389 2.48-2.978 2.73c-2.391.375-4.237-2.131-3.158-4.302c.198-.399.486-.751.836-1.026l1.616-1.087l.287 1.881a2.01 2.01 0 0 0 1.517 1.516ZM12.752 4.03c3.401.273 6.907 2.548 8.539 5.554c.4.737.711 1.567.711 2.416c0 1.224-.616 2.403-1.315 3.37c-2.12 2.935-5.783 4.895-9.439 4.6c-3.401-.273-6.907-2.548-8.539-5.554c-.4-.737-.711-1.567-.711-2.416c0-1.224.616-2.403 1.315-3.37c2.12-2.935 5.783-4.895 9.439-4.6m-1.343 1.995c-1.155.093-2.276.461-3.291 1.012c-1.547.839-3.09 2.223-3.825 3.852c-.155.345-.291.727-.291 1.111c0 .791.488 1.582.933 2.199c1.834 2.538 5.085 4.209 8.237 3.706c1.137-.181 2.225-.621 3.2-1.227c1.366-.85 2.664-2.08 3.335-3.567c.155-.345.291-.727.291-1.111c0-.791-.488-1.582-.933-2.199c-1.714-2.372-4.693-4.015-7.656-3.776"/>',
    bookmark: '<path fill="none" stroke="currentColor" stroke-width="2" d="M11.784 2.87a.25.25 0 0 1 .432 0l2.961 5.085a.25.25 0 0 0 .164.119l5.75 1.245a.25.25 0 0 1 .134.41l-3.92 4.388a.25.25 0 0 0-.063.192l.593 5.854a.25.25 0 0 1-.35.254l-5.384-2.373a.25.25 0 0 0-.202 0l-5.384 2.373a.25.25 0 0 1-.35-.254l.593-5.854a.25.25 0 0 0-.062-.192L2.776 9.73a.25.25 0 0 1 .133-.411l5.75-1.245a.25.25 0 0 0 .164-.119z"/>',
    share: '<path fill="none" stroke="currentColor" stroke-width="2" d="m16.407 6.81l-6 3.145m0 4.089l6 3.145M11 12a4 4 0 1 1-8 0a4 4 0 0 1 8 0Zm10-6.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Zm0 13a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z"/>',
    more: '<path fill="currentColor" d="M12.5 12a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m6 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m-12 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0"/><path fill="none" stroke="currentColor" stroke-width="2" d="M12.5 12a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0Zm6 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0Zm-12 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0Z"/>',
    search: '<path fill="currentColor" d="m17.176 15.762l3.652 3.652c.359.41.405 1.01 0 1.414c-.404.405-1.004.359-1.414 0l-3.652-3.652c-1.145.85-2.399 1.459-3.814 1.702C5.871 19.921.72 14.327 2.272 8.355a8.5 8.5 0 0 1 1.979-3.618A8.55 8.55 0 0 1 7.68 2.478c6.112-2.146 12.292 3.095 11.198 9.47c-.243 1.415-.852 2.669-1.702 3.814M9.938 4.025a6.5 6.5 0 0 0-3.844 1.697a6.5 6.5 0 0 0-1.727 2.622c-1.558 4.436 2.021 9.03 6.695 8.631a6.5 6.5 0 0 0 3.844-1.697a6.5 6.5 0 0 0 1.727-2.622c1.558-4.436-2.021-9.03-6.695-8.631"/>',
    smile: '<path fill="currentColor" d="M8.697 13.59c.357.072.555.336.829.552c.702.553 1.58.856 2.474.856s1.772-.303 2.474-.856c.274-.216.472-.480.829-.552a1.010 1.01 0 0 1 1.195 1.045c-.031.487-.430.8-.784 1.08a6 6 0 0 1-1.106.691a6.05 6.05 0 0 1-6.322-.691c-.268-.212-.616-.477-.733-.824c-.242-.716.403-1.449 1.144-1.301m7.278-5.526l.418.216c.985.72.742 2.274-.418 2.656l-.475.077l-.475-.077l-.418-.216c-.985-.72-.742-2.274.418-2.656l.475-.077Zm-7 0l.418.216c.985.72.742 2.274-.418 2.656l-.475.077l-.475-.077l-.418-.216c-.985-.72-.742-2.274.418-2.656l.475-.077Zm3.805-6.035c1.747.135 3.445.737 4.888 1.731c5.510 3.795 5.807 11.855.587 16.043a10 10 0 0 1-3.237 1.734a10.02 10.02 0 0 1-8.686-1.296C.822 16.445.525 8.385 5.745 4.197a10 10 0 0 1 3.237-1.734a10.1 10.1 0 0 1 3.798-.434m-1.406 1.996a8 8 0 0 0-4.377 1.733C2.03 9.744 3.510 17.709 9.585 19.629a8 8 0 0 0 7.418-1.387c4.967-3.985 3.487-11.951-2.588-13.871a8.1 8.1 0 0 0-3.041-.346"/>',
    image: '<path fill="currentColor" d="M15.77 7.024a1.516 1.516 0 0 1 1.206 1.746a1.516 1.516 0 0 1-1.746 1.206a1.516 1.516 0 0 1-1.206-1.746a1.516 1.516 0 0 1 1.746-1.206m4.554-3.998C21.308 3.186 21.961 4.031 22 5v14c-.022.535-.202 1.03-.586 1.414s-.879.564-1.414.586H4c-.535-.022-1.03-.202-1.414-.586S2.022 19.535 2 19V5c.046-1.146.854-1.954 2-2h16ZM4 17.929V19h16v-1.071l-3.05-3.05l-.707.707c.198.198.393.378.467.660c.220.837-.709 1.554-1.461 1.124l-.213-.163l-5.157-5.157ZM4 5v10.1l5.171-5.171c.432-.378.983-.378 1.415 0l4.242 4.243l1.415-1.415c.432-.378.982-.378 1.414 0L20 15.101V5Z"/>',
    sparkles: '<path fill="currentColor" d="m2.084 17.326l1.464-1.189c1.017-.888 1.686-1.981 2.452-3.093c.766 1.111 1.435 2.205 2.451 3.093l1.464 1.189l-1.464 1.189c-1.016.888-1.685 1.981-2.451 3.092c-.767-1.112-1.435-2.204-2.452-3.091ZM6 16.485l-.797.841l.797.841l.796-.841Zm1.667-6.191c1.012-.714 1.811-1.216 2.696-1.973a15.2 15.2 0 0 0 3.056-3.569l1.355-2.356l1.355 2.356a15.3 15.3 0 0 0 3.057 3.569c.886.757 1.685 1.259 2.697 1.973c-1.012.714-1.811 1.216-2.697 1.973a15.3 15.3 0 0 0-3.057 3.569l-1.355 2.356l-1.355-2.356a15.2 15.2 0 0 0-3.056-3.569c-.885-.757-1.684-1.259-2.696-1.973m7.107-3.966c-1.006 1.523-2.254 2.826-3.674 3.966c1.420 1.140 2.668 2.443 3.674 3.966c1.007-1.523 2.255-2.826 3.676-3.966c-1.421-1.140-2.669-2.443-3.676-3.966"/>',
    chevronLeft: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.657 17.657L9 12l5.657-5.657"/>',
    chevronRight: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.343 17.657L15 12l-5.657-5.657"/>',
    warning: '<path fill="currentColor" d="M11.741 16.966a1 1 0 0 1-.607-.466c-.439-.759.290-1.690 1.127-1.465c.254.068.475.237.607.466c.439.759-.290 1.690-1.127 1.465m-.707-8.224c.226-.843 1.396-.997 1.832-.242c.101.175.121.302.134.500v4.001c-.030.450-.288.844-.741.965c-.656.176-1.217-.326-1.259-.965V9ZM3.213 20.341c-1.104-.129-1.653-1.272-1.146-2.238l8.634-14.955c.414-.648 1.240-.953 1.951-.596c.274.138.482.338.647.596l8.634 14.955c.263.501.265 1.076-.040 1.560c-.276.437-.751.670-1.259.690H3.366Zm1.019-1.988h15.536L12 4.898Z"/>'
  };

  // ============================ 1. 运行状态 ============================

  let root = null;              // #pco-root
  let shell = null;             // 浮层主卡片
  let contentEl = null;         // 左侧正文
  let countEl = null;           // 回复数
  let current = null;           // { id, link, rect, radius, controller, pushed }
  let restoreFocus = null;      // 打开前的焦点元素
  let closing = false;
  let routeTimer = null;
  let closeTimer = null;
  let backFallback = null;
  let toastTimer = null;
  let prefetchController = null;  // 相邻帖子预取专用，关闭浮层时统一中止
  let overlayEnabled = true;      // 浮窗模式开关（默认开启，可在设置里关闭）
  let composerToolsEnabled = false; // 回复框工具条（排版 / 表情 / 图片 / AI），默认关闭
  let blurOn = true;              // 遮罩毛玻璃效果（设置项，默认开启）
  let pageScaleOn = true;         // 背景页面同步缩放（设置项，默认开启）
  let imageZoomOn = true;         // 点击图片查看大图（站点外观设置项，默认开启）
  let pageEl = null;              // 浮层背后的站点页面容器，打开时整体后退缩放

  /** 当前浮层的数据与交互状态；关闭时整体丢弃 */
  let view = null;

  /** AI 助手：复用扩展后台的 pcai 端口（与帖子页 AI 回复同一套配置） */
  let aiPort = null;
  let aiPending = null;
  let aiSeq = 0;
  let aiBusy = false;
  let aiConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' };

  /** 详情缓存（按帖子 id）与回复缓存（按「帖子 id + 排序」） */
  const cache = new Map();
  const commentCache = new Map();
  /** 正在预取的帖子 id，避免同一目标重复请求 */
  const prefetching = new Set();

  /** 回复排序：与站点 /posts 接口的 sort 取值一致 */
  const SORTS = [
    { value: 'hot', label: '最热' },
    { value: 'latest', label: '最新' },
    { value: 'earliest', label: '最早' }
  ];

  /** 回复编辑器的常用表情 */
  const EMOJIS = [
    '😀', '😄', '😁', '😊', '🙂', '😉', '😍', '🤔',
    '😅', '😢', '😡', '👍', '👎', '❤️', '🔥', '🎉',
    '✅', '❌', '👀', '🙏', '💡', '🚀', '☕', '🌙'
  ];

  /** AI 总结：与 ai/content.js 的默认提示词保持一致，用户在设置里改过的会优先使用 */
  const SUM_SYSTEM = '你是一个严谨的阅读助手。只依据用户提供的帖子内容作答，不要编造原文没有的信息。' +
    '所有回答都必须用 Markdown 排版：可用小标题（##）、要点列表（-）、**加粗**关键词；不要输出 HTML 或整段无格式纯文本。';
  const SUM_PROMPT = '请阅读下面的帖子，提炼它的核心信息，并直接用 Markdown 排版输出。{{lang}}{{length}}\n\n' +
    '标题：{{title}}\n\n正文：\n{{content}}';
  const SUM_LANG = { auto: '', zh: '请使用简体中文输出。', en: 'Please respond in English.' };
  const SUM_LENGTH = {
    short: '控制在 3 行以内，只给结论。',
    medium: '用 5-8 条要点分点说明，重点突出。',
    long: '用不超过 12 条要点分点说明，可加小标题分节。'
  };
  const SUM_MAX_CHARS = 12000;

  const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };

  // ============================ 2. 工具 ============================

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, size) {
    const px = size || 16;
    return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" ' +
      'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function absUrl(url) {
    if (!url) return '';
    try { return new URL(url, location.origin).href; } catch (e) { return ''; }
  }

  function fmtCount(value) {
    const n = Number(value || 0);
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  }

  function timeAgo(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 45) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function isFeedPage() {
    const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    return FEED_PATH.test(path);
  }

  function postIdOf(href) {
    const m = String(href || '').match(POST_HREF);
    return m ? m[1] : '';
  }

  function avatarHtml(user, cls) {
    const url = absUrl(user && user.avatar && user.avatar.url);
    if (url) {
      return '<img class="' + cls + '" src="' + esc(url) + '" alt="" loading="lazy" ' +
        'referrerpolicy="no-referrer" />';
    }
    const initial = String((user && user.username) || '?').slice(0, 1);
    return '<span class="' + cls + ' pco-avatar--ph" aria-hidden="true">' + esc(initial) + '</span>';
  }

  function badgeHtml(user, small) {
    const badge = user && user.displayedBadge;
    const url = absUrl(badge && badge.image && badge.image.url);
    if (!url) return '';
    return '<span class="pco-badge' + (small ? ' pco-badge--sm' : '') + '" ' +
      'title="' + esc((badge && badge.name) || '徽章') + '">' +
      '<img src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>';
  }

  /** 把正文里的 @{uuid} 占位替换成已加载数据里的用户名 */
  function localizeMentions(container, map) {
    if (!container || !map) return;
    container.querySelectorAll('span.markdown-user-mention[data-user-id]').forEach((node) => {
      const name = map[node.getAttribute('data-user-id')];
      if (name) node.textContent = '@' + name;
    });
  }

  function buildMentionMap(topic, posts) {
    const map = {};
    if (topic && topic.author && topic.author.id) map[topic.author.id] = topic.author.username;
    ((posts && posts.items) || []).forEach((p) => {
      if (p && p.author && p.author.id) map[p.author.id] = p.author.username;
    });
    return map;
  }

  // ============================ 3. 数据 ============================

  async function fetchJson(url, signal) {
    const res = await fetch(url, {
      credentials: 'include',
      signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const postsUrl = (topicId, sort) =>
    '/api/v1/topics/' + encodeURIComponent(topicId) + '/posts?limit=' + COMMENT_LIMIT + '&sort=' + sort;

  /** 写接口统一入口：带 Cookie；POST 附带幂等键；204 / 空响应都安全返回 */
  async function apiSend(path, method, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') {
      let key = '';
      try { key = crypto.randomUUID(); } catch (e) { key = ''; }
      if (!key) key = 'pco-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      headers['Idempotency-Key'] = key;
    }

    const res = await fetch('/api/v1' + path, {
      method: method,
      credentials: 'include',
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (!res.ok) {
      const err = new Error((data && (data.message || data.reasonCode || data.code)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** 拉取主题详情，成功后渲染正文并加载当前排序下的回复 */
  async function loadTopic(topicId) {
    const signal = current && current.controller && current.controller.signal;
    const cached = cache.get(topicId);
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      applyTopic(cached.topic);
      loadComments(topicId, view.sort);
      return;
    }

    const base = '/api/v1/topics/' + encodeURIComponent(topicId);
    try {
      const result = await Promise.all([
        fetchJson(base, signal),
        fetchJson(postsUrl(topicId, view ? view.sort : 'hot'), signal).catch(() => null)
      ]);
      if (!current || current.id !== topicId) return;
      const topic = result[0];
      const posts = result[1];
      cache.set(topicId, { topic: topic, at: Date.now() });
      if (posts && view) commentCache.set(topicId + '|' + view.sort, { posts: posts, at: Date.now() });
      applyTopic(topic);
      applyPosts(topic, posts);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (!current || current.id !== topicId) return;
      showError();
    }
  }

  /** 切换排序或刷新回复；force 为 true 时跳过缓存 */
  async function loadComments(topicId, sort, force) {
    if (!view || !view.topic || !root) return;
    const key = topicId + '|' + sort;
    const cached = commentCache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
      applyPosts(view.topic, cached.posts);
      return;
    }

    const signal = current && current.controller && current.controller.signal;
    try {
      const posts = await fetchJson(postsUrl(topicId, sort), signal);
      if (!current || current.id !== topicId) return;
      commentCache.set(key, { posts: posts, at: Date.now() });
      applyPosts(view.topic, posts);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (!current || current.id !== topicId) return;
      view.posts = null;
      root.classList.remove('is-side-loaded');
      root.classList.add('is-side-error');
    }
  }

  // ============================ 3.1 栏目相邻帖子 ============================

  /** 信息流列表容器：优先用站点 aria-label（推荐 / 最新 / 关注 / 板块），兜底整页卡片 */
  function resolveFeedScope(link) {
    let node = link && link.parentElement;
    while (node && node !== document.body) {
      if (node.tagName === 'SECTION') {
        const label = node.getAttribute('aria-label') || '';
        const ids = collectFeedIds(node);
        if (ids.length > 1 && (!label || /帖子|搜索|板块/.test(label))) return node;
      }
      node = node.parentElement;
    }
    return collectFeedIds(document.body).length > 1 ? document.body : null;
  }

  /** 按 DOM 顺序收集信息流卡片的帖子 id；同一卡片里的多个链接只取第一个 */
  function collectFeedIds(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    const cards = scope.querySelectorAll('article[data-slot="root"]');
    const nodes = cards.length ? cards : scope.querySelectorAll('article');
    const ids = [];
    const seen = new Set();
    Array.prototype.forEach.call(nodes, (card) => {
      const links = card.querySelectorAll('a[href*="/forum/post/"]');
      for (let i = 0; i < links.length; i++) {
        const id = postIdOf(links[i].href);
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
          break;
        }
      }
    });
    return ids;
  }

  /** 当前栏目最新的有序帖子列表：优先读实时 DOM，退化为打开时的快照 */
  function currentFeedIds() {
    if (!current) return [];
    let ids = [];
    if (current.scope && current.scope.isConnected) ids = collectFeedIds(current.scope);
    if (!ids.length && current.list) ids = current.list.slice();
    if (!ids.length) ids = collectFeedIds(document.body);
    if (current.id && ids.indexOf(current.id) === -1) ids.push(current.id);
    return ids;
  }

  function findFeedLink(topicId) {
    if (!current || !current.scope || !current.scope.isConnected) return null;
    const links = current.scope.querySelectorAll('a[href*="/forum/post/"]');
    for (let i = 0; i < links.length; i++) {
      if (postIdOf(links[i].href) === topicId) return links[i];
    }
    return null;
  }

  /** 预取相邻帖子的正文与最热回复；命中缓存时切换瞬时完成 */
  async function prefetchTopic(topicId) {
    if (!topicId) return;
    const hit = cache.get(topicId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return;
    if (prefetching.has(topicId)) return;
    prefetching.add(topicId);

    const signal = prefetchController && prefetchController.signal;
    const base = '/api/v1/topics/' + encodeURIComponent(topicId);
    try {
      const result = await Promise.all([
        fetchJson(base, signal),
        fetchJson(postsUrl(topicId, 'hot'), signal).catch(() => null)
      ]);
      cache.set(topicId, { topic: result[0], at: Date.now() });
      if (result[1]) commentCache.set(topicId + '|hot', { posts: result[1], at: Date.now() });
    } catch (err) {
      /* 预取失败静默：真正切过去时会再请求一次 */
    } finally {
      prefetching.delete(topicId);
    }
  }

  function prefetchNeighbors() {
    if (!current || !root) return;
    const ids = currentFeedIds();
    const index = ids.indexOf(current.id);
    if (index === -1) return;
    if (ids[index - 1]) prefetchTopic(ids[index - 1]);
    if (ids[index + 1]) prefetchTopic(ids[index + 1]);
  }

  // ============================ 4. 模板 ============================

  function skeletonMain() {
    return '<div class="pco-skeleton" data-skel="main">' +
      '<div class="pco-skeleton-lines">' +
        '<div class="pco-sk-head"><span class="pco-sk pco-sk-avatar"></span>' +
          '<span class="pco-sk pco-sk-name"></span></div>' +
        '<div class="pco-sk pco-sk-title"></div>' +
        '<div class="pco-sk pco-sk-title pco-sk-title--short"></div>' +
        '<div class="pco-sk pco-sk-line"></div>' +
        '<div class="pco-sk pco-sk-line"></div>' +
        '<div class="pco-sk pco-sk-line pco-sk-line--short"></div>' +
        '<div class="pco-sk pco-sk-block"></div>' +
        '<div class="pco-sk pco-sk-line"></div>' +
        '<div class="pco-sk pco-sk-line pco-sk-line--short"></div>' +
      '</div>' +
      errorHtml() +
    '</div>';
  }

  function skeletonSide() {
    let bars = '';
    for (let i = 0; i < 6; i++) {
      bars += '<div class="pco-sk-comment">' +
        '<span class="pco-sk pco-sk-avatar pco-sk-avatar--sm"></span>' +
        '<span class="pco-sk-body">' +
          '<span class="pco-sk pco-sk-name pco-sk-name--sm"></span>' +
          '<span class="pco-sk pco-sk-line pco-sk-line--sm"></span>' +
          '<span class="pco-sk pco-sk-line pco-sk-line--sm pco-sk-line--short"></span>' +
        '</span>' +
      '</div>';
    }
    return '<div class="pco-skeleton pco-skeleton--side" data-skel="side">' +
      '<div class="pco-skeleton-lines">' + bars + '</div>' +
      '<div class="pco-error pco-error--side">' +
        '<span class="pco-error-ico">' + icon('warning', 18) + '</span>' +
        '<p>回复暂时加载失败</p>' +
        '<button type="button" class="pco-retry" data-act="retry">重新加载</button>' +
      '</div>' +
    '</div>';
  }

  function errorHtml() {
    return '<div class="pco-error pco-error--main">' +
      '<span class="pco-error-ico">' + icon('warning', 22) + '</span>' +
      '<strong>帖子暂时打不开</strong>' +
      '<p>网络或服务暂时不可用，可以重试，或直接打开原帖。</p>' +
      '<div class="pco-error-actions">' +
        '<button type="button" class="pco-retry" data-act="retry">重新加载</button>' +
        '<a class="pco-retry pco-retry--ghost" data-role="open" href="#" target="_blank" rel="noopener">打开原帖</a>' +
      '</div>' +
    '</div>';
  }

  function shellTemplate() {
    const sorts = SORTS.map((s) =>
      '<button type="button" class="pco-sort' + (s.value === 'hot' ? ' is-active' : '') + '" ' +
        'data-act="sort" data-sort="' + s.value + '" aria-pressed="' + (s.value === 'hot') + '">' +
        s.label +
      '</button>'
    ).join('');

    const emojis = EMOJIS.map((e) =>
      '<button type="button" class="pco-emoji" data-act="emoji" data-emoji="' + e + '">' + e + '</button>'
    ).join('');

    return '<div class="pco-backdrop" data-act="close" aria-hidden="true"></div>' +
      '<div class="pco-shell" role="dialog" aria-modal="true" aria-label="帖子预览" tabindex="-1">' +
        '<div class="pco-frame">' +
          '<section class="pco-main">' +
            '<div class="pco-scroll" data-role="scroll">' +
              '<div class="pco-content" data-role="content"></div>' +
              skeletonMain() +
            '</div>' +
          '</section>' +
          '<aside class="pco-side" aria-label="帖子回复">' +
            '<div class="pco-side-head">' +
              '<span class="pco-side-title">全部回复</span>' +
              '<span class="pco-side-count" data-role="count">…</span>' +
            '</div>' +
            '<div class="pco-side-tools">' +
              '<div class="pco-sorts" role="group" aria-label="回复排序">' + sorts + '</div>' +
              '<label class="pco-filter">' + icon('search', 14) +
                '<input type="search" data-role="filter" placeholder="筛选回复" ' +
                  'aria-label="按用户名或关键词筛选回复" autocomplete="off" />' +
              '</label>' +
            '</div>' +
            '<div class="pco-comments" data-role="comments">' +
              '<div class="pco-comments-inner" data-role="comments-inner"></div>' +
              skeletonSide() +
            '</div>' +
            '<div class="pco-composer">' +
              '<div class="pco-composer-box">' +
                '<div class="pco-composer-tools" data-role="tools">' +
                  '<button type="button" class="pco-tool pco-tool--text" data-act="tool-more" ' +
                    'title="展开更多排版功能" aria-expanded="false">Aa</button>' +
                  '<button type="button" class="pco-tool" data-act="tool-emoji" ' +
                    'title="插入表情" aria-expanded="false">' + icon('smile', 15) + '</button>' +
                  '<button type="button" class="pco-tool" data-act="tool-image" ' +
                    'title="插入图片" aria-expanded="false">' + icon('image', 15) + '</button>' +
                  '<button type="button" class="pco-tool" data-act="tool-ai" ' +
                    'title="AI 助手" aria-expanded="false">' + icon('sparkles', 15) + '</button>' +
                  '<div class="pco-tool-extra" data-role="extra-tools" hidden>' +
                    '<button type="button" class="pco-tool" data-act="fmt-bold" title="加粗">B</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-italic" title="斜体">I</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-quote" title="引用">❝</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-code" title="代码">&lt;/&gt;</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-link" title="链接">🔗</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-list" title="列表">≡</button>' +
                  '</div>' +
                  '<div class="pco-pop pco-emoji-pop" data-role="emoji-pop" hidden>' + emojis + '</div>' +
                  '<div class="pco-pop pco-image-pop" data-role="image-pop" hidden>' +
                    '<input type="url" data-role="image-url" placeholder="图片链接 https://…" />' +
                    '<button type="button" class="pco-pop-btn" data-act="image-insert">插入</button>' +
                  '</div>' +
                  '<div class="pco-pop pco-ai-pop" data-role="ai-pop" hidden>' +
                    '<div class="pco-ai-head">AI 助手</div>' +
                    '<div class="pco-ai-actions">' +
                      '<button type="button" class="pco-ai-btn" data-act="ai-summary">总结本帖</button>' +
                      '<button type="button" class="pco-ai-btn" data-act="ai-write">写一条回复</button>' +
                      '<button type="button" class="pco-ai-btn" data-act="ai-polish">润色草稿</button>' +
                    '</div>' +
                    '<div class="pco-ai-status" data-role="ai-status">使用设置里的模型与密钥生成</div>' +
                    '<div class="pco-ai-out" data-role="ai-out" hidden></div>' +
                  '</div>' +
                '</div>' +
                '<textarea data-role="composer" rows="2" maxlength="4000" ' +
                  'placeholder="写下你的回复…" aria-label="回复内容"></textarea>' +
                '<div class="pco-composer-bar">' +
                  '<span class="pco-composer-tip">Ctrl + Enter 发送</span>' +
                  '<a class="pco-side-link" data-role="open" href="#" target="_blank" rel="noopener">' +
                    '完整讨论' + icon('external', 12) +
                  '</a>' +
                  '<button type="button" class="pco-send" data-act="submit">回复</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</aside>' +
          '<div class="pco-rail" role="toolbar" aria-label="帖子操作">' +
            '<a class="pco-rail-avatar" data-role="rail-avatar" href="#" target="_blank" ' +
              'rel="noopener" title="查看作者主页" aria-label="查看作者主页"></a>' +
            '<span class="pco-rail-sep" aria-hidden="true"></span>' +
            '<button type="button" class="pco-rail-btn" data-act="like" aria-pressed="false" title="点赞">' +
              icon('heart', 18) +
              '<span class="pco-rail-num" data-role="like-count">—</span>' +
            '</button>' +
            '<button type="button" class="pco-rail-btn" data-act="comment" title="写回复">' +
              icon('chat', 18) +
              '<span class="pco-rail-num" data-role="comment-count">—</span>' +
            '</button>' +
            '<button type="button" class="pco-rail-btn" data-act="bookmark" aria-pressed="false" title="收藏">' +
              icon('bookmark', 18) +
            '</button>' +
            '<button type="button" class="pco-rail-btn" data-act="share" title="复制链接">' +
              icon('share', 18) +
            '</button>' +
            '<button type="button" class="pco-rail-btn" data-act="more" title="更多操作" ' +
              'aria-haspopup="true" aria-expanded="false">' +
              icon('more', 18) +
            '</button>' +
            '<div class="pco-rail-menu" data-role="rail-menu" role="menu" hidden>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-detail">在详情页打开</button>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-newtab">在新标签页打开</button>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-copy">复制帖子链接</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pco-actions">' +
          '<a class="pco-icon-btn" data-role="open" href="#" target="_blank" rel="noopener" ' +
            'title="在详情页打开" aria-label="在详情页打开">' + icon('external', 17) + '</a>' +
          '<button type="button" class="pco-icon-btn pco-icon-btn--close" data-act="close" ' +
            'title="关闭（Esc）" aria-label="关闭">' + icon('close', 18) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="pco-nav" role="group" aria-label="切换帖子">' +
        '<button type="button" class="pco-nav-btn" data-act="prev" title="上一个帖子" ' +
          'aria-label="上一个帖子" disabled>' + icon('chevronLeft', 22) + '</button>' +
        '<button type="button" class="pco-nav-btn" data-act="next" title="下一个帖子" ' +
          'aria-label="下一个帖子" disabled>' + icon('chevronRight', 22) + '</button>' +
      '</div>';
  }

  // ============================ 5. 打开与动画 ============================

  function lockScroll() {
    const gap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    document.documentElement.style.setProperty('--pco-sbw', gap + 'px');
    document.documentElement.classList.add('pco-lock');
  }

  function unlockScroll() {
    document.documentElement.classList.remove('pco-lock');
    document.documentElement.style.removeProperty('--pco-sbw');
  }

  // ---------- 背景页面的前后景缩放 ----------

  /** 以当前视口中心为原点后退一小步，让浮层与页面之间产生空间层次 */
  function pageBackIn() {
    if (!pageEl || !pageScaleOn || reducedMotion()) return;
    const box = pageEl.getBoundingClientRect();
    const ox = Math.round(window.innerWidth / 2 - box.left);
    const oy = Math.round(window.innerHeight / 2 - box.top);
    pageEl.style.transition = 'transform 0.44s cubic-bezier(0.22, 1, 0.36, 1), filter 0.44s ease';
    pageEl.style.transformOrigin = ox + 'px ' + oy + 'px';
    pageEl.style.transform = 'scale(' + PAGE_SCALE + ')';
    pageEl.style.filter = 'brightness(0.94) saturate(0.97)';
  }

  /** 读取页面当前的缩放比例，用于把回缩目标还原到缩放结束后的位置 */
  function pageScaleNow() {
    if (!pageEl) return 0;
    const tr = window.getComputedStyle(pageEl).transform;
    if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const a = parseFloat(m[1].split(',')[0]);
    return isNaN(a) ? 0 : a;
  }

  /** 把缩放状态下的卡片矩形还原成页面恢复后的最终矩形（原点在视口中心） */
  function unscaleRect(r, scale) {
    if (!r || !scale || scale === 1) return r;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const width = r.width / scale;
    const height = r.height / scale;
    return {
      left: cx + (r.left + r.width / 2 - cx) / scale - width / 2,
      top: cy + (r.top + r.height / 2 - cy) / scale - height / 2,
      width: width,
      height: height
    };
  }

  function pageBackOut() {
    if (!pageEl) return;
    pageEl.style.transform = '';
    pageEl.style.filter = '';
  }

  function resetPage() {
    if (!pageEl) return;
    pageEl.style.transition = '';
    pageEl.style.transformOrigin = '';
    pageEl.style.transform = '';
    pageEl.style.filter = '';
    pageEl = null;
  }

  // ---------- 正文图片大图预览（与原站点点击图片的效果一致） ----------

  function closeLightbox() {
    if (!root) return;
    const lb = root.querySelector('.pco-lightbox');
    if (!lb) return;
    lb.classList.remove('is-on');
    setTimeout(() => {
      if (lb.parentNode) lb.parentNode.removeChild(lb);
    }, 160);
  }

  function openLightbox(img) {
    if (!root || !imageZoomOn || !img) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    closeLightbox();

    const lb = document.createElement('div');
    lb.className = 'pco-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', '查看大图');
    lb.innerHTML =
      '<img class="pco-lightbox-img" src="' + esc(src) + '" alt="' + esc(img.alt || '') + '" />' +
      '<button type="button" class="pco-lightbox-close" data-act="lightbox-close" ' +
        'title="关闭（Esc）" aria-label="关闭大图">' + icon('close', 20) + '</button>';
    root.appendChild(lb);

    requestAnimationFrame(() => {
      if (lb.parentNode) lb.classList.add('is-on');
    });
  }

  function setOpenLinks(topicId) {
    if (!root) return;
    root.querySelectorAll('[data-role="open"]').forEach((el) => {
      el.setAttribute('href', '/forum/post/' + encodeURIComponent(topicId));
    });
  }

  function build(rect, radius) {
    root = document.createElement('div');
    root.id = 'pco-root';
    root.innerHTML = shellTemplate();
    if (!blurOn) root.classList.add('pco-no-blur');
    if (!imageZoomOn) root.classList.add('pco-no-zoom');
    document.body.appendChild(root);
    lockScroll();

    // 站点是 Nuxt 应用，整页内容都在 #__nuxt 里；浮层挂在 body 下，不受这层缩放影响
    pageEl = document.getElementById('__nuxt');

    shell = root.querySelector('.pco-shell');
    contentEl = root.querySelector('[data-role="content"]');
    countEl = root.querySelector('[data-role="count"]');
    syncComposerTools();

    // 先把最终尺寸量出来，再倒推初始缩放，保证卡片原位「长」成浮层
    const last = shell.getBoundingClientRect();
    const first = rect || { left: last.left, top: last.top, width: 0, height: 0 };
    const reduce = reducedMotion();

    shell.style.transition = 'none';
    shell.style.transformOrigin = '50% 50%';

    if (!reduce && last.width > 0 && last.height > 0 && first.width > 0 && first.height > 0) {
      const sx = Math.max(96, first.width) / last.width;
      const sy = Math.max(64, first.height) / last.height;
      const dx = (first.left + first.width / 2) - (last.left + last.width / 2);
      const dy = (first.top + first.height / 2) - (last.top + last.height / 2);
      shell.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')';
      shell.style.borderRadius = Math.min(radius || 14, 24) + 'px';
      shell.style.opacity = '0.72';
    } else {
      shell.style.transform = reduce ? 'none' : 'translateY(12px) scale(.985)';
      shell.style.opacity = reduce ? '0' : '0.3';
    }

    void shell.offsetWidth;
    shell.style.transition = '';
    shell.style.transformOrigin = '';

    requestAnimationFrame(() => {
      if (!root || !shell) return;
      root.classList.add('is-open');
      pageBackIn();
      shell.style.transform = '';
      shell.style.opacity = '';
      shell.style.borderRadius = '';
    });

    // 首帧把焦点交给关闭按钮，Esc 与键盘用户都能立刻操作
    setTimeout(() => {
      if (!root) return;
      const btn = root.querySelector('.pco-icon-btn--close');
      if (btn) btn.focus({ preventScroll: true });
    }, 140);
  }

  function openPost(topicId, link) {
    if (!topicId || closing) return;
    if (root) cleanup();

    const card = link.closest('article') || link;
    const rect = card.getBoundingClientRect();
    let radius = 14;
    try {
      const raw = parseFloat(getComputedStyle(card).borderTopLeftRadius);
      if (isFinite(raw) && raw > 0) radius = raw;
    } catch (e) { /* noop */ }

    restoreFocus = document.activeElement;
    view = {
      topic: null,
      posts: null,
      sort: 'hot',
      keyword: '',
      liked: false,
      likeCount: 0,
      bookmarkId: null,
      likeBusy: false,
      bookmarkBusy: false,
      commentBusy: false
    };
    current = {
      id: topicId,
      link: link,
      scope: null,
      list: [],
      openedAt: Date.now(),
      controller: null,
      pushed: false
    };
    try { current.controller = new AbortController(); } catch (e) { current.controller = null; }

    // 记录打开时所在栏目（关注 / 推荐 / 最新 / 板块）的有序列表，供左右切换
    current.scope = resolveFeedScope(link);
    const ids = collectFeedIds(current.scope || document.body);
    current.list = ids.indexOf(topicId) === -1 ? ids.concat([topicId]) : ids;
    try { prefetchController = new AbortController(); } catch (e) { prefetchController = null; }

    build(rect, radius);
    bind();
    setOpenLinks(topicId);
    paintNav();
    loadAiConfig();

    // 记一条与当前 URL 相同的历史：后退键能无缝关闭，而不是离开页面
    try {
      history.pushState({ pco: true, id: topicId }, '', location.href);
      current.pushed = true;
    } catch (e) { current.pushed = false; }

    loadTopic(topicId);
    prefetchNeighbors();

    routeTimer = setInterval(() => {
      if (root && !isFeedPage()) cleanup();
    }, 800);
  }

  // ============================ 6. 渲染 ============================

  /** 主题数据到手：记录状态、渲染正文、刷新操作栏 */
  function applyTopic(topic) {
    if (!root || !topic || !view) return;
    const first = topic.firstPost || {};
    view.topic = topic;
    view.liked = !!(first.viewerState && first.viewerState.liked);
    view.likeCount = Number(first.likeCount != null ? first.likeCount : topic.likeCount) || 0;
    view.bookmarkId = (topic.viewerState && topic.viewerState.bookmarkId) || null;
    renderTopic(topic);
    paintRail();
  }

  function applyPosts(topic, posts) {
    if (!root || !view || !topic) return;
    view.posts = posts || null;
    renderComments(topic, posts, buildMentionMap(topic, posts));
  }

  function renderTopic(topic) {
    if (!root || !contentEl || !topic) return;
    const author = topic.author || {};
    const first = topic.firstPost || {};
    const map = buildMentionMap(topic, view && view.posts ? view.posts : null);

    const tags = (topic.tags || []).map((tag) =>
      '<a class="pco-tag" href="/forum/category/' + encodeURIComponent(tag.slug) + '">' +
        esc(tag.name) + '</a>'
    ).join('');

    contentEl.innerHTML =
      '<h1 class="pco-title">' + esc(topic.title || '无标题帖子') + '</h1>' +
      '<div class="pco-author">' +
        avatarHtml(author, 'pco-avatar') +
        '<div class="pco-author-main">' +
          '<div class="pco-author-line">' +
            '<span class="pco-author-name">' + esc(author.username || '匿名用户') + '</span>' +
            badgeHtml(author, false) +
            '<span class="pco-time">' + esc(timeAgo(topic.createdAt)) + '</span>' +
          '</div>' +
          '<div class="pco-author-sub">' +
            (topic.kind === 'QUESTION' ? '问答' : '讨论') +
          '</div>' +
        '</div>' +
      '</div>' +
      (tags ? '<div class="pco-tags">' + tags + '</div>' : '') +
      '<div class="pco-post-foot">' +
        '<span>' + icon('heart', 15) + esc(fmtCount(topic.likeCount != null ? topic.likeCount : first.likeCount)) + '</span>' +
        '<span>' + icon('chat', 15) + esc(fmtCount(topic.replyCount)) + '</span>' +
        '<span>' + icon('eye', 15) + esc(fmtCount(topic.viewCount)) + '</span>' +
      '</div>' +
      '<div class="pco-md pco-post-body">' +
        (first.cookedHtml || '<p class="pco-empty">正文为空</p>') +
      '</div>';

    localizeMentions(contentEl, map);
    contentEl.querySelectorAll('img').forEach((img) => {
      if (img.classList.contains('markdown-emoji')) return;
      img.loading = 'lazy';
      img.decoding = 'async';
    });

    // 内容与骨架交叉淡出，避免出现闪白或跳版
    root.classList.add('is-loaded');
  }

  // ============================ 6.0 切换相邻帖子 ============================

  function paintNav() {
    if (!root || !current) return;
    const ids = currentFeedIds();
    const index = ids.indexOf(current.id);
    const prev = root.querySelector('[data-act="prev"]');
    const next = root.querySelector('[data-act="next"]');
    if (prev) {
      const on = index > 0;
      prev.disabled = !on;
      prev.title = on ? '上一个帖子' : '已经是第一个帖子';
    }
    if (next) {
      const on = index !== -1 && index < ids.length - 1;
      next.disabled = !on;
      next.title = on ? '下一个帖子' : '已经是最后一个帖子';
    }
  }

  function goNeighbor(step) {
    if (!root || !current || closing) return;
    const ids = currentFeedIds();
    const index = ids.indexOf(current.id);
    if (index === -1) return;
    const target = ids[index + step];
    if (!target) return;
    switchPost(target, step > 0 ? 'next' : 'prev');
  }

  /** 切换帖子前清空操作栏，避免短暂显示上一篇的作者与计数 */
  function resetRail() {
    if (!root) return;
    closeRailMenu();
    closePops();
    const avatar = root.querySelector('[data-role="rail-avatar"]');
    if (avatar) {
      avatar.innerHTML = '';
      avatar.setAttribute('href', '#');
    }
    root.querySelectorAll('.pco-rail-btn.is-on').forEach((el) => el.classList.remove('is-on'));
    const like = root.querySelector('[data-act="like"]');
    if (like) {
      like.setAttribute('aria-pressed', 'false');
      like.title = '点赞';
    }
    const bookmark = root.querySelector('[data-act="bookmark"]');
    if (bookmark) {
      bookmark.setAttribute('aria-pressed', 'false');
      bookmark.title = '收藏';
    }
    const likeNum = root.querySelector('[data-role="like-count"]');
    if (likeNum) likeNum.textContent = '—';
    const commentNum = root.querySelector('[data-role="comment-count"]');
    if (commentNum) commentNum.textContent = '—';
  }

  /** 清空正文与回复，露出骨架，等新帖数据填充 */
  function resetPanel() {
    if (!root) return;
    closeLightbox();
    root.classList.remove('is-loaded', 'is-side-loaded', 'is-side-error', 'is-error');
    if (countEl) countEl.textContent = '…';
    if (contentEl) contentEl.innerHTML = '';
    const inner = root.querySelector('[data-role="comments-inner"]');
    if (inner) inner.innerHTML = '';
    const out = aiOut();
    if (out) {
      out.hidden = true;
      out.innerHTML = '';
    }
    const aiPop = root.querySelector('[data-role="ai-pop"]');
    if (aiPop) aiPop.classList.remove('is-summary');
  }

  /** 命中缓存时给正文与回复加一段同向轻滑，外层浮层本身不重播动画 */
  function animateSwap(dir) {
    if (!root || !contentEl || reducedMotion()) return;
    const inner = root.querySelector('[data-role="comments-inner"]');
    [contentEl, inner].forEach((el) => {
      if (!el) return;
      el.classList.remove('pco-anim-next', 'pco-anim-prev');
      void el.offsetWidth;
      el.classList.add(dir === 'prev' ? 'pco-anim-prev' : 'pco-anim-next');
    });
  }

  function switchPost(topicId, dir) {
    if (!root || !current || closing || !topicId || topicId === current.id) return;

    current.id = topicId;
    const cardLink = findFeedLink(topicId);
    current.link = cardLink || null;
    if (cardLink) restoreFocus = cardLink;

    setOpenLinks(topicId);
    try {
      if (current.pushed) history.replaceState({ pco: true, id: topicId }, '', location.href);
    } catch (e) { /* noop */ }

    if (view) {
      view.topic = null;
      view.posts = null;
      view.sort = 'hot';
      view.keyword = '';
      view.liked = false;
      view.likeCount = 0;
      view.bookmarkId = null;
      view.likeBusy = false;
      view.bookmarkBusy = false;
      view.commentBusy = false;
    }
    paintSorts();

    const filter = root.querySelector('[data-role="filter"]');
    if (filter) filter.value = '';
    const composer = root.querySelector('[data-role="composer"]');
    if (composer) {
      composer.value = '';
      growComposer(composer);
    }
    abortAi();

    resetRail();
    resetPanel();
    animateSwap(dir);

    const scroll = root.querySelector('[data-role="scroll"]');
    if (scroll) scroll.scrollTop = 0;
    const comments = root.querySelector('[data-role="comments"]');
    if (comments) comments.scrollTop = 0;

    const cached = cache.get(topicId);
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      applyTopic(cached.topic);
      loadComments(topicId, 'hot');
    } else {
      loadTopic(topicId);
    }

    paintNav();
    prefetchNeighbors();
  }

  // ============================ 6.1 操作栏与提示 ============================

  function paintRail() {
    if (!root || !view || !view.topic) return;
    const topic = view.topic;
    const author = topic.author || {};

    const avatar = root.querySelector('[data-role="rail-avatar"]');
    if (avatar) {
      avatar.innerHTML = avatarHtml(author, 'pco-rail-avatar-img');
      avatar.setAttribute('href', '/profile/' + encodeURIComponent(author.id || ''));
    }

    const likeBtn = root.querySelector('[data-act="like"]');
    if (likeBtn) {
      likeBtn.classList.toggle('is-on', view.liked);
      likeBtn.setAttribute('aria-pressed', view.liked ? 'true' : 'false');
      likeBtn.title = view.liked ? '取消点赞' : '点赞';
    }

    const likeNum = root.querySelector('[data-role="like-count"]');
    if (likeNum) likeNum.textContent = fmtCount(view.likeCount);

    const commentNum = root.querySelector('[data-role="comment-count"]');
    if (commentNum) commentNum.textContent = fmtCount(topic.replyCount);

    const bookmarkBtn = root.querySelector('[data-act="bookmark"]');
    if (bookmarkBtn) {
      const on = view.bookmarkId != null;
      bookmarkBtn.classList.toggle('is-on', on);
      bookmarkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      bookmarkBtn.title = on ? '取消收藏' : '收藏';
    }
  }

  function paintSorts() {
    if (!root || !view) return;
    root.querySelectorAll('[data-act="sort"]').forEach((btn) => {
      const on = btn.getAttribute('data-sort') === view.sort;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function toast(message, type) {
    if (!root) return;
    let el = root.querySelector('.pco-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'pco-toast';
      root.appendChild(el);
    }
    el.textContent = message;
    el.className = 'pco-toast pco-toast--' + (type || 'ok') + ' is-show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      if (el) el.classList.remove('is-show');
    }, 2400);
  }

  /** 浮层里的写操作：点赞（点赞对象是主题首帖） */
  async function toggleLike() {
    if (!view || !view.topic || view.likeBusy) return;
    const first = view.topic.firstPost || {};
    if (!first.id) {
      toast('暂时拿不到点赞目标，请打开原帖操作', 'err');
      return;
    }

    const next = !view.liked;
    view.likeBusy = true;
    try {
      await apiSend('/posts/' + encodeURIComponent(first.id) + '/like', next ? 'PUT' : 'DELETE');
      view.liked = next;
      view.likeCount = Math.max(0, view.likeCount + (next ? 1 : -1));
      // 同步缓存里的点赞状态，避免 5 分钟内重开浮层显示旧状态
      first.likeCount = view.likeCount;
      first.viewerState = first.viewerState || {};
      first.viewerState.liked = next;
      paintRail();
    } catch (err) {
      toast(err.status === 401 ? '请先登录后再点赞' : '点赞失败：' + err.message, 'err');
    } finally {
      if (view) view.likeBusy = false;
    }
  }

  /** 收藏 / 取消收藏（接口：POST /bookmarks，DELETE /bookmarks/{id}） */
  async function toggleBookmark() {
    if (!view || !view.topic || view.bookmarkBusy) return;
    const topic = view.topic;
    view.bookmarkBusy = true;
    try {
      if (view.bookmarkId) {
        await apiSend('/bookmarks/' + encodeURIComponent(view.bookmarkId), 'DELETE');
        view.bookmarkId = null;
        toast('已取消收藏');
      } else {
        const res = await apiSend('/bookmarks', 'POST', {
          bookmarkableType: 'TOPIC',
          bookmarkableId: topic.id
        });
        view.bookmarkId = (res && (res.bookmarkId || (res.bookmark && res.bookmark.id))) || null;
        toast('已收藏');
      }
      topic.viewerState = topic.viewerState || {};
      topic.viewerState.bookmarkId = view.bookmarkId;
      paintRail();
    } catch (err) {
      toast(err.status === 401 ? '请先登录后再收藏' : '收藏失败：' + err.message, 'err');
    } finally {
      if (view) view.bookmarkBusy = false;
    }
  }

  function topicUrl() {
    return location.origin + '/forum/post/' + encodeURIComponent(view && view.topic ? view.topic.id : '');
  }

  async function sharePost() {
    const url = topicUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制到剪贴板');
    } catch (err) {
      // 剪贴板接口被拒时退化为临时 textarea
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      toast(ok ? '链接已复制到剪贴板' : '复制失败，请手动复制', ok ? 'ok' : 'err');
    }
  }

  function openOriginal() {
    if (!view || !view.topic) return;
    window.open('/forum/post/' + encodeURIComponent(view.topic.id), '_blank', 'noopener');
  }

  // ============================ 6.2 发表回复 ============================

  function growComposer(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, Math.max(56, ta.scrollHeight)) + 'px';
  }

  async function submitComment() {
    if (!view || !view.topic || view.commentBusy) return;
    if (aiBusy) { toast('AI 正在生成，等它写完再发送'); return; }
    const ta = root && root.querySelector('[data-role="composer"]');
    if (!ta) return;

    const markdown = ta.value.trim();
    if (!markdown) {
      ta.focus();
      toast('先写点内容再发送', 'err');
      return;
    }

    const topicId = view.topic.id;
    view.commentBusy = true;
    const btn = root.querySelector('[data-act="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.textContent = '发送中';
    }

    try {
      // 与站点回复编辑器一致的请求体：topicId + markdown，第 1 楼为主楼
      const res = await apiSend('/posts', 'POST', {
        topicId: topicId,
        markdown: markdown,
        replyToPostNumber: 1
      });

      ta.value = '';
      growComposer(ta);

      const status = res && (res.status || (res.submission && res.submission.status));
      if (status === 'PENDING' || status === 'PENDING_ADMIN_REVIEW') {
        toast('回复已提交，等待人工审核');
      } else if (status === 'REJECTED' || status === 'PROVIDER_FAILED' ||
                 status === 'PUBLICATION_FAILED') {
        toast('回复未通过审核，换个说法再试试', 'err');
      } else {
        toast('回复已发布');
        if (view && view.topic) {
          view.topic.replyCount = (Number(view.topic.replyCount) || 0) + 1;
          if (countEl) countEl.textContent = fmtCount(view.topic.replyCount);
          paintRail();
        }
      }
      if (view && view.topic) loadComments(topicId, view.sort, true);
    } catch (err) {
      let msg = err.message;
      if (err.status === 401) msg = '请先登录后再发表回复';
      else if (err.status === 403) msg = '当前账号暂时不能回复这个帖子';
      else if (err.status === 422) msg = '内容未通过校验或审核';
      toast('回复失败：' + msg, 'err');
    } finally {
      if (view) view.commentBusy = false;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.textContent = '回复';
      }
    }
  }

  /** 取评论纯文本，用于关键词筛选 */
  function plainText(html) {
    if (!html) return '';
    const box = document.createElement('div');
    box.innerHTML = html;
    return box.textContent || '';
  }

  function renderComments(topic, posts, mentionMap) {
    if (!countEl) return;
    countEl.textContent = fmtCount(topic.replyCount);

    const inner = root.querySelector('[data-role="comments-inner"]');
    if (!inner) return;

    if (!posts) {
      root.classList.add('is-side-error');
      return;
    }
    root.classList.remove('is-side-error');
    root.classList.add('is-side-loaded');

    const all = (posts.items || []).slice(0, COMMENT_LIMIT);
    const keyword = view && view.keyword ? view.keyword.toLowerCase() : '';
    const items = keyword ? all.filter((post) => {
      const name = (post.author && post.author.username) || '';
      return name.toLowerCase().indexOf(keyword) !== -1 ||
        plainText(post.cookedHtml).toLowerCase().indexOf(keyword) !== -1;
    }) : all;

    if (!items.length) {
      inner.innerHTML = '<div class="pco-comments-empty">' +
        (keyword ? '没有匹配「' + esc(view.keyword) + '」的回复' : '还没有回复，来抢沙发吧') +
      '</div>';
      return;
    }

    inner.innerHTML = items.map((post, index) => {
      const a = post.author || {};
      const body = post.deleted
        ? '<p class="pco-empty">这条回复已被删除</p>'
        : (post.cookedHtml || '');
      return '<article class="pco-comment" style="--i:' + index + '">' +
        avatarHtml(a, 'pco-avatar pco-avatar--sm') +
        '<div class="pco-comment-main">' +
          '<div class="pco-comment-head">' +
            '<span class="pco-comment-name">' + esc(a.username || '已删除用户') + '</span>' +
            badgeHtml(a, true) +
            '<span class="pco-comment-time">' + esc(timeAgo(post.createdAt)) + '</span>' +
          '</div>' +
          '<div class="pco-md pco-md--sm">' + body + '</div>' +
          '<div class="pco-comment-foot">' +
            '<span>' + icon('heart', 12) + esc(fmtCount(post.likeCount)) + '</span>' +
            (post.pinned ? '<span class="pco-comment-pin">置顶</span>' : '') +
            '<span class="pco-comment-no">#' + esc(post.postNumber || '') + '</span>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');

    localizeMentions(inner, mentionMap);
  }

  function showError() {
    if (!root) return;
    root.classList.add('is-error', 'is-side-error');
  }

  // ============================ 7. 关闭 ============================

  function clearTimers() {
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (backFallback) { clearTimeout(backFallback); backFallback = null; }
  }

  function cleanup() {
    clearTimers();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    // 关掉浮层时中止未完成的 AI 生成
    abortAi();
    if (aiPort) {
      try { aiPort.disconnect(); } catch (e) { /* noop */ }
      aiPort = null;
    }

    view = null;
    if (current && current.controller) {
      try { current.controller.abort(); } catch (e) { /* noop */ }
    }
    if (prefetchController) {
      try { prefetchController.abort(); } catch (e) { /* noop */ }
      prefetchController = null;
    }
    prefetching.clear();
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    shell = null;
    contentEl = null;
    countEl = null;
    current = null;
    closing = false;
    unlockScroll();
    resetPage();
  }

  function animateClose() {
    if (!root || closing) return;
    closing = true;
    clearTimers();
    closeLightbox();

    const reduce = reducedMotion();
    const link = current && current.link;
    const pageScale = pageScaleNow();
    const rawTarget = link && link.isConnected
      ? (link.closest('article') || link).getBoundingClientRect()
      : null;
    // 页面正在退回原尺寸：把缩放后的卡片位置反算成最终位置，浮层才能精准落回卡片
    const target = rawTarget ? unscaleRect(rawTarget, pageScale) : null;

    root.classList.remove('is-open');
    root.classList.add('is-closing');
    pageBackOut();

    if (shell) {
      if (target && !reduce) {
        const base = shell.getBoundingClientRect();
        const sx = Math.max(96, target.width) / base.width;
        const sy = Math.max(64, target.height) / base.height;
        const dx = (target.left + target.width / 2) - (base.left + base.width / 2);
        const dy = (target.top + target.height / 2) - (base.top + base.height / 2);
        shell.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')';
        shell.style.borderRadius = '14px';
        shell.style.opacity = '0.5';
      } else if (!reduce) {
        shell.style.transform = 'translateY(10px) scale(.985)';
        shell.style.opacity = '0';
      }
    }

    const focusTarget = restoreFocus;
    restoreFocus = null;

    closeTimer = setTimeout(cleanup, CLOSE_MS);

    // 关闭后把焦点还给原来那张卡片，键盘用户不会「掉出去」
    if (focusTarget && focusTarget.isConnected) {
      setTimeout(() => {
        try { focusTarget.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      }, 0);
    }
  }

  function requestClose() {
    if (!root || closing) return;
    // 有我们压入的历史记录时，让浏览器后退触发 popstate，
    // 这样历史栈保持干净，后退 / 关闭都走同一条关闭动画。
    if (current && current.pushed && history.state && history.state.pco) {
      try {
        history.back();
        backFallback = setTimeout(() => {
          backFallback = null;
          if (root) animateClose();
        }, 420);
        return;
      } catch (e) { /* noop */ }
    }
    animateClose();
  }

  // ============================ 8. 事件 ============================

  function onDocClick(e) {
    if (!e || e.defaultPrevented) return;
    if (!overlayEnabled) return;   // 未开启时完全交给站点原生跳转
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    let link = target.closest('a[href]');
    // 有些卡片只有标题是链接；点在封面 / 空白处时，把整张卡片也当作入口，
    // 但点赞、收藏等交互控件保持站点原行为。
    if (!link && !target.closest('button, [role="button"], input, textarea, select, summary')) {
      const card = target.closest('article[data-slot="root"]');
      if (card) link = card.querySelector('a[href*="/forum/post/"]');
    }
    if (!link) return;
    if (root && root.contains(link)) return;              // 浮层内部链接按站点原行为
    if ((link.getAttribute('target') || '').toLowerCase() === '_blank') return;
    if (link.hasAttribute('download')) return;
    if (!isFeedPage()) return;

    const topicId = postIdOf(link.href);
    if (!topicId) return;

    // 正在选词时不要抢走点击，避免打断复制
    const selection = window.getSelection && window.getSelection();
    if (selection && String(selection).trim()) return;

    e.preventDefault();
    e.stopPropagation();
    openPost(topicId, link);
  }

  function onRootClick(e) {
    if (!root) return;

    // 点浮层其他位置时收起菜单与编辑器弹层
    if (!e.target.closest('[data-role="rail-menu"]') && !e.target.closest('[data-act="more"]')) {
      closeRailMenu();
    }
    if (!e.target.closest('[data-role="tools"]')) closePops();

    // 正文 / 回复里的图片：铺开大图；已展开时点任意位置收起
    const zoomImg = e.target.closest('.pco-md img');
    if (zoomImg && imageZoomOn && !zoomImg.classList.contains('markdown-emoji')) {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(zoomImg);
      return;
    }
    if (e.target.closest('.pco-lightbox')) {
      e.preventDefault();
      closeLightbox();
      return;
    }

    const actEl = e.target.closest('[data-act]');
    if (actEl && root.contains(actEl)) {
      const act = actEl.getAttribute('data-act');

      // 点其他按钮时顺手收起「更多」菜单与编辑器弹层
      if (act !== 'more' && act.indexOf('more-') !== 0) closeRailMenu();
      if (act.indexOf('tool-') !== 0 && act !== 'emoji' && act !== 'image-insert' &&
          act.indexOf('ai-') !== 0) closePops();

      if (act === 'close') {
        e.preventDefault();
        // 双击卡片时，第二次点击常落在刚出现的遮罩上；短时间内的遮罩点击忽略，
        // 否则会「一打开就关掉」。
        if (actEl.classList.contains('pco-backdrop') &&
            current && Date.now() - current.openedAt < 300) return;
        requestClose();
      } else if (act === 'retry') {
        e.preventDefault();
        if (!current) return;
        root.classList.remove('is-error', 'is-side-error', 'is-loaded');
        loadTopic(current.id);
      } else if (act === 'like') {
        e.preventDefault();
        toggleLike();
      } else if (act === 'bookmark') {
        e.preventDefault();
        toggleBookmark();
      } else if (act === 'share') {
        e.preventDefault();
        sharePost();
      } else if (act === 'more') {
        e.preventDefault();
        toggleRailMenu();
      } else if (act === 'more-detail') {
        e.preventDefault();
        closeRailMenu();
        if (view && view.topic) location.assign('/forum/post/' + encodeURIComponent(view.topic.id));
      } else if (act === 'more-newtab') {
        e.preventDefault();
        closeRailMenu();
        openOriginal();
      } else if (act === 'more-copy') {
        e.preventDefault();
        closeRailMenu();
        sharePost();
      } else if (act === 'tool-more') {
        e.preventDefault();
        toggleExtraTools(actEl);
      } else if (act === 'tool-emoji' || act === 'tool-image' || act === 'tool-ai') {
        e.preventDefault();
        togglePop(act.slice(5));
      } else if (act === 'emoji') {
        e.preventDefault();
        insertAtCursor(actEl.getAttribute('data-emoji') || '');
      } else if (act === 'image-insert') {
        e.preventDefault();
        insertImage();
      } else if (act === 'fmt-bold') {
        e.preventDefault();
        wrapSelection('**', '**');
      } else if (act === 'fmt-italic') {
        e.preventDefault();
        wrapSelection('*', '*');
      } else if (act === 'fmt-code') {
        e.preventDefault();
        wrapSelection('`', '`');
      } else if (act === 'fmt-quote') {
        e.preventDefault();
        prefixLine('> ');
      } else if (act === 'fmt-list') {
        e.preventDefault();
        prefixLine('- ');
      } else if (act === 'fmt-link') {
        e.preventDefault();
        insertAtCursor('[文字](链接)');
      } else if (act === 'ai-write' || act === 'ai-polish') {
        e.preventDefault();
        runAi(act === 'ai-polish' ? 'polish' : 'write');
      } else if (act === 'ai-summary') {
        e.preventDefault();
        runSummary();
      } else if (act === 'comment') {
        e.preventDefault();
        focusComposer();
      } else if (act === 'submit') {
        e.preventDefault();
        submitComment();
      } else if (act === 'sort') {
        e.preventDefault();
        changeSort(actEl);
      } else if (act === 'prev') {
        e.preventDefault();
        goNeighbor(-1);
      } else if (act === 'next') {
        e.preventDefault();
        goNeighbor(1);
      }
      return;
    }

    // 点击遮罩空白处等同关闭
    if (e.target === root.querySelector('.pco-backdrop')) requestClose();
  }

  function onDocKeydown(e) {
    if (!root) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();   // 不让站点起始页 / 其他模块同时响应 Esc
    // 大图展开时 Esc 只收起大图，浮层保持打开
    if (root.querySelector('.pco-lightbox')) {
      closeLightbox();
      return;
    }
    requestClose();
  }

  function onPopState() {
    if (root && !closing) animateClose();
  }

  /** 操作栏「评论」：把焦点送进回复输入框 */
  function focusComposer() {
    const ta = root && root.querySelector('[data-role="composer"]');
    if (!ta) return;
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* noop */ }
  }

  // ---------------------------- 操作栏「更多」菜单 ----------------------------

  function toggleRailMenu() {
    if (!root) return;
    const menu = root.querySelector('[data-role="rail-menu"]');
    const btn = root.querySelector('[data-act="more"]');
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      const first = menu.querySelector('.pco-menu-item');
      if (first) first.focus({ preventScroll: true });
    }
  }

  function closeRailMenu() {
    if (!root) return;
    const menu = root.querySelector('[data-role="rail-menu"]');
    const btn = root.querySelector('[data-act="more"]');
    if (menu && !menu.hidden) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // ---------------------------- 回复编辑器工具 ----------------------------

  function composerInput() {
    return root && root.querySelector('[data-role="composer"]');
  }

  function toggleExtraTools(btn) {
    if (!root) return;
    const extra = root.querySelector('[data-role="extra-tools"]');
    if (!extra) return;
    extra.hidden = !extra.hidden;
    if (btn) btn.setAttribute('aria-expanded', extra.hidden ? 'false' : 'true');
  }

  function closePops() {
    if (!root) return;
    root.querySelectorAll('.pco-pop').forEach((pop) => { pop.hidden = true; });
    ['tool-emoji', 'tool-image', 'tool-ai'].forEach((act) => {
      const btn = root.querySelector('[data-act="' + act + '"]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function togglePop(name) {
    if (!root) return;
    const pop = root.querySelector('[data-role="' + name + '-pop"]');
    if (!pop) return;
    const willOpen = pop.hidden;
    closePops();
    pop.hidden = !willOpen;
    const btn = root.querySelector('[data-act="tool-' + name + '"]');
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen && name === 'image') {
      const input = pop.querySelector('[data-role="image-url"]');
      if (input) input.focus();
    }
  }

  /** 在光标处插入文本，插完把焦点还给输入框 */
  function insertAtCursor(text) {
    const ta = composerInput();
    if (!ta || !text) return;
    const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* noop */ }
    growComposer(ta);
  }

  /** 用 Markdown 记号包住选中内容；没有选中就插入占位文本 */
  function wrapSelection(before, after) {
    const ta = composerInput();
    if (!ta) return;
    const start = ta.selectionStart == null ? 0 : ta.selectionStart;
    const end = ta.selectionEnd == null ? start : ta.selectionEnd;
    const selected = ta.value.slice(start, end) || '文字';
    ta.value = ta.value.slice(0, start) + before + selected + after + ta.value.slice(end);
    ta.focus();
    try {
      ta.setSelectionRange(start + before.length, start + before.length + selected.length);
    } catch (e) { /* noop */ }
    growComposer(ta);
  }

  /** 在当前行行首加前缀，适用于引用与列表 */
  function prefixLine(prefix) {
    const ta = composerInput();
    if (!ta) return;
    const start = ta.selectionStart == null ? 0 : ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    ta.value = ta.value.slice(0, lineStart) + prefix + ta.value.slice(lineStart);
    ta.focus();
    const pos = start + prefix.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* noop */ }
    growComposer(ta);
  }

  function insertImage() {
    if (!root) return;
    const pop = root.querySelector('[data-role="image-pop"]');
    const input = pop && pop.querySelector('[data-role="image-url"]');
    const url = input ? input.value.trim() : '';
    if (!url) {
      toast('先填写图片链接', 'err');
      if (input) input.focus();
      return;
    }
    insertAtCursor('![图片](' + url + ')\n');
    if (input) input.value = '';
    if (pop) pop.hidden = true;
  }

  // ---------------------------- AI 助手 ----------------------------

  function loadAiConfig() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['pcai_config'], (raw) => {
        const saved = (raw && raw.pcai_config) || {};
        aiConfig = Object.assign(
          { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
          saved
        );
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  function ensureAiPort() {
    if (aiPort) return aiPort;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) return null;
      aiPort = chrome.runtime.connect({ name: 'pcai' });
    } catch (e) {
      aiPort = null;
      return null;
    }
    aiPort.onMessage.addListener((msg) => {
      const cb = aiPending;
      if (!cb || !msg || msg.id !== cb.id) return;
      if (msg.type === 'chunk') { if (cb.onChunk) cb.onChunk(msg.delta || ''); }
      else if (msg.type === 'done') { aiPending = null; if (cb.onDone) cb.onDone(msg); }
      else if (msg.type === 'error') { aiPending = null; if (cb.onError) cb.onError(msg); }
    });
    aiPort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      aiPort = null;
      const cb = aiPending;
      aiPending = null;
      if (cb && cb.onError) cb.onError({ message: 'AI 后台连接已断开，请重试' });
    });
    return aiPort;
  }

  function abortAi() {
    if (aiPending && aiPort) {
      try { aiPort.postMessage({ type: 'abort', id: aiPending.id }); } catch (e) { /* noop */ }
    }
    aiPending = null;
    aiBusy = false;
  }

  function setAiStatus(text) {
    const el = root && root.querySelector('[data-role="ai-status"]');
    if (el) el.textContent = text;
  }

  function aiMessages(kind, topic, draft) {
    if (kind === 'polish') {
      return [
        { role: 'system', content: '你是中文写作润色助手。用户会给出回复草稿，你只输出修改后的文本本身：' +
          '不要解释、不要对比、不要加前缀，也不要用代码围栏包裹。保持原意与事实不变，不要添加原文没有的信息；' +
          '保留 @提及、链接、代码与专有名词。' },
        { role: 'user', content: '修改要求：让表达更自然、信息更清楚，保持原有语气。\n\n草稿：\n' +
          draft.slice(0, 4000) }
      ];
    }
    const bodyText = plainText(topic.firstPost && topic.firstPost.cookedHtml).slice(0, 2500);
    return [
      { role: 'system', content: '你是 Pickcat 社区的回帖助手。根据用户给出的帖子标题与正文，写一条可以直接发布的中文回复。' +
        '只输出回复正文本身：不要开场白、解释或总结；不要编造帖子中不存在的事实；' +
        '语气像真实用户，自然、有信息量，不堆砌套话。' },
      { role: 'user', content: '帖子标题：' + (topic.title || '（无标题）') +
        '\n\n帖子正文：\n' + (bodyText || '（正文为空）') }
    ];
  }

  function runAi(kind) {
    if (!view || !view.topic || aiBusy) return;
    const ta = composerInput();
    if (!ta) return;

    const draft = ta.value.trim();
    if (kind === 'polish' && !draft) {
      toast('先写几句草稿再润色', 'err');
      ta.focus();
      return;
    }
    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama' && aiConfig.provider !== 'custom') {
      setAiStatus('还没有配置 API Key，请到扩展设置里填写模型与密钥');
      toast('请先在扩展设置里配置 AI 模型与密钥', 'err');
      return;
    }

    const port = ensureAiPort();
    if (!port) {
      setAiStatus('扩展后台不可用，请刷新页面后重试');
      return;
    }

    aiBusy = true;
    setAiStatus('生成中…');
    const id = 'o' + (++aiSeq);
    let acc = '';

    const commit = () => {
      if (!root) return;
      const text = acc.trim();
      if (text) {
        ta.value = text;
        growComposer(ta);
      }
    };

    aiPending = {
      id: id,
      onChunk: (delta) => {
        acc += delta;
        commit();
      },
      onDone: (msg) => {
        aiBusy = false;
        acc = (msg && msg.text) || acc;
        if (!acc.trim()) {
          setAiStatus('模型返回了空内容，请重试或更换模型');
          if (kind === 'polish' && draft) { ta.value = draft; growComposer(ta); }
        } else {
          commit();
          setAiStatus('已生成，可直接发送或再修改');
          ta.focus();
        }
      },
      onError: (err) => {
        aiBusy = false;
        const message = (err && err.message) || '生成失败，请重试';
        setAiStatus(message);
        toast(message, 'err');
        if (kind === 'polish' && draft) { ta.value = draft; growComposer(ta); }
      }
    };

    try {
      port.postMessage({ type: 'start', id: id, messages: aiMessages(kind, view.topic, draft),
        cacheKey: null, bypass: true });
    } catch (e) {
      aiPending = null;
      aiBusy = false;
      setAiStatus('AI 后台连接失败，请重试');
    }
  }

  // ---------------------------- AI 总结 ----------------------------

  /** 行内 Markdown：代码 / 链接 / 加粗 / 斜体（文本已转义） */
  function mdInline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
  }

  /** 轻量 Markdown 渲染（只用于 AI 总结输出，文本均先转义） */
  function mdRender(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const stack = [];   // 列表栈：{ tag: 'ul'|'ol', indent }

    const closeLists = (indent) => {
      while (stack.length && stack[stack.length - 1].indent > indent) {
        out.push('</' + stack.pop().tag + '>');
      }
    };
    const closeAll = () => closeLists(-1);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (!line.trim()) { closeAll(); continue; }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeAll(); out.push('<hr>'); continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeAll();
        const lv = Math.min(6, heading[1].length + 2);
        out.push('<h' + lv + '>' + mdInline(heading[2]) + '</h' + lv + '>');
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) { closeAll(); out.push('<blockquote>' + mdInline(quote[1]) + '</blockquote>'); continue; }

      const item = line.match(/^([ \t]*)([-*+•]|\d+[.)])\s+(.*)$/);
      if (item) {
        const indent = item[1].replace(/\t/g, '  ').length;
        const tag = /^\d/.test(item[2]) ? 'ol' : 'ul';
        closeLists(indent);
        const top = stack[stack.length - 1];
        if (!top || top.indent < indent || top.tag !== tag) {
          out.push('<' + tag + '>');
          stack.push({ tag: tag, indent: indent });
        }
        out.push('<li>' + mdInline(item[3]) + '</li>');
        continue;
      }

      closeAll();
      out.push('<p>' + mdInline(line) + '</p>');
    }
    closeAll();
    return out.join('');
  }

  function aiOut() {
    return root && root.querySelector('[data-role="ai-out"]');
  }

  /** 总结用的提示词：与 ai/content.js 的默认模板一致，优先使用设置里自定义的版本 */
  function summaryMessages(topic) {
    const cfg = aiConfig || {};
    const body = plainText(topic.firstPost && topic.firstPost.cookedHtml)
      .replace(/\n{3,}/g, '\n\n').trim();
    const content = body.length > SUM_MAX_CHARS
      ? body.slice(0, SUM_MAX_CHARS) + '\n……（正文过长，已截断）'
      : (body || '（正文为空）');

    const tpl = (cfg.userPrompt || '').trim() || SUM_PROMPT;
    const user = tpl
      .replace(/\{\{lang\}\}/g, SUM_LANG[cfg.lang] || '')
      .replace(/\{\{length\}\}/g, SUM_LENGTH[cfg.length] || '')
      .replace(/\{\{title\}\}/g, topic.title || '（无标题）')
      .replace(/\{\{author\}\}/g, (topic.author && topic.author.username) || '未知')
      .replace(/\{\{content\}\}/g, content);

    return [
      { role: 'system', content: (cfg.systemPrompt || '').trim() || SUM_SYSTEM },
      { role: 'user', content: user }
    ];
  }

  /** 在 AI 面板里流式生成帖子总结，结果只展示、不写入回复框 */
  function runSummary() {
    if (!view || !view.topic || aiBusy || !root) return;

    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama' && aiConfig.provider !== 'custom') {
      setAiStatus('还没有配置 API Key，请到扩展设置里填写模型与密钥');
      toast('请先在扩展设置里配置 AI 模型与密钥', 'err');
      return;
    }

    const port = ensureAiPort();
    if (!port) {
      setAiStatus('扩展后台不可用，请刷新页面后重试');
      return;
    }

    const pop = root.querySelector('[data-role="ai-pop"]');
    if (pop) pop.classList.add('is-summary');
    const out = aiOut();
    if (out) {
      out.hidden = false;
      out.innerHTML = '<p class="pco-ai-wait">正在阅读并总结…</p>';
    }

    aiBusy = true;
    setAiStatus('正在总结…');
    const id = 's' + (++aiSeq);
    let acc = '';

    const paint = () => {
      if (!out || !root) return;
      out.innerHTML = mdRender(acc) || '<p class="pco-ai-wait">正在阅读并总结…</p>';
    };

    aiPending = {
      id: id,
      onChunk: (delta) => {
        acc += delta;
        paint();
      },
      onDone: (msg) => {
        aiBusy = false;
        acc = (msg && msg.text) || acc;
        if (!acc.trim()) {
          setAiStatus('模型返回了空内容，请重试或更换模型');
        } else {
          paint();
          setAiStatus('总结完成，可再次点击重新生成');
        }
      },
      onError: (err) => {
        aiBusy = false;
        const message = (err && err.message) || '生成失败，请重试';
        setAiStatus(message);
        toast(message, 'err');
      }
    };

    try {
      port.postMessage({ type: 'start', id: id, messages: summaryMessages(view.topic),
        cacheKey: null, bypass: true });
    } catch (e) {
      aiPending = null;
      aiBusy = false;
      setAiStatus('AI 后台连接失败，请重试');
    }
  }

  /** 切换回复排序：先露出骨架，再按新排序加载 */
  function changeSort(btn) {
    if (!view || !view.topic || !root) return;
    const sort = btn.getAttribute('data-sort');
    if (!sort || sort === view.sort) return;
    view.sort = sort;
    paintSorts();
    root.classList.remove('is-side-loaded', 'is-side-error');
    loadComments(view.topic.id, sort);
  }

  function onRootInput(e) {
    if (!root || !view) return;
    const el = e.target;
    if (!el || !el.getAttribute) return;
    const role = el.getAttribute('data-role');
    if (role === 'filter') {
      view.keyword = el.value.trim();
      if (view.topic) {
        renderComments(view.topic, view.posts, buildMentionMap(view.topic, view.posts));
      }
    } else if (role === 'composer') {
      growComposer(el);
    }
  }

  function onRootKeydown(e) {
    if (!root || !view) return;
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-role') === 'composer') {
      e.preventDefault();
      submitComment();
    }
  }

  /** 工具条按钮不抢输入框焦点，保证「聚焦才显示」不会闪没 */
  function onRootMouseDown(e) {
    if (!root) return;
    const btn = e.target.closest && e.target.closest('.pco-composer-tools button');
    if (btn) e.preventDefault();
  }

  function bind() {
    root.addEventListener('click', onRootClick);
    root.addEventListener('input', onRootInput);
    root.addEventListener('keydown', onRootKeydown);
    root.addEventListener('mousedown', onRootMouseDown);
  }

  // ============================ 9. 开关 ============================

  /** 按设置显隐回复框工具条；关闭时整条移除（不占高度） */
  function syncComposerTools() {
    const tools = root && root.querySelector('[data-role="tools"]');
    if (!tools) return;
    tools.hidden = !composerToolsEnabled;
    if (!composerToolsEnabled) closePops();
  }

  /** 应用设置：关闭时立即收起已打开的浮层，之后的点击恢复站点跳转 */
  function applyOverlaySetting(cfg) {
    overlayEnabled = !(cfg && cfg.enabled === false);
    composerToolsEnabled = !!(cfg && cfg.composerTools);
    blurOn = !(cfg && cfg.blur === false);
    pageScaleOn = !(cfg && cfg.pageScale === false);

    if (!overlayEnabled && root) {
      cleanup();
      return;
    }

    syncComposerTools();
    if (root) {
      root.classList.toggle('pco-no-blur', !blurOn);
      if (pageScaleOn) pageBackIn();
      else pageBackOut();
    }
  }

  /** 站点外观：点击图片查看大图；关闭时立刻收起已展开的大图 */
  function applyImageZoom(value) {
    imageZoomOn = value !== false && value !== '0';
    if (!imageZoomOn) closeLightbox();
    if (root) root.classList.toggle('pco-no-zoom', !imageZoomOn);
  }

  function loadImageZoom() {
    try {
      chrome.storage.local.get(IMAGE_ZOOM_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        applyImageZoom(raw && raw[IMAGE_ZOOM_KEY]);
      });
    } catch (e) { /* 扩展上下文失效时保持默认开启 */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[IMAGE_ZOOM_KEY]) return;
      applyImageZoom(changes[IMAGE_ZOOM_KEY].newValue);
    });
  } catch (e) { /* noop */ }

  function loadOverlaySetting() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        applyOverlaySetting(raw && raw[SETTINGS_KEY]);
      });
    } catch (e) { /* 扩展上下文失效时沿用默认开启 */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      applyOverlaySetting(changes[SETTINGS_KEY].newValue);
    });
  } catch (e) { /* noop */ }

  // 只注册一次：捕获阶段先于站点路由与扩展其他模块
  loadOverlaySetting();
  loadImageZoom();
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('popstate', onPopState);
})();

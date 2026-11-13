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
  /** 浮层首屏展示的回复条数；点「查看所有评论」后在原地加载全部 */
  const COMMENT_LIMIT = 24;
  /** 一次加载全部评论时的上限，避免超大帖把浮层拖垮 */
  const COMMENT_ALL_MAX = 500;
  /** 接口是游标分页，逐页拉取时每页条数 */
  const COMMENT_PAGE = 60;
  /** 详情数据内存缓存：重复打开同一帖秒开 */
  const CACHE_TTL = 5 * 60 * 1000;
  /** 关闭动画时长（对齐 overlay.css：0.54s 位移结束 + 0.14s 交接淡出） */
  const CLOSE_MS = 720;
  /** 拖动关闭阈值：拖动超过该距离，或松手速度超过该值（px / ms）即关闭 */
  const DRAG_CLOSE_DISTANCE = 90;
  const DRAG_CLOSE_VELOCITY = 0.18;
  /** 设置键：浮窗模式默认开启，用户在设置里显式关闭后不再拦截帖子点击 */
  const SETTINGS_KEY = 'pco_config';
  /** 站点外观里的「点击图片查看大图」开关，与设置页保持同一个键 */
  const IMAGE_ZOOM_KEY = 'pcr_image_zoom';
  /** 文章目录的展开状态，跨帖子 / 跨会话记忆 */
  const TOC_KEY = 'pco_toc_open';
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
    arrowUp: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19.5V5m0 0l-6.2 6.2M12 5l6.2 6.2"/>',
    layout: '<rect x="3" y="4.5" width="18" height="6" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13.5" width="18" height="6" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/>',
    list: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M9 6h11M9 12h11M9 18h7"/><circle cx="4.6" cy="6" r="1.3" fill="currentColor"/><circle cx="4.6" cy="12" r="1.3" fill="currentColor"/><circle cx="4.6" cy="18" r="1.3" fill="currentColor"/>',
    width: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 12h16m0 0-4.2-4.2M20 12l-4.2 4.2M4 12l4.2-4.2M4 12l4.2 4.2"/>',
    full: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5"/>',
    cursor: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M9 4h6M12 4v16M9 20h6"/>',
    warning: '<path fill="currentColor" d="M11.741 16.966a1 1 0 0 1-.607-.466c-.439-.759.290-1.690 1.127-1.465c.254.068.475.237.607.466c.439.759-.290 1.690-1.127 1.465m-.707-8.224c.226-.843 1.396-.997 1.832-.242c.101.175.121.302.134.500v4.001c-.030.450-.288.844-.741.965c-.656.176-1.217-.326-1.259-.965V9ZM3.213 20.341c-1.104-.129-1.653-1.272-1.146-2.238l8.634-14.955c.414-.648 1.240-.953 1.951-.596c.274.138.482.338.647.596l8.634 14.955c.263.501.265 1.076-.040 1.560c-.276.437-.751.670-1.259.690H3.366Zm1.019-1.988h15.536L12 4.898Z"/>'
  };

  /**
   * 帖子编辑页（插件 content.js）工具栏的同一套 SVG。
   * 两个内容脚本不共享执行环境，这里原样复制 path；
   * 描边参数（fill=none / stroke-width 1.8 / 圆角端点）由 edIcon() 统一注入，
   * 保证浮层与帖子编辑页的图标笔画、尺寸、间距完全一致。
   */
  const ED_ICONS = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    color: '<path d="M5 19h14"/><path d="M8.6 15.5 12 6l3.4 9.5"/><path d="M9.8 12.4h4.4"/>',
    highlight: '<path d="M15.5 3.8 20.2 8.5 11 17.7H6.2v-4.8z"/><path d="M4 21h16"/>',
    ol: '<path d="M10 6h10M10 12h10M10 18h10"/><text x="2.5" y="9" font-size="7.5" fill="currentColor" stroke="none">1</text><text x="2.5" y="15" font-size="7.5" fill="currentColor" stroke="none">2</text>',
    ul: '<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="4.6" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
    task: '<rect x="3" y="4.5" width="6" height="6" rx="1.5"/><path d="m4.6 7.7 1.4 1.4 2-2.6"/><rect x="3" y="13.5" width="6" height="6" rx="1.5"/><path d="M12.5 7.5h8.5M12.5 16.5h8.5"/>',
    quote: '<path d="M7.5 8H5.5v4h3V8z" fill="currentColor" stroke="none"/><path d="M15.5 8h-2v4h3V8z" fill="currentColor" stroke="none"/><path d="M5.5 12c0 3 1.2 4.4 3 4.8"/><path d="M13.5 12c0 3 1.2 4.4 3 4.8"/>',
    code: '<path d="m9 8-5 4 5 4"/><path d="m15 8 5 4-5 4"/>',
    codeblock: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m9.5 9.5-2.5 2.5 2.5 2.5"/><path d="m14.5 9.5 2.5 2.5-2.5 2.5"/>',
    link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
    video: '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10.4 9.2 14.9 12l-4.5 2.8z" fill="currentColor" stroke="none"/>',
    hr: '<path d="M3 12h18"/><path d="M6.5 8.5v7M12 8.5v7M17.5 8.5v7" stroke-dasharray="1 2.5"/>',
    alignLeft: '<path d="M3 6h18M3 10h12M3 14h18M3 18h12"/>',
    alignCenter: '<path d="M3 6h18M6 10h12M3 14h18M6 18h12"/>',
    alignRight: '<path d="M3 6h18M9 10h12M3 14h18M9 18h12"/>',
    table: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4.5v15M15 4.5v15"/>',
    mathInline: '<path d="M4.5 8.5h5.5M7.25 8.5v7M4.5 15.5h5.5"/><path d="M14.5 9.5 18 15M18 9.5 14.5 15"/>',
    mathBlock: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M6.5 9.5h6M6.5 12.5h9M6.5 15.5h6"/>',
    clear: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="10.7" cy="10.7" r="6.1"/><path d="m15.3 15.3 4.3 4.3"/>'
  };

  /** 帖子编辑页风格的线条图标（与 icon() 的区别：默认描边而非填充） */
  function edIcon(name, size) {
    const px = size || 15;
    return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + (ED_ICONS[name] || '') + '</svg>';
  }

  // ============================ 1. 运行状态 ============================

  let root = null;              // #pco-root
  let shell = null;             // 浮层主卡片
  let contentEl = null;         // 左侧正文
  let countEl = null;           // 回复数
  let current = null;           // { id, link, rect, controller, pushed }
  let restoreFocus = null;      // 打开前的焦点元素
  let closing = false;
  let routeTimer = null;
  let closeTimer = null;
  let shellFadeTimer = null;      // 关闭动画末段：面板淡出、原卡片接手
  let toastTimer = null;
  let prefetchController = null;  // 相邻帖子预取专用，关闭浮层时统一中止
  let overlayEnabled = true;      // 浮窗模式开关（默认开启，可在设置里关闭）
  let composerToolsEnabled = false; // 回复框工具条（排版 / 表情 / 图片 / AI），默认关闭
  let blurOn = true;              // 遮罩毛玻璃效果（设置项，默认开启）
  let pageScaleOn = true;         // 背景页面同步缩放（设置项，默认开启）
  let animSpeed = 1;              // 动画速度倍率（设置项，1 为标准；越大越快）
  let cardTiltOn = false;         // 信息流卡片 3D 倾斜（设置项，默认关闭）
  let openTiltOn = true;          // 打开动画 3D 倾斜回正（设置项，默认开启）
  let lastPointer = null;         // 最近一次按下位置（视口坐标），用于判定倾斜方向
  let imageZoomOn = true;         // 点击图片查看大图（站点外观设置项，默认开启）
  let pageEl = null;              // 浮层背后的站点页面容器，打开时整体后退缩放
  let drag = null;                // 拖动横条的手势状态 { id, x0, y0, x, y, t, v, dx, dy }
  let pendingBack = false;        // 关闭动画结束后需要补发的一次 history.back
  let originCard = null;          // 当前帖子在信息流里的原始卡片，全程与浮层同步移动缩放
  let stage = null;               // 只做位移的舞台层，尺寸缩放交给浮层自身
  let wideOn = false;             // 加宽窗口（同一次会话内记忆）
  let fullOn = true;              // 全屏显示：默认全屏，用户手动退出后由 pco_config.fullscreen 记住
  let selectOn = false;           // 文本选中模式：默认关闭，禁止鼠标划选（同一次会话内记忆）
  let selectProbe = null;         // 正文拖选探测起点：用于在划选被拦截时给出一次提示
  let tocHeads = [];              // 当前正文里的标题节点，用于文章导航
  let tocFrame = 0;               // 滚动同步目录高亮的 rAF 句柄
  let tocActiveIdx = -1;          // 上次高亮的标题序号，用于判断是否需要滚动目录
  let tocScrollLock = 0;          // 目录平滑滚动期间的上锁时间，避免逐帧打断动画
  let tocOn = false;              // 文章目录的展开状态（chrome.storage.local 记忆）
  let tocOpenAnim = false;        // 浮层刚打开：首次恢复展开时播放宽度过渡（换帖时不重复播）

  /** 当前浮层的数据与交互状态；关闭时整体丢弃 */
  let view = null;

  /** 全屏回复编辑器：全屏层内的输入框是从原位置搬过去的，关闭时再放回 */
  let composerFull = false;
  let composerHome = null;        // 原回复框的父节点
  let composerAnchor = null;      // 原位置占位注释，退出全屏时按它插回去
  let composerAnimTimer = null;
  let composerPageOverflow = null; // 全屏时锁住页面滚动，退出时还原
  /** 打开表情/图片弹层前记录的光标位置，避免点按钮后光标被浏览器重置 */
  let insertPoint = null;
  /** 当前打开的表情 / 图片 / AI 弹层名，用于 fixed 定位与随窗口重排 */
  let openPopName = '';

  /** AI 助手：复用扩展后台的 pcai 端口（与帖子页 AI 回复同一套配置） */
  let aiPort = null;
  let aiPending = null;
  let aiSeq = 0;
  let aiBusy = false;
  let aiCommitFrame = 0;
  let aiPanelText = '';           // AI 助手面板里的流式文本
  let aiPanelBusy = false;        // 面板里的请求是否进行中
  let aiConfig = {
    aiEnabled: true, enabled: true, aiReply: true,
    provider: 'deepseek', model: 'deepseek-chat', apiKey: ''
  };

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

  /** 按用户设置的动画速度换算时长：speed > 1 更快，返回带 s 的合法 CSS 时长 */
  const sec = (base) => (base / animSpeed).toFixed(3) + 's';

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

  /** 开放接口 post.open 的页面范围：只认首页 / 站点信息流，不包含搜索页与个人主页 */
  function isApiFeedPage() {
    const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    return /^\/$|^\/forum(?:\/category\/[^/?#]+)?$/.test(path);
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

  /**
   * 用户 id → 用户名缓存。
   * 帖子数据里已经带出来的作者先写入缓存；没有的（比如正文里 @ 的第三方用户）
   * 再按 id 调 GET /users/{id} 补全，失败或查不到时退回 @短id，绝不留空。
   */
  const mentionNames = new Map();
  const mentionTried = new Set();     // 已确认取不到名字的 id，避免反复请求
  const mentionLoading = new Set();   // 正在请求中的 id
  const mentionQueue = [];            // 待请求队列
  let mentionWorkers = 0;             // 并发中的请求数
  const MENTION_CONCURRENCY = 4;      // 最多 4 个并发，避免一屏几十个 @ 打爆接口

  /** 用户对象取名字：username → nickname → displayName → name */
  function userName(user) {
    if (!user) return '';
    return String(
      user.username || user.nickname || user.displayName || user.name || user.display_name || ''
    ).trim();
  }

  /** 只有 id 时的兜底显示：截前 8 位，避免整段 uuid 撑破一行 */
  function shortMentionId(id) {
    const s = String(id || '');
    return s.length > 10 ? s.slice(0, 8) : s;
  }

  /** 把单个 @ 节点换成用户名；没有名字就显示 @短id，绝不留空 */
  function applyMentionName(node) {
    const id = node.getAttribute('data-user-id');
    if (!id) return;
    const hit = mentionNames.get(id);
    // 站点渲染结果自带 data-username 等属性时优先使用（同样是页面已有数据）
    const attrName = userName({
      username: node.getAttribute('data-username'),
      nickname: node.getAttribute('data-nickname'),
      displayName: node.getAttribute('data-display-name')
    });
    const name = (hit && hit.name) || attrName;
    const text = '@' + (name || shortMentionId(id));
    if (node.textContent !== text) node.textContent = text;
    node.setAttribute('title', name ? '@' + name : '用户 ' + id);
    if (!name) requestMentionName(id);
  }

  /** 名字补全后，把整层里同一个 id 的 @ 节点全部就地刷新（正文 / 评论 / 回复框） */
  function paintMentionName(id) {
    if (!root) return;
    root.querySelectorAll('span.markdown-user-mention[data-user-id]').forEach((node) => {
      if (node.getAttribute('data-user-id') === id) applyMentionName(node);
    });
  }

  /** 登记一个待补全的 id（去重），由队列按并发度逐个请求 */
  function requestMentionName(id) {
    if (!id || mentionNames.has(id) || mentionTried.has(id) || mentionLoading.has(id)) return;
    mentionLoading.add(id);
    mentionQueue.push(id);
    pumpMentionQueue();
  }

  function pumpMentionQueue() {
    while (mentionWorkers < MENTION_CONCURRENCY && mentionQueue.length) {
      const id = mentionQueue.shift();
      mentionWorkers += 1;
      apiSend('/users/' + encodeURIComponent(id), 'GET')
        .then((user) => {
          const name = userName(user);
          if (name) {
            mentionNames.set(id, { name: name });
            paintMentionName(id);
          } else {
            mentionTried.add(id);
          }
        })
        .catch(() => { mentionTried.add(id); })
        .finally(() => {
          mentionLoading.delete(id);
          mentionWorkers -= 1;
          pumpMentionQueue();
        });
    }
  }

  /** 把容器里的 @{uuid} 占位替换成用户名：正文、评论、回复编辑区共用这一处 */
  function localizeMentions(container, map) {
    if (!container) return;
    if (map) {
      Object.keys(map).forEach((id) => {
        const name = map[id];
        if (name && !mentionNames.has(id)) mentionNames.set(id, { name: name });
      });
    }
    container.querySelectorAll('span.markdown-user-mention[data-user-id]').forEach(applyMentionName);
  }

  function noteMentionUser(map, user) {
    const id = user && user.id;
    const name = userName(user);
    if (id && name) map[id] = name;
  }

  function buildMentionMap(topic, posts) {
    const map = {};
    if (topic) {
      noteMentionUser(map, topic.author);
      noteMentionUser(map, topic.firstPost && topic.firstPost.author);
    }
    ((posts && posts.items) || []).forEach((p) => {
      if (!p) return;
      noteMentionUser(map, p.author);
      noteMentionUser(map, p.replyToUser);
      noteMentionUser(map, p.replyTo && p.replyTo.author);
      noteMentionUser(map, p.parentPost && p.parentPost.author);
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

  const postsUrl = (topicId, sort, limit, cursor) =>
    '/api/v1/topics/' + encodeURIComponent(topicId) + '/posts?limit=' +
      (limit || COMMENT_LIMIT) + '&sort=' + sort +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');

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

  /** 游标分页把所有回复拉全：单页 60 条，直到没有下一页或触顶 */
  async function fetchAllPosts(topicId, sort, signal) {
    const seen = new Set();
    const items = [];
    let cursor = '';
    while (true) {
      const page = await fetchJson(postsUrl(topicId, sort, COMMENT_PAGE, cursor), signal);
      const list = (page && page.items) || [];
      list.forEach((post) => {
        const no = String(post.postNumber);
        if (seen.has(no)) return;
        seen.add(no);
        items.push(post);
      });
      const info = page && page.pageInfo;
      if (!info || !info.hasNextPage || !info.nextCursor) break;
      if (items.length >= COMMENT_ALL_MAX) break;
      cursor = info.nextCursor;
    }
    return { items: items };
  }

  /** 切换排序或刷新回复；force 为 true 时跳过缓存 */
  async function loadComments(topicId, sort, force) {
    if (!view || !view.topic || !root) return;
    const key = topicId + '|' + sort;
    const all = !!view.showAll;
    const cached = commentCache.get(key);
    // 缓存里只有首屏 24 条时，即使已展开全部也不能直接用它凑数
    const cachedEnough = cached && (!all || !!cached.all);
    if (!force && cached && cachedEnough && Date.now() - cached.at < CACHE_TTL) {
      applyPosts(view.topic, cached.posts);
      return;
    }

    const signal = current && current.controller && current.controller.signal;
    try {
      const posts = all
        ? await fetchAllPosts(topicId, sort, signal)
        : await fetchJson(postsUrl(topicId, sort, COMMENT_LIMIT), signal);
      if (!current || current.id !== topicId) return;
      commentCache.set(key, { posts: posts, at: Date.now(), all: all });
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

  /** 按 id 在整页找卡片链接：开放接口打开时 current 还不存在，不能复用 findFeedLink */
  function findFeedLinkAnywhere(topicId) {
    if (!topicId) return null;
    const links = document.querySelectorAll('a[href*="/forum/post/"]');
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

    return '<div class="pco-backdrop" data-act="close" aria-hidden="true"></div>' +
      '<div class="pco-stage">' +
      '<div class="pco-shell" role="dialog" aria-modal="true" aria-label="帖子预览" tabindex="-1">' +
        '<div class="pco-toc" id="pco-toc" data-role="toc">' +
          '<div class="pco-toc-head">文章目录</div>' +
          '<div class="pco-toc-list" data-role="toc-list"></div>' +
        '</div>' +
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
                '<div class="pco-composer-target" data-role="composer-target" hidden>' +
                  '<span>回复 <b data-role="composer-target-name"></b></span>' +
                  '<button type="button" class="pco-composer-target-x" data-act="reply-cancel">取消</button>' +
                '</div>' +
                '<div class="pco-composer-tools" data-role="tools">' +
                  '<div class="pco-tool-row">' +
                    '<button type="button" class="pco-tool pco-tool--text" data-act="tool-more" ' +
                      'title="展开更多排版功能" aria-expanded="false">Aa</button>' +
                    '<button type="button" class="pco-tool" data-act="tool-emoji" ' +
                      'title="插入表情" aria-expanded="false">' + icon('smile', 15) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="tool-image" ' +
                      'title="插入图片" aria-expanded="false">' + icon('image', 15) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="tool-ai" ' +
                      'title="AI 助手" aria-expanded="false">' + icon('sparkles', 15) + '</button>' +
                    '<button type="button" class="pco-tool pco-tool--full" data-act="composer-full" ' +
                      'title="全屏编辑" aria-label="全屏编辑" aria-expanded="false">' +
                      icon('full', 15) + '</button>' +
                  '</div>' +
                  '<div class="pco-tool-extra" data-role="extra-tools" hidden>' +
                    '<button type="button" class="pco-tool" data-act="fmt-bold" data-ed-cmd="bold" title="加粗">B</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-italic" data-ed-cmd="italic" title="斜体">I</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-strike" data-ed-cmd="strikeThrough" title="删除线">S</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-underline" data-ed-cmd="underline" title="下划线">U</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-quote" title="引用">' + edIcon('quote', 14) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-code" title="行内代码">' + edIcon('code', 14) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-link" title="链接">' + edIcon('link', 14) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-list" title="列表">' + edIcon('ul', 14) + '</button>' +
                    '<button type="button" class="pco-tool" data-act="fmt-task" title="待办">' + edIcon('task', 14) + '</button>' +
                  '</div>' +
                  // 全屏编辑器的完整排版工具栏：仅在浮层回复框全屏时显示
                  '<div class="pco-ed-toolbar" data-role="full-tools" aria-label="排版工具">' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-undo" title="撤销">' + edIcon('undo') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-redo" title="重做">' + edIcon('redo') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn pco-ed-btn--icon" data-act="fmt-bold" data-ed-cmd="bold" title="加粗"><b>B</b></button>' +
                      '<button type="button" class="pco-ed-btn pco-ed-btn--icon" data-act="fmt-italic" data-ed-cmd="italic" title="斜体"><i>I</i></button>' +
                      '<button type="button" class="pco-ed-btn pco-ed-btn--icon" data-act="fmt-strike" data-ed-cmd="strikeThrough" title="删除线"><s>S</s></button>' +
                      '<button type="button" class="pco-ed-btn pco-ed-btn--icon" data-act="fmt-underline" data-ed-cmd="underline" title="下划线"><u>U</u></button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-h1" data-ed-heading="1" title="一级标题">H1</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-h2" data-ed-heading="2" title="二级标题">H2</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-h3" data-ed-heading="3" title="三级标题">H3</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-h4" data-ed-heading="4" title="四级标题">H4</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-p" data-ed-heading="p" title="正文">¶</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-align-left" data-ed-align="left" title="左对齐">' + edIcon('alignLeft') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-align-center" data-ed-align="center" title="居中">' + edIcon('alignCenter') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-align-right" data-ed-align="right" title="右对齐">' + edIcon('alignRight') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-color" title="文字颜色">' + edIcon('color') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-highlight" title="背景高亮">' + edIcon('highlight') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="fmt-list" title="无序列表">' + edIcon('ul') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-ol" title="有序列表">' + edIcon('ol') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="fmt-task" title="待办列表">' + edIcon('task') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="fmt-quote" title="引用">' + edIcon('quote') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="fmt-code" title="行内代码">' + edIcon('code') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-codeblock" title="代码块">' + edIcon('codeblock') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="fmt-link" title="链接">' + edIcon('link') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-table" title="表格">' + edIcon('table') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-hr" title="分割线">' + edIcon('hr') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-math-inline" title="行内公式">' + edIcon('mathInline') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-math-block" title="块级公式">' + edIcon('mathBlock') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-video" title="插入哔哩哔哩视频">' + edIcon('video') + '</button>' +
                    '</div>' +
                    '<div class="pco-ed-group">' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-clear" title="清除格式">' + edIcon('clear') + '</button>' +
                      '<button type="button" class="pco-ed-btn" data-act="ed-find" title="查找替换">' + edIcon('search') + '</button>' +
                    '</div>' +
                  '</div>' +
                  '<div class="pco-pop pco-emoji-pop" data-role="emoji-pop" hidden>' +
                    '<div class="pco-emoji-head">' +
                      '<span>表情</span>' +
                      '<span class="pco-emoji-colname" data-role="emoji-colname"></span>' +
                    '</div>' +
                    '<div class="pco-emoji-cols">' +
                      '<button type="button" class="pco-emoji-colnav" data-act="emoji-col-prev" ' +
                        'title="上一页表情合集" aria-label="上一页表情合集">' + icon('chevronLeft', 14) + '</button>' +
                      '<div class="pco-emoji-cols-grid" data-role="emoji-cols"></div>' +
                      '<button type="button" class="pco-emoji-colnav" data-act="emoji-col-next" ' +
                        'title="下一页表情合集" aria-label="下一页表情合集">' + icon('chevronRight', 14) + '</button>' +
                    '</div>' +
                    '<div class="pco-emoji-grid" data-role="emoji-grid"></div>' +
                    '<div class="pco-emoji-state" data-role="emoji-state"></div>' +
                    '<div class="pco-emoji-foot">' +
                      '<button type="button" class="pco-emoji-pagebtn" data-act="emoji-prev" ' +
                        'title="上一页" aria-label="上一页">' + icon('chevronLeft', 13) + '</button>' +
                      '<span data-role="emoji-page">1 / 1</span>' +
                      '<button type="button" class="pco-emoji-pagebtn" data-act="emoji-next" ' +
                        'title="下一页" aria-label="下一页">' + icon('chevronRight', 13) + '</button>' +
                    '</div>' +
                  '</div>' +
                  '<div class="pco-pop pco-image-pop" data-role="image-pop" hidden>' +
                    '<div class="pco-image-head">' +
                      '<span>选择图片</span>' +
                      '<button type="button" class="pco-image-refresh" data-act="image-refresh" ' +
                        'title="刷新个人图盘">刷新</button>' +
                    '</div>' +
                    '<div class="pco-image-body" data-role="image-body">' +
                      '<div class="pco-image-grid" data-role="image-grid"></div>' +
                      '<button type="button" class="pco-image-more" data-act="image-more" ' +
                        'data-role="image-more" hidden>加载更多图片</button>' +
                      '<div class="pco-image-state" data-role="image-state"></div>' +
                    '</div>' +
                    '<div class="pco-image-foot">' +
                      '<button type="button" class="pco-image-btn" data-act="image-upload">选择本地图片</button>' +
                      '<input type="file" accept="image/*" data-role="image-file" hidden />' +
                      '<span class="pco-image-quota" data-role="image-quota"></span>' +
                      '<button type="button" class="pco-image-btn" data-act="image-cancel">取消</button>' +
                      '<button type="button" class="pco-image-btn pco-image-btn--primary" ' +
                        'data-act="image-confirm" disabled>插入图片</button>' +
                    '</div>' +
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
                '<div class="pco-editor" data-role="composer" contenteditable="true" ' +
                  'role="textbox" aria-multiline="true" data-placeholder="说说你的看法…" ' +
                  'aria-label="回复内容"></div>' +
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
            '<button type="button" class="pco-rail-btn" data-act="top" title="返回顶部" ' +
              'aria-label="返回顶部" disabled>' +
              icon('arrowUp', 18) +
            '</button>' +
            '<button type="button" class="pco-rail-btn" data-act="toc" title="文章目录" ' +
              'aria-label="文章目录" aria-expanded="false" aria-controls="pco-toc" hidden>' +
              icon('list', 18) +
            '</button>' +
            '<div class="pco-rail-menu" data-role="rail-menu" role="menu" hidden>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-detail">在详情页打开</button>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-newtab">在新标签页打开</button>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-copy">复制帖子链接</button>' +
              '<button type="button" class="pco-menu-item" role="menuitem" data-act="more-guide">功能引导</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pco-actions">' +
          '<button type="button" class="pco-icon-btn" data-act="select" title="文本选中模式" ' +
            'aria-label="文本选中模式" aria-pressed="false">' + icon('cursor', 17) + '</button>' +
          '<a class="pco-icon-btn" data-role="open" href="#" target="_blank" rel="noopener" ' +
            'title="在详情页打开" aria-label="在详情页打开">' + icon('external', 17) + '</a>' +
          '<button type="button" class="pco-icon-btn" data-act="wide" title="加宽窗口" ' +
            'aria-label="加宽窗口" aria-pressed="false">' + icon('width', 17) + '</button>' +
          '<button type="button" class="pco-icon-btn" data-act="full" title="全屏显示" ' +
            'aria-label="全屏显示" aria-pressed="false">' + icon('full', 17) + '</button>' +
          '<button type="button" class="pco-icon-btn pco-icon-btn--close" data-act="close" ' +
            'title="关闭（Esc）" aria-label="关闭">' + icon('close', 18) + '</button>' +
        '</div>' +
        '<div class="pco-grabber" data-role="grabber" title="向上拖动关闭帖子" aria-label="向上拖动关闭帖子">' +
          '<span></span>' +
        '</div>' +
      '</div>' +
      '</div>' +
      '<div class="pco-nav" role="group" aria-label="切换帖子">' +
        '<button type="button" class="pco-nav-btn" data-act="prev" title="上一个帖子" ' +
          'aria-label="上一个帖子" disabled>' + icon('chevronLeft', 22) + '</button>' +
        '<button type="button" class="pco-nav-btn" data-act="next" title="下一个帖子" ' +
          'aria-label="下一个帖子" disabled>' + icon('chevronRight', 22) + '</button>' +
      '</div>' +
      '<div class="pco-composer-full" data-role="composer-full" hidden>' +
        '<div class="pco-cf-head">' +
          '<div class="pco-cf-title">' +
            '<b data-role="cf-target">写回复</b>' +
            '<span class="pco-cf-topic" data-role="cf-topic"></span>' +
          '</div>' +
          '<span class="pco-cf-count" data-role="cf-count">0 字</span>' +
          '<button type="button" class="pco-cf-layout" data-act="composer-layout" ' +
            'title="工具栏布局：紧凑（点击切换）" aria-label="切换工具栏布局">' +
            icon('layout', 16) + '</button>' +
          '<button type="button" class="pco-cf-exit" data-act="composer-full-exit">' +
            icon('close', 16) + '<span>退出全屏</span>' +
          '</button>' +
        '</div>' +
        '<div class="pco-cf-body" data-role="cf-body"></div>' +
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

  // ---------- 开合动画的“落定”时序 ----------
  /**
   * 开合动画期间只允许动画 transform / opacity：
   * 毛玻璃、嵌入内容（iframe / video）都等落定后再启用或加载，
   * 避免在缩放帧里做整屏模糊采样和嵌入文档初始化。
   */
  const OPEN_SETTLE_MS = 560;
  let settleTimer = null;
  let settleTasks = [];

  /** 落定后执行；已经落定时立即执行 */
  function whenSettled(fn) {
    if (!root) return;
    if (root.classList.contains('is-settled')) { fn(); return; }
    settleTasks.push(fn);
  }

  function flushSettleTasks() {
    const tasks = settleTasks;
    settleTasks = [];
    tasks.forEach((fn) => {
      try { fn(); } catch (e) { /* noop */ }
    });
  }

  function settleOverlay() {
    if (!root) return;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    restoreHeavyMedia();
    if (pageEl) pageEl.style.willChange = '';
    root.classList.remove('is-animating');
    root.classList.add('is-settled');
    flushSettleTasks();
    // 落定时统一重算两侧切换按钮：禁用态（首帖 / 末帖）与贴边位置都按「此刻」的
    // 相邻列表和最终尺寸决定。build() 里那次 paintNav / paintNavOffset 发生在
    // 动画开始前，首次打开时相邻列表与舞台尺寸都可能还没稳定，只算一次会让
    // 首开停在错误状态；放到落定点后每次打开（含重开）走的是同一条路径。
    paintNav();
    paintNavOffset();
    // 落定后才通知引导层：引导只在该状态之后挂载 DOM，避免参与开合动画
    guideNotify('overlay-settled', { composerTools: composerToolsEnabled });
  }

  /** 与新手引导（guide/guide.js）的唯一通信方式：自定义事件，不互相引用内部变量 */
  function guideNotify(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('pco-guide:' + name, { detail: detail || {} }));
    } catch (e) { /* noop */ }
  }

  function scheduleSettle() {
    if (!root) return;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    settleTimer = setTimeout(settleOverlay, Math.max(0, Math.round(OPEN_SETTLE_MS / animSpeed)));
  }

  // ---------- 背景页面的前后景缩放 ----------

  /** 以当前视口中心为原点后退一小步，让浮层与页面之间产生空间层次 */
  function pageBackIn() {
    if (!pageEl || !pageScaleOn || reducedMotion()) return;
    const box = pageEl.getBoundingClientRect();
    const ox = Math.round(window.innerWidth / 2 - box.left);
    const oy = Math.round(window.innerHeight / 2 - box.top);
    // 只动 transform：对整页做 filter 动画会逐帧重新合成整页，是开合掉帧的主要来源
    pageEl.style.transition = 'transform ' + sec(0.4) + ' cubic-bezier(0.32, 1.24, 0.44, 1)';
    pageEl.style.transformOrigin = ox + 'px ' + oy + 'px';
    pageEl.style.transform = 'scale(' + PAGE_SCALE + ')';
    pageEl.style.willChange = 'transform';
  }

  function pageBackOut() {
    if (!pageEl) return;
    pageEl.style.transform = '';
    pageEl.style.filter = '';
    pageEl.style.willChange = '';
  }

  function resetPage() {
    if (!pageEl) return;
    pageEl.style.transition = '';
    pageEl.style.transformOrigin = '';
    pageEl.style.transform = '';
    pageEl.style.filter = '';
    pageEl.style.willChange = '';
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

  function build(rect) {
    root = document.createElement('div');
    root.id = 'pco-root';
    root.innerHTML = shellTemplate();
    // 表情 / 图片 / AI 弹层改用 fixed 定位，必须脱离 .pco-shell 的 overflow 裁剪，
    // 所以统一挂到 #pco-root 下：root 自身不裁剪，且继续继承 --pco-* 设计令牌
    ['emoji', 'image', 'ai'].forEach((name) => {
      const pop = root.querySelector('[data-role="' + name + '-pop"]');
      if (pop) root.appendChild(pop);
    });
    mountRailAi();
    applyAiAvailability();
    root.style.setProperty('--pco-dur', String(1 / animSpeed));
    if (!blurOn) root.classList.add('pco-no-blur');
    if (!imageZoomOn) root.classList.add('pco-no-zoom');
    // 全屏与加宽都是会话级偏好，重开浮层时恢复
    if (fullOn) root.classList.add('is-full');
    // 目录不再在挂载时提前展开：此时标题还没扫，展开只会露出一个空侧栏。
    // 统一等 buildToc 确认标题数量足够后，再恢复上次的展开状态；
    // 但这一次恢复要走宽度过渡（tocOpenAnim），不能直接落位，否则有目录的帖子会瞬变。
    tocOpenAnim = true;
    document.body.appendChild(root);
    lockScroll();
    initComposerEditor();

    // 站点是 Nuxt 应用，整页内容都在 #__nuxt 里；浮层挂在 body 下，不受这层缩放影响
    pageEl = document.getElementById('__nuxt');

    shell = root.querySelector('.pco-shell');
    stage = root.querySelector('.pco-stage');
    if (wideOn) root.classList.add('is-wide');
    if (selectOn) root.classList.add('is-select');
    paintNavOffset();
    contentEl = root.querySelector('[data-role="content"]');
    countEl = root.querySelector('[data-role="count"]');
    syncComposerTools();
    paintViewControls();
    const scrollBox = root.querySelector('[data-role="scroll"]');
    if (scrollBox) scrollBox.addEventListener('scroll', onContentScroll, { passive: true });

    // 先把最终尺寸量出来，再倒推初始状态，保证卡片原位「长」成浮层
    const last = shell.getBoundingClientRect();
    const first = rect || { left: last.left, top: last.top, width: 0, height: 0 };
    const reduce = reducedMotion();

    adoptOriginCard(current && current.id, false);

    const animate = !reduce && last.width > 0 && last.height > 0 &&
      first.width > 0 && first.height > 0;

    // 只要不是减弱动效，就有 0.46–0.52s 的缩放/位移；
    // 期间只允许 transform/opacity，毛玻璃与嵌入内容留到落定后
    const animating = !reduce;
    if (animating) root.classList.add('is-animating');

    if (animate) {
      // 位移层把浮层中心从屏幕中心搬到卡片中心
      const dx = (first.left + first.width / 2) - (last.left + last.width / 2);
      const dy = (first.top + first.height / 2) - (last.top + last.height / 2);
      // 尺寸交给 scale：从卡片大小拉伸到浮层大小（起始严格等于卡片，不做下限钳制）
      const sx0 = Math.max(0.04, first.width / last.width);
      const sy0 = Math.max(0.04, first.height / last.height);
      // 3D 倾斜回正：面板从点击所在侧倾斜展开后回正（模仿 iOS 27 APP 打开）。
      // 方向以「点击点相对卡片中心的位置」为准：点卡片左侧 → 面板左侧近，点右侧 → 右侧近。
      // 幅度固定：用归一化方向向量 × 固定角度，避免中间弱、四周强。
      let tiltTf = '';
      if (openTiltOn) {
        const anchorEl = (current && current.link) || null;
        const ar = anchorEl ? anchorEl.getBoundingClientRect() : first;
        const cw = Math.max(ar.width || first.width, 1);
        const ch = Math.max(ar.height || first.height, 1);
        // 优先用真实点击坐标，没有则退回到卡片中心
        const cx = lastPointer ? lastPointer.x : ar.left + cw / 2;
        const cy = lastPointer ? lastPointer.y : ar.top + ch / 2;
        // 点击点相对卡片中心的归一化位置，限制在 [-0.5, 0.5]
        const nx = Math.max(-0.5, Math.min(0.5, (cx - (ar.left + cw / 2)) / cw));
        const ny = Math.max(-0.5, Math.min(0.5, (cy - (ar.top + ch / 2)) / ch));
        const AMP_X = 11;
        const AMP_Y = 13;
        let rx = 5, ry = 0; // 默认：正中间点击时顶部略近，保留 3D 体感
        const len = Math.hypot(nx, ny);
        if (len > 0.015) {
          const ux = nx / len;
          const uy = ny / len;
          rx = -uy * AMP_X;  // 点上方→顶部近；点下方→底部近
          ry = ux * AMP_Y;    // 点左侧→左侧近；点右侧→右侧近
        }
        tiltTf = ' rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
        // 透视点跟随卡片中心：避免从视口中心看偏移面板时方向被透视扭曲
        root.style.perspectiveOrigin = (ar.left + cw / 2).toFixed(1) + 'px 50%';
      }

      stage.style.transition = 'none';
      shell.style.transition = 'none';

      stage.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)' + tiltTf;
      shell.style.transform = 'scale(' + sx0 + ', ' + sy0 + ')';
      // 原始卡片同步长向浮层：与浮层同向移动缩放，淡出交给后面的 rAF
      if (originCard && originCard.isConnected) {
        originCard.style.transition = 'none';
        originCard.style.transformOrigin = '50% 50%';
        originCard.style.willChange = 'transform, opacity';
      }
    } else {
      stage.style.transform = reduce ? 'none' : 'translateY(10px)';
      if (!reduce) shell.style.transform = 'scale(0.985)';
    }

    void shell.offsetWidth;
    stage.style.transition = '';
    shell.style.transition = '';

    requestAnimationFrame(() => {
      // 极端情况下开启动画还没起跑就被关闭打断：交给关闭动画，别再清内联值
      if (!root || !stage || !shell || closing) return;
      root.classList.add('is-open');
      pageBackIn();
      root.style.perspectiveOrigin = '';
      stage.style.transform = '';
      shell.style.transform = '';

      if (animate && originCard && originCard.isConnected) {
        // 卡片跟随浮层移动缩放（内联 var() 解析不到，这里写字面量曲线）。
        // 放大比例必须与浮层起始的 scale 严格一致，两者才能在起始帧完全重合。
        const gsx = Math.max(0.04, first.width / last.width);
        const gsy = Math.max(0.04, first.height / last.height);
        const dx = (last.left + last.width / 2) - (first.left + first.width / 2);
        const dy = (last.top + last.height / 2) - (first.top + first.height / 2);
        originCard.style.transition =
          'transform ' + sec(0.52) + ' cubic-bezier(0.16, 1.06, 0.32, 1), opacity ' + sec(0.16) + ' ease';
        originCard.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) ' +
          'scale(' + (1 / gsx) + ', ' + (1 / gsy) + ')';
        originCard.style.opacity = '0';
      }

      // 动画落定后再启用毛玻璃、恢复 iframe / video，并执行延后的布局任务
      if (animating) scheduleSettle();
      else settleOverlay();
    });

    // 首帧把焦点交给关闭按钮，Esc 与键盘用户都能立刻操作
    setTimeout(() => {
      if (!root) return;
      const btn = root.querySelector('.pco-icon-btn--close');
      if (btn) btn.focus({ preventScroll: true });
    }, 140);
  }

  /** 没有卡片可量时，从视口中央给一个合理起始矩形，保证开合动画仍有空间感 */
  function centerOpenRect() {
    const width = Math.max(280, Math.min(520, window.innerWidth * 0.36));
    const height = Math.max(200, Math.min(340, window.innerHeight * 0.34));
    return {
      top: (window.innerHeight - height) / 2,
      left: (window.innerWidth - width) / 2,
      width,
      height
    };
  }

  function openPost(topicId, link) {
    if (!topicId) return;
    // 上一条浮层还在退场时又点了卡片：直接接管，沿用它占用的那条历史记录，
    // 这样这一下点击不会被丢掉，历史里也不会多堆一条
    let reuseEntry = false;
    if (closing) {
      reuseEntry = !!(history.state && history.state.pco);
      cleanup(true);
    }
    if (root) cleanup();

    // 开放接口按 id 打开时没有卡片链接：用视口中央矩形兜底，不能依赖 link 非空
    const card = link ? (link.closest('article') || link) : null;
    if (card) clearCardTilt(card);  // 摘掉悬停倾斜，保证量到未变形的矩形
    const rect = card ? card.getBoundingClientRect() : centerOpenRect();

    restoreFocus = document.activeElement;
    view = {
      topic: null,
      posts: null,
      sort: 'hot',
      keyword: '',
      showAll: false,
      liked: false,
      likeCount: 0,
      bookmarkId: null,
      likeBusy: false,
      bookmarkBusy: false,
      commentBusy: false,
      commentLikeBusy: new Set(),
      replyTo: null
    };
    current = {
      id: topicId,
      link: link,
      scope: null,
      list: [],
      controller: null,
      pushed: false
    };
    try { current.controller = new AbortController(); } catch (e) { current.controller = null; }

    // 记录打开时所在栏目（关注 / 推荐 / 最新 / 板块）的有序列表，供左右切换
    current.scope = resolveFeedScope(link);
    const ids = collectFeedIds(current.scope || document.body);
    current.list = ids.indexOf(topicId) === -1 ? ids.concat([topicId]) : ids;
    try { prefetchController = new AbortController(); } catch (e) { prefetchController = null; }

    build(rect);
    bind();
    setOpenLinks(topicId);
    paintNav();
    loadAiConfig();

    // 记一条与当前 URL 相同的历史：后退键能无缝关闭，而不是离开页面
    try {
      if (reuseEntry) history.replaceState({ pco: true, id: topicId }, '', location.href);
      else history.pushState({ pco: true, id: topicId }, '', location.href);
      current.pushed = true;
    } catch (e) { current.pushed = false; }

    loadTopic(topicId);
    // 相邻帖预取放到动画落定后，避免 JSON 解析和首帧动画抢主线程
    whenSettled(prefetchNeighbors);

    routeTimer = setInterval(() => {
      if (root && !isFeedPage()) cleanup();
    }, 800);
  }

  /** 开放接口：按 id 打开浮层；非信息流页静默失败（只回 ACK，不弹提示） */
  function openPostById(topicId) {
    if (!topicId) return { ok: false, code: 'BAD_REQUEST', message: '缺少 postId' };
    if (!isApiFeedPage()) return { ok: false, code: 'UNSUPPORTED_CONTEXT', message: '仅信息流页可用' };
    if (!overlayEnabled) return { ok: false, code: 'OVERLAY_DISABLED', message: '浮窗模式已关闭' };
    try {
      openPost(topicId, findFeedLinkAnywhere(topicId));
      return { ok: true, code: 'OK', data: { opened: true, postId: topicId } };
    } catch (e) {
      return { ok: false, code: 'INTERNAL', message: String((e && e.message) || e) };
    }
  }

  // ============================ 6. 渲染 ============================

  /** 主题数据到手：记录状态、渲染正文、刷新操作栏 */
  function applyTopic(topic) {
    if (!root || !topic || !view) return;
    // 先清掉上一帖的目录，避免新帖正文还在骨架屏时露出旧目录或空目录
    resetToc();
    const first = topic.firstPost || {};
    view.topic = topic;
    view.liked = !!(first.viewerState && first.viewerState.liked);
    view.likeCount = Number(first.likeCount != null ? first.likeCount : topic.likeCount) || 0;
    view.bookmarkId = (topic.viewerState && topic.viewerState.bookmarkId) || null;

    // 含图片 / 视频 / 作品嵌入的正文等动画落定后再插入：
    // 动画期间保留骨架占位，避免整层缩放时解码图片、初始化 iframe
    const heavy = isHeavyHtml(first.cookedHtml);
    if (heavy && root.classList.contains('is-animating') && !root.classList.contains('is-settled')) {
      if (!view.pendingHeavy) {
        view.pendingHeavy = true;
        whenSettled(() => {
          if (!root || !view || view.topic !== topic) return;
          view.pendingHeavy = false;
          renderTopic(topic);
          paintRail();
        });
      }
      paintRail();
      return;
    }

    renderTopic(topic);
    paintRail();
  }

  function applyPosts(topic, posts) {
    if (!root || !view || !topic) return;
    view.posts = posts || null;
    // 回复里带图片 / 嵌入时同样推迟到动画结束，避免侧栏内容在缩放帧里重排
    const heavy = !!posts && (posts.items || []).some((p) => isHeavyHtml(p && p.cookedHtml));
    if (heavy && root.classList.contains('is-animating') && !root.classList.contains('is-settled')) {
      if (!view.pendingPosts) {
        view.pendingPosts = true;
        whenSettled(() => {
          if (!root || !view || view.posts !== posts) return;
          view.pendingPosts = false;
          renderComments(topic, posts, buildMentionMap(topic, posts));
        });
      }
      return;
    }
    renderComments(topic, posts, buildMentionMap(topic, posts));
  }

  // ---------- 动画期间暂缓嵌入内容 ----------
  let deferredMedia = [];

  /** 正文 / 回复里是否有真正吃性能的媒体（行内表情是小图，不算） */
  function isHeavyHtml(html) {
    const s = String(html || '');
    if (/<(?:iframe|video)\b/i.test(s)) return true;
    return /<img\b(?![^>]*markdown-emoji)/i.test(s);
  }

  /** 开合动画期间先摘掉 iframe / video 的 src（保留尺寸占位），落定后再恢复 */
  function deferHeavyMedia(container) {
    if (!container || !root || root.classList.contains('is-settled')) return;
    container.querySelectorAll('iframe[src], video[src]').forEach((el) => {
      const src = el.getAttribute('src');
      if (!src) return;
      el.setAttribute('data-pco-src', src);
      el.setAttribute('data-pco-deferred', '1');
      el.removeAttribute('src');
      deferredMedia.push(el);
    });
    container.querySelectorAll('video source[src]').forEach((source) => {
      const src = source.getAttribute('src');
      if (!src) return;
      source.setAttribute('data-pco-src', src);
      source.removeAttribute('src');
      const video = source.closest('video');
      if (video) video.setAttribute('data-pco-deferred', '1');
    });
  }

  function restoreHeavyMedia() {
    const list = deferredMedia;
    deferredMedia = [];
    list.forEach((el) => {
      if (!el || !el.isConnected) return;
      const src = el.getAttribute('data-pco-src');
      if (src) el.setAttribute('src', src);
      el.removeAttribute('data-pco-src');
      el.removeAttribute('data-pco-deferred');
      el.querySelectorAll('source[data-pco-src]').forEach((source) => {
        source.setAttribute('src', source.getAttribute('data-pco-src'));
        source.removeAttribute('data-pco-src');
      });
    });
  }

  // ---------- 视频门面：先渲染等尺寸占位层，点击后才注入真实媒体 ----------

  const MEDIA_LABEL_RULES = [
    { test: /bilibili\.com|b23\.tv/i, label: '哔哩哔哩视频' },
    { test: /youtube\.com|youtu\.be/i, label: 'YouTube 视频' },
    { test: /codemao/i, label: '作品演示' }
  ];

  function mediaLabelFor(src) {
    const s = String(src || '');
    for (let i = 0; i < MEDIA_LABEL_RULES.length; i++) {
      if (MEDIA_LABEL_RULES[i].test.test(s)) return MEDIA_LABEL_RULES[i].label;
    }
    return '视频';
  }

  /** 记下真实媒体的地址与属性，但不留在 DOM 里，避免提前发起请求 */
  function captureMediaMeta(el) {
    const attr = (name) => el.getAttribute(name) || '';
    if (el.tagName === 'IFRAME') {
      const src = attr('src') || attr('data-src');
      return {
        kind: 'iframe',
        src: src,
        label: attr('title') || mediaLabelFor(src),
        title: attr('title'),
        allow: attr('allow')
      };
    }
    if (el.tagName === 'VIDEO') {
      const src = attr('src') || attr('data-src');
      const sources = Array.prototype.map.call(el.querySelectorAll('source'), (source) => ({
        src: source.getAttribute('src') || source.getAttribute('data-src') || '',
        type: source.getAttribute('type') || ''
      })).filter((item) => item.src);
      return {
        kind: 'video',
        src: src,
        sources: sources,
        label: attr('title') || mediaLabelFor(src || (sources[0] && sources[0].src)),
        poster: attr('poster') || attr('data-poster'),
        loop: el.hasAttribute('loop'),
        muted: el.hasAttribute('muted')
      };
    }
    return null;
  }

  /**
   * 解析 HTML 前就把 iframe / video / source 的地址挪到 data-src、poster 挪到 data-poster。
   * 离屏容器里的媒体虽然还没插入文档，但 video 一旦带 src 仍可能开始预取，
   * 这里从字符串层面保证占位阶段一个媒体请求都不会发出。
   */
  function stripMediaSources(html) {
    return String(html || '').replace(/<(?:iframe|video|source)\b[^>]*>/gi, (tag) => {
      let out = tag
        .replace(/\sposter\s*=\s*"([\s\S]*?)"/i, ' data-poster="$1"')
        .replace(/\sposter\s*=\s*'([\s\S]*?)'/i, " data-poster='$1'")
        .replace(/\sposter\s*=\s*([^\s>"']+)/i, ' data-poster=$1');

      // 已有 data-src 时只摘掉 src，避免覆盖已记录的地址
      if (/\sdata-src\s*=/i.test(out)) {
        return out
          .replace(/\ssrc\s*=\s*"[^"]*"/i, '')
          .replace(/\ssrc\s*=\s*'[^']*'/i, '')
          .replace(/\ssrc\s*=\s*[^\s>"']+/i, '');
      }
      return out
        .replace(/\ssrc\s*=\s*"([\s\S]*?)"/i, ' data-src="$1"')
        .replace(/\ssrc\s*=\s*'([\s\S]*?)'/i, " data-src='$1'")
        .replace(/\ssrc\s*=\s*([^\s>"']+)/i, ' data-src=$1');
    });
  }

  function buildMediaHost(meta) {
    const host = document.createElement('div');
    host.className = 'pco-media-host';
    host.setAttribute('data-pco-media', '1');
    host.__pcoMeta = meta;
    const facade = document.createElement('button');
    facade.type = 'button';
    facade.className = 'pco-media-facade';
    facade.setAttribute('aria-label', '播放' + (meta.label || '视频'));
    facade.innerHTML =
      '<span class="pco-media-play">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
          '<path fill="currentColor" d="M8.5 5.2v13.6L19 12z"/>' +
        '</svg>' +
      '</span>' +
      '<span class="pco-media-label"></span>' +
      '<span class="pco-media-spinner" hidden></span>';
    facade.querySelector('.pco-media-label').textContent = meta.label || '视频';
    facade.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      armMedia(host);
    });
    host.appendChild(facade);
    return host;
  }

  /** 点击占位层：注入真实 iframe / video 并自动播放，加载中显示转圈 */
  function armMedia(host) {
    if (!host || host.classList.contains('is-armed')) return;
    const meta = host.__pcoMeta;
    if (!meta) return;
    host.classList.add('is-armed');

    const facade = host.querySelector('.pco-media-facade');
    if (facade) {
      facade.disabled = true;
      facade.classList.add('is-loading');
      const spinner = facade.querySelector('.pco-media-spinner');
      if (spinner) spinner.hidden = false;
    }
    const ready = () => {
      if (!host.isConnected) return;
      host.classList.add('is-ready');
      if (facade && facade.parentNode) facade.parentNode.removeChild(facade);
      host.__pcoMeta = null;
    };

    if (meta.kind === 'iframe') {
      const frame = document.createElement('iframe');
      frame.className = 'pco-media-frame';
      frame.setAttribute('data-pco-injected', '1');
      // allow 里已含 fullscreen 时不再重复写 allowfullscreen，避免 Chrome 告警
      if (meta.allow) frame.setAttribute('allow', meta.allow);
      else frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('scrolling', 'no');
      frame.setAttribute('frameborder', '0');
      frame.setAttribute('title', meta.title || meta.label || '视频');
      frame.addEventListener('load', ready, { once: true });
      frame.src = meta.src;
      host.appendChild(frame);
      return;
    }

    const video = document.createElement('video');
    video.className = 'pco-media-frame';
    video.setAttribute('data-pco-injected', '1');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    if (meta.loop) video.loop = true;
    if (meta.muted) video.muted = true;
    if (meta.poster) video.setAttribute('poster', meta.poster);
    if (meta.src) video.src = meta.src;
    (meta.sources || []).forEach((item) => {
      const source = document.createElement('source');
      source.src = item.src;
      if (item.type) source.type = item.type;
      video.appendChild(source);
    });
    video.addEventListener('loadeddata', ready, { once: true });
    video.addEventListener('error', ready, { once: true });
    host.appendChild(video);
    try {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦截时保留控件 */ });
    } catch (e) { /* noop */ }
  }

  /** 在离屏容器里把 iframe / video 换成等尺寸占位层，再插入页面，全程不触发媒体请求 */
  function prepareVideoFacades(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('iframe, video').forEach((el) => {
      const meta = captureMediaMeta(el);
      if (!meta || (!meta.src && !(meta.sources && meta.sources.length))) return;
      el.replaceWith(buildMediaHost(meta));
    });
  }

  /** 音频不做门面：搬入文档后再把地址放回去，保持原有的播放能力 */
  function restoreAudioSources(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('audio').forEach((audio) => {
      const src = audio.getAttribute('data-src');
      if (src && !audio.hasAttribute('src')) audio.setAttribute('src', src);
      audio.querySelectorAll('source[data-src]').forEach((source) => {
        if (!source.hasAttribute('src')) source.setAttribute('src', source.getAttribute('data-src'));
        source.removeAttribute('data-src');
      });
    });
  }

  /** 关闭浮层 / 切帖：暂停并移除已注入的媒体，避免后台继续播放 */
  function teardownMedia(scope) {
    const box = scope || root;
    if (!box || !box.querySelectorAll) return;
    box.querySelectorAll('video[data-pco-injected]').forEach((video) => {
      try { video.pause(); } catch (e) { /* noop */ }
      video.removeAttribute('src');
      video.querySelectorAll('source').forEach((source) => source.removeAttribute('src'));
      try { video.load(); } catch (e) { /* noop */ }
      video.remove();
    });
    box.querySelectorAll('iframe[data-pco-injected]').forEach((frame) => {
      frame.removeAttribute('src');
      frame.remove();
    });
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

    // 先在离屏容器里解析：视频 / 嵌入在插入页面前就换成占位层，
    // 保证真实媒体地址不会在用户点击前发起任何请求
    const holder = document.createElement('div');
    holder.innerHTML = stripMediaSources(
      // 标题行：标题文字与「总结本帖」排在同一行，按钮紧跟标题文字之后
      '<div class="pco-title-row">' +
        '<h1 class="pco-title">' + esc(topic.title || '无标题帖子') + '</h1>' +
        '<button type="button" class="pco-sum-btn" data-act="ai-summarize" ' +
          'title="用 AI 总结本帖" aria-label="用 AI 总结本帖">' +
          icon('sparkles', 13) + '<span>总结本帖</span>' +
        '</button>' +
      '</div>' +
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
      // AI 助手：回到正文流原位（分割线下方、正文之前），宽度由 CSS 收口
      '<div class="pco-ai-panel" data-role="ai-panel"' +
          (aiHidden() || (!aiPanelText && !aiPanelBusy) ? ' hidden' : '') + '>' +
        '<div class="pco-ai-panel-head">' +
          '<span class="pco-ai-panel-title">' + icon('sparkles', 15) + 'AI 助手</span>' +
          '<span class="pco-ai-panel-hint">AI 总结</span>' +
        '</div>' +
        '<div class="pco-ai-panel-status" data-role="ai-panel-status">' +
          '使用设置里的模型与密钥生成</div>' +
        '<div class="pco-ai-panel-out" data-role="ai-panel-out"></div>' +
        // AI 生成说明：只在有总结内容时出现，复制正文时不包含这句
        '<p data-role="ai-note" hidden ' +
          'style="flex:none;margin:0;padding:8px 14px 0;font-size:11.5px;line-height:1.5;color:var(--pco-muted);">' +
          '内容由 AI 生成</p>' +
        '<div class="pco-ai-panel-foot">' +
          '<button type="button" class="pco-ai-foot-btn" data-act="ai-stop" hidden>停止</button>' +
          '<button type="button" class="pco-ai-foot-btn" data-act="ai-copy" hidden>复制</button>' +
        '</div>' +
      '</div>' +
      // 窄屏操作栏收起时，用这一行切换同一块面板
      '<div class="pco-ai-row">' +
        '<button type="button" class="pco-ai-row-btn" data-act="rail-ai">' +
          icon('sparkles', 15) + '<span>AI 助手</span></button>' +
      '</div>' +
      (tags ? '<div class="pco-tags">' + tags + '</div>' : '') +
      '<div class="pco-post-foot">' +
        '<span>' + icon('heart', 15) + esc(fmtCount(topic.likeCount != null ? topic.likeCount : first.likeCount)) + '</span>' +
        '<span>' + icon('chat', 15) + esc(fmtCount(topic.replyCount)) + '</span>' +
        '<span>' + icon('eye', 15) + esc(fmtCount(topic.viewCount)) + '</span>' +
      '</div>' +
      '<div class="pco-md pco-post-body">' +
        (first.cookedHtml || '<p class="pco-empty">正文为空</p>') +
      '</div>'
    );

    // 离屏把 iframe / video 换成等尺寸占位层；随后再清理旧媒体、搬入正式容器
    prepareVideoFacades(holder);
    teardownMedia(contentEl);
    contentEl.innerHTML = '';
    while (holder.firstChild) contentEl.appendChild(holder.firstChild);
    restoreAudioSources(contentEl);

    localizeMentions(contentEl, map);
    contentEl.querySelectorAll('iframe').forEach((frame) => {
      // allow 与 allowfullscreen 同时存在时 Chrome 会告警，且以 allow 为准；
      // 去掉冗余的 allowfullscreen，行为不变
      if (frame.hasAttribute('allow')) frame.removeAttribute('allowfullscreen');
      frame.loading = 'lazy';
    });
    contentEl.querySelectorAll('img').forEach((img) => {
      if (img.classList.contains('markdown-emoji')) return;
      img.loading = 'lazy';
      img.decoding = 'async';
    });
    // 视频 / 作品嵌入在动画期间不初始化，落定后再恢复 src
    deferHeavyMedia(contentEl);

    // 新内容挂上后重新按 AI 开关隐藏入口（标题「总结本帖」、面板等）
    applyAiAvailability();
    // 该帖已经生成过总结：按同一缓存键直接恢复展示，不重新请求
    restoreAiSummary(topic);

    // 内容与骨架交叉淡出，避免出现闪白或跳版
    root.classList.add('is-loaded');

    // 目录与回到顶部要读布局，推迟到动画落定，避免在缩放帧里强制重排
    whenSettled(() => {
      if (!root || !contentEl) return;
      buildToc();
      paintTopBtn();
    });
  }

  // ============================ 6.0 文章导航与窗口视图 ============================

  /** 把全屏 / 加宽开关的状态同步到按钮上 */
  function paintViewControls() {
    if (!root) return;
    const full = root.querySelector('[data-act="full"]');
    if (full) {
      full.classList.toggle('is-on', fullOn);
      full.setAttribute('aria-pressed', fullOn ? 'true' : 'false');
      full.title = fullOn ? '退出全屏（Esc）' : '全屏显示';
    }
    const wide = root.querySelector('[data-act="wide"]');
    if (wide) {
      wide.classList.toggle('is-on', wideOn);
      wide.setAttribute('aria-pressed', wideOn ? 'true' : 'false');
      wide.title = wideOn ? '还原窗口宽度' : '加宽窗口';
      wide.disabled = fullOn;
    }
    const sel = root.querySelector('[data-act="select"]');
    if (sel) {
      sel.classList.toggle('is-on', selectOn);
      sel.setAttribute('aria-pressed', selectOn ? 'true' : 'false');
      sel.title = selectOn ? '关闭文本选中' : '文本选中模式';
    }
  }

  /** 文本选中模式：默认禁止鼠标划选，开启后可自由选择与复制 */
  function toggleSelect() {
    if (!root) return;
    selectOn = !selectOn;
    root.classList.toggle('is-select', selectOn);
    paintViewControls();
    toast(selectOn ? '已开启文本选中，可自由划选复制' : '已关闭文本选中，避免误选');
  }

  /** 在默认宽度与贴边宽度之间切换，宽度过渡由 CSS 完成 */
  function toggleWide() {
    if (!root || fullOn) return;
    wideOn = !wideOn;
    root.classList.toggle('is-wide', wideOn);
    paintViewControls();
    // 宽度有 0.3s 过渡，过渡结束后再校准两侧切换按钮
    scheduleNavOffset();
  }

  function toggleFull(force) {
    if (!root) return;
    const next = typeof force === 'boolean' ? force : !fullOn;
    if (next === fullOn) { paintViewControls(); return; }
    fullOn = next;
    root.classList.toggle('is-full', fullOn);
    paintViewControls();
    scheduleNavOffset();
    // 记住用户的选择：复用 pco_config 这个键里的 fullscreen 字段，不单独新建存储键
    saveFullPreference(fullOn);
  }

  /** 全屏偏好写回 pco_config（保留配置里的其他字段） */
  function saveFullPreference(on) {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        const cfg = Object.assign({}, raw && raw[SETTINGS_KEY], { fullscreen: on });
        chrome.storage.local.set({ [SETTINGS_KEY]: cfg });
      });
    } catch (e) { /* 扩展上下文失效时忽略 */ }
  }

  /** 两侧切换按钮贴住浮层边缘；窗口太宽或全屏时退到视口内侧 */
  function paintNavOffset() {
    if (!root || !stage) return;
    // 38px 按钮 + 14px 间距
    const outside = Math.round((window.innerWidth - stage.offsetWidth) / 2) - 52;
    const left = Math.max(10, outside);
    root.style.setProperty('--pco-nav-left', left + 'px');
    root.style.setProperty('--pco-nav-right', left + 'px');
  }

  /** 尺寸变化有 0.3s 过渡，过渡结束后再校一次按钮位置 */
  function scheduleNavOffset() {
    paintNavOffset();
    setTimeout(paintNavOffset, 360);
  }

  /**
   * 恢复目录状态时直接落位：抑制宽度过渡，避免浮层开启动画期间
   * 目录再从 0 → 288px 展开一次，视觉上像重复播放了展开动画。
   */
  function setTocInstant(open) {
    if (!root) return;
    root.classList.add('pco-toc-instant');
    root.classList.toggle('is-toc', open);
    const btn = root.querySelector('[data-act="toc"]');
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('is-on', open);
    }
    void root.offsetWidth;   // 先按终值完成布局，移除抑制类后不会再补播过渡
    requestAnimationFrame(() => {
      if (root) root.classList.remove('pco-toc-instant');
    });
  }

  /**
   * 恢复「上次是展开的」目录。
   * 浮层刚打开时（tocOpenAnim）走正常类切换，让侧栏从 0 过渡到 288px；
   * 之后换帖只做瞬时落位，避免一次切换里收起、展开连播两段动画。
   */
  function restoreTocOpen() {
    if (!root) return;
    if (!tocOpenAnim) {
      setTocInstant(true);
      return;
    }
    tocOpenAnim = false;     // 只认第一次恢复；之后的换帖一律瞬时
    root.classList.remove('pco-toc-instant');
    root.classList.add('is-toc');
    const btn = root.querySelector('[data-act="toc"]');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('is-on');
    }
  }

  /**
   * 切帖 / 重新渲染前先把目录「归零」：清空条目、收起侧栏、隐藏入口。
   * 收起必须瞬时完成：从有目录的帖子切到没目录的帖子时，不能让竖栏边收边被看到；
   * 是否重新展开由 buildToc 落定后决定。
   */
  function resetToc() {
    if (!root) return;
    tocHeads = [];
    tocActiveIdx = -1;
    root.classList.add('pco-toc-instant');
    root.classList.remove('is-toc');
    void root.offsetWidth;   // 先按 0 宽完成布局，再放开过渡，不会补播收起动画
    root.classList.remove('pco-toc-instant');
    const btn = root.querySelector('[data-act="toc"]');
    if (btn) {
      btn.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('is-on');
    }
    const list = root.querySelector('[data-role="toc-list"]');
    if (list) list.innerHTML = '';
  }

  /** 从正文里抽取标题生成目录；标题不足两个时隐藏入口 */
  function buildToc() {
    if (!root || !contentEl) return;
    const body = contentEl.querySelector('.pco-post-body');
    const btn = root.querySelector('[data-act="toc"]');
    const list = root.querySelector('[data-role="toc-list"]');
    if (!body || !btn || !list) return;
    tocHeads = [];
    tocActiveIdx = -1;

    // 与站点一致：帖子标题本身作为目录的第一项
    const title = contentEl.querySelector('.pco-title');
    const heads = (title ? [title] : []).concat(
      Array.prototype.slice
        .call(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter((h) => (h.textContent || '').trim() && !h.classList.contains('pco-empty'))
    );
    if (heads.length < 2) {
      // 没有可用大纲：入口与侧栏都不能出现在任何一帧里
      resetToc();
      return;
    }

    // 以最浅的标题层级作为缩进基准，避免正文从 h2 开始时整体右移
    const base = Math.min.apply(null, heads.map((h) => Number(h.tagName.charAt(1))));
    list.innerHTML = heads.map((h, i) => {
      if (!h.id) h.id = 'pco-head-' + i;
      const lvl = Math.max(0, Number(h.tagName.charAt(1)) - base);
      return '<button type="button" class="pco-toc-item" data-act="toc-jump" ' +
        'data-idx="' + i + '" style="--lvl:' + lvl + '">' +
        esc((h.textContent || '').trim()) + '</button>';
    }).join('');

    tocHeads = heads;
    btn.hidden = false;
    // 沿用上次的展开状态：浮层刚打开时播放展开过渡，换帖时直接落位
    if (tocOn) restoreTocOpen();
    paintTocFlow();
    paintTocActive();
    // 目录建好后才知道章节数：用于「这篇有点长」气泡的触发条件
    guideNotify('topic-rendered', {
      headingCount: tocHeads.length,
      hasToc: !btn.hidden,
      tocOpen: root.classList.contains('is-toc')
    });
  }

  function toggleToc() {
    if (!root) return;
    const btn = root.querySelector('[data-act="toc"]');
    if (!btn) return;
    const open = !root.classList.contains('is-toc');
    root.classList.toggle('is-toc', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('is-on', open);
    tocOn = open;
    saveTocPref();
    if (open) paintTocActive();
  }

  /** 记住目录展开状态：换帖、刷新页面、下次打开浮层都沿用 */
  function saveTocPref() {
    try { chrome.storage.local.set({ [TOC_KEY]: tocOn }); } catch (e) { /* 扩展上下文失效时忽略 */ }
  }

  function loadTocPref() {
    try {
      chrome.storage.local.get(TOC_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        tocOn = !!(raw && raw[TOC_KEY]);
        // 目录已经建好（例如命中缓存秒开）时立即补上展开状态
        if (!tocOn || !root || !tocHeads.length) return;
        const btn = root.querySelector('[data-act="toc"]');
        if (!btn || btn.hidden) return;
        restoreTocOpen();
        paintTocActive();
      });
    } catch (e) { /* 扩展上下文失效时保持收起 */ }
  }

  /** 目录项跳转：按标题相对滚动容器的位置换算，不受外层定位影响 */
  function jumpToHeading(idx) {
    const head = tocHeads[idx];
    const scroll = root && root.querySelector('[data-role="scroll"]');
    if (!head || !scroll) return;
    const top = scroll.scrollTop +
      (head.getBoundingClientRect().top - scroll.getBoundingClientRect().top) - 14;
    scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /**
   * 目录折线：整列画成一条 SVG 路径。
   * 竖线 x 随层级内缩（12 / 28 / 44…），层级切换处用一段平滑曲线滑过去，
   * 与站点「文章目录」的画法一致；彩色副本再用 clip 裁到当前条目。
   */
  function paintTocFlow() {
    if (!root) return;
    const list = root.querySelector('[data-role="toc-list"]');
    if (!list) return;
    const stale = list.querySelector('.pco-toc-flow');
    if (stale) stale.remove();
    const items = Array.prototype.slice.call(list.querySelectorAll('.pco-toc-item'));
    if (!items.length) return;

    const SVG = 'http://www.w3.org/2000/svg';
    const lvls = items.map((el) => Number(el.style.getPropertyValue('--lvl')) || 0);
    const tops = items.map((el) => el.offsetTop);
    const hts = items.map((el) => el.offsetHeight);
    const xOf = (lvl) => 12 + 16 * lvl;

    let d = 'M ' + xOf(lvls[0]) + ' 0';
    for (let i = 0; i < items.length; i += 1) {
      const x = xOf(lvls[i]);
      const bot = tops[i] + hts[i];
      const nextLvl = i + 1 < items.length ? lvls[i + 1] : null;
      const changed = nextLvl !== null && nextLvl !== lvls[i];
      // 层级变化时竖线提前 11px 收住，剩下 22px 交给过渡曲线
      d += ' L ' + x + ' ' + (changed ? bot - 11 : bot);
      if (changed) {
        const nx = xOf(nextLvl);
        d += ' C ' + x + ' ' + bot + ', ' + nx + ' ' + bot + ', ' + nx + ' ' + (bot + 11);
      }
    }

    const w = list.clientWidth || 288;
    const h = Math.max(list.scrollHeight, tops[tops.length - 1] + hts[hts.length - 1]);

    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'pco-toc-flow');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('aria-hidden', 'true');

    const clip = document.createElementNS(SVG, 'clipPath');
    clip.setAttribute('id', 'pco-toc-clip');
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('class', 'pco-toc-clip-rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', '0');
    clip.appendChild(rect);

    const base = document.createElementNS(SVG, 'path');
    base.setAttribute('class', 'pco-toc-flow-base');
    base.setAttribute('d', d);

    const active = document.createElementNS(SVG, 'path');
    active.setAttribute('class', 'pco-toc-flow-active');
    active.setAttribute('d', d);
    active.setAttribute('clip-path', 'url(#pco-toc-clip)');

    svg.appendChild(clip);
    svg.appendChild(base);
    svg.appendChild(active);
    list.appendChild(svg);
  }

  /**
   * 依据滚动位置高亮当前阅读到的标题，并把它保持在目录可视区域内。
   * 与站点一致：可见区内的标题整段高亮，裁剪窗用 CSS 过渡平滑滑动。
   */
  function paintTocActive() {
    if (!root || !tocHeads.length) return;
    const scroll = root.querySelector('[data-role="scroll"]');
    const list = root.querySelector('[data-role="toc-list"]');
    if (!scroll || !list) return;

    const items = Array.prototype.slice.call(list.querySelectorAll('.pco-toc-item'));
    if (!items.length) return;

    const box = scroll.getBoundingClientRect();
    const line = box.top + 20;

    // 当前阅读位置：最后一个越过参考线的标题
    let active = 0;
    for (let i = 0; i < tocHeads.length; i += 1) {
      const node = tocHeads[i];
      if (node.isConnected && node.getBoundingClientRect().top <= line) active = i;
    }

    // 可见标题区间：首尾都在可视范围内时，整段折线一起高亮
    const visible = [];
    for (let i = 0; i < tocHeads.length; i += 1) {
      const node = tocHeads[i];
      if (!node.isConnected) continue;
      const top = node.getBoundingClientRect().top;
      const next = tocHeads[i + 1];
      const bottom = next && next.isConnected ? next.getBoundingClientRect().top : box.bottom;
      if (top < box.bottom && Math.min(bottom, box.bottom) > line) visible.push(i);
    }
    const first = visible.length ? visible[0] : -1;
    const last = visible.length ? visible[visible.length - 1] : -1;
    const visibleSet = new Set(visible);

    let activeEl = null;
    items.forEach((el, i) => {
      el.classList.toggle('is-active', visibleSet.has(i));
      if (i === active) {
        el.setAttribute('aria-current', 'location');
        activeEl = el;
      } else {
        el.removeAttribute('aria-current');
      }
    });

    // 折线高亮：裁剪窗的 y / height 交给 CSS 过渡，切换标题时平滑滑动
    const clipRect = list.querySelector('.pco-toc-flow clipPath rect');
    if (clipRect) {
      if (first >= 0) {
        const start = items[first].offsetTop;
        const end = items[last].offsetTop + items[last].offsetHeight;
        clipRect.style.y = start + 'px';
        clipRect.style.height = Math.max(0, end - start) + 'px';
      } else {
        clipRect.style.height = '0px';
      }
    }
    const activePath = list.querySelector('.pco-toc-flow-active');
    if (activePath) activePath.style.opacity = first >= 0 ? '1' : '0';

    // 侧栏收起时不做滚动补偿，避免把隐藏列表滚乱
    if (!activeEl || !root.classList.contains('is-toc')) return;
    const listBox = list.getBoundingClientRect();
    if (!listBox.height) return;
    const item = activeEl.getBoundingClientRect();
    const out = item.top < listBox.top || item.bottom > listBox.bottom;
    if (!out) {
      tocActiveIdx = active;
      return;
    }
    if (active === tocActiveIdx || Date.now() < tocScrollLock) return;

    // 与站点一致：目录自身平滑滚动到当前标题，而不是瞬间跳位
    tocActiveIdx = active;
    tocScrollLock = Date.now() + 360;
    const target = list.scrollTop + item.top - listBox.top - (listBox.height - item.height) / 2;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
  }

  function onContentScroll() {
    if (tocFrame) return;
    tocFrame = requestAnimationFrame(() => {
      tocFrame = 0;
      paintTocActive();
      paintTopBtn();
    });
  }

  /** 返回顶部：正文滚过一段距离后才可点，避免按钮时有时无导致操作栏跳动 */
  function paintTopBtn() {
    if (!root) return;
    const btn = root.querySelector('[data-act="top"]');
    const box = root.querySelector('[data-role="scroll"]');
    if (!btn || !box) return;
    btn.disabled = box.scrollTop < 240;
  }

  function scrollContentTop() {
    const box = root && root.querySelector('[data-role="scroll"]');
    if (!box) return;
    box.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // ============================ 6.1 切换相邻帖子 ============================

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
    // 切帖前停掉已注入的媒体，避免上一篇的视频在后台继续播放
    teardownMedia(root);
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
    // 换帖时目录清空，等新正文渲染完再重建（侧栏展开状态保留）
    tocHeads = [];
    const tocBtn = root.querySelector('[data-act="toc"]');
    if (tocBtn) tocBtn.hidden = true;
    // AI 结果属于上一篇帖子，换帖时清空，避免误用
    aiPanelText = '';
    aiPanelBusy = false;
    paintAiPanel(false);
    setAiPanelStatus('使用设置里的模型与密钥生成');
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
    // 切换到别的帖子时先退出全屏回复，避免把草稿带到新帖子里
    if (composerFull) toggleComposerFull(false, true);
    insertPoint = null;

    current.id = topicId;
    const cardLink = findFeedLink(topicId);
    current.link = cardLink || null;
    if (cardLink) restoreFocus = cardLink;

    setOpenLinks(topicId);
    // 切换帖子后，跟随的对象换成新帖子的卡片
    adoptOriginCard(topicId, true);
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
      if (view.commentLikeBusy) view.commentLikeBusy.clear();
    }
    paintSorts();

    const filter = root.querySelector('[data-role="filter"]');
    if (filter) filter.value = '';
    const composer = root.querySelector('[data-role="composer"]');
    if (composer) {
      if (composerEditor) composerEditor.clear();
      else composer.innerHTML = '';
      growComposer(composer);
    }
    if (view) view.replyTo = null;
    paintReplyTarget();
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

  // ============================ 6.2 操作栏与提示 ============================

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

  // ============================ 6.3 发表回复 ============================

  function growComposer(ta) {
    if (!ta) return;
    if (composerEditor) { composerEditor.autoGrow(); return; }
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, Math.max(56, ta.scrollHeight)) + 'px';
  }

  /** 点某一楼的「回复」：把发送目标指向它，输入框提示改为回复 @某人 */
  function startReply(btn) {
    if (!view || !view.topic || !btn) return;
    const no = Number(btn.dataset.no) || 0;
    if (!no) return;
    view.replyTo = { no: no, name: (btn.dataset.name || '').trim() };
    paintReplyTarget();
    const ta = root && root.querySelector('[data-role="composer"]');
    if (ta) {
      if (composerEditor) composerEditor.focusEnd();
      else ta.focus();
    }
  }

  function cancelReply() {
    if (!view) return;
    view.replyTo = null;
    paintReplyTarget();
  }

  /** 同步输入框上方的「回复 @某人」提示条 */
  function paintReplyTarget() {
    if (!root) return;
    const bar = root.querySelector('[data-role="composer-target"]');
    const nameEl = root.querySelector('[data-role="composer-target-name"]');
    const target = view && view.replyTo;
    if (bar) bar.hidden = !target;
    if (nameEl) {
      nameEl.textContent = target ? (target.name ? '@' + target.name : '#' + target.no) : '';
    }
    if (composerFull) fillComposerFullHeader();
  }

  async function submitComment() {
    if (!view || !view.topic || view.commentBusy) return;
    if (aiBusy) { toast('AI 正在生成，等它写完再发送'); return; }
    const ta = root && root.querySelector('[data-role="composer"]');
    if (!ta) return;

    const markdown = composerEditor
      ? composerEditor.getMarkdown()
      : String(ta.textContent || '').trim();
    if (!markdown) {
      ta.focus();
      toast('先写点内容再发送', 'err');
      return;
    }
    if (markdown.length > 4000) {
      toast('回复最多 4000 字，先精简一下', 'err');
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
      // 与站点回复编辑器一致的请求体：topicId + markdown；未指定楼层时回主楼
      const res = await apiSend('/posts', 'POST', {
        topicId: topicId,
        markdown: markdown,
        replyToPostNumber: (view.replyTo && view.replyTo.no) || 1
      });

      if (composerEditor) composerEditor.clear();
      else ta.innerHTML = '';
      growComposer(ta);
      view.replyTo = null;
      paintReplyTarget();
      insertPoint = null;
      if (composerFull) toggleComposerFull(false);

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

    const all = posts.items || [];
    const shown = view && view.showAll ? all : all.slice(0, COMMENT_LIMIT);
    const keyword = view && view.keyword ? view.keyword.toLowerCase() : '';
    const items = keyword ? shown.filter((post) => {
      const name = (post.author && post.author.username) || '';
      return name.toLowerCase().indexOf(keyword) !== -1 ||
        plainText(post.cookedHtml).toLowerCase().indexOf(keyword) !== -1;
    }) : shown;

    if (!items.length) {
      inner.innerHTML = '<div class="pco-comments-empty">' +
        (keyword ? '没有匹配「' + esc(view.keyword) + '」的回复' : '还没有回复，来抢沙发吧') +
      '</div>';
      return;
    }

    // 按 replyToPostNumber 把回复挂回父楼，正常呈现「评论 - 回复」的层级
    const byNumber = new Map();
    const childrenOf = new Map();
    const roots = [];
    if (!keyword) {
      items.forEach((post) => byNumber.set(Number(post.postNumber), post));
      items.forEach((post) => {
        const parentNo = Number(post.replyToPostNumber) || 1;
        const parent = parentNo > 1 ? byNumber.get(parentNo) : null;
        if (parent && parent !== post) {
          if (!childrenOf.has(parent)) childrenOf.set(parent, []);
          childrenOf.get(parent).push(post);
        } else {
          roots.push(post);
        }
      });
    }

    let seq = 0;
    const rendered = new Set();
    const renderComment = (post, depth) => {
      const a = post.author || {};
      const body = post.deleted
        ? '<p class="pco-empty">这条回复已被删除</p>'
        : (post.cookedHtml || '');
      const parentNo = Number(post.replyToPostNumber) || 1;
      // 父楼被折叠、不在当前列表里时不显示「回复」，避免指错人
      const parent = parentNo > 1 ? byNumber.get(parentNo) : null;
      const replyTo = parent && parent !== post
        ? '<div class="pco-comment-replyto">回复 <span>@' +
            esc(userName(parent.author) || shortMentionId(parent.author && parent.author.id)) +
            '</span></div>'
        : '';
      const liked = !!(post.viewerState && post.viewerState.liked);
      const likeBtn = post.deleted ? '' :
        '<button type="button" class="pco-comment-like' + (liked ? ' is-on' : '') + '"' +
          ' data-act="comment-like" data-id="' + esc(post.id || '') + '"' +
          ' data-no="' + esc(post.postNumber || '') + '"' +
          ' aria-pressed="' + (liked ? 'true' : 'false') + '"' +
          ' title="' + (liked ? '取消点赞' : '点赞') + '">' +
          icon('heart', 12) +
          '<span data-role="comment-like-count">' + esc(fmtCount(post.likeCount)) + '</span>' +
        '</button>';
      return '<article class="pco-comment' + (depth ? ' pco-comment--child' : '') +
          '" style="--i:' + (seq++) + '"' +
          ' data-role="comment" data-id="' + esc(post.id || '') + '"' +
          ' data-no="' + esc(post.postNumber || '') + '">' +
        avatarHtml(a, 'pco-avatar pco-avatar--sm') +
        '<div class="pco-comment-main">' +
          '<div class="pco-comment-head">' +
            '<span class="pco-comment-name">' +
              esc(userName(a) || (a.id ? shortMentionId(a.id) : '已删除用户')) + '</span>' +
            badgeHtml(a, true) +
            '<span class="pco-comment-time">' + esc(timeAgo(post.createdAt)) + '</span>' +
          '</div>' +
          replyTo +
          '<div class="pco-md pco-md--sm">' + body + '</div>' +
          '<div class="pco-comment-foot">' +
            likeBtn +
            (post.pinned ? '<span class="pco-comment-pin">置顶</span>' : '') +
            '<span class="pco-comment-no">#' + esc(post.postNumber || '') + '</span>' +
            (post.postNumber
              ? '<button type="button" class="pco-comment-reply" data-act="reply-comment"' +
                  ' data-no="' + esc(post.postNumber) + '"' +
                  ' data-name="' + esc(userName(a) || shortMentionId(a.id)) + '">回复</button>'
              : '') +
          '</div>' +
        '</div>' +
      '</article>';
    };

    // 最深缩进 3 层：再深的回复并到同一层，免得侧栏被挤窄；rendered 防环
    const renderBranch = (post, depth) => {
      const no = Number(post.postNumber);
      if (rendered.has(no)) return '';
      rendered.add(no);
      const kids = childrenOf.get(post) || [];
      const html = renderComment(post, depth);
      if (!kids.length) return html;
      const nextDepth = Math.min(depth + 1, 3);
      const inner2 = kids.map((kid) => renderBranch(kid, nextDepth)).join('');
      return html + (depth < 3 ? '<div class="pco-comment-children">' + inner2 + '</div>' : inner2);
    };

    // 回复里的视频同样先离屏换成占位层，再连同「查看所有评论」一起搬入
    const holder = document.createElement('div');
    holder.innerHTML = stripMediaSources(
      (keyword ? items : roots).map((post) => renderBranch(post, 0)).join('')
    );

    // 首屏有折叠时，底部提供「查看所有评论」，点开后原地加载全部
    const more = moreCommentsHtml(topic, shown);
    if (more) holder.insertAdjacentHTML('beforeend', more);

    prepareVideoFacades(holder);
    teardownMedia(inner);
    inner.innerHTML = '';
    while (holder.firstChild) inner.appendChild(holder.firstChild);
    restoreAudioSources(inner);

    localizeMentions(inner, mentionMap);
    deferHeavyMedia(inner);
  }

  /** 按楼层号 / id 在当前回复列表里定位 post（浮层只认 view.posts 这一份数据） */
  function findCommentPost(no, id) {
    const items = (view && view.posts && view.posts.items) || [];
    return items.find((p) => p && ((id && p.id === id) ||
      (no && String(p.postNumber) === String(no)))) || null;
  }

  /** 只刷新这一条评论的点赞外观，不重渲染整列，避免计数闪动与入场动画重播 */
  function paintCommentLike(btn, post) {
    if (!btn || !post) return;
    const liked = !!(post.viewerState && post.viewerState.liked);
    btn.classList.toggle('is-on', liked);
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    btn.title = liked ? '取消点赞' : '点赞';
    const num = btn.querySelector('[data-role="comment-like-count"]');
    if (num) num.textContent = fmtCount(post.likeCount);
  }

  /** 评论点赞：先乐观更新，再写回站点；失败（含未登录）回滚并提示 */
  async function toggleCommentLike(btn) {
    if (!view || !btn) return;
    const post = findCommentPost(btn.getAttribute('data-no'), btn.getAttribute('data-id'));
    if (!post || !post.id) return;
    if (!view.commentLikeBusy) view.commentLikeBusy = new Set();
    if (view.commentLikeBusy.has(post.id)) return;

    const prevLiked = !!(post.viewerState && post.viewerState.liked);
    const prevCount = Number(post.likeCount) || 0;
    const next = !prevLiked;

    post.viewerState = post.viewerState || {};
    post.viewerState.liked = next;
    post.likeCount = Math.max(0, prevCount + (next ? 1 : -1));
    paintCommentLike(btn, post);
    view.commentLikeBusy.add(post.id);

    try {
      const res = await apiSend('/posts/' + encodeURIComponent(post.id) + '/like',
        next ? 'PUT' : 'DELETE');
      // 服务端有明确返回值时以它为准（PUT 返回帖子；DELETE 可能只返回本地推算）
      if (res && typeof res === 'object') {
        const serverLiked = typeof res.liked === 'boolean' ? res.liked :
          (res.viewerState && typeof res.viewerState.liked === 'boolean' ? res.viewerState.liked : null);
        if (serverLiked !== null) post.viewerState.liked = serverLiked;
        if (typeof res.likeCount === 'number') post.likeCount = Math.max(0, res.likeCount);
        if (btn.isConnected) paintCommentLike(btn, post);
      }
    } catch (err) {
      post.viewerState.liked = prevLiked;
      post.likeCount = prevCount;
      if (btn.isConnected) paintCommentLike(btn, post);
      let msg = '点赞失败：' + err.message;
      if (err.status === 401) msg = '请先登录后再点赞';
      else if (err.status === 403) msg = '当前账号不能点赞这条回复';
      toast(msg, 'err');
    } finally {
      if (view) view.commentLikeBusy.delete(post.id);
    }
  }

  /** 「查看所有评论」入口：只有首屏被折叠时才出现 */
  function moreCommentsHtml(topic, shown) {
    if (!view || view.showAll) return '';
    const total = Number(topic.replyCount) || 0;
    if (total <= shown.length && shown.length < COMMENT_LIMIT) return '';
    return '<button type="button" class="pco-comments-more" data-act="all-comments">' +
      '<span>查看所有评论</span>' + icon('chevronRight', 14) + '</button>';
  }

  /** 原地加载全部回复：首屏只取 24 条，这里按游标逐页补齐 */
  async function loadAllComments() {
    if (!root || !view || !view.topic || view.loadingAll) return;
    const topic = view.topic;
    const btn = root.querySelector('[data-act="all-comments"]');
    view.loadingAll = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>正在加载…</span>';
    }

    const signal = current && current.controller ? current.controller.signal : undefined;
    try {
      const posts = await fetchAllPosts(topic.id, view.sort, signal);
      if (!current || current.id !== topic.id) return;
      view.showAll = true;
      view.posts = posts;
      commentCache.set(topic.id + '|' + view.sort, { posts: posts, at: Date.now(), all: true });
      renderComments(topic, posts, buildMentionMap(topic, posts));
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (!root) return;
      // 失败时把按钮恢复原样，用户可以直接重试
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = '<span>查看所有评论</span>' + icon('chevronRight', 14);
      }
      toast('评论加载失败，请稍后重试', 'err');
    }
    view.loadingAll = false;
  }

  function showError() {
    if (!root) return;
    root.classList.add('is-error', 'is-side-error');
  }

  // ============================ 7. 关闭 ============================

  function clearTimers() {
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (shellFadeTimer) { clearTimeout(shellFadeTimer); shellFadeTimer = null; }
    if (composerAnimTimer) { clearTimeout(composerAnimTimer); composerAnimTimer = null; }
  }

  function cleanup(keepPage) {
    clearTimers();
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    settleTasks = [];
    deferredMedia = [];
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    // 关掉浮层时中止未完成的 AI 生成；已经生成好的内容留在 pcai_cache 里，
    // 下次打开同一帖按同一缓存键直接恢复，不会重新请求
    abortAi();
    aiPanelText = '';
    aiPanelBusy = false;
    if (aiPort) {
      try { aiPort.disconnect(); } catch (e) { /* noop */ }
      aiPort = null;
    }

    view = null;
    composerFull = false;
    composerHome = null;
    composerAnchor = null;
    insertPoint = null;
    openPopName = '';
    if (composerPageOverflow !== null) {
      document.documentElement.style.overflow = composerPageOverflow;
      composerPageOverflow = null;
    }
    if (current && current.controller) {
      try { current.controller.abort(); } catch (e) { /* noop */ }
    }
    if (prefetchController) {
      try { prefetchController.abort(); } catch (e) { /* noop */ }
      prefetchController = null;
    }
    prefetching.clear();
    drag = null;
    pendingBack = false;
    resetOriginCard();
    // 关闭浮层：先暂停并摘掉已注入的媒体，再移除整层
    teardownMedia(root);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    shell = null;
    stage = null;
    contentEl = null;
    countEl = null;
    current = null;
    closing = false;
    unlockScroll();
    // 关闭→立刻打开下一张：保留页面当前的缩放，避免背景闪回 1:1 再缩一次
    if (keepPage) pageEl = null;
    else resetPage();
    selectProbe = null;
    // 通知引导层收尾：移除 Tour / 气泡，不残留任何节点
    guideNotify('overlay-closed');
  }

  function animateClose(fromDrag) {
    if (!root || closing) return;
    if (composerFull) toggleComposerFull(false, true);
    closing = true;
    clearTimers();
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    settleTasks = [];
    // 关闭动画同样只动 transform/opacity：先摘掉毛玻璃与落定状态
    root.classList.remove('is-settled');
    root.classList.add('is-animating');
    closeLightbox();
    // 关闭动作一开始就停掉正在播放的媒体，不等整段退出动画结束
    teardownMedia(root);
    // 回弹计时器可能还在跑：立刻摘掉，避免中途换掉位移层的过渡曲线
    root.classList.remove('is-springing');
    // 只有“上滑松手”关闭才保留尺寸过冲；点按钮 / 点空白处属于主动关闭，直接收回到卡片
    root.classList.toggle('is-drag-close', !!fromDrag);

    const reduce = reducedMotion();
    const link = current && current.link;

    // —— 遮罩尽早退场：模糊/压暗随浮层开始收缩就淡出，
    //    并立刻放开点击拦截，让下一张卡片可以马上点 ——
    const bd = root.querySelector('.pco-backdrop');
    if (bd) {
      bd.style.transition = 'opacity ' + sec(0.18) + ' ease ' + sec(0.1);
      bd.style.opacity = '0';
      bd.style.pointerEvents = 'none';
    }
    const navEl = root.querySelector('.pco-nav');
    if (navEl) {
      navEl.style.transition = 'opacity ' + sec(0.14) + ' ease';
      navEl.style.opacity = '0';
    }
    const grabEl = root.querySelector('.pco-grabber');
    if (grabEl) {
      grabEl.style.transition = 'opacity ' + sec(0.1) + ' ease';
      grabEl.style.opacity = '0';
    }

    // —— 量落点前先临时摘掉页面缩放：不受 0.4s 回弹曲线干扰，量到的才是
    //    卡片最终矩形（尺寸精确匹配）。同帧内还原，不会产生可见跳变 ——
    let pageTf = '';
    if (pageEl) {
      // 取当前计算值（可能是开合途中的插值），还原时画面才不会跳
      pageTf = window.getComputedStyle(pageEl).transform;
      if (!pageTf || pageTf === 'none') pageTf = '';
      pageEl.style.transition = 'none';
      pageEl.style.transform = '';
    }

    let target = null;
    if (link && link.isConnected) {
      const cardEl = link.closest('article') || link;
      // 拖动时卡片本身带着 translate + scale，直接量会把「拖动后的卡片」当成落点，
      // 于是浮层会继续缩到比原卡片还小。先摘掉变换量到真实外框，再原样放回去做回位动画。
      let keepTf = '';
      if (originCard === cardEl) {
        keepTf = cardEl.style.transform;
        cardEl.style.transition = 'none';
        cardEl.style.transform = '';
      }
      const r = cardEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) target = r;
      if (keepTf) {
        cardEl.style.transform = keepTf;
      }
    }

    // 同帧还原页面缩放（不产生可见变化），随后与浮层同步平滑回到 1:1
    if (pageEl) {
      pageEl.style.transform = pageTf;
      void pageEl.offsetWidth;
      pageEl.style.transition = 'transform ' + sec(0.44) + ' cubic-bezier(0.32, 0.72, 0.2, 1)';
      pageEl.style.transform = '';
      pageEl.style.filter = '';
      // will-change 留到 cleanup 再清：关闭的 0.44s 页面缩放同样需要合成层
    }

    // 历史回退改到动画结束之后发，站点重渲染不会再和退出动画抢主线程
    pendingBack = !!(current && current.pushed && history.state && history.state.pco);

    root.classList.remove('is-open');
    root.classList.add('is-closing');

    if (stage && shell && target && !reduce) {
      // 以 shell 的可见矩形为准（包含拖动时的位移与收缩），落点直接对准卡片
      const vis = shell.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      // 舞台可能已被拖动位移（translate 是绝对值），先还原出未位移的中心，
      // 否则直接把「中心差」当绝对值写入，会把这段拖动位移丢掉，落点整体偏移。
      const cur = stageTranslate();
      const baseCx = stageRect.left + stageRect.width / 2 - cur.x;
      const baseCy = stageRect.top + stageRect.height / 2 - cur.y;
      const dx = (target.left + target.width / 2) - baseCx;
      const dy = (target.top + target.height / 2) - baseCy;
      // 拖动时的收缩量：从当前 scale 继续收成卡片大小
      const s0x = stageRect.width > 0 ? Math.min(1, vis.width / stageRect.width) : 1;
      const s0y = stageRect.height > 0 ? Math.min(1, vis.height / stageRect.height) : 1;
      // 目标收缩到卡片大小（与打开时的起始比例完全对称）
      const s1x = stageRect.width > 0 ? Math.min(1, target.width / stageRect.width) : 0.06;
      const s1y = stageRect.height > 0 ? Math.min(1, target.height / stageRect.height) : 0.06;

      // 起点钉成当前这一帧的位置与缩放（无过渡）：哪怕开启动画还在跑，
      // 也能从半途的画面原地接管，不会跳一下再反向
      stage.style.transition = 'none';
      shell.style.transition = 'none';
      stage.style.transform = 'translate(' + cur.x + 'px, ' + cur.y + 'px)';
      shell.style.transform = 'scale(' + s0x + ', ' + s0y + ')';
      void shell.offsetWidth;

      // —— 收尾动画：缩放快于位移，先收成卡片大小、再滑回卡片 ——
      stage.style.transition = '';
      shell.style.transition = '';
      stage.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      shell.style.transform = 'scale(' + s1x + ', ' + s1y + ')';

      // 原始卡片同步回家：从拖动位置随浮层一起移动缩放；
      // 显形压到浮层落位之后（0.54s），两者在同一位置做一次几乎无感的交接
      if (originCard && originCard.isConnected) {
        originCard.style.transition =
          'transform ' + sec(0.54) + ' cubic-bezier(0.3, 0.88, 0.26, 1), opacity ' +
          sec(0.14) + ' ease ' + sec(0.54);
        originCard.style.transform = '';
        originCard.style.opacity = '1';
      }
    } else if (stage && shell && !reduce) {
      resetOriginCard();
      stage.style.transform = 'translateY(10px)';
      shell.style.transform = 'scale(.06)';
    } else {
      resetOriginCard();
    }

    const focusTarget = restoreFocus;
    restoreFocus = null;

    // —— 交接：位移收尾（0.54s）后，面板淡出，由同一位置的原卡片接手 ——
    //    面板不透明地落回卡片，再和卡片做一次位置完全重合的交叉淡化，
    //    这样既不会中途透出原卡片，也不会在容器移除的瞬间“换层”。
    if (stage && shell && target && !reduce) {
      shellFadeTimer = setTimeout(() => {
        shellFadeTimer = null;
        if (!shell) return;
        shell.style.transition = 'opacity ' + sec(0.14) + ' ease';
        shell.style.opacity = '0';
      }, Math.round(540 / animSpeed));
    }

    closeTimer = setTimeout(() => {
      cleanup();
      // 动画结束、浮层销毁后再回退历史：popstate 处理看到 root 已空，直接跳过
      if (pendingBack) {
        pendingBack = false;
        try { history.back(); } catch (e) { /* noop */ }
      }
    }, Math.round(CLOSE_MS / animSpeed));

    // 关闭后把焦点还给原来那张卡片，键盘用户不会「掉出去」
    if (focusTarget && focusTarget.isConnected) {
      setTimeout(() => {
        try { focusTarget.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      }, 0);
    }
  }

  function requestClose(fromDrag) {
    if (!root || closing) return;
    animateClose(fromDrag);
  }

  // ---------- 拖动横条关闭：跟手 + 二维位移 + 惯性 + iOS 回弹 ----------

  /**
   * 收缩量由拖动距离映射：距离代表力度，甩得越快收缩越狠。
   * 0–140px 是正常力度，最多收 45%；再往上进入高强度，最低收到 38%。
   */
  function dragScaleOf(dy) {
    const d = Math.abs(dy);
    if (d <= 140) return 1 - d / 140 * 0.45;
    return 1 - Math.min(0.62, 0.45 + (d - 140) / 110 * 0.17);
  }

  /** 拖动过程中实时跟手：位移层平移、浮层收缩、遮罩变淡、原始卡片同步跟随 */
  function paintDrag(offsetX, offsetY, velocity) {
    if (!stage || !shell || !root) return;
    // 甩动速度再叠加一段额外收缩，低阻尼、有甩动力度感
    const boost = Math.min(0.08, Math.abs(velocity || 0) * 0.12);
    const scale = Math.max(0.3, dragScaleOf(offsetY) - boost);
    // 位移按缩放比衰减：窗口跟着手指缩，但不会整个被拖跑，收缩始终围绕页面中央
    stage.style.transition = 'none';
    stage.style.transform = 'translate3d(' +
      Math.round(offsetX * scale) + 'px,' + Math.round(offsetY * scale) + 'px,0)';
    shell.style.transition = 'none';
    shell.style.transform = 'scale(' + scale + ')';
    const bd = root.querySelector('.pco-backdrop');
    if (bd) bd.style.opacity = String(Math.max(0.55, 1 - Math.abs(offsetY) / 900));
    const nav = root.querySelector('.pco-nav');
    if (nav) nav.style.opacity = String(Math.max(0, 1 - Math.abs(offsetY) / 260));
    // 投影随容器一起缩放，无需单独处理
    // 原位卡片全程保持隐藏：拖动时不再让它跟着浮层跑，避免背景里出现一张反向移动的卡片
  }

  function onPointerDown(e) {
    if (!root || !stage || closing) return;
    if (!e.target.closest || !e.target.closest('[data-role="grabber"]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    e.preventDefault();
    // 拖动也是逐帧改变 transform：保持合成层，避免每次 pointermove 触发重栅格化
    root.classList.add('is-animating');
    drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      v: 0,
      dx: 0,
      dy: 0
    };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    stage.classList.add('is-dragging');
    closeRailMenu();
    closePops();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const offsetX = e.clientX - drag.x0;
    const offsetY = e.clientY - drag.y0;
    const dt = Math.max(1, now - drag.t);
    // 更偏重当前帧的速度，甩动时形变立刻跟上，阻尼感更低
    drag.v = drag.v * 0.5 + ((e.clientY - drag.y) / dt) * 0.5;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.t = now;
    drag.dx = offsetX;
    drag.dy = offsetY;
    paintDrag(offsetX, offsetY, drag.v);
  }

  function onPointerUp(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const offsetY = drag.dy;
    const velocity = drag.v;
    drag = null;
    if (stage) stage.classList.remove('is-dragging');
    if (!root) return;

    // 竖向拖够距离，或竖向甩得足够快，就直接关闭；否则弹回原位
    if (Math.abs(offsetY) > DRAG_CLOSE_DISTANCE || Math.abs(velocity) > DRAG_CLOSE_VELOCITY) {
      // 遮罩 / 导航的过渡与不透明度交给 animateClose 接管，
      // 这里绝不能清空内联值——那会让 is-open 的 opacity:1 立刻生效，闪一帧整屏遮罩
      requestClose(true);
      return;
    }

    springBack();
  }

  /** 松手回弹：低阻尼、快速归位，落回原位只留很小的过冲 */
  function springBack() {
    if (!stage || !shell || !root) return;
    root.classList.add('is-springing');
    root.classList.add('is-animating');
    stage.style.transition = '';
    stage.style.transform = '';
    shell.style.transition = '';
    shell.style.transform = '';
    const bd = root.querySelector('.pco-backdrop');
    if (bd) bd.style.opacity = '';
    const nav = root.querySelector('.pco-nav');
    if (nav) nav.style.opacity = '';
    // 原位卡片在拖动时始终隐藏，回弹只需保持隐藏即可
    if (originCard && originCard.isConnected) originCard.style.opacity = '0';
    setTimeout(() => {
      if (!stage || !shell) return;
      stage.style.transition = '';
      stage.style.transform = '';
      shell.style.transition = '';
      if (root) {
        root.classList.remove('is-springing');
        root.classList.remove('is-animating');
      }
    }, 560);
  }

  // ---------- 原位卡片：打开时隐藏，关闭落回后再显示 ----------

  function resetOriginCard() {
    if (originCard) {
      originCard.style.transition = '';
      originCard.style.opacity = '';
      originCard.style.transform = '';
      originCard.style.transformOrigin = '';
      originCard.style.willChange = '';
    }
    originCard = null;
  }

  /** 位移层当前的平移量（拖动或回弹过程中是插值后的实时值） */
  function stageTranslate() {
    if (!stage) return { x: 0, y: 0 };
    const tf = window.getComputedStyle(stage).transform;
    if (!tf || tf === 'none') return { x: 0, y: 0 };
    const m = tf.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return { x: 0, y: 0 };
    const p = m[1].split(',').map(parseFloat);
    if (p.length >= 16) return { x: p[12] || 0, y: p[13] || 0 };
    return { x: p[4] || 0, y: p[5] || 0 };
  }

  function adoptOriginCard(topicId, atRest) {
    resetOriginCard();
    if (reducedMotion() || !shell) return;
    const link = findFeedLink(topicId) || (current && current.link);
    const card = link && link.closest ? link.closest('article') : null;
    if (!card) return;
    originCard = card;
    card.style.transition = 'none';
    card.style.transform = '';
    card.style.opacity = atRest ? '0' : '';
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
    if (!e.target.closest('[data-role="tools"], .pco-pop')) closePops();

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

      // 全屏排版工具栏
      if (act.indexOf('ed-') === 0) {
        e.preventDefault();
        runEditorAction(act, actEl);
        return;
      }

      // 点其他按钮时顺手收起「更多」菜单与编辑器弹层
      if (act !== 'more' && act.indexOf('more-') !== 0) closeRailMenu();
      if (act.indexOf('tool-') !== 0 && act.indexOf('emoji') !== 0 &&
          act.indexOf('image-') !== 0 && act.indexOf('ai-') !== 0) closePops();

      if (act === 'close') {
        e.preventDefault();
        // 双击卡片时，第二次点击常落在刚出现的遮罩上（detail >= 2），只忽略这一次，
        // 否则会「一打开就关掉」；单次点击则允许打断开启动画，直接反向收回。
        if (actEl.classList.contains('pco-backdrop') && e.detail > 1) return;
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
      } else if (act === 'top') {
        e.preventDefault();
        scrollContentTop();
      } else if (act === 'toc') {
        e.preventDefault();
        toggleToc();
      } else if (act === 'toc-jump') {
        e.preventDefault();
        jumpToHeading(Number(actEl.getAttribute('data-idx')));
      } else if (act === 'wide') {
        e.preventDefault();
        toggleWide();
      } else if (act === 'full') {
        e.preventDefault();
        toggleFull();
      } else if (act === 'select') {
        e.preventDefault();
        toggleSelect();
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
      } else if (act === 'more-guide') {
        e.preventDefault();
        closeRailMenu();
        // 手动重看引导：交给 guide 脚本，忽略已完成步骤立即重播
        if (window.PCOGuide && window.PCOGuide.replay) window.PCOGuide.replay();
      } else if (act === 'all-comments') {
        e.preventDefault();
        loadAllComments();
      } else if (act === 'tool-more') {
        e.preventDefault();
        toggleExtraTools(actEl);
      } else if (act === 'tool-emoji' || act === 'tool-image' || act === 'tool-ai') {
        e.preventDefault();
        togglePop(act.slice(5));
      } else if (act === 'composer-full') {
        e.preventDefault();
        toggleComposerFull();
      } else if (act === 'composer-layout') {
        e.preventDefault();
        cycleTbStyle();
      } else if (act === 'composer-full-exit') {
        e.preventDefault();
        toggleComposerFull(false);
      } else if (act === 'emoji') {
        e.preventDefault();
        if (insertAtCursor(actEl.getAttribute('data-emoji') || '')) closePops();
      } else if (act === 'emoji-col') {
        e.preventDefault();
        selectEmojiCollection(actEl.getAttribute('data-id') || '');
      } else if (act === 'emoji-col-prev') {
        e.preventDefault();
        emojiColPage(-1);
      } else if (act === 'emoji-col-next') {
        e.preventDefault();
        emojiColPage(1);
      } else if (act === 'emoji-prev') {
        e.preventDefault();
        emojiPage(-1);
      } else if (act === 'emoji-next') {
        e.preventDefault();
        emojiPage(1);
      } else if (act === 'emoji-pick') {
        e.preventDefault();
        pickEmoji(actEl.getAttribute('data-id') || '');
      } else if (act === 'emoji-retry') {
        e.preventDefault();
        emojiPicker.error = '';
        emojiPicker.loaded = false;
        emojiPicker.itemError = '';
        loadEmojiPicker();
      } else if (act === 'image-pick') {
        e.preventDefault();
        imagePicker.selected = actEl.getAttribute('data-id') || '';
        paintImagePicker();
      } else if (act === 'image-more') {
        e.preventDefault();
        loadImageFiles(false);
      } else if (act === 'image-retry') {
        e.preventDefault();
        loadImageFiles(true);
      } else if (act === 'image-refresh') {
        e.preventDefault();
        loadImageFiles(true);
        loadImageStorage();
      } else if (act === 'image-upload') {
        e.preventDefault();
        const fileInput = root.querySelector('[data-role="image-file"]');
        if (fileInput) fileInput.click();
      } else if (act === 'image-cancel') {
        e.preventDefault();
        closePops();
      } else if (act === 'image-confirm') {
        e.preventDefault();
        confirmImage();
      } else if (act === 'fmt-bold') {
        e.preventDefault();
        wrapSelection('**', '**');
      } else if (act === 'fmt-italic') {
        e.preventDefault();
        wrapSelection('*', '*');
      } else if (act === 'fmt-strike') {
        e.preventDefault();
        wrapSelection('~~', '~~');
      } else if (act === 'fmt-underline') {
        e.preventDefault();
        if (composerEditor) composerEditor.exec('underline');
      } else if (act === 'fmt-code') {
        e.preventDefault();
        wrapSelection('`', '`');
      } else if (act === 'fmt-quote') {
        e.preventDefault();
        prefixLine('> ');
      } else if (act === 'fmt-list') {
        e.preventDefault();
        prefixLine('- ');
      } else if (act === 'fmt-task') {
        e.preventDefault();
        if (composerEditor) composerEditor.insertTaskList();
      } else if (act === 'fmt-link') {
        e.preventDefault();
        const url = window.prompt('链接地址：', 'https://');
        if (url) {
          if (!composerEditor || !composerEditor.insertLink(url)) {
            toast('链接地址无效', 'err');
          }
        }
      } else if (act === 'rail-ai') {
        e.preventDefault();
        // 只切换正文里那块面板的显示，不弹浮层
        const panel = root.querySelector('[data-role="ai-panel"]');
        setAiHidden(!!panel && !panel.hidden);
      } else if (act === 'ai-summarize') {
        e.preventDefault();
        if (!aiFeatureOn('summary')) return;
        // 还没配置密钥：让引导层给出「去设置」气泡，同时继续走原有错误提示
        // ollama / custom 走本地或自建地址，不需要密钥，不能误报
        if (!aiConfig.apiKey && aiConfig.provider !== 'ollama' && aiConfig.provider !== 'custom') {
          guideNotify('ai-blocked');
        }
        // 面板可能被开关收起：先确保可见，再开始生成
        if (aiHidden()) setAiHidden(false);
        runAiPanel();
      } else if (act === 'ai-stop') {
        e.preventDefault();
        abortAi();
        aiPanelBusy = false;
        paintAiPanel(false);
        setAiPanelStatus('已停止生成');
      } else if (act === 'ai-copy') {
        e.preventDefault();
        copyAiPanel();
      } else if (act === 'ai-write' || act === 'ai-polish') {
        e.preventDefault();
        if (aiConfig.aiEnabled === false || aiConfig.aiReply === false) return;
        runAi(act === 'ai-polish' ? 'polish' : 'write');
      } else if (act === 'ai-summary') {
        e.preventDefault();
        if (!aiFeatureOn('summary')) return;
        runSummary();
      } else if (act === 'comment-like') {
        e.preventDefault();
        toggleCommentLike(actEl);
      } else if (act === 'comment') {
        e.preventDefault();
        focusComposer();
      } else if (act === 'reply-comment') {
        e.preventDefault();
        startReply(actEl);
      } else if (act === 'reply-cancel') {
        e.preventDefault();
        cancelReply();
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
    // 表情 / 图片 / AI 弹层优先收起
    if (root.querySelector('.pco-pop:not([hidden])')) {
      closePops();
      return;
    }
    // 全屏回复时 Esc 先退回普通回复框
    if (composerFull) {
      toggleComposerFull(false);
      return;
    }
    // 全屏时 Esc 先退回窗口态，再按一次才关闭
    if (root.classList.contains('is-full')) {
      toggleFull(false);
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
    if (composerEditor) {
      composerEditor.focusEnd();
      return;
    }
    ta.focus();
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

  // ---------------------------- 操作栏「AI 助手」开关 ----------------------------

  const AI_HIDDEN_KEY = 'pco_ai_hidden';

  /** 某项 AI 能力是否开启（总开关优先；summary 复用已有的 enabled 键） */
  function aiFeatureOn(name) {
    if (aiConfig.aiEnabled === false) return false;
    if (name === 'summary') return aiConfig.enabled !== false;
    return aiConfig[name] !== false;
  }

  /** 按设置隐藏 AI 入口；关闭后同时清掉面板内容，避免展示缓存结果 */
  function applyAiAvailability() {
    if (!root) return;
    const summary = aiFeatureOn('summary');
    const reply = aiConfig.aiEnabled !== false && aiConfig.aiReply !== false;
    const show = (sel, on) => {
      root.querySelectorAll(sel).forEach((el) => { el.hidden = !on; });
    };
    show('[data-act="ai-summarize"]', summary);
    show('[data-act="ai-summary"]', summary);
    show('[data-act="rail-ai"]', summary);
    show('[data-act="ai-write"], [data-act="ai-polish"]', reply);
    const tool = root.querySelector('[data-act="tool-ai"]');
    if (tool) tool.hidden = !(summary || reply);
    const pop = root.querySelector('[data-role="ai-pop"]');
    if (pop && !(summary || reply)) pop.hidden = true;
    if (!summary) {
      aiPanelText = '';
      aiPanelBusy = false;
      abortAi();
    }
    syncAiPanelVisibility();
  }

  /** 显示状态持久化：面板回到正文流，切帖 / 重渲染后按上次开关恢复 */
  function aiHidden() {
    try { return localStorage.getItem(AI_HIDDEN_KEY) === '1'; } catch (e) { return false; }
  }

  /**
   * 面板只在「已有总结内容」或「正在生成」时出现；
   * 空态（标题栏、虚线占位、min-height）整块隐藏，不占版面。
   */
  function syncAiPanelVisibility() {
    if (!root) return;
    const panel = root.querySelector('[data-role="ai-panel"]');
    if (!panel) return;
    const hasText = !!String(aiPanelText || '').trim();
    const visible = aiFeatureOn('summary') && !aiHidden() && (hasText || aiPanelBusy);
    panel.hidden = !visible;
    const note = panel.querySelector('[data-role="ai-note"]');
    if (note) note.hidden = !hasText;
    root.querySelectorAll('[data-act="rail-ai"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    });
  }

  function setAiHidden(hidden) {
    try { localStorage.setItem(AI_HIDDEN_KEY, hidden ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
    syncAiPanelVisibility();
  }

  /** 操作栏插入 AI 按钮，只做显示 / 隐藏，不再弹浮层 */
  function mountRailAi() {
    if (!root) return;
    const shell = root.querySelector('.pco-shell');
    const rail = shell && shell.querySelector('.pco-rail');
    if (!rail || rail.querySelector('[data-act="rail-ai"]')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pco-rail-btn';
    btn.setAttribute('data-act', 'rail-ai');
    btn.title = 'AI 助手';
    btn.setAttribute('aria-label', 'AI 助手');
    btn.innerHTML = icon('sparkles', 18);
    const more = rail.querySelector('[data-act="more"]');
    if (more) rail.insertBefore(btn, more); else rail.appendChild(btn);
    setAiHidden(aiHidden());
  }

  // ---------------------------- 回复编辑器工具 ----------------------------

  function composerInput() {
    return root && root.querySelector('[data-role="composer"]');
  }

  /** 初始化回复框的所见即所得编辑器（全屏与普通状态共用同一实例） */
  let composerEditor = null;
  function initComposerEditor() {
    const host = composerInput();
    if (!host || !window.PCOEditor) return;
    // 每次打开浮层都是新的 DOM，旧实例只做销毁，不复用
    if (composerEditor) composerEditor.destroy();
    // 清掉模板里可能残留的空白，避免 :empty 占位符失效
    if (!host.textContent.trim() && !host.querySelector('img,table,hr,pre,blockquote')) {
      host.innerHTML = '';
    }
    composerEditor = new window.PCOEditor(host, {
      getMentionName: (id) => {
        const hit = mentionNames.get(id);
        return (hit && hit.name) || shortMentionId(id);
      },
      onChange: () => {
        paintComposerCount();
        if (!composerFull) growComposer(host);
      },
      onRendered: (el) => {
        localizeMentions(el, null);
        if (composerEditor) composerEditor.refreshState();
      }
    });
    bindComposerDrop(host);
  }

  /** 统一取回复框里的 Markdown 内容 */
  function composerMarkdown() {
    return composerEditor ? composerEditor.getMarkdown() : '';
  }

  function toggleExtraTools(btn) {
    if (!root) return;
    const extra = root.querySelector('[data-role="extra-tools"]');
    if (!extra) return;
    extra.hidden = !extra.hidden;
    if (btn) btn.setAttribute('aria-expanded', extra.hidden ? 'false' : 'true');
    // 展开/收起第二行会移动工具条，已打开的弹层跟着重新贴靠
    placePop();
  }

  function closePops() {
    if (!root) return;
    openPopName = '';
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
    if (!willOpen) return;
    openPopName = name;
    // 点击工具按钮会让输入框失焦，先记住此时的光标位置
    rememberInsertPoint();
    if (name === 'emoji') loadEmojiPicker();
    else if (name === 'image') openImagePicker();
    // 先按当前工具条位置落位，异步内容渲染完后再校正一次
    placePop();
  }

  /** 弹层挂在 #pco-root 下、position: fixed，按工具条位置贴合视口计算坐标 */
  function placePop() {
    if (!root || !openPopName) return;
    const pop = root.querySelector('[data-role="' + openPopName + '-pop"]');
    const tools = root.querySelector('[data-role="tools"]');
    if (!pop || !tools || pop.hidden) return;
    const anchor = tools.getBoundingClientRect();
    if (!anchor.width) return; // 工具条被收起时不做定位
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    // 水平：默认与工具条左对齐（留 8px），右侧放不下就贴视口右侧
    let left = anchor.left + gap;
    left = Math.max(gap, Math.min(left, vw - w - gap));
    // 垂直：优先在工具条上方展开；上方空间不足时翻到下方
    let top = anchor.top - gap - h;
    const above = top >= gap;
    if (!above) top = anchor.bottom + gap;
    top = Math.max(gap, Math.min(top, vh - h - gap));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.style.transformOrigin = above ? '0 100%' : '0 0';
  }

  /** 记录回复框当前光标，供表情/图片弹层使用 */
  function rememberInsertPoint() {
    if (composerEditor) composerEditor.saveSelection();
    insertPoint = null;
  }

  /** 在光标处插入内容：表情/图片引用直接渲染为富文本，其余按纯文本插入 */
  function insertAtCursor(text) {
    if (!composerEditor || !text) return false;
    const current = composerMarkdown();
    if (current.length + text.length > 4000) {
      toast('回复内容超过 4000 字限制', 'err');
      return false;
    }
    const emoji = /^!\[emoji:([\w-]+)\]$/.exec(text);
    if (emoji) {
      composerEditor.insertEmoji(emoji[1]);
      return true;
    }
    const imgRef = /^!\[([0-9A-Za-z_-]{8,})\]$/.exec(text);
    if (imgRef) {
      composerEditor.insertImageRef(imgRef[1]);
      return true;
    }
    composerEditor.insertText(text);
    return true;
  }

  /** 普通状态的排版工具：直接对富文本选区生效 */
  function wrapSelection(before, after) {
    if (!composerEditor) return;
    if (before === '**') composerEditor.exec('bold');
    else if (before === '*') composerEditor.exec('italic');
    else if (before === '~~') composerEditor.exec('strikeThrough');
    else if (before === '`') composerEditor.insertInlineCode();
    else if (before === '> ') composerEditor.toggleBlock('blockquote');
    else composerEditor.exec('bold');
  }

  /** 在当前行加前缀：引用/列表改为切换块级格式 */
  function prefixLine(prefix) {
    if (!composerEditor) return;
    if (prefix === '> ') composerEditor.toggleBlock('blockquote');
    else if (prefix === '- ') composerEditor.toggleList(false);
    else if (prefix === '1. ') composerEditor.toggleList(true);
  }

  /** 全屏工具栏的动作分发 */
  function runEditorAction(act, btn) {
    if (!composerEditor) return true;
    switch (act) {
      case 'ed-undo': composerEditor.undo(); return true;
      case 'ed-redo': composerEditor.redo(); return true;
      case 'ed-h1': composerEditor.toggleHeading(1); return true;
      case 'ed-h2': composerEditor.toggleHeading(2); return true;
      case 'ed-h3': composerEditor.toggleHeading(3); return true;
      case 'ed-h4': composerEditor.toggleHeading(4); return true;
      case 'ed-p': composerEditor.toggleHeading(0); return true;
      case 'ed-align-left': composerEditor.exec('justifyLeft'); return true;
      case 'ed-align-center': composerEditor.exec('justifyCenter'); return true;
      case 'ed-align-right': composerEditor.exec('justifyRight'); return true;
      case 'ed-color': composerEditor.openPalette(btn, 'color'); return true;
      case 'ed-highlight': composerEditor.openPalette(btn, 'highlight'); return true;
      case 'ed-ol': composerEditor.toggleList(true); return true;
      case 'ed-codeblock': composerEditor.insertCodeBlock(); return true;
      case 'ed-table':
        composerEditor.insertTable();
        return true;
      case 'ed-hr': composerEditor.insertHr(); return true;
      case 'ed-math-inline': composerEditor.insertInlineMath(); return true;
      case 'ed-math-block': composerEditor.insertBlockMath(); return true;
      case 'ed-video': {
        const url = window.prompt('粘贴哔哩哔哩播放器地址：', 'https://player.bilibili.com/player.html?bvid=');
        if (url == null) return true;
        if (!composerEditor.insertVideo(url)) {
          toast('只支持 player.bilibili.com 播放器地址', 'err');
        }
        return true;
      }
      case 'ed-clear': composerEditor.clearFormat(); return true;
      case 'ed-find': composerEditor.findReplace(); return true;
      default: return false;
    }
  }

  // ---------------------------- 原生表情合集 ----------------------------

  const EMOJI_PAGE_SIZE = 20;
  const EMOJI_COL_PAGE = 6;
  const emojiPicker = {
    loaded: false,
    loading: false,
    error: '',
    collections: [],
    colPage: 0,
    collection: null,
    page: 1,
    pages: 1,
    items: [],
    itemLoading: false,
    itemError: '',
    reqId: 0
  };

  /** 站点接口可能返回数组或 {items}，统一取列表 */
  function listOf(data) {
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.items) ? data.items : [];
  }

  async function loadEmojiPicker() {
    if (!root) return;
    if (emojiPicker.loading) { paintEmojiPicker(); return; }
    if (emojiPicker.loaded && !emojiPicker.error) { paintEmojiPicker(); return; }
    emojiPicker.loading = true;
    emojiPicker.error = '';
    paintEmojiPicker();
    try {
      const all = [];
      let page = 1;
      while (page <= 20) {
        const data = await apiSend('/emoji-collections?page=' + page + '&pageSize=100', 'GET');
        if (!root) return;
        const items = listOf(data);
        items.forEach((item) => { if (item && item.id) all.push(item); });
        const total = Number(data && data.total) || all.length;
        if (!items.length || all.length >= total) break;
        page += 1;
      }
      emojiPicker.collections = all;
      emojiPicker.loaded = true;
      emojiPicker.colPage = 0;
      emojiPicker.collection = all[0] || null;
      emojiPicker.items = [];
      emojiPicker.page = 1;
      emojiPicker.pages = 1;
      if (!all.length) emojiPicker.error = '还没有可用的表情合集';
      if (emojiPicker.collection) await loadEmojiPage(1);
    } catch (err) {
      if (!root) return;
      emojiPicker.error = err && err.status === 401
        ? '登录后可以使用表情合集'
        : '表情合集加载失败，已切换为常用表情';
    } finally {
      emojiPicker.loading = false;
      paintEmojiPicker();
    }
  }

  async function loadEmojiPage(page) {
    const col = emojiPicker.collection;
    if (!col) return;
    const req = ++emojiPicker.reqId;
    emojiPicker.itemLoading = true;
    emojiPicker.itemError = '';
    paintEmojiPicker();
    try {
      const data = await apiSend(
        '/emojis?collectionId=' + encodeURIComponent(col.id) + '&page=' + page,
        'GET'
      );
      if (req !== emojiPicker.reqId || !root) return;
      const items = listOf(data).filter((it) =>
        it && it.id && (!it.state || it.state === 'ACTIVE'));
      emojiPicker.items = items;
      emojiPicker.page = page;
      const total = Number(data && data.total) || items.length;
      const size = Number(data && data.pageSize) || EMOJI_PAGE_SIZE;
      emojiPicker.pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
    } catch (err) {
      if (req !== emojiPicker.reqId || !root) return;
      emojiPicker.items = [];
      emojiPicker.itemError = err && err.status === 401
        ? '登录后可以使用表情'
        : '表情加载失败，请重试';
    } finally {
      if (req === emojiPicker.reqId) {
        emojiPicker.itemLoading = false;
        paintEmojiPicker();
      }
    }
  }

  function selectEmojiCollection(id) {
    const idx = emojiPicker.collections.findIndex((c) => String(c.id) === String(id));
    if (idx < 0) return;
    emojiPicker.collection = emojiPicker.collections[idx];
    emojiPicker.colPage = Math.floor(idx / EMOJI_COL_PAGE);
    emojiPicker.items = [];
    emojiPicker.page = 1;
    emojiPicker.pages = 1;
    loadEmojiPage(1);
  }

  function emojiColPage(dir) {
    const pages = Math.max(1, Math.ceil(emojiPicker.collections.length / EMOJI_COL_PAGE));
    emojiPicker.colPage = Math.max(0, Math.min(pages - 1, emojiPicker.colPage + dir));
    paintEmojiPicker();
  }

  function emojiPage(dir) {
    if (emojiPicker.itemLoading) return;
    const page = emojiPicker.page + dir;
    if (page < 1 || page > emojiPicker.pages) return;
    loadEmojiPage(page);
  }

  function pickEmoji(id) {
    if (!id) return;
    if (insertAtCursor('![emoji:' + id + ']')) closePops();
  }

  function paintEmojiPicker() {
    if (!root) return;
    const pop = root.querySelector('[data-role="emoji-pop"]');
    if (!pop) return;
    const colsEl = pop.querySelector('[data-role="emoji-cols"]');
    const gridEl = pop.querySelector('[data-role="emoji-grid"]');
    const stateEl = pop.querySelector('[data-role="emoji-state"]');
    const nameEl = pop.querySelector('[data-role="emoji-colname"]');
    const pageEl = pop.querySelector('[data-role="emoji-page"]');
    const prev = pop.querySelector('[data-act="emoji-prev"]');
    const next = pop.querySelector('[data-act="emoji-next"]');
    if (!colsEl || !gridEl || !stateEl) return;

    const colPages = Math.max(1, Math.ceil(emojiPicker.collections.length / EMOJI_COL_PAGE));
    emojiPicker.colPage = Math.max(0, Math.min(colPages - 1, emojiPicker.colPage));
    const start = emojiPicker.colPage * EMOJI_COL_PAGE;
    const visible = emojiPicker.collections.slice(start, start + EMOJI_COL_PAGE);
    colsEl.innerHTML = visible.map((col) => {
      const active = emojiPicker.collection &&
        String(emojiPicker.collection.id) === String(col.id);
      const cover = col.coverUrl ? absUrl(col.coverUrl) : '';
      return '<button type="button" class="pco-emoji-col' + (active ? ' is-active' : '') + '" ' +
        'data-act="emoji-col" data-id="' + esc(col.id) + '" ' +
        'title="' + esc(col.name || '表情合集') + '">' +
        (cover
          ? '<img src="' + esc(cover) + '" alt="" loading="lazy" />'
          : '<span>' + esc(String(col.name || '表').slice(0, 1)) + '</span>') +
      '</button>';
    }).join('');
    const colPrev = pop.querySelector('[data-act="emoji-col-prev"]');
    const colNext = pop.querySelector('[data-act="emoji-col-next"]');
    if (colPrev) colPrev.disabled = emojiPicker.colPage <= 0;
    if (colNext) colNext.disabled = emojiPicker.colPage >= colPages - 1;
    if (nameEl) nameEl.textContent = emojiPicker.collection ? (emojiPicker.collection.name || '') : '';

    if (emojiPicker.loading || (emojiPicker.itemLoading && !emojiPicker.items.length)) {
      gridEl.innerHTML = '';
      stateEl.hidden = false;
      stateEl.innerHTML = '<span>正在加载表情…</span>';
    } else if (emojiPicker.error && !emojiPicker.collections.length) {
      // 接口不可用时退回常用 emoji，保证回复框仍能插入表情
      gridEl.innerHTML = EMOJIS.map((e) =>
        '<button type="button" class="pco-emoji" data-act="emoji" data-emoji="' + esc(e) + '">' +
          esc(e) +
        '</button>'
      ).join('');
      stateEl.hidden = false;
      stateEl.innerHTML = '<span>' + esc(emojiPicker.error) + '</span>' +
        '<button type="button" class="pco-emoji-retry" data-act="emoji-retry">重试</button>';
    } else if (emojiPicker.itemError) {
      gridEl.innerHTML = '';
      stateEl.hidden = false;
      stateEl.innerHTML = '<span>' + esc(emojiPicker.itemError) + '</span>' +
        '<button type="button" class="pco-emoji-retry" data-act="emoji-retry">重试</button>';
    } else if (!emojiPicker.items.length) {
      gridEl.innerHTML = '';
      stateEl.hidden = false;
      stateEl.textContent = emojiPicker.collections.length
        ? '这个合集还没有表情'
        : '还没有可用的表情合集';
    } else {
      stateEl.hidden = true;
      stateEl.innerHTML = '';
      gridEl.innerHTML = emojiPicker.items.map((it) => {
        const src = it.imageUrl
          ? absUrl(it.imageUrl)
          : '/api/v1/emojis/' + encodeURIComponent(it.id) + '/image';
        return '<button type="button" class="pco-emoji-item" data-act="emoji-pick" ' +
          'data-id="' + esc(it.id) + '" title="插入表情">' +
          '<img src="' + esc(src) + '" alt="" loading="lazy" />' +
        '</button>';
      }).join('');
    }

    if (pageEl) pageEl.textContent = emojiPicker.page + ' / ' + Math.max(1, emojiPicker.pages);
    if (prev) prev.disabled = emojiPicker.page <= 1 || emojiPicker.itemLoading;
    if (next) next.disabled = emojiPicker.page >= emojiPicker.pages || emojiPicker.itemLoading;
    // 表情数量变化后高度会变，重新贴靠工具条
    if (openPopName === 'emoji') placePop();
  }

  // ---------------------------- 原生个人图盘 ----------------------------

  const imagePicker = {
    loading: false,
    error: '',
    files: [],
    nextCursor: '',
    hasNext: false,
    selected: '',
    quota: null,
    uploading: false,
    uploadPercent: 0,
    uploadError: '',
    reqId: 0,
    policy: null,
    policyAt: 0
  };

  function imageFileId(file) {
    if (!file) return '';
    return file.id || (file.file && file.file.id) || '';
  }

  function imageErrorMessage(err) {
    const status = err && err.status;
    if (status === 401) return '请先登录后使用个人图盘';
    if (status === 403) return '当前账号暂时无法使用个人图盘';
    if (status === 429) return '请求过于频繁，请稍后再试';
    if (status === 404) return '个人图盘接口暂不可用';
    return '个人图盘加载失败，请重试';
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function imageRemaining() {
    const q = imagePicker.quota;
    if (!q) return null;
    const candidates = [
      q.remainingBytes,
      q.remaining,
      q.availableBytes,
      q.storage && q.storage.remainingBytes
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const n = Number(candidates[i]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function openImagePicker() {
    const pop = root && root.querySelector('[data-role="image-pop"]');
    if (!pop) return;
    imagePicker.error = '';
    imagePicker.uploadError = '';
    imagePicker.selected = '';
    paintImagePicker();
    loadImageFiles(true);
    loadImageStorage();
  }

  async function loadImageFiles(reset) {
    if (!root || imagePicker.loading) return;
    const req = ++imagePicker.reqId;
    imagePicker.loading = true;
    imagePicker.error = '';
    if (reset) {
      imagePicker.files = [];
      imagePicker.nextCursor = '';
      imagePicker.hasNext = false;
    }
    paintImagePicker();
    try {
      let path = '/files?scope=OWN&state=READY';
      if (!reset && imagePicker.nextCursor) {
        path += '&cursor=' + encodeURIComponent(imagePicker.nextCursor);
      }
      const data = await apiSend(path, 'GET');
      if (req !== imagePicker.reqId || !root) return;
      const seen = new Set(imagePicker.files.map((f) => imageFileId(f)));
      listOf(data).forEach((file) => {
        const id = imageFileId(file);
        if (!id || seen.has(id)) return;
        seen.add(id);
        imagePicker.files.push(file);
      });
      const info = data && data.pageInfo;
      imagePicker.hasNext = !!(info && info.hasNextPage && info.nextCursor);
      imagePicker.nextCursor = (info && info.nextCursor) || '';
    } catch (err) {
      if (req !== imagePicker.reqId || !root) return;
      imagePicker.error = imageErrorMessage(err);
    } finally {
      if (req === imagePicker.reqId) {
        imagePicker.loading = false;
        paintImagePicker();
      }
    }
  }

  async function loadImageStorage() {
    try {
      const data = await apiSend('/file-storage', 'GET');
      if (!root) return;
      imagePicker.quota = data || null;
      paintImagePicker();
    } catch (e) { /* 容量读取失败不影响选择已有图片 */ }
  }

  function paintImagePicker() {
    if (!root) return;
    const pop = root.querySelector('[data-role="image-pop"]');
    if (!pop) return;
    const body = pop.querySelector('[data-role="image-body"]');
    const grid = pop.querySelector('[data-role="image-grid"]');
    const state = pop.querySelector('[data-role="image-state"]');
    const more = pop.querySelector('[data-role="image-more"]');
    const quotaEl = pop.querySelector('[data-role="image-quota"]');
    const uploadBtn = pop.querySelector('[data-act="image-upload"]');
    const confirmBtn = pop.querySelector('[data-act="image-confirm"]');
    if (!grid || !state) return;
    const scrollTop = body ? body.scrollTop : 0;

    grid.innerHTML = imagePicker.files.map((file) => {
      const id = imageFileId(file);
      const active = id && String(id) === String(imagePicker.selected);
      return '<button type="button" class="pco-image-cell' + (active ? ' is-active' : '') + '" ' +
        'data-act="image-pick" data-id="' + esc(id) + '" title="选择这张图片">' +
        '<img src="/api/v1/files/' + encodeURIComponent(id) + '" alt="" loading="lazy" />' +
      '</button>';
    }).join('');
    if (more) more.hidden = !imagePicker.hasNext;

    let stateHtml = '';
    if (imagePicker.uploading) {
      const pct = Math.max(0, Math.min(100, imagePicker.uploadPercent));
      stateHtml = '<span>正在上传 ' + pct + '%</span>' +
        '<span class="pco-image-progress"><i style="width:' + pct + '%"></i></span>';
    } else if (imagePicker.uploadError) {
      stateHtml = '<span class="is-err">' + esc(imagePicker.uploadError) + '</span>';
    } else if (imagePicker.loading && !imagePicker.files.length) {
      stateHtml = '<span>正在加载个人图盘…</span>';
    } else if (imagePicker.error && !imagePicker.files.length) {
      stateHtml = '<span class="is-err">' + esc(imagePicker.error) + '</span>' +
        '<button type="button" class="pco-image-retry" data-act="image-retry">重试</button>';
    } else if (!imagePicker.loading && !imagePicker.files.length) {
      stateHtml = '<span>个人图盘还没有图片，选择本地图片上传吧</span>';
    }
    state.hidden = !stateHtml;
    state.innerHTML = stateHtml;

    const remaining = imageRemaining();
    if (quotaEl) {
      if (Number.isFinite(remaining)) {
        quotaEl.textContent = remaining > 0 ? '剩余 ' + fmtBytes(remaining) : '图盘空间已满';
      } else {
        quotaEl.textContent = '';
      }
    }
    if (uploadBtn) {
      uploadBtn.disabled = imagePicker.uploading ||
        (Number.isFinite(remaining) && remaining <= 0) ||
        (imagePicker.error && imagePicker.error.indexOf('登录') !== -1);
      uploadBtn.textContent = imagePicker.uploading ? '上传中…' : '选择本地图片';
    }
    if (confirmBtn) confirmBtn.disabled = !imagePicker.selected || imagePicker.uploading;
    if (body) body.scrollTop = scrollTop;
    // 图盘内容 / 上传进度会改变面板高度，重新贴靠工具条
    if (openPopName === 'image') placePop();
  }

  function confirmImage() {
    if (!imagePicker.selected) return;
    if (insertAtCursor('![' + imagePicker.selected + ']')) closePops();
  }

  function newIdempotencyKey() {
    let key = '';
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) key = crypto.randomUUID();
    } catch (e) { /* noop */ }
    if (!key) key = 'pco-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    return key;
  }

  async function uploadImage(file) {
    if (!file || imagePicker.uploading) return;
    if (!/^image\//.test(file.type || '')) {
      toast('只能上传图片文件', 'err');
      return;
    }
    const remaining = imageRemaining();
    if (Number.isFinite(remaining) && remaining <= 0) {
      toast('个人图盘空间已满', 'err');
      return;
    }
    let policy = imagePicker.policy;
    if (!policy || Date.now() - imagePicker.policyAt > 60000) {
      try {
        policy = await apiSend('/file-upload-policy', 'GET');
        imagePicker.policy = policy;
        imagePicker.policyAt = Date.now();
      } catch (e) { policy = null; }
    }
    const rule = policy && (policy.policy || policy);
    const isAnimated = /gif|webp|apng/i.test(file.type || '');
    let max = Number(rule && (isAnimated ? rule.animatedMaxBytes : rule.staticMaxBytes));
    if (!Number.isFinite(max) || max <= 0) max = 20 * 1024 * 1024;
    if (file.size > max) {
      toast('图片超过 ' + fmtBytes(max) + ' 限制', 'err');
      return;
    }

    imagePicker.uploading = true;
    imagePicker.uploadPercent = 0;
    imagePicker.uploadError = '';
    paintImagePicker();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/files');
    xhr.withCredentials = true;
    xhr.timeout = 120000;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Idempotency-Key', newIdempotencyKey());
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      imagePicker.uploadPercent = pct;
      // 只更新进度条，避免每个进度事件都重绘整张图盘
      const state = root && root.querySelector('[data-role="image-state"]');
      const bar = state && state.querySelector('.pco-image-progress i');
      if (bar) bar.style.width = pct + '%';
      const label = state && state.querySelector('span');
      if (label) label.textContent = '正在上传 ' + pct + '%';
    };
    const finishUpload = (ok, data, status) => {
      imagePicker.uploading = false;
      imagePicker.uploadPercent = 0;
      if (!root) return;
      if (ok) {
        imagePicker.uploadError = '';
        const id = data && (data.id || (data.file && data.file.id));
        if (!id) {
          imagePicker.uploadError = '上传失败：服务没有返回图片编号';
          paintImagePicker();
          return;
        }
        imagePicker.selected = id;
        if (insertAtCursor('![' + id + ']')) {
          closePops();
          toast('图片已插入');
        } else {
          imagePicker.uploadError = '图片已上传，但插入失败，请从图盘中选择';
          paintImagePicker();
        }
        loadImageFiles(true);
        loadImageStorage();
        return;
      }
      const msg = (data && (data.message || data.reasonCode || data.code)) ||
        (status ? '上传失败 HTTP ' + status : '上传失败，请检查网络');
      imagePicker.uploadError = msg;
      toast('图片上传失败：' + msg, 'err');
      paintImagePicker();
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText || 'null'); } catch (e) { data = null; }
      finishUpload(xhr.status >= 200 && xhr.status < 300, data, xhr.status);
    };
    xhr.onerror = () => finishUpload(false, null, 0);
    xhr.ontimeout = () => finishUpload(false, null, 0);
    const form = new FormData();
    form.append('ownership', 'PERSONAL');
    form.append('file', file);
    xhr.send(form);
  }

  // ---------------------------- 全屏回复编辑器 ----------------------------

  function composerNode() {
    return root && root.querySelector('.pco-composer');
  }

  function fillComposerFullHeader() {
    if (!root) return;
    const target = root.querySelector('[data-role="cf-target"]');
    const topicEl = root.querySelector('[data-role="cf-topic"]');
    const t = view && view.replyTo;
    if (target) {
      target.textContent = t ? (t.name ? '回复 @' + t.name : '回复 #' + t.no) : '写回复';
    }
    if (topicEl) topicEl.textContent = (view && view.topic && view.topic.title) || '';
  }

  // ---------- 全屏排版工具栏：布局切换 / 字数 / 拖拽上传 ----------
  /** 三种工具栏布局，与帖子编辑页共用同一个存储键：compact → line → groups */
  const TB_KEY = 'pcr_toolbar_style';
  const TB_MODES = ['compact', 'line', 'groups'];
  const TB_NAMES = { compact: '紧凑', line: '分组线', groups: '功能组' };

  function readTbStyle() {
    try {
      const v = localStorage.getItem(TB_KEY);
      return TB_MODES.indexOf(v) > -1 ? v : 'compact';
    } catch (e) { return 'compact'; }
  }

  /** 只切类名、不重建 DOM，与帖子编辑页的工具栏布局行为一致 */
  function applyTbStyle(style, animate) {
    const layer = root && root.querySelector('[data-role="composer-full"]');
    if (!layer) return;
    const s = TB_MODES.indexOf(style) > -1 ? style : 'compact';
    layer.classList.toggle('is-tb-grouped', s !== 'compact');
    layer.classList.toggle('is-tb-labels', s === 'groups');
    const btn = layer.querySelector('[data-act="composer-layout"]');
    if (btn) {
      btn.classList.toggle('is-on', s !== 'compact');
      btn.setAttribute('title', '工具栏布局：' + TB_NAMES[s] + '（点击切换）');
    }
    if (animate) {
      const tb = layer.querySelector('.pco-ed-toolbar');
      if (tb) {
        tb.classList.remove('is-tb-anim');
        void tb.offsetWidth;
        tb.classList.add('is-tb-anim');
      }
    }
  }

  function cycleTbStyle() {
    const next = TB_MODES[(TB_MODES.indexOf(readTbStyle()) + 1) % TB_MODES.length];
    try { localStorage.setItem(TB_KEY, next); } catch (e) { /* noop */ }
    applyTbStyle(next, true);
  }

  /** 全屏头部的字数：按去掉空白后的字符数统计 */
  function paintComposerCount() {
    const el = root && root.querySelector('[data-role="cf-count"]');
    if (!el) return;
    const n = composerMarkdown().replace(/\s+/g, '').length;
    el.textContent = n + ' 字';
  }

  /** 拖拽图片到回复框直接上传，与帖子编辑页一致 */
  function hasImageFiles(dt) {
    if (!dt || !dt.types) return false;
    if (Array.prototype.indexOf.call(dt.types, 'Files') === -1) return false;
    const items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    return items.length
      ? items.some((it) => it.kind === 'file' && /^image\//.test(it.type))
      : true;
  }

  function bindComposerDrop(host) {
    if (!host || host.__pcoDropBound) return;
    host.__pcoDropBound = true;
    const clear = () => host.classList.remove('is-dragover');
    host.addEventListener('dragover', (e) => {
      if (!hasImageFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      host.classList.add('is-dragover');
    });
    host.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      clear();
    });
    host.addEventListener('drop', (e) => {
      if (!hasImageFiles(e.dataTransfer)) return;
      e.preventDefault();
      clear();
      const files = Array.prototype.slice.call(e.dataTransfer.files || [])
        .filter((f) => /^image\//.test(f.type || ''));
      files.slice(0, 4).forEach((f) => uploadImage(f));
    });
  }

  function toggleComposerFull(force, immediate) {
    if (!root) return;
    const on = force === undefined ? !composerFull : !!force;
    if (on === composerFull) return;
    const node = composerNode();
    const box = root.querySelector('.pco-composer-box');
    const layer = root.querySelector('[data-role="composer-full"]');
    const body = layer && layer.querySelector('[data-role="cf-body"]');
    if (!node || !box || !layer || !body) return;
    if (composerAnimTimer) {
      clearTimeout(composerAnimTimer);
      composerAnimTimer = null;
    }
    const btn = root.querySelector('[data-act="composer-full"]');
    const ta = composerInput();

    if (on) {
      closePops();
      node.style.transition = '';
      node.style.transform = '';
      node.style.transformOrigin = '';
      composerHome = node.parentNode;
      composerAnchor = document.createComment('pco-composer-home');
      if (composerHome) composerHome.insertBefore(composerAnchor, node);
      const first = node.getBoundingClientRect();
      layer.hidden = false;
      layer.style.background = '';
      layer.style.pointerEvents = '';
      body.appendChild(node);
      root.classList.add('is-composer-full');
      box.classList.add('pco-composer-box--full');
      composerFull = true;
      // 锁住页面滚动，避免全屏时背景还在跟着滚
      if (composerPageOverflow === null) {
        composerPageOverflow = document.documentElement.style.overflow || '';
        document.documentElement.style.overflow = 'hidden';
      }
      fillComposerFullHeader();
      applyTbStyle(readTbStyle(), false);
      paintComposerCount();
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('title', '退出全屏编辑');
      }
      const last = node.getBoundingClientRect();
      if (!immediate && !reducedMotion() && first.width > 0 && last.width > 0 && last.height > 0) {
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const sx = first.width / last.width;
        const sy = first.height / last.height;
        node.style.transformOrigin = 'top left';
        node.style.transition = 'none';
        node.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' +
          sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
        void node.offsetWidth;
        node.style.transition = 'transform ' + sec(0.38) + ' var(--pco-ease)';
        node.style.transform = '';
        composerAnimTimer = setTimeout(() => {
          composerAnimTimer = null;
          if (!root || !composerFull) return;
          node.style.transition = '';
          node.style.transform = '';
          node.style.transformOrigin = '';
        }, 430 / animSpeed + 40);
      }
      if (ta) {
        if (composerEditor) composerEditor.focusEnd();
        else ta.focus();
      }
      return;
    }

    // 退出全屏：把回复框搬回原位，并从全屏尺寸收回
    const first = node.getBoundingClientRect();
    layer.style.background = 'transparent';
    layer.style.pointerEvents = 'none';
    if (composerHome && composerAnchor && composerAnchor.parentNode === composerHome) {
      composerHome.insertBefore(node, composerAnchor);
    }
    if (composerAnchor && composerAnchor.parentNode) {
      composerAnchor.parentNode.removeChild(composerAnchor);
    }
    composerHome = null;
    composerAnchor = null;
    box.classList.remove('pco-composer-box--full');
    composerFull = false;
    root.classList.remove('is-composer-full');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('title', '全屏编辑');
    }
    if (ta) growComposer(ta);
    const last = node.getBoundingClientRect();
    const finish = () => {
      layer.hidden = true;
      layer.style.background = '';
      layer.style.pointerEvents = '';
      node.style.transition = '';
      node.style.transform = '';
      node.style.transformOrigin = '';
      if (composerPageOverflow !== null) {
        document.documentElement.style.overflow = composerPageOverflow;
        composerPageOverflow = null;
      }
      if (ta) {
        if (composerEditor) composerEditor.focusEnd();
        else ta.focus();
      }
    };
    if (immediate || reducedMotion() || first.width <= 0 || last.width <= 0 || last.height <= 0) {
      finish();
      return;
    }
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    node.style.transformOrigin = 'top left';
    node.style.transition = 'none';
    node.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' +
      sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    void node.offsetWidth;
    node.style.transition = 'transform ' + sec(0.34) + ' var(--pco-ease)';
    node.style.transform = '';
    composerAnimTimer = setTimeout(() => {
      composerAnimTimer = null;
      if (!root) return;
      finish();
    }, 380 / animSpeed + 40);
  }

  // ---------------------------- AI 助手 ----------------------------

  function loadAiConfig() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['pcai_config'], (raw) => {
        const saved = (raw && raw.pcai_config) || {};
        aiConfig = Object.assign(
          { aiEnabled: true, enabled: true, aiReply: true, provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
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
    if (aiCommitFrame) {
      cancelAnimationFrame(aiCommitFrame);
      aiCommitFrame = 0;
    }
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
    if (aiConfig.aiEnabled === false || aiConfig.aiReply === false) return;
    if (!view || !view.topic || aiBusy) return;
    const ta = composerInput();
    if (!ta) return;

    const draft = composerEditor
      ? composerEditor.getMarkdown()
      : String(ta.textContent || '').trim();
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
      if (!text) return;
      // 流式输出按帧合并，避免每个 chunk 都重绘整篇富文本
      if (aiCommitFrame) return;
      aiCommitFrame = requestAnimationFrame(() => {
        aiCommitFrame = 0;
        if (!root) return;
        if (composerEditor) composerEditor.setMarkdown(acc.trim());
        else ta.textContent = acc.trim();
        growComposer(ta);
      });
    };

    const restoreDraft = () => {
      if (composerEditor) composerEditor.setMarkdown(draft);
      else ta.textContent = draft;
      growComposer(ta);
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
          if (kind === 'polish' && draft) restoreDraft();
        } else {
          commit();
          setAiStatus('已生成，可直接发送或再修改');
          if (composerEditor) composerEditor.focusEnd();
          else ta.focus();
        }
      },
      onError: (err) => {
        aiBusy = false;
        const message = (err && err.message) || '生成失败，请重试';
        setAiStatus(message);
        toast(message, 'err');
        if (kind === 'polish' && draft) restoreDraft();
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

  // ---------------------------- AI 助手 ----------------------------

  function aiPanelParts() {
    if (!root) return null;
    return {
      out: root.querySelector('[data-role="ai-panel-out"]'),
      status: root.querySelector('[data-role="ai-panel-status"]'),
      stop: root.querySelector('[data-act="ai-stop"]'),
      copy: root.querySelector('[data-act="ai-copy"]')
    };
  }

  function setAiPanelStatus(text) {
    const parts = aiPanelParts();
    if (parts && parts.status) parts.status.textContent = text;
  }

  /** streaming = true 时按纯文本跟流，结束后再用轻量 Markdown 渲染 */
  function paintAiPanel(streaming) {
    const parts = aiPanelParts();
    if (!parts || !parts.out) return;
    if (streaming) parts.out.textContent = aiPanelText;
    else parts.out.innerHTML = aiPanelText ? mdRender(aiPanelText) : '';
    const hasText = !!String(aiPanelText || '').trim();
    parts.out.classList.toggle('is-empty', !hasText);
    // 还没有任何正文时不显示输出区，避免空态虚线框和占位高度
    parts.out.hidden = !hasText;
    if (parts.stop) parts.stop.hidden = !aiPanelBusy;
    if (parts.copy) parts.copy.hidden = aiPanelBusy || !hasText;
    parts.out.scrollTop = parts.out.scrollHeight;
    // 空态整块隐藏；有内容或生成中才占版面
    syncAiPanelVisibility();
  }

  function runAiPanel() {
    if (!aiFeatureOn('summary')) return;
    if (!root || !view || !view.topic || aiBusy) return;

    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama' && aiConfig.provider !== 'custom') {
      setAiPanelStatus('还没有配置 API Key，请到扩展设置里填写模型与密钥');
      toast('请先在扩展设置里配置 AI 模型与密钥', 'err');
      return;
    }
    const port = ensureAiPort();
    if (!port) {
      setAiPanelStatus('扩展后台不可用，请刷新页面后重试');
      return;
    }

    aiPanelText = '';
    aiPanelBusy = true;
    aiBusy = true;
    setAiPanelStatus('正在阅读正文并总结…');
    paintAiPanel(true);

    const id = 'p' + (++aiSeq);
    let acc = '';
    aiPending = {
      id: id,
      onChunk: (delta) => {
        acc += delta;
        aiPanelText = acc;
        paintAiPanel(true);
      },
      onDone: (msg) => {
        aiBusy = false;
        aiPanelBusy = false;
        acc = (msg && msg.text) || acc;
        aiPanelText = acc.trim();
        paintAiPanel(false);
        setAiPanelStatus(aiPanelText
          ? ((msg && msg.cached) ? '已读取缓存总结' : '生成完成')
          : '模型没有返回内容，请重试');
        // 没有内容时面板会整块隐藏，用 toast 兜住这条提示
        if (!aiPanelText) toast('模型没有返回内容，请重试', 'err');
      },
      onError: (msg) => {
        aiBusy = false;
        aiPanelBusy = false;
        paintAiPanel(false);
        const text = (msg && msg.message) || '生成失败，请重试';
        setAiPanelStatus(text);
        if (!aiPanelText) toast(text, 'err');
      }
    };

    try {
      const messages = summaryMessages(view.topic);
      port.postMessage({
        type: 'start',
        id: id,
        messages: messages,
        cacheKey: summaryCacheKey(messages)
      });
    } catch (e) {
      aiPending = null;
      aiBusy = false;
      aiPanelBusy = false;
      paintAiPanel(false);
      setAiPanelStatus('后台连接失败，请重新加载页面后再试');
    }
  }

  function copyAiPanel() {
    if (!aiPanelText) return;
    try {
      navigator.clipboard.writeText(aiPanelText).then(
        () => toast('已复制到剪贴板', 'ok'),
        () => toast('复制失败，请手动选择', 'err')
      );
    } catch (e) {
      toast('复制失败，请手动选择', 'err');
    }
  }

  function aiOut() {
    return root && root.querySelector('[data-role="ai-out"]');
  }

  /** 轻量哈希（djb2）：与 ai/content.js 的缓存键算法一致，浮层与帖子页可共用同一份缓存 */
  function aiHash(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** 总结缓存：与后台同一个存储键，浮层只读不写，清缓存仍由设置页负责 */
  const AI_CACHE_KEY = 'pcai_cache';

  /**
   * 打开 / 切回帖子时恢复已生成的总结。
   * 读的是后台写入的同一份缓存、同一个键，所以：
   *  - 关闭浮层、切走再切回不会丢内容，也不会重新发模型请求；
   *  - 设置页「清空总结缓存」后自然读不到，回到空态；
   *  - 正文或模型变化时缓存键随之变化，不会误用旧结果；
   *  - AI 总开关 / 帖子总结关闭时直接跳过，既不读缓存也不显示。
   */
  function restoreAiSummary(topic) {
    if (!root || !topic || aiPanelBusy || !aiFeatureOn('summary')) return;
    const key = summaryCacheKey(summaryMessages(topic), topic);
    readCachedSummary(key, (text) => {
      // 异步回来时可能已经切帖 / 关闭浮层，必须再确认一次归属
      if (!root || !view || view.topic !== topic || aiPanelBusy) return;
      if (!text) { syncAiPanelVisibility(); return; }
      aiPanelText = text;
      paintAiPanel(false);
      setAiPanelStatus('已读取缓存总结');
    });
  }

  /** 从 chrome.storage 读取一条总结缓存；失败或关闭时一律当作没有 */
  function readCachedSummary(key, done) {
    if (!key || !aiFeatureOn('summary')) { done(''); return; }
    try {
      chrome.storage.local.get(AI_CACHE_KEY, (raw) => {
        if (chrome.runtime.lastError) { done(''); return; }
        const box = raw && raw[AI_CACHE_KEY];
        const item = box && box[key];
        done(item && item.text ? String(item.text) : '');
      });
    } catch (e) {
      done('');
    }
  }

  /** 总结缓存键：帖子 + 模型 + 实际发出的提示词；正文或模型变化时自动失效 */
  function summaryCacheKey(messages, topic, cfgOpt) {
    const t = topic || (view && view.topic) || null;
    const cfg = cfgOpt || aiConfig || {};
    const model = cfg.model || '';
    const payload = model + '|' + messages.map((m) => m.content).join('\n');
    const postId = (t && t.id) || '';
    return 'sum:' + postId + ':' + aiHash(payload);
  }

  /** 总结用的提示词：与 ai/content.js 的默认模板一致，优先使用设置里自定义的版本 */
  function summaryMessages(topic, cfgOpt) {
    const cfg = cfgOpt || aiConfig || {};
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

  // ---------------- 开放接口 v1.0：post.summarize ----------------

  const API_SUMMARY_TIMEOUT = 90000;   // 比 post.context 宽松，后台按长耗时 90 秒处理

  /** 接口调用时实时读取 AI 配置，不依赖页面初始化时的快照 */
  function apiLoadAiConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('pcai_config', (raw) => {
          void chrome.runtime.lastError;
          const saved = raw && raw.pcai_config;
          resolve(Object.assign(
            { aiEnabled: true, enabled: true, aiReply: true, provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
            saved || {}
          ));
        });
      } catch (e) {
        resolve(Object.assign({}, aiConfig || {}));
      }
    });
  }

  /** 只读缓存：写入仍由后台在模型返回后统一完成 */
  function apiCachedSummary(key) {
    return new Promise((resolve) => {
      if (!key) { resolve(null); return; }
      try {
        chrome.storage.local.get(AI_CACHE_KEY, (raw) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          const box = raw && raw[AI_CACHE_KEY];
          const item = box && box[key];
          resolve(item && item.text ? item : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * 独立端口调用一次模型：不复用 aiPending，避免和面板里正在流式生成的请求互相覆盖。
   * 超时 / 断开 / 错误都返回明确错误码，避免调用方无限等待。
   */
  function apiAiOnce(messages, cacheKey, timeoutMs) {
    return new Promise((resolve) => {
      let port = null;
      let settled = false;
      const id = 'api' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (port) port.disconnect(); } catch (e) { /* 忽略 */ }
        resolve(res);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, code: 'AI_TIMEOUT', message: 'AI 总结超时，请稍后重试' });
      }, timeoutMs);
      try {
        port = chrome.runtime.connect({ name: 'pcai' });
      } catch (e) {
        finish({ ok: false, code: 'NOT_READY', message: '扩展后台不可用' });
        return;
      }
      port.onMessage.addListener((msg) => {
        if (!msg || msg.id !== id) return;
        if (msg.type === 'chunk') return;
        if (msg.type === 'done') {
          const text = String(msg.text || '').trim();
          if (!text) {
            finish({ ok: false, code: 'AI_EMPTY', message: '模型返回了空内容' });
            return;
          }
          finish({ ok: true, text, cached: !!msg.cached, usage: msg.usage || null });
          return;
        }
        if (msg.type === 'error') {
          finish({ ok: false, code: msg.code || 'AI_ERROR', message: msg.message || 'AI 请求失败' });
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish({ ok: false, code: 'NOT_READY', message: 'AI 后台连接已断开' });
      });
      try {
        port.postMessage({ type: 'start', id, messages, cacheKey, bypass: false });
      } catch (e) {
        finish({ ok: false, code: 'NOT_READY', message: String((e && e.message) || e) });
      }
    });
  }

  /** 对当前帖子做 AI 总结：命中缓存直接返回，未命中才调用模型 */
  async function apiPostSummarize(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    let postId = typeof p.postId === 'string' ? p.postId.trim().slice(0, 128) : '';
    if (!postId) postId = apiPostIdFromLocation();
    if (!postId && view && view.topic && view.topic.id) postId = String(view.topic.id);
    if (!postId && current && current.id) postId = String(current.id);
    if (!postId) {
      return { ok: false, code: 'UNSUPPORTED_CONTEXT', message: '当前页面没有可总结的帖子' };
    }

    const cfg = await apiLoadAiConfig();
    if (cfg.aiEnabled === false) {
      return { ok: false, code: 'AI_DISABLED', message: 'AI 功能已在设置中关闭' };
    }
    if (cfg.enabled === false) {
      return { ok: false, code: 'AI_DISABLED_FEATURE', message: '帖子总结已在设置中关闭' };
    }

    let topic = null;
    try {
      const openTopic = view && view.topic && String(view.topic.id) === String(postId) ? view.topic : null;
      topic = openTopic || await apiFetchTopic(postId);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/HTTP 404/.test(msg)) {
        return { ok: false, code: 'NOT_FOUND', message: '没有找到该帖子' };
      }
      if (/HTTP 401|HTTP 403/.test(msg)) {
        return { ok: false, code: 'UNAUTHORIZED', message: '没有权限读取该帖子' };
      }
      return { ok: false, code: 'FETCH_FAILED', message: '读取帖子失败：' + msg };
    }
    if (!topic || !topic.id) {
      return { ok: false, code: 'NOT_FOUND', message: '没有找到该帖子' };
    }
    if (!topic.firstPost || !topic.firstPost.cookedHtml) {
      return { ok: false, code: 'EMPTY_POST', message: '该帖子没有可总结的正文' };
    }

    const messages = summaryMessages(topic, cfg);
    const key = summaryCacheKey(messages, topic, cfg);
    const hit = await apiCachedSummary(key);
    if (hit) {
      const text = String(hit.text || '');
      return {
        ok: true,
        code: 'OK',
        data: {
          postId: String(topic.id),
          summary: text,
          cached: true,
          length: text.length,
          model: hit.model || cfg.model || ''
        }
      };
    }

    if (!cfg.apiKey && cfg.provider !== 'ollama' && cfg.provider !== 'custom') {
      return { ok: false, code: 'AI_NOT_CONFIGURED', message: '还没有配置 AI 模型与 API Key' };
    }

    const res = await apiAiOnce(messages, key, API_SUMMARY_TIMEOUT);
    if (!res.ok) return res;
    return {
      ok: true,
      code: 'OK',
      data: {
        postId: String(topic.id),
        summary: res.text,
        cached: !!res.cached,
        length: res.text.length,
        model: cfg.model || ''
      }
    };
  }

  /** 在 AI 面板里流式生成帖子总结，结果只展示、不写入回复框 */
  function runSummary() {
    if (!aiFeatureOn('summary')) return;
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
    // 同一帖子已经出过结果时，再点一次视为「重新生成」，绕过缓存
    const force = !!(out && out.dataset.donePost === String(view.topic.id));

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
          if (out) out.dataset.donePost = String(view.topic.id);
          setAiStatus((msg && msg.cached) ? '已读取缓存总结' : '总结完成，可再次点击重新生成');
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
      const messages = summaryMessages(view.topic);
      port.postMessage({ type: 'start', id: id, messages: messages,
        cacheKey: summaryCacheKey(messages), bypass: force });
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
      insertPoint = null;
      growComposer(el);
    }
  }

  function onRootChange(e) {
    const el = e.target;
    if (!el || !el.getAttribute || el.getAttribute('data-role') !== 'image-file') return;
    const file = el.files && el.files[0];
    el.value = '';
    if (file) uploadImage(file);
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
    const btn = e.target.closest && e.target.closest('.pco-composer-tools button, .pco-pop button');
    if (btn) e.preventDefault();
    // 未开启文本选中时在正文里按下：记下起点，拖动超过阈值再提示
    if (!selectOn && !btn && e.target.closest && e.target.closest('.pco-post-body')) {
      selectProbe = { x: e.clientX, y: e.clientY };
    }
  }

  /** 正文拖选探测：默认 user-select:none 下不会产生 selection，只能靠拖动距离判断 */
  function onRootMouseMoveProbe(e) {
    if (!selectProbe) return;
    if (Math.abs(e.clientX - selectProbe.x) + Math.abs(e.clientY - selectProbe.y) > 8) {
      selectProbe = null;
      guideNotify('select-blocked');
    }
  }

  /** 回复框获得焦点：用于「回复工具条默认关闭」的场景气泡 */
  function onRootFocusIn(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-role="composer"]')) {
      guideNotify('composer-focus', { toolsEnabled: composerToolsEnabled });
    }
  }

  /** 未开启文本选中时禁止拖动图片（含被链接包裹的图片），避免拽出半透明残影 */
  function onRootDragStart(e) {
    if (selectOn || !root) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const a = t.closest('a');
    if (t.closest('img') || (a && a.querySelector('img'))) e.preventDefault();
  }

  function bind() {
    root.addEventListener('click', onRootClick);
    root.addEventListener('change', onRootChange);
    root.addEventListener('dragstart', onRootDragStart);
    root.addEventListener('focusin', onRootFocusIn);
    root.addEventListener('input', onRootInput);
    root.addEventListener('keydown', onRootKeydown);
    root.addEventListener('mousedown', onRootMouseDown);
    root.addEventListener('mousemove', onRootMouseMoveProbe);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
  }

  /* ---------------- 信息流卡片 3D 倾斜 ----------------
   * 悬停时卡片随指针位置轻微俯仰 / 偏航；用 rAF 缓动插值，不写 CSS transition，
   * 这样既不覆盖站点自己的 hover 过渡，也不和浮层开合时写给卡片的 transform 打架。
   * 悬停期间矩形只在进入时量一次：用倾斜后的矩形反推指针比例会自我反馈、越抖越厉害。 */

  const TILT_CARD_SEL = 'article[data-slot="root"]';
  const TILT_MAX_X = 12;            // 俯仰最大角（度）
  const TILT_MAX_Y = 16;            // 偏航最大角（度）

  let tiltCard = null;              // 当前正在倾斜的卡片
  let tiltRect = null;              // 进入时量下的未变形矩形
  let tiltRaf = 0;
  let tiltInside = false;           // 指针是否还在卡片上（决定缓动目标）
  const tiltTo = { x: 0, y: 0 };    // 目标角度
  const tiltAt = { x: 0, y: 0 };    // 插值后的当前角度

  function tiltTick() {
    tiltRaf = 0;
    if (!tiltCard) return;
    // 卡片被浮层接管（originCard）或浮层已开：倾斜引擎立刻松手，样式归浮层管
    if (tiltCard === originCard || root) {
      tiltCard = null;
      tiltInside = false;
      return;
    }
    const ease = tiltInside ? 0.24 : 0.16;
    tiltAt.x += (tiltTo.x - tiltAt.x) * ease;
    tiltAt.y += (tiltTo.y - tiltAt.y) * ease;
    if (!tiltInside && Math.abs(tiltAt.x) < 0.03 && Math.abs(tiltAt.y) < 0.03) {
      tiltCard.style.transform = '';
      tiltCard.style.boxShadow = '';
      tiltCard.style.willChange = '';
      tiltCard = null;
      tiltRect = null;
      return;
    }
    // 透视拉近到 700px + 随倾角偏移的阴影，让 3D 体感一眼可辨；
    // 阴影跟随倾斜方向轻微位移，淡且小，不抢画面
    const shadowDx = (tiltAt.y / TILT_MAX_Y) * 3;
    const shadowDy = (tiltAt.x / TILT_MAX_X) * 3 + 2;
    const shadowBlur = 6 + (Math.abs(tiltAt.x) + Math.abs(tiltAt.y)) * 0.4;
    tiltCard.style.transform =
      'perspective(700px) rotateX(' + tiltAt.x.toFixed(2) + 'deg) rotateY(' + tiltAt.y.toFixed(2) + 'deg)';
    tiltCard.style.boxShadow =
      shadowDx.toFixed(1) + 'px ' + shadowDy.toFixed(1) + 'px ' + shadowBlur.toFixed(1) +
      'px rgba(0,0,0,0.10)';
    tiltRaf = requestAnimationFrame(tiltTick);
  }

  function tiltSchedule() {
    if (!tiltRaf && tiltCard) tiltRaf = requestAnimationFrame(tiltTick);
  }

  /** 让当前倾斜的卡片缓动回正（不改开关状态） */
  function tiltRelease() {
    if (!tiltCard) return;
    tiltInside = false;
    tiltTo.x = 0;
    tiltTo.y = 0;
    tiltSchedule();
  }

  /** 立刻摘掉指定卡片的倾斜（打开浮层量矩形前调用，保证量到未变形的尺寸） */
  function clearCardTilt(card) {
    if (!card) return;
    if (tiltCard === card) {
      tiltCard = null;
      tiltRect = null;
      tiltInside = false;
      if (tiltRaf) { cancelAnimationFrame(tiltRaf); tiltRaf = 0; }
      tiltAt.x = 0; tiltAt.y = 0; tiltTo.x = 0; tiltTo.y = 0;
    }
    // originCard 的内联样式归浮层开合动画管，这里不碰
    if (card !== originCard) {
      card.style.transform = '';
      card.style.boxShadow = '';
      card.style.willChange = '';
    }
  }

  function onTiltMove(e) {
    const off = !cardTiltOn || !overlayEnabled || !!root || closing ||
      reducedMotion() || e.pointerType === 'touch';
    if (off) { tiltRelease(); return; }
    const t = e.target instanceof Element ? e.target : null;
    const card = t && t.closest ? t.closest(TILT_CARD_SEL) : null;
    if (!card || card === originCard) { tiltRelease(); return; }
    if (card !== tiltCard) {
      if (tiltCard) {   // 换卡：旧卡直接复位，不等缓动
        tiltCard.style.transform = '';
        tiltCard.style.boxShadow = '';
        tiltCard.style.willChange = '';
        if (tiltRaf) { cancelAnimationFrame(tiltRaf); tiltRaf = 0; }
      }
      tiltCard = card;
      tiltRect = card.getBoundingClientRect();
      tiltAt.x = 0; tiltAt.y = 0;
      card.style.willChange = 'transform';
    }
    const r = tiltRect;
    if (!r || r.width < 2 || r.height < 2) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    tiltTo.x = (0.5 - py) * TILT_MAX_X;
    tiltTo.y = (px - 0.5) * TILT_MAX_Y;
    tiltInside = true;
    tiltSchedule();
  }

  function onTiltOut(e) {
    // 指针离开窗口：pointermove 不再触发，靠这里把卡片放回去
    if (!e.relatedTarget) tiltRelease();
  }

  // ============================ 9. 开关 ============================

  /** 按设置显隐回复框工具条；关闭时整条移除（不占高度） */
  function syncComposerTools() {
    const tools = root && root.querySelector('[data-role="tools"]');
    if (!tools) return;
    tools.hidden = !composerToolsEnabled;
    if (!composerToolsEnabled) {
      if (composerFull) toggleComposerFull(false, true);
      closePops();
    }
  }

  /** 应用设置：关闭时立即收起已打开的浮层，之后的点击恢复站点跳转 */
  function applyOverlaySetting(cfg) {
    overlayEnabled = !(cfg && cfg.enabled === false);
    composerToolsEnabled = !!(cfg && cfg.composerTools);
    blurOn = !(cfg && cfg.blur === false);
    pageScaleOn = !(cfg && cfg.pageScale === false);
    // 动画速度：0.5–2 倍，非法值回落到标准速度
    const speed = Number(cfg && cfg.animSpeed);
    animSpeed = Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1;
    cardTiltOn = !(cfg && cfg.cardTilt === false);
    openTiltOn = !(cfg && cfg.openTilt === false);
    if (!cardTiltOn && tiltCard) clearCardTilt(tiltCard);

    // 全屏偏好：默认全屏，用户手动退出后沿用他的选择；切帖复用同一个 fullOn，不退回默认
    const wantFull = !(cfg && cfg.fullscreen === false);
    if (wantFull !== fullOn) {
      fullOn = wantFull;
      if (root) {
        root.classList.toggle('is-full', fullOn);
        paintViewControls();
        scheduleNavOffset();
      }
    }

    if (!overlayEnabled && root) {
      cleanup();
      return;
    }

    syncComposerTools();
    if (root) {
      root.classList.toggle('pco-no-blur', !blurOn);
      root.style.setProperty('--pco-dur', String(1 / animSpeed));
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

  // AI 开关改动：立即隐藏 / 恢复入口，关闭时中断请求并清掉已生成内容
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.pcai_config) return;
      aiConfig = Object.assign(
        { aiEnabled: true, enabled: true, aiReply: true, provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
        changes.pcai_config.newValue || {}
      );
      applyAiAvailability();
    });
  } catch (e) { /* noop */ }

  // 开放接口 v1.0：post.context —— 按 postId 或当前打开的帖子返回基础信息
  const POST_CONTEXT_MAX = 100000;  // 正文 Markdown 上限（字符），超出截断并标记
  const POST_CONTEXT_FIELDS = ['id', 'title', 'author', 'createdAt', 'replyCount', 'url', 'body'];

  /** 从当前页面 URL 推断帖子 id（详情页 /forum/post/:id） */
  function apiPostIdFromLocation() {
    try {
      const m = String(location.pathname || '').match(POST_HREF);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
  }

  /** 优先复用浮层已加载的帖子，避免重复请求 */
  async function apiFetchTopic(topicId) {
    const hit = cache.get(topicId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.topic;
    const topic = await fetchJson('/api/v1/topics/' + encodeURIComponent(topicId));
    cache.set(topicId, { topic: topic, at: Date.now() });
    return topic;
  }

  /** 帖子正文 HTML → Markdown；转换器不可用时降级为纯文本 */
  function apiPostBodyMarkdown(topic) {
    const html = topic && topic.firstPost && topic.firstPost.cookedHtml;
    if (!html) return '';
    let out = '';
    try {
      const div = document.createElement('div');
      div.innerHTML = String(html);
      div.querySelectorAll('script,style,iframe,link,meta,noscript,svg,canvas,video,audio')
        .forEach((el) => el.remove());
      const convert = window.PCOEditor && typeof window.PCOEditor.htmlToMd === 'function'
        ? window.PCOEditor.htmlToMd : null;
      out = convert ? String(convert(div) || '') : String(div.textContent || '');
    } catch (e) {
      out = '';
    }
    return out.trim();
  }

  /** 只回白名单字段；body 在请求时才包含 */
  function apiShapePost(topic, requested) {
    const first = topic.firstPost || {};
    const author = topic.author || {};
    const wanted = requested && requested.length ? requested : POST_CONTEXT_FIELDS;
    const data = { id: String(topic.id || '') };
    if (wanted.indexOf('title') !== -1) data.title = String(topic.title || '');
    if (wanted.indexOf('author') !== -1) {
      data.author = { id: String(author.id || ''), username: String(author.username || '') };
    }
    if (wanted.indexOf('createdAt') !== -1) data.createdAt = String(topic.createdAt || '');
    if (wanted.indexOf('replyCount') !== -1) data.replyCount = Number(topic.replyCount) || 0;
    if (wanted.indexOf('url') !== -1) data.url = location.origin + '/forum/post/' + encodeURIComponent(data.id);
    if (wanted.indexOf('body') !== -1) {
      const full = apiPostBodyMarkdown(topic);
      data.bodyLength = full.length;
      data.bodyTruncated = full.length > POST_CONTEXT_MAX;
      data.body = data.bodyTruncated ? full.slice(0, POST_CONTEXT_MAX) : full;
      data.floor = Number(first.postNumber) || null;
    }
    return data;
  }

  async function apiPostContext(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    let postId = typeof p.postId === 'string' ? p.postId.trim().slice(0, 128) : '';
    // 未指定 postId 时：详情页取路径 id，信息流页取当前浮层打开的帖子
    if (!postId) postId = apiPostIdFromLocation();
    if (!postId && view && view.topic && view.topic.id) postId = String(view.topic.id);
    if (!postId && current && current.id) postId = String(current.id);
    if (!postId) {
      return { ok: false, code: 'UNSUPPORTED_CONTEXT', message: '当前页面没有可读取的帖子' };
    }

    // 字段白名单：只接受已知字段，避免把内部结构透给第三方
    const requested = Array.isArray(p.fields)
      ? p.fields.filter((f) => typeof f === 'string' && POST_CONTEXT_FIELDS.indexOf(f) !== -1)
      : [];

    try {
      const openTopic = view && view.topic && String(view.topic.id) === String(postId) ? view.topic : null;
      const topic = openTopic || await apiFetchTopic(postId);
      if (!topic || !topic.id) {
        return { ok: false, code: 'NOT_FOUND', message: '没有找到该帖子' };
      }
      return { ok: true, code: 'OK', data: apiShapePost(topic, requested) };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/HTTP 404/.test(msg)) {
        return { ok: false, code: 'NOT_FOUND', message: '没有找到该帖子' };
      }
      if (/HTTP 401|HTTP 403/.test(msg)) {
        return { ok: false, code: 'UNAUTHORIZED', message: '没有权限读取该帖子' };
      }
      return { ok: false, code: 'INTERNAL', message: '读取帖子失败：' + msg };
    }
  }

  // 开放接口 v1.0：background broker 转发的 post.open / post.context
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.__pcr_api_dispatch !== true) return;
      if (msg.action === 'post.context') {
        apiPostContext(msg.payload).then(sendResponse);
        return true;
      }
      if (msg.action === 'post.summarize') {
        apiPostSummarize(msg.payload).then(sendResponse);
        return true;
      }
      if (msg.action !== 'post.open') return;
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      const id = typeof p.postId === 'string' ? p.postId.trim().slice(0, 128) : '';
      sendResponse(openPostById(id));
    });
  } catch (e) { /* 扩展上下文失效时忽略 */ }

  // 只注册一次：捕获阶段先于站点路由与扩展其他模块
  loadOverlaySetting();
  loadImageZoom();
  loadTocPref();
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown, true);
  document.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('pointermove', onTiltMove, { passive: true });
  document.addEventListener('pointerout', onTiltOut, { passive: true });
  window.addEventListener('popstate', onPopState);
  // 视口变化时重新计算两侧切换按钮的位置（加宽宽度由 CSS 的 vw 决定）
  window.addEventListener('resize', () => {
    if (!root) return;
    scheduleNavOffset();
    placePop();
  });
})();

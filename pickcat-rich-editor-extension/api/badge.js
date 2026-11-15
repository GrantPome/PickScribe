/**
 * 账号工牌：把 Pickcat 右上角头像菜单换成一张挂在头像下方、可拖拽摆动的 3D 工牌。
 *
 * 形态：
 *   头像底部伸出一根弹性绳，绳子系着工牌顶部；工牌浮在页面之上，不再铺全屏遮罩。
 *   拖动时只让工牌沿绳子甩动（不做 3D 倾斜），松手弹回；点击卡片才做 3D 翻面查看账号菜单。
 *
 * 数据：
 *   GET /api/v1/session          当前登录用户
 *   GET /api/v1/users/{id}       等级与 粉丝 / 关注 / 帖子 / 回复
 *   GET /api/v1/users/{id}/works 作品列表（取前 50 条计数）
 *
 * 细节：
 *   1. 甩脱手：拖拽松手速度过快时工牌脱离绳子自己飞（重力 + 视口反弹），
 *      停住后需要再拖回挂点附近松手才重新系上，不会自动弹回；
 *   2. 小鱼干挂件：连续 7 天发帖后由 api/badge-streak.js 挂到绳子中段；
 *   3. 甩动音效：shared/swing-sound.js 合成，默认关闭，设置页 pcr_badge_swing_sound 控制；
 *   4. 倾斜：自由状态（拖着 / 甩出 / 落地）保留当时角度，最大 ±90°（能横放，不会倒立）；
 *      挂回绳子后角度平滑归正，挂在绳上始终竖直。
 *
 * 约定：
 *   1. 只在 pickcat.dao3.fun 生效，CDSQ 继续使用站点原生下拉；
 *   2. 拦截头像 click 并 preventDefault，站点下拉的 onClick 会检查 defaultPrevented；
 *   3. 设置页开关 pcr_badge_menu 默认关闭，只有显式开启才接管头像；
 *   4. 所有颜色走站点 --ui-* 令牌，深色模式自动跟随。
 */

(() => {
  'use strict';

  if (location.hostname !== 'pickcat.dao3.fun') return;

  const ENABLED_KEY = 'pcr_badge_menu';
  const TRIGGER_SELECTOR = '[aria-label="打开账号菜单"]';
  const SESSION_URL = '/api/v1/session';
  const SESSION_TTL = 60 * 1000;
  const PROFILE_TTL = 2 * 60 * 1000;
  const WORKS_SAMPLE = 50;
  const THEME_KEY = 'pickcat-theme';
  const ROPE_GAP = 38;
  /** 松手瞬间指针速度超过这个值（px/s）就算甩脱手 */
  const THROW_SPEED = 1500;
  /** 脱手后的自由飞行参数 */
  const FREE_GRAVITY = 2600;
  const FREE_BOUNCE = 0.52;
  /** 把工牌拖回静止挂点这个半径内松手，重新系回绳子 */
  const REHANG_RADIUS = 112;
  /** 卡片倾斜角上限：允许横放，但不允许转成倒立 */
  const TILT_LIMIT = 90;
  /** 拖拽转角的水平位移尺度：tanh 映射，50px≈9°、150px≈25°、300px≈48° */
  const TILT_DRAG_SCALE = 520;
  const THEMES = [
    ['system', '跟随系统'],
    ['light', '亮色'],
    ['dark', '暗色']
  ];

  /** 站点判定「能看到管理后台」的权限集合（取自站点 AccountMenu 的实现） */
  const ADMIN_PERMISSIONS = new Set([
    'identity.client.manage', 'community.badge.manage', 'community.badge.grant',
    'community.level.certify', 'community.level.manage', 'file.manage', 'access.manage',
    'community.entrance-exam.manage', 'moderation.profile-report.manage',
    'community.emoji.manage', 'community.link-domain.manage', 'community.work.manage',
    'moderation.submission.manage', 'moderation.case.manage', 'moderation.content.remove',
    'moderation.topic.manage', 'moderation.topic.pin', 'moderation.question.manage',
    'moderation.tag.manage', 'moderation.user.silence.manage',
    'moderation.user.suspension.manage', 'moderation.user.profile.manage'
  ]);

  const ICONS = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 4.9 2.1 2.1"/><path d="m17 17 2.1 2.1"/><path d="m19.1 4.9-2.1 2.1"/><path d="m7 17-2.1 2.1"/>',
    shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9.5 12 1.8 1.8L15 10"/>',
    flip: '<path d="M4 9a8 8 0 0 1 14-4"/><path d="M18 3v5h-5"/><path d="M20 15a8 8 0 0 1-14 4"/><path d="M6 21v-5h5"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'
  };

  const state = {
    enabled: false,
    open: false,
    closing: false,
    root: null,
    stage: null,
    card: null,
    front: null,
    back: null,
    rope: null,
    ropeKnot: null,
    trigger: null,
    anchor: { x: 0, y: 0 },
    cardW: 320,
    cardH: 460,
    rest: { phi: 0, len: ROPE_GAP },
    maxLen: 900,
    phi: 0,
    len: 0,
    phiVel: 0,
    lenVel: 0,
    targetPhi: 0,
    targetLen: ROPE_GAP,
    raf: 0,
    lastT: 0,
    drag: null,
    moved: false,
    suppressClick: false,
    /* ---- 甩脱手：脱离绳子后的自由飞行状态 ---- */
    detached: false,
    free: { x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0 },
    grab: null,           // 脱手状态下重新抓住工牌时的指针信息
    rehangEl: null,       // 脱手后显示的挂回目标提示
    soundArmed: false,    // 速度回落后重新允许发声，一次甩动只响一声
    soundReady: false,    // 用户真正碰过工牌之后才发声，打开动画本身不响
    soundAt: 0,
    user: null,
    profile: null,
    works: null,
    sessionAt: 0,
    profileAt: 0,
    sessionPromise: null,
    profilePromise: null,
    lastFocus: null,
    loggedOut: false,
    flip: 0,
    logoutArmed: false,
    logoutTimer: 0,
    escBound: false,
    viewportBound: false,
    outsideBound: false
  };

  // ============================ 1. 小工具 ============================

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function icon(name, size) {
    const px = size || 18;
    return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function isInteractive(el) {
    return !!(el && el.closest && el.closest('a,button,input,select,textarea,[role="button"]'));
  }

  // ============================ 2. 开关 ============================

  function readEnabled() {
    try {
      chrome.storage.local.get(ENABLED_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        // 默认关闭：只有用户主动打开开关才接管头像
        state.enabled = !!raw && raw[ENABLED_KEY] === true;
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  function watchEnabled() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[ENABLED_KEY]) return;
        state.enabled = changes[ENABLED_KEY].newValue === true;
        if (!state.enabled && state.open) close();
      });
    } catch (e) { /* 忽略 */ }
  }

  // ============================ 3. 数据 ============================

  function readSession(force) {
    const now = Date.now();
    if (!force && state.user && now - state.sessionAt < SESSION_TTL) {
      return Promise.resolve(state.user);
    }
    if (state.sessionPromise) return state.sessionPromise;

    state.sessionPromise = fetch(SESSION_URL, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        const user = (data && (data.user || data.data || data)) || null;
        if (!user || (!user.id && !user.username)) throw new Error('empty session');
        state.user = user;
        state.sessionAt = Date.now();
        return user;
      })
      .finally(() => {
        state.sessionPromise = null;
      });

    state.sessionPromise.catch(() => {});
    return state.sessionPromise;
  }

  /** 等级与关注/粉丝等统计；作品数用作品列表前 50 条计数，超过则显示 50+ */
  function loadProfile(userId) {
    if (!userId) return Promise.resolve();
    const now = Date.now();
    if (state.profile && state.profile.id === userId && now - state.profileAt < PROFILE_TTL) {
      return Promise.resolve();
    }
    if (state.profilePromise) return state.profilePromise;

    const base = '/api/v1/users/' + encodeURIComponent(userId);
    const opts = { credentials: 'include', headers: { Accept: 'application/json' } };

    const profileTask = fetch(base, opts)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    const worksTask = fetch(base + '/works?limit=' + WORKS_SAMPLE, opts)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);

    state.profilePromise = Promise.all([profileTask, worksTask])
      .then(([profile, works]) => {
        if (profile && profile.id === userId) {
          state.profile = profile;
          state.profileAt = Date.now();
        }
        if (works && Array.isArray(works.items)) {
          state.works = {
            count: works.items.length,
            more: !!(works.pageInfo && works.pageInfo.hasNextPage)
          };
        }
      })
      .finally(() => {
        state.profilePromise = null;
      });

    state.profilePromise.catch(() => {});
    return state.profilePromise;
  }

  function isAdmin(user) {
    const perms = user && Array.isArray(user.effectivePermissions) ? user.effectivePermissions : [];
    return perms.some((p) => p && ADMIN_PERMISSIONS.has(p.key));
  }

  // ============================ 4. 模板 ============================

  /** 会话里的 username 可能直接是账号 id（UUID），不能当作显示名 */
  function looksLikeId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(value || '').trim());
  }

  function frontHtml(user, profile, works, fallbackAvatar) {
    const stats = (profile && profile.stats) || (user && user.stats) || {};
    const avatar = (user && user.avatar && (user.avatar.url || user.avatar.thumb_url)) || fallbackAvatar || '';
    // 优先用资料接口的 username（站内显示名）；会话里的 username 可能直接是账号 id，要跳过
    const candidates = [
      profile && profile.username,
      user && user.nickname,
      user && user.name,
      user && user.username
    ];
    const displayName = candidates.find((v) => {
      const text = typeof v === 'string' ? v.trim() : '';
      return text && !looksLikeId(text);
    }) || '';
    const name = displayName || '我的账号';
    const initial = String(name).slice(0, 1).toUpperCase() || 'P';
    const level = num(profile && profile.level ? profile.level.current : (user && user.level && user.level.current));
    const fish = num(user && user.tokenBalance);
    const worksCount = works ? works.count : null;
    const followers = num(stats.followers);
    const following = num(stats.following);
    const topics = num(stats.topics);
    const replies = num(stats.replies);

    const cards = [
      { label: '作品', value: worksCount === null ? '—' : String(worksCount) + (works.more ? '+' : '') },
      { label: '粉丝', value: followers === null ? '—' : String(followers) },
      { label: '关注', value: following === null ? '—' : String(following) }
    ].map((item) =>
      '<div class="pcr-badge-stat"><b>' + escapeHtml(item.value) + '</b><span>' + item.label + '</span></div>'
    ).join('');

    const meta = [];
    if (topics !== null) meta.push(topics + ' 帖子');
    if (replies !== null) meta.push(replies + ' 回复');
    if (fish !== null) meta.push(fish + ' 小鱼干');

    // 证件编号取自账号 id 末 4 位，仅作工牌装饰，不额外请求数据
    const serial = String((user && user.id) || '').replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase();

    // 正面按证件工牌排版：品牌行 → 证件照 + 身份 → 数据条 → 底部条码与编号
    return '<div class="pcr-badge-holo" aria-hidden="true"></div>' +
      '<div class="pcr-badge-watermark" aria-hidden="true">' + escapeHtml(initial) + '</div>' +
      '<div class="pcr-badge-clip" aria-hidden="true"><span></span></div>' +
      '<div class="pcr-badge-front-body">' +
        '<div class="pcr-badge-brand">' +
          '<i aria-hidden="true"></i>' +
          '<span class="pcr-badge-brand-name">PICKCAT</span>' +
          '<span class="pcr-badge-brand-tag">MEMBER CARD</span>' +
        '</div>' +
        '<div class="pcr-badge-head">' +
          '<div class="pcr-badge-avatar">' +
            (avatar
              ? '<img src="' + escapeHtml(avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
              : '<span>' + escapeHtml(initial) + '</span>') +
          '</div>' +
          '<div class="pcr-badge-id">' +
            '<h2 class="pcr-badge-name">' + escapeHtml(name) + '</h2>' +
            '<div class="pcr-badge-sub">' +
              (displayName ? '<span class="pcr-badge-handle">@' + escapeHtml(displayName) + '</span>' : '') +
              (level !== null ? '<span class="pcr-badge-chip">Lv.' + escapeHtml(String(level)) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pcr-badge-divider" aria-hidden="true"><span>ACCOUNT INFO</span></div>' +
        '<div class="pcr-badge-stats">' + cards + '</div>' +
        (meta.length
          ? '<p class="pcr-badge-meta">' +
              meta.map((text) => '<span>' + escapeHtml(text) + '</span>').join('<i aria-hidden="true"></i>') +
            '</p>'
          : '') +
        '<div class="pcr-badge-foot">' +
          '<div class="pcr-badge-barcode" aria-hidden="true"></div>' +
          '<div class="pcr-badge-foot-row">' +
            '<span class="pcr-badge-serial">NO. ' + escapeHtml(serial || '—') + '</span>' +
            '<span class="pcr-badge-hint">拖动摆动 · 点击翻面</span>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function menuItems(user) {
    const items = [];
    if (user) {
      items.push({
        label: '个人中心',
        href: user.id ? '/profile/' + encodeURIComponent(user.id) : '/settings',
        icon: 'user'
      });
    }
    items.push({ label: '个人图盘', href: '/personal-library', icon: 'image' });
    items.push({ label: '设置', href: '/settings', icon: 'gear' });
    if (isAdmin(user)) items.push({ label: '管理后台', href: '/manage', icon: 'shield' });
    items.push({ label: 'PickScribe 设置', act: 'settings', icon: 'logo' });
    return items;
  }

  function backHtml(user) {
    const rows = menuItems(user).map((item) => {
      // PickScribe 入口沿用插件 LOGO，与原生菜单里的图标保持一致
      const glyph = item.icon === 'logo'
        ? '<span class="pcr-badge-logo" aria-hidden="true"></span>'
        : icon(item.icon);
      const inner = '<span class="pcr-badge-item-ico">' + glyph + '</span>' +
        '<span class="pcr-badge-item-text">' + escapeHtml(item.label) + '</span>';
      if (item.href) {
        return '<a class="pcr-badge-item" href="' + escapeHtml(item.href) + '">' + inner + '</a>';
      }
      return '<button type="button" class="pcr-badge-item" data-pcr-act="' + escapeHtml(item.act) + '">' +
        inner + '</button>';
    }).join('');

    const current = currentTheme();
    const themeBtns = THEMES.map(([value, label]) =>
      '<button type="button" data-pcr-theme="' + value + '"' +
        (value === current ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') +
      '>' + label + '</button>'
    ).join('');

    return '<div class="pcr-badge-back-head">' +
        '<span>账号与设置</span>' +
        '<button type="button" class="pcr-badge-flip" data-pcr-act="flip" aria-label="返回正面">' +
          icon('flip', 16) +
        '</button>' +
      '</div>' +
      '<nav class="pcr-badge-menu" aria-label="账号菜单">' + rows + '</nav>' +
      '<div class="pcr-badge-theme">' +
        '<span class="pcr-badge-theme-label">显示模式</span>' +
        '<div class="pcr-badge-seg" role="group" aria-label="显示模式">' + themeBtns + '</div>' +
      '</div>' +
      '<button type="button" class="pcr-badge-logout" data-pcr-act="logout">' +
        icon('logout', 16) + '<span>退出登录</span>' +
      '</button>' +
      '<p class="pcr-badge-error" hidden></p>';
  }

  // ============================ 5. 显示模式 ============================

  function currentTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return THEMES.some(([key]) => key === value) ? value : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function applyThemeClass(pref) {
    let mode = pref;
    if (pref === 'system') {
      try {
        mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (e) {
        mode = 'light';
      }
    }
    const html = document.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(mode);
    html.style.colorScheme = mode;
  }

  function setTheme(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* 忽略 */ }
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key: THEME_KEY,
        newValue: pref,
        oldValue: null,
        storageArea: localStorage,
        url: location.href
      }));
    } catch (e) { /* 手动构造失败时靠下面的兜底 */ }
    applyThemeClass(pref);
    updateThemeButtons();
  }

  function updateThemeButtons() {
    if (!state.back) return;
    const pref = currentTheme();
    state.back.querySelectorAll('[data-pcr-theme]').forEach((btn) => {
      const on = btn.getAttribute('data-pcr-theme') === pref;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ============================ 6. 3D 与绳子 ============================

  /** 重新计算绳子锚点与工牌静止位置 */
  function measure() {
    const trigger = state.trigger;
    const card = state.card;
    if (!card) return;

    let ax = window.innerWidth - 52;
    let ay = 64;
    if (trigger && trigger.getBoundingClientRect) {
      const rect = trigger.getBoundingClientRect();
      ax = rect.left + rect.width / 2;
      ay = rect.bottom;
    }

    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 460;
    state.cardW = width;
    state.cardH = height;
    state.anchor = { x: ax, y: ay };

    let top = ay + ROPE_GAP;
    if (top + height > window.innerHeight - 12) {
      top = Math.max(ay + 8, window.innerHeight - height - 12);
    }
    const left = clamp(ax - width / 2, 22, window.innerWidth - width - 22);
    const bx = left + width / 2;
    const by = top;
    const dx = bx - ax;
    const dy = by - ay;

    state.rest = {
      phi: Math.atan2(dx, Math.max(1, dy)),
      len: Math.max(ROPE_GAP, Math.hypot(dx, dy))
    };
    // 绳长上限取视口对角线：拖到屏幕任意角落都够长，不再额外限制拉远距离
    state.maxLen = Math.max(state.rest.len + 240, Math.hypot(window.innerWidth, window.innerHeight));
  }

  /** 每帧更新工牌位置与绳子曲线 */
  function render() {
    if (!state.stage || !state.card) return;
    // 脱手后位置归自由飞行管，任何迟到的 render（比如连续天数同步回来）
    // 都不能把卡片拽回绳子位置
    if (state.detached) return;
    const ax = state.anchor.x;
    const ay = state.anchor.y;
    const bx = ax + Math.sin(state.phi) * state.len;
    const by = ay + Math.cos(state.phi) * state.len;

    // 系着绳子时也跟着当前角度：挂回来不强行摆正
    state.stage.style.transform =
      'translate3d(' + (bx - state.cardW / 2).toFixed(2) + 'px,' + by.toFixed(2) + 'px,0)' +
      ' rotate(' + ((state.free && state.free.rot) || 0).toFixed(2) + 'deg)';

    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy) || 1;
    // 绳子被拉长时向外鼓，摆动时顺着运动方向甩出一点弧度
    const bulge = clamp((state.len - state.rest.len) * 0.2, -4, 44) +
      clamp(-state.phiVel * 12, -18, 18);
    const cx = (ax + bx) / 2 + (-dy / dist) * bulge;
    const cy = (ay + by) / 2 + (dx / dist) * bulge;

    if (state.rope) {
      state.rope.setAttribute('d',
        'M ' + ax.toFixed(2) + ' ' + ay.toFixed(2) +
        ' Q ' + cx.toFixed(2) + ' ' + cy.toFixed(2) +
        ' ' + bx.toFixed(2) + ' ' + by.toFixed(2));
    }
    if (state.ropeKnot) {
      state.ropeKnot.setAttribute('cx', ax.toFixed(2));
      state.ropeKnot.setAttribute('cy', ay.toFixed(2));
    }
    // 小鱼干挂件跟着同一条曲线滑动（未解锁时内部直接返回）
    if (window.PCRBadgeStreak) {
      window.PCRBadgeStreak.position({ x: ax, y: ay }, { x: cx, y: cy }, { x: bx, y: by });
    }
  }

  /** 静止时工牌顶部中心的位置，脱手后既是回挂判定点也是提示圈的位置 */
  function restTip() {
    return {
      x: state.anchor.x + Math.sin(state.rest.phi) * state.rest.len,
      y: state.anchor.y + Math.cos(state.rest.phi) * state.rest.len
    };
  }

  /**
   * 摆动积分：拖动时用较硬的弹簧让卡片带惯性跟随指针，
   * 松手后换成阻尼更小的弹簧，让它像吊牌一样来回摆几下再停。
   */
  function tick(now) {
    state.raf = 0;
    if (!state.open) return;
    const dt = Math.min(0.032, Math.max(0.001, (now - (state.lastT || now)) / 1000));
    state.lastT = now;

    // 脱手后走另一套自由飞行积分
    if (state.detached) {
      stepFree(dt);
      return;
    }

    const dragging = !!(state.drag && state.moved);
    const kPhi = dragging ? 520 : 118;
    const cPhi = dragging ? 34 : 6.4;
    const kLen = dragging ? 520 : 190;
    const cLen = dragging ? 36 : 13;

    state.phiVel += ((state.targetPhi - state.phi) * kPhi - state.phiVel * cPhi) * dt;
    state.phi += state.phiVel * dt;

    state.lenVel += ((state.targetLen - state.len) * kLen - state.lenVel * cLen) * dt;
    state.len += state.lenVel * dt;

    // 摆动音效：速度刚冲过阈值时响一声，回落到 160 以下再重新武装。
    // 这样一次甩动只伴随一声风声，来回嗡嗡响反而打扰。
    const speed = Math.abs(state.phiVel) * state.len + Math.abs(state.lenVel) * 0.5;
    if (speed < 160) {
      state.soundArmed = true;
    } else if (state.soundReady && state.soundArmed && speed > 300) {
      state.soundArmed = false;
      playSwing(clamp(speed / 1400, 0, 1));
    }

    // 挂在绳子上就必须竖直：自由状态带回来的角度在这里平滑衰减到 0，
    // 不能瞬间跳正，也不能一直歪着
    if (state.free.rot !== 0) {
      const next = state.free.rot * Math.pow(0.00005, dt);
      state.free.rot = Math.abs(next) < 0.2 ? 0 : next;
    }

    const springDone =
      Math.abs(state.targetPhi - state.phi) < 0.002 &&
      Math.abs(state.phiVel) < 0.006 &&
      Math.abs(state.targetLen - state.len) < 0.4 &&
      Math.abs(state.lenVel) < 1;

    if (springDone) {
      state.phi = state.targetPhi;
      state.len = state.targetLen;
      state.phiVel = 0;
      state.lenVel = 0;
    }

    render();
    // 弹簧停了但角度还没归零时也要继续跑，别把没转完的动画丢在那
    if (!(springDone && state.free.rot === 0) && !state.closing) schedule();
  }

  function schedule() {
    if (state.raf || !state.open) return;
    state.lastT = performance.now();
    state.raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  // ============================ 6.1 甩脱手与挂回 ============================

  /** 甩动音效：开关与声音都在 shared/swing-sound.js 里，这里只做节流调用 */
  function playSwing(strength) {
    const api = window.PCRSwingSound;
    if (!api || typeof api.play !== 'function') return;
    const now = performance.now();
    if (now - state.soundAt < 220) return;
    state.soundAt = now;
    api.play(strength);
  }

  /**
   * 脱手：工牌离开绳子，用松手瞬间的速度自己飞出去。
   * 位置以「工牌顶部中心」为锚，和绳子系着时的坐标口径保持一致。
   */
  function detach(vx, vy) {
    const f = state.free;
    f.x = state.anchor.x + Math.sin(state.phi) * state.len;
    f.y = state.anchor.y + Math.cos(state.phi) * state.len;
    f.vx = vx;
    f.vy = vy;
    // 保留当前角度，甩出去只在原有角度上继续转
    f.vrot = clamp(vx * 0.06, -260, 260);

    state.detached = true;
    state.phiVel = 0;
    state.lenVel = 0;
    state.soundArmed = true;
    if (state.root) state.root.classList.add('is-detached');
    if (window.PCRBadgeStreak) window.PCRBadgeStreak.hide();
    playSwing(1);

    updateRehangHint();
    renderFree();
    schedule();
  }

  /**
   * 脱手后工牌能待的范围：卡片放得下就整张留在视口里，
   * 放不下（很窄的窗口）才只保证上面一小截可见，保证永远找得到。
   * 尺寸每次现取：卡片内容（昵称 / 统计）是异步填进来的，缓存的 cardH 会偏大，
   * 一旦偏大就会把可拖动的上边界压低，工牌就再也挂不回绳子。
   */
  function freeBounds() {
    const w = (state.card && state.card.offsetWidth) || state.cardW;
    const h = (state.card && state.card.offsetHeight) || state.cardH;
    const halfW = w / 2;
    // 卡片绕顶部挂孔旋转：倾斜后往下占的高度会变，落地位置按真实投影算，
    // 否则横放时会悬在半空、或者陷进底部
    const rad = Math.abs((state.free && state.free.rot) || 0) * Math.PI / 180;
    const below = h * Math.cos(rad) + halfW * Math.sin(rad);
    const fits = below + 24 <= window.innerHeight;
    return {
      minX: halfW + 8,
      maxX: Math.max(halfW + 8, window.innerWidth - halfW - 8),
      minY: 8,
      maxY: Math.max(8, window.innerHeight - (fits ? below : Math.min(below, 160)) - 8)
    };
  }

  /**
   * 脱手后的自由飞行：重力 + 空气阻力 + 视口反弹。
   * 四个边都做反弹而不是越界即停，保证工牌永远留在屏幕里，不会丢。
   */
  function stepFree(dt) {
    const f = state.free;
    const bounds = freeBounds();
    const minX = bounds.minX;
    const maxX = bounds.maxX;
    const minY = bounds.minY;
    const maxY = bounds.maxY;

    if (state.grab) {
      // 正在被拖回去：位置由指针直接给，速度沿用指针速度。
      // 这里不能再按自由飞行边界纠正位置，否则会和拖拽的边界互相拉扯，
      // 拖到屏幕边缘时卡片会一帧一帧地在两个位置之间来回跳。
      f.vx = state.grab.vx;
      f.vy = state.grab.vy;
      renderFree();
      return;
    }

    f.vy += FREE_GRAVITY * dt;
    const air = Math.pow(0.16, dt);
    f.vx *= air;
    f.vy *= air;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.rot += f.vrot * dt;
    f.vrot *= air;

    // 只限制范围，不往 0° 收：横放可以，倒立不行
    const tilt = clamp(f.rot, -TILT_LIMIT, TILT_LIMIT);
    if (tilt !== f.rot) {
      f.rot = tilt;
      f.vrot = 0;
    }

    if (f.x < minX) { f.x = minX; f.vx = Math.abs(f.vx) * FREE_BOUNCE; f.vrot *= -0.5; }
    if (f.x > maxX) { f.x = maxX; f.vx = -Math.abs(f.vx) * FREE_BOUNCE; f.vrot *= -0.5; }
    if (f.y < minY) { f.y = minY; f.vy = Math.abs(f.vy) * FREE_BOUNCE; }
    if (f.y > maxY) {
      f.y = maxY;
      if (f.vy > 0) f.vy = -f.vy * FREE_BOUNCE;
      f.vx *= 0.82;   // 落地摩擦
      f.vrot *= 0.7;
    }

    // 角度只受上限约束，不会被慢慢摆回 0°：松手、落地都保留当时的角度
    const slow = Math.abs(f.vx) < 14 && Math.abs(f.vy) < 20;
    const atFloor = f.y >= maxY - 1 || maxY <= minY;
    const still = slow && Math.abs(f.vrot) < 12 && atFloor;
    if (still) {
      f.vx = 0;
      f.vy = 0;
      f.vrot = 0;
    }

    renderFree();
    // 停稳就收工。角度保留着，不能因为 rot !== 0 就继续空转 rAF
    if (!still) schedule();
  }

  function renderFree() {
    if (!state.stage) return;
    const f = state.free;
    state.stage.style.transform =
      'translate3d(' + (f.x - state.cardW / 2).toFixed(2) + 'px,' + f.y.toFixed(2) + 'px,0)' +
      ' rotate(' + f.rot.toFixed(2) + 'deg)';
  }

  /** 挂回提示圈：脱手后出现在原来的挂点，告诉用户把工牌拖回哪里 */
  function updateRehangHint() {
    if (!state.rehangEl) return;
    const tip = restTip();
    const size = REHANG_RADIUS * 2;
    state.rehangEl.style.width = size + 'px';
    state.rehangEl.style.height = size + 'px';
    state.rehangEl.style.transform =
      'translate3d(' + (tip.x - REHANG_RADIUS).toFixed(1) + 'px,' +
      (tip.y - REHANG_RADIUS).toFixed(1) + 'px,0)';
  }

  /** 拖回挂点附近松手：换算回极坐标，交给原来的弹簧弹回静止位 */
  function rehang() {
    const f = state.free;
    const dx = f.x - state.anchor.x;
    const dy = Math.max(8, f.y - state.anchor.y);

    state.detached = false;
    state.grab = null;
    if (state.root) state.root.classList.remove('is-detached');
    if (state.card) state.card.classList.remove('is-dragging');

    state.phi = clamp(Math.atan2(dx, dy), state.rest.phi - 1.35, state.rest.phi + 1.35);
    state.len = clamp(Math.hypot(dx, dy), 16, state.maxLen);
    state.phiVel = 0;
    state.lenVel = 0;
    state.soundArmed = true;
    state.targetPhi = state.rest.phi;
    state.targetLen = state.rest.len;

    render();
    schedule();
  }

  function setFlip(next) {
    state.flip = next;
    if (state.card) state.card.style.setProperty('--pcr-flip', state.flip + 'deg');
    updateFaceState();
  }

  function toggleFlip() {
    setFlip(state.flip === 180 ? 0 : 180);
    const active = document.activeElement;
    if (state.card && active && active !== state.card && state.card.contains(active)) {
      state.card.focus({ preventScroll: true });
    }
  }

  // ============================ 7. 拖拽 ============================

  function onPointerDown(e) {
    if (!state.card || e.button !== 0 || e.isPrimary === false) return;
    // 用户已经上手，之后的摆动才需要声音（打开时的下落动画保持安静）
    state.soundReady = true;

    // 脱手状态：直接抓住自由飞行的工牌，准备拖回挂点
    if (state.detached) {
      const f = state.free;
      // 记下按住的那一点在卡片本地坐标（相对挂孔、未旋转）：
      // 拖动时让它一直待在指针下，卡片才会绕着手指转，而不是越拖越偏
      const rad = (f.rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dxp = e.clientX - f.x;
      const dyp = e.clientY - f.y;
      state.grab = {
        lx: dxp * cos + dyp * sin,
        ly: -dxp * sin + dyp * cos,
        rot0: f.rot,
        rx: 0,
        px: e.clientX,
        py: e.clientY,
        t: performance.now(),
        vx: 0,
        vy: 0,
        pointerId: e.pointerId
      };
      f.vx = 0;
      f.vy = 0;
      f.vrot = 0;
      state.moved = false;
      state.suppressClick = false;
      state.card.classList.add('is-dragging');
      try { state.card.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      return;
    }

    // 记住指针与卡片顶部中心之间的偏移，拖动时让顶部中心跟着指针走；
    // 不打断当前摆动，按下但没拖动时卡片会继续自然回位。
    const topX = state.anchor.x + Math.sin(state.phi) * state.len;
    const topY = state.anchor.y + Math.cos(state.phi) * state.len;
    state.drag = {
      x: e.clientX,
      y: e.clientY,
      px: e.clientX,
      py: e.clientY,
      t: performance.now(),
      vx: 0,
      vy: 0,
      offsetX: topX - e.clientX,
      offsetY: topY - e.clientY,
      pointerId: e.pointerId,
      interactive: isInteractive(e.target)
    };
    state.moved = false;
    state.suppressClick = false;
    state.card.classList.add('is-dragging');
  }

  function onPointerMove(e) {
    if (!state.card) return;

    // ---------- 脱手状态：把工牌拖回挂点 ----------
    if (state.grab) {
      const dx = e.clientX - state.grab.px;
      const dy = e.clientY - state.grab.py;
      if (!state.moved && Math.hypot(dx, dy) > 4) state.moved = true;
      if (!state.moved) return;
      if (e.cancelable) e.preventDefault();

      const now = performance.now();
      const span = Math.max(8, now - state.grab.t) / 1000;
      // 指针速度做一次平滑，松手时用它决定是否继续甩出去
      state.grab.vx = state.grab.vx * 0.55 + (dx / span) * 0.45;
      state.grab.vy = state.grab.vy * 0.55 + (dy / span) * 0.45;
      state.grab.px = e.clientX;
      state.grab.py = e.clientY;
      state.grab.t = now;

      // 边界和松手后的自由飞行用同一套范围（卡片尽量整张留在视口里），
      // 只在窗口太窄时放宽到挂点，保证任何尺寸下都能把工牌拖回去。
      // 两边范围不一致的话，拖到边缘会被两套边界来回夹、松手还会瞬间弹回来。
      const bounds = freeBounds();
      const tip = restTip();
      const dragMinX = Math.min(bounds.minX, tip.x);
      const dragMaxX = Math.max(bounds.maxX, tip.x);
      const dragMinY = Math.min(bounds.minY, tip.y);
      const dragMaxY = Math.max(bounds.maxY, tip.y);
      const f = state.free;
      const g = state.grab;
      // 转角只由累计水平位移决定，且小位移几乎不转：tanh 曲线，越拖越接近横放
      g.rx += dx;
      const tilt = clamp(g.rot0 + TILT_LIMIT * Math.tanh(g.rx / TILT_DRAG_SCALE), -TILT_LIMIT, TILT_LIMIT);
      f.rot = tilt;
      const rad = (tilt * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // 反解挂孔位置：绕按住的那一点转，按住点始终贴着指针
      f.x = clamp(e.clientX - (g.lx * cos - g.ly * sin), dragMinX, dragMaxX);
      f.y = clamp(e.clientY - (g.lx * sin + g.ly * cos), dragMinY, dragMaxY);
      f.vx = state.grab.vx;
      f.vy = state.grab.vy;
      f.vrot = 0;
      renderFree();
      schedule();
      return;
    }

    if (!state.drag) return;
    const dx = e.clientX - state.drag.x;
    const dy = e.clientY - state.drag.y;

    if (!state.moved && Math.hypot(dx, dy) > 4) {
      state.moved = true;
      state.suppressClick = true;
      try { state.card.setPointerCapture(state.drag.pointerId); } catch (err) { /* 忽略 */ }
    }
    if (!state.moved) return;
    if (e.cancelable) e.preventDefault();

    // 记录指针速度：松手时超过阈值就判定「甩脱手」
    const span = Math.max(8, performance.now() - state.drag.t) / 1000;
    state.drag.vx = state.drag.vx * 0.55 + ((e.clientX - state.drag.px) / span) * 0.45;
    state.drag.vy = state.drag.vy * 0.55 + ((e.clientY - state.drag.py) / span) * 0.45;
    state.drag.px = e.clientX;
    state.drag.py = e.clientY;
    state.drag.t = performance.now();

    // 拖动只负责甩动卡片本身，不做任何 3D 倾斜；翻转是点击后的独立动作。
    // 这里只更新「卡片顶部中心想去哪」，真正的位移交给 tick 的弹簧追过去，才有重量感。
    const ax = state.anchor.x;
    const ay = state.anchor.y;
    const halfW = state.cardW / 2;
    const tx = clamp(e.clientX + state.drag.offsetX, halfW + 6, window.innerWidth - halfW - 6);
    // 纵向允许拉到接近屏幕底部，只保证工牌还有一部分留在视口里
    const maxY = Math.max(ay + 16, window.innerHeight - state.cardH * 0.34);
    const ty = clamp(e.clientY + state.drag.offsetY, ay + 16, maxY);
    const ox = tx - ax;
    const oy = ty - ay;

    // 绳长上限由 measure() 按视口对角线给出，摆角放宽到 ±77°，能甩到屏幕另一侧
    state.targetLen = clamp(Math.hypot(ox, oy), 16, state.maxLen);
    state.targetPhi = clamp(
      Math.atan2(ox, Math.max(1, oy)),
      state.rest.phi - 1.35,
      state.rest.phi + 1.35
    );
    schedule();
  }

  function onPointerUp(e) {
    if (!state.card) return;

    // ---------- 脱手状态松手 ----------
    if (state.grab) {
      const grab = state.grab;
      const moved = state.moved;
      state.grab = null;
      state.moved = false;
      try { state.card.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      state.card.classList.remove('is-dragging');

      // 脱手状态下只点一下：和挂着时一样翻转，点链接则照常跳转
      if (!moved) {
        if (!isInteractive(e.target)) {
          if (document.activeElement !== state.card) state.card.focus({ preventScroll: true });
          toggleFlip();
        }
        return;
      }

      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 350);

      const tip = restTip();
      const f = state.free;
      if (Math.hypot(f.x - tip.x, f.y - tip.y) <= REHANG_RADIUS) {
        // 拖回挂点附近：重新系回绳子
        rehang();
        return;
      }

      // 没挂回就按松手速度继续飞（可以再甩一次）
      const idle = performance.now() - grab.t > 90;
      f.vx = idle ? 0 : grab.vx;
      f.vy = idle ? 0 : grab.vy;
      f.vrot = clamp(f.vx * 0.05, -240, 240);
      schedule();
      return;
    }

    if (!state.drag) return;
    const drag = state.drag;
    const moved = state.moved;
    state.drag = null;
    state.moved = false;
    try { state.card.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

    if (!moved) {
      state.card.classList.remove('is-dragging');
      if (!drag.interactive) {
        if (document.activeElement !== state.card) state.card.focus({ preventScroll: true });
        toggleFlip();
      }
      return;
    }

    setTimeout(() => { state.suppressClick = false; }, 350);
    state.card.classList.remove('is-dragging');

    // 甩得够猛就脱手飞出去；否则照旧弹回静止位置
    const idle = performance.now() - drag.t > 90;
    const speed = idle ? 0 : Math.hypot(drag.vx, drag.vy);
    if (speed >= THROW_SPEED) {
      detach(drag.vx, drag.vy);
      return;
    }

    state.targetPhi = state.rest.phi;
    state.targetLen = state.rest.len;
    schedule();
  }

  function onPointerCancel() {
    if (state.grab) {
      const grab = state.grab;
      state.grab = null;
      state.moved = false;
      if (state.card) state.card.classList.remove('is-dragging');
      state.free.vx = grab.vx;
      state.free.vy = grab.vy;
      schedule();
      return;
    }
    if (!state.drag) return;
    state.drag = null;
    state.moved = false;
    state.targetPhi = state.rest.phi;
    state.targetLen = state.rest.len;
    if (state.card) state.card.classList.remove('is-dragging');
    schedule();
  }

  // ============================ 8. 创建与渲染 ============================

  function ensureRoot() {
    if (state.root && state.root.isConnected) return state.root;

    const root = document.createElement('div');
    root.id = 'pcr-badge-root';
    root.hidden = true;
    root.innerHTML =
      '<svg class="pcr-badge-rope" aria-hidden="true">' +
        '<path data-pcr-rope d=""/>' +
        '<circle data-pcr-rope-knot r="3" cx="0" cy="0"/>' +
      '</svg>' +
      // 脱手后才出现的挂回提示圈
      '<div class="pcr-badge-rehang" data-pcr-rehang aria-hidden="true"><span>挂回这里</span></div>' +
      '<div class="pcr-badge-stage">' +
        '<div class="pcr-badge-card" tabindex="0" role="dialog" aria-label="账号工牌">' +
          '<div class="pcr-badge-face pcr-badge-front" data-pcr-front></div>' +
          '<div class="pcr-badge-face pcr-badge-back" data-pcr-back></div>' +
        '</div>' +
      '</div>';

    try {
      root.style.setProperty('--pcr-logo', 'url("' + chrome.runtime.getURL('icons/logo.svg') + '")');
    } catch (e) { /* 非扩展环境忽略 */ }

    document.body.appendChild(root);

    state.root = root;
    state.stage = root.querySelector('.pcr-badge-stage');
    state.card = root.querySelector('.pcr-badge-card');
    state.front = root.querySelector('[data-pcr-front]');
    state.back = root.querySelector('[data-pcr-back]');
    state.rope = root.querySelector('[data-pcr-rope]');
    state.ropeKnot = root.querySelector('[data-pcr-rope-knot]');
    state.rehangEl = root.querySelector('[data-pcr-rehang]');

    // 小鱼干挂件挂在绳子 SVG 里，由独立文件负责解不解锁、摆在哪
    if (window.PCRBadgeStreak) {
      window.PCRBadgeStreak.attach(root.querySelector('.pcr-badge-rope'));
    }

    wireRoot();
    return root;
  }

  function renderFaces(fallbackAvatar) {
    if (!state.front || !state.back) return;
    state.front.innerHTML = frontHtml(state.user, state.profile, state.works, fallbackAvatar);
    state.back.innerHTML = backHtml(state.user);
    updateFaceState();
  }

  function updateFaceState() {
    const back = state.flip === 180;
    if (state.front) {
      state.front.setAttribute('aria-hidden', back ? 'true' : 'false');
      state.front.inert = back;
    }
    if (state.back) {
      state.back.setAttribute('aria-hidden', back ? 'false' : 'true');
      state.back.inert = !back;
    }
    if (state.card) state.card.setAttribute('data-face', back ? 'back' : 'front');
  }

  // ============================ 9. 打开与关闭 ============================

  function open(trigger) {
    if (!state.enabled || state.loggedOut) return;
    if (state.open) {
      close();
      return;
    }

    state.lastFocus = document.activeElement;
    state.trigger = trigger;
    const root = ensureRoot();
    const domAvatar = trigger && trigger.querySelector('img');
    const fallbackAvatar = domAvatar ? domAvatar.getAttribute('src') || '' : '';

    state.flip = 0;
    state.closing = false;
    // 每次打开都从「系着绳子」的状态开始，不残留上次脱手的位置；
    // 角度保留上次的，且第一帧 render() 就带上它，不会出现打开瞬间跳角度
    state.detached = false;
    state.grab = null;
    state.free = { x: 0, y: 0, vx: 0, vy: 0, rot: state.free.rot, vrot: 0 };
    state.soundArmed = false;
    state.soundReady = false;
    if (state.card) {
      state.card.style.setProperty('--pcr-flip', '0deg');
      state.card.classList.remove('is-dragging');
    }

    root.hidden = false;
    root.classList.remove('is-closing');
    root.classList.remove('is-detached');
    measure();
    renderFaces(fallbackAvatar);

    // 从靠近头像的位置落下，弹簧带一点回弹
    state.phi = state.rest.phi;
    state.len = Math.max(14, state.rest.len * 0.35);
    state.phiVel = 0;
    state.lenVel = 0;
    state.targetPhi = state.rest.phi;
    state.targetLen = state.rest.len;
    render();

    state.open = true;
    void root.offsetWidth;
    root.classList.add('is-open');
    bindViewport();
    bindOutside();
    bindEscape();
    schedule();

    setTimeout(() => {
      if (state.open && state.card) state.card.focus({ preventScroll: true });
    }, 30);

    // 会话 + 资料 + 作品数
    readSession()
      .then((user) => {
        if (!state.open) return;
        if (state.profile && user.id && state.profile.id !== user.id) {
          state.profile = null;
          state.works = null;
        }
        state.user = user;
        renderFaces(fallbackAvatar);
        return loadProfile(user.id);
      })
      .then(() => {
        if (!state.open) return;
        renderFaces(fallbackAvatar);
        // 连续发帖天数：达到 7 天后把小鱼干挂到绳子上（结果会缓存，失败则保持无挂件）
        if (window.PCRBadgeStreak && state.user) {
          window.PCRBadgeStreak.sync(state.user.id)
            .then((on) => {
              if (on && state.open) render();
            })
            .catch(() => { /* 数据拿不到就不挂 */ });
        }
      })
      .catch(() => { /* 读取失败保留兜底 */ });
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.closing = true;
    state.drag = null;
    clearTimeout(state.logoutTimer);
    state.logoutArmed = false;
    unbindViewport();
    unbindOutside();

    const root = state.root;
    if (!root) return;
    root.classList.remove('is-open');
    root.classList.add('is-closing');

    // 顺着绳子缩回头像；脱手飞出去的工牌则原地淡出，不再拉绳子
    if (state.detached) {
      state.detached = false;
      state.grab = null;
      root.classList.remove('is-detached');
    } else {
      state.targetPhi = state.rest.phi;
      state.targetLen = Math.max(8, state.rest.len * 0.18);
      state.phiVel = 0;
      state.lenVel = 0;
      state.lastT = performance.now();
      state.raf = requestAnimationFrame(function retract(now) {
        state.raf = 0;
        const dt = Math.min(0.032, Math.max(0.001, (now - state.lastT) / 1000));
        state.lastT = now;
        state.len += (state.targetLen - state.len) * Math.min(1, dt * 14);
        state.phi += (state.targetPhi - state.phi) * Math.min(1, dt * 14);
        render();
        if (state.closing) state.raf = requestAnimationFrame(retract);
      });
    }

    setTimeout(() => {
      // 关闭动画途中又被重新打开：交给新一轮的动画，这里不能停掉 rAF
      if (state.open) return;
      state.closing = false;
      stopLoop();
      root.classList.remove('is-closing');
      root.hidden = true;
      if (state.lastFocus && state.lastFocus.isConnected && state.lastFocus.focus) {
        state.lastFocus.focus({ preventScroll: true });
      }
    }, prefersReducedMotion() ? 0 : 340);
  }

  // ============================ 10. 键盘与外部点击 ============================

  function bindEscape() {
    if (state.escBound) return;
    state.escBound = true;
    document.addEventListener('keydown', onDocumentKeydown, true);
  }

  function onDocumentKeydown(e) {
    if (!state.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !state.card) return;

    const nodes = state.root.querySelectorAll(
      'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'
    );
    if (!nodes.length) return;
    const list = Array.prototype.slice.call(nodes)
      .filter((el) => el.offsetParent !== null && !el.closest('[inert]'));
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onOutsidePointerDown(e) {
    if (!state.open) return;
    // 脱手后卡片已经离开绳子，点空白不该把它关掉：它就停在原地等用户拖回挂点
    if (state.detached) return;
    const target = e.target;
    if (!target || !target.closest) return;
    if (state.root.contains(target)) return;
    // 头像本身交给 click 走开关逻辑，避免 pointerdown 先关、click 又开
    if (target.closest(TRIGGER_SELECTOR)) return;
    close();
  }

  function onViewportChange(e) {
    if (!state.open) return;
    // 脱手状态下滚动 / 缩放都不关闭，也不拉回绳子；只保证卡片还在视口里
    if (state.detached) {
      if (e.type === 'resize') {
        measure();
        const f = state.free;
        const bounds = freeBounds();
        f.x = clamp(f.x, bounds.minX, bounds.maxX);
        f.y = clamp(f.y, bounds.minY, bounds.maxY);
        updateRehangHint();
        renderFree();
      }
      return;
    }
    if (e.type === 'scroll' && e.target && e.target.nodeType === 1 && state.root.contains(e.target)) return;
    close();
  }

  function bindOutside() {
    if (state.outsideBound) return;
    state.outsideBound = true;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
  }

  function unbindOutside() {
    if (!state.outsideBound) return;
    state.outsideBound = false;
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  }

  function bindViewport() {
    if (state.viewportBound) return;
    state.viewportBound = true;
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  function unbindViewport() {
    if (!state.viewportBound) return;
    state.viewportBound = false;
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  }

  // ============================ 11. 背面交互 ============================

  function showError(text) {
    if (!state.back) return;
    const box = state.back.querySelector('.pcr-badge-error');
    if (!box) return;
    box.hidden = false;
    box.textContent = text;
  }

  function clearError() {
    if (!state.back) return;
    const box = state.back.querySelector('.pcr-badge-error');
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'open-options' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 非扩展环境忽略 */ }
    close();
  }

  function doLogout(btn) {
    if (!state.logoutArmed) {
      state.logoutArmed = true;
      btn.classList.add('is-armed');
      const label = btn.querySelector('span');
      if (label) label.textContent = '再点一次确认退出';
      clearTimeout(state.logoutTimer);
      state.logoutTimer = setTimeout(() => {
        state.logoutArmed = false;
        btn.classList.remove('is-armed');
        if (label) label.textContent = '退出登录';
      }, 3000);
      return;
    }

    clearTimeout(state.logoutTimer);
    state.logoutArmed = false;
    btn.disabled = true;
    const label = btn.querySelector('span');
    if (label) label.textContent = '正在退出…';
    clearError();

    fetch(SESSION_URL, { method: 'DELETE', credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.loggedOut = true;
        location.replace('/');
      })
      .catch(() => {
        btn.disabled = false;
        btn.classList.remove('is-armed');
        if (label) label.textContent = '退出登录';
        showError('退出失败，请稍后重试');
      });
  }

  function wireRoot() {
    const root = state.root;
    const card = state.card;

    root.addEventListener('click', (e) => {
      const themeBtn = e.target.closest('[data-pcr-theme]');
      if (themeBtn) {
        e.preventDefault();
        setTheme(themeBtn.getAttribute('data-pcr-theme'));
        return;
      }

      const act = e.target.closest('[data-pcr-act]');
      if (!act) return;
      const name = act.getAttribute('data-pcr-act');
      if (name === 'flip') {
        e.preventDefault();
        toggleFlip();
      } else if (name === 'settings') {
        e.preventDefault();
        openOptions();
      } else if (name === 'logout') {
        e.preventDefault();
        doLogout(act);
      }
    });

    // 拖动后抑制一次点击，避免误触链接
    card.addEventListener('click', (e) => {
      if (!state.suppressClick) return;
      state.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    card.addEventListener('pointerdown', onPointerDown);
    card.addEventListener('pointermove', onPointerMove);
    card.addEventListener('pointerup', onPointerUp);
    card.addEventListener('pointercancel', onPointerCancel);

    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleFlip();
      }
    });
  }

  // ============================ 12. 接管头像 ============================

  function interceptClick(e) {
    if (!state.enabled || state.loggedOut) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = e.target;
    if (!target || !target.closest) return;
    const trigger = target.closest(TRIGGER_SELECTOR);
    if (!trigger) return;

    // 站点 DropdownMenuTrigger 的 onClick 会检查 defaultPrevented
    e.preventDefault();
    e.stopPropagation();
    open(trigger);
  }

  function interceptKeydown(e) {
    if (!state.enabled || state.loggedOut || state.open) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target;
    if (!target || !target.closest) return;
    const trigger = target.closest(TRIGGER_SELECTOR);
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    open(trigger);
  }

  function boot() {
    readEnabled();
    watchEnabled();
    document.addEventListener('click', interceptClick, true);
    document.addEventListener('keydown', interceptKeydown, true);

    const warm = () => {
      readSession()
        .then((user) => loadProfile(user.id))
        .catch(() => {});
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(warm, { timeout: 3000 });
    } else {
      setTimeout(warm, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

/**
 * Luma·Gran 流光 —— 社区站点皮肤控制器
 *
 * 只做三件事：
 *   1. 读取开关 pcr_luma_skin，把皮肤类挂到 <html data-luma="on">（CSS 全部收口在该属性下）；
 *   2. 首屏顶栏不衬背景，滚动后切到云母材质（html.pcl-scrolled）；
 *   3. 鼠标球三态光标：普通态为完整球体（可隐藏为小点），吸附控件时放大成形并跟随，大板块自动隐藏光标球。
 *
 * 开关关闭时不会注册任何监听，也不会创建任何 DOM，站点保持原样。
 */

(() => {
  'use strict';

  /** 设置键：Luma·Gran 外观总开关，默认开启；与设置页保持一致 */
  const LUMA_KEY = 'pcr_luma_skin';

  /** 设置键：隐藏鼠标球（只保留指针中心的小点），默认关闭即显示完整鼠标球 */
  const CURSOR_KEY = 'pcr_luma_cursor';

  /** 设置键：吸附时是否跟随指针做微位移，默认开启 */
  const CURSOR_FOLLOW_KEY = 'pcr_luma_cursor_follow';

  const html = document.documentElement;
  const finePointer = window.matchMedia('(pointer: fine)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let enabled = false;
  let cursorPref = false;   // true = 隐藏鼠标球，只保留小点
  let cursorFollow = true;
  let cursorOn = false;
  let scrollBound = false;

  // ============================ 1. 顶部栏 ============================

  function onScroll() {
    html.classList.toggle('pcl-scrolled', window.scrollY > 8);
  }

  function bindScroll(on) {
    if (on && !scrollBound) {
      window.addEventListener('scroll', onScroll, { passive: true });
      scrollBound = true;
      onScroll();
    } else if (!on && scrollBound) {
      window.removeEventListener('scroll', onScroll);
      scrollBound = false;
      html.classList.remove('pcl-scrolled');
    }
  }

  // ============================ 2. 鼠标球 ============================

  /** 文本输入类：保留系统光标，球体让位 */
  const TEXT_SEL = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  /** 可操作控件：只对最外围的那个画选中框 */
  const INTERACTIVE_SEL = 'a[href], button, [role="button"], summary, [role="tab"], .tab';
  /** 大板块：不再继续变形，交给板块自身的辉光 */
  const CARD_SEL = 'article, [class*="post-card"], [class*="postCard"], [data-post-id]';
  /** 播放器 / 媒体查看器：整块不参与吸附形变，球体保持普通大小 */
  const PLAYER_SEL = 'video, [class*="player"], [class*="Player"], [class*="viewer"], '
    + '[class*="Viewer"], [class*="lightbox"], [class*="Lightbox"], [class*="pswp"]';

  /** 吸附时球体、选中框与被框住的控件共用的跟随比例 */
  const FOLLOW_RATE = 0.1;

  /** 普通态完整鼠标球尺寸（默认）与“隐藏鼠标球”后的小点尺寸 */
  const BALL_SIZE = 22;
  const DOT_SIZE = 6;

  let dot = null;
  let frameEl = null;         // 当前吸附的最外围容器
  let frameMetrics = null;    // 缓存容器几何，避免指针移动时反复读布局
  let followEl = null;        // 被框住的控件本体，随指针做同步微位移
  let followOrigin = '';      // 控件原本的 inline translate，离开时原样还原
  let spotRaf = 0;
  let shrinkTimer = 0;        // 离开控件后，收缩动画结束时移除临时过渡类
  let mode = 'normal';        // normal | control | card | hidden
  let needsResolve = false;   // 滚动 / 缩放后需要重新命中容器
  let mouseX = -100;
  let mouseY = -100;

  /** 归位动画进行中的元素计时器，动画结束后移除临时类 */
  const returnTimers = new WeakMap();

  /** 还原控件本体的位移；animate 为 true 时用一段过渡动画归位 */
  function resetFollow(animate) {
    if (!followEl) return;
    const el = followEl;
    const origin = followOrigin;
    followEl = null;
    followOrigin = '';
    const pending = returnTimers.get(el);
    if (pending) {
      clearTimeout(pending);
      returnTimers.delete(el);
    }
    // 元素已被移除或明确要求瞬时归位，直接写回原值
    if (!animate || !el.isConnected) {
      el.classList.remove('pcl-return');
      el.style.translate = origin;
      return;
    }
    // 先挂过渡类，再把位移写回原值，浏览器会插值出归位动画
    el.classList.add('pcl-return');
    el.style.translate = origin;
    returnTimers.set(el, setTimeout(() => {
      returnTimers.delete(el);
      el.classList.remove('pcl-return');
    }, 340));
  }

  /** 接管一个新的控件：先还原上一个，再记下它原本的 translate */
  function captureFollow(el) {
    if (el === followEl) return;
    resetFollow(true);
    // 取消该元素可能还在进行的归位动画，避免跟随被过渡拖慢
    const pending = returnTimers.get(el);
    if (pending) {
      clearTimeout(pending);
      returnTimers.delete(el);
    }
    el.classList.remove('pcl-return');
    followEl = el;
    followOrigin = el.style.translate || '';
  }

  /**
   * 球体由中心点定位：用 -50% 抵消自身尺寸，交给 translate 属性而不是 transform。
   * translate 在 scale 之后合成，不会被“扩散”时的缩放系数缩小，
   * 所以光团既能从进入方向的边扩散，位置又始终贴在控件上。
   */
  function placeDot(cx, cy) {
    if (!dot) return;
    dot.style.translate = 'calc(' + cx + 'px - 50%) calc(' + cy + 'px - 50%)';
  }

  /** 回到普通态：完整鼠标球，或隐藏后的小点 */
  function setDotNormal() {
    if (!dot) return;
    const fromControl = mode === 'control';
    const size = cursorPref ? DOT_SIZE : BALL_SIZE;
    if (fromControl) {
      // 脱离吸附：尺寸这一路才参与过渡，缩放立即归 1，从控件边缘收拢回指针
      clearTimeout(shrinkTimer);
      dot.classList.add('pcl-shrink');
      dot.style.scale = '1';
      dot.style.transformOrigin = '50% 50%';
      shrinkTimer = setTimeout(() => {
        shrinkTimer = 0;
        if (dot) dot.classList.remove('pcl-shrink');
      }, 420);
    }
    dot.classList.remove('pcl-melt');
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    // 用超大 px 半径代替 50%：收缩过程中始终是胶囊形，避免宽矩形被 50% 撑成椭圆
    dot.style.borderRadius = '999px';
    dot.style.background = cursorPref ? 'rgba(128,128,128,.85)' : 'rgba(128,128,128,.22)';
    dot.style.borderColor = cursorPref ? 'rgba(128,128,128,.35)' : 'rgba(128,128,128,.5)';
    dot.style.borderWidth = cursorPref ? '1px' : '1.5px';
    // 辉光回到球心，避免离开控件后小点仍被残留的偏置照亮
    dot.style.setProperty('--pcl-sx', '50%');
    dot.style.setProperty('--pcl-sy', '50%');
    dot.style.setProperty('--pcl-sr', Math.round(size * 1.6) + 'px');
    dot.style.opacity = '1';
    placeDot(mouseX, mouseY);
  }

  /**
   * 向上寻找“最外围容器”：
   * - 可操作控件取最外层的那个，内部嵌套的按钮 / 链接不再重复变形；
   * - 卡片是最外围容器时整块不吸附，避免卡片里的元素牵动整张卡片变形。
   */
  function resolveContainer(target) {
    let el = target;
    let control = null;
    let card = null;
    while (el && el !== document.body && el !== html) {
      if (el.matches) {
        if (el.matches(INTERACTIVE_SEL)) control = el;
        if (el.matches(CARD_SEL)) card = el;
      }
      el = el.parentElement;
    }
    if (card && (!control || card.contains(control))) return { type: 'card' };
    if (control) return { type: 'control', el: control };
    return { type: 'plain' };
  }

  /**
   * 用缓存的几何更新选中框、框内辉光与控件本体，不触发任何布局读取。
   * 三者按同一比例偏移，视觉上整块控件随指针轻微漂浮，框始终套住控件；
   * 关闭跟随开关时偏移为 0，全部静止在控件原位。
   */
  function updateSpot() {
    if (!dot || !frameMetrics || mode !== 'control') return;
    const m = frameMetrics;
    const rate = cursorFollow ? FOLLOW_RATE : 0;
    const ox = (mouseX - m.cx) * rate;
    const oy = (mouseY - m.cy) * rate;
    const left = m.left - m.pad + ox;
    const top = m.top - m.pad + oy;
    // 辉光画在球体自身，跟着指针在球内游走
    dot.style.setProperty('--pcl-sx', (((mouseX - left) / m.w) * 100).toFixed(2) + '%');
    dot.style.setProperty('--pcl-sy', (((mouseY - top) / m.h) * 100).toFixed(2) + '%');
    dot.style.setProperty('--pcl-sr', Math.round(Math.max(m.w, m.h) * 1.3) + 'px');
    if (followEl) {
      followEl.style.translate = ox.toFixed(2) + 'px ' + oy.toFixed(2) + 'px';
    }
  }

  /** 辉光按帧合并，高频移动时不做多余的样式写入 */
  function scheduleSpot() {
    if (spotRaf) return;
    spotRaf = requestAnimationFrame(() => {
      spotRaf = 0;
      updateSpot();
    });
  }

  /** 结束吸附：控件归位，球体继续跟随 */
  function hideFrame() {
    resetFollow(true);
    frameEl = null;
    frameMetrics = null;
  }

  /** 文本输入 / 指针离开：两层都收起，恢复系统光标 */
  function hideAll(native) {
    mode = 'hidden';
    resetFollow(true);
    if (dot) {
      dot.style.opacity = '0';
      // 收起时把缩放/原点归位，避免下次出现时带着上一次的形变
      clearTimeout(shrinkTimer);
      shrinkTimer = 0;
      dot.classList.remove('pcl-shrink', 'pcl-melt');
      dot.style.scale = '1';
      dot.style.transformOrigin = '50% 50%';
    }
    html.classList.toggle('pcl-native-cursor', !!native);
    frameEl = null;
    frameMetrics = null;
    if (spotRaf) {
      cancelAnimationFrame(spotRaf);
      spotRaf = 0;
    }
  }

  /** 把球体融成最外围容器的形状 */
  function showFrame(el) {
    if (!dot) return;
    // 同一个最外围容器内移动（事件来自子元素）不重复触发行变
    if (el === frameEl && mode === 'control' && frameMetrics) return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) {
      hideFrame();
      setDotNormal();
      mode = 'plain';
      return;
    }
    // 覆盖过大的容器（整栏 / 整页链接）不吸附，避免出现一个巨大的框
    if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.4) {
      hideFrame();
      setDotNormal();
      mode = 'plain';
      return;
    }

    const cs = getComputedStyle(el);
    // 自带底色或框线的控件已经有视觉边界，选中框贴合本身；纯文字链接外扩 4px 套住
    const hasSurface = cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
      || cs.backgroundImage !== 'none'
      || parseFloat(cs.borderTopWidth) > 0;
    const pad = hasSurface ? 0 : 4;
    const w = rect.width + pad * 2;
    const h = rect.height + pad * 2;

    const rawRadius = cs.borderTopLeftRadius || '';
    let radiusCss;
    if (rawRadius.indexOf('%') !== -1) {
      // 圆形控件保留百分比，避免 pad 叠加后变成椭圆
      radiusCss = '50%';
    } else if (Math.abs(rect.width - rect.height) <= 2 && rect.width <= 44) {
      radiusCss = '50%';
    } else {
      let radius = parseFloat(rawRadius) || 8;
      radiusCss = (radius + pad) + 'px';
    }

    mode = 'control';
    frameEl = el;
    frameMetrics = {
      left: rect.left,
      top: rect.top,
      w: w,
      h: h,
      pad: pad,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2
    };

    // 球体形变成控件大小，并与控件、选中框一起按同一比例跟随指针
    if (cursorFollow) captureFollow(el);
    else resetFollow(true);
    const rate = cursorFollow ? FOLLOW_RATE : 0;
    const dx = mouseX >= 0 ? (mouseX - frameMetrics.cx) * rate : 0;
    const dy = mouseY >= 0 ? (mouseY - frameMetrics.cy) * rate : 0;

    // 进入方向：取指针最近的那条边，光团就从那条边扩散出去
    const toL = mouseX - rect.left;
    const toR = rect.right - mouseX;
    const toT = mouseY - rect.top;
    const toB = rect.bottom - mouseY;
    const near = Math.min(toL, toR, toT, toB);
    let originCss = '50% 50%';
    if (near === toL) originCss = '0% 50%';
    else if (near === toR) originCss = '100% 50%';
    else if (near === toT) originCss = '50% 0%';
    else if (near === toB) originCss = '50% 100%';

    clearTimeout(shrinkTimer);
    shrinkTimer = 0;
    // 起始态（尺寸、缩放、原点）先直接落位，再展开，避免和上一态插值
    dot.classList.remove('pcl-shrink');
    dot.classList.add('pcl-instant');
    dot.classList.remove('pcl-melt');
    dot.style.transformOrigin = originCss;
    dot.style.scale = '0.04';
    dot.style.width = w + 'px';
    dot.style.height = h + 'px';
    dot.style.borderRadius = radiusCss;
    // 只留光辉：几乎不压暗控件，去掉描边，交给 .pcl-melt 的虚化融球
    dot.style.background = 'rgba(128,128,128,.04)';
    dot.style.borderColor = 'transparent';
    dot.style.opacity = '1';
    placeDot(frameMetrics.cx + dx, frameMetrics.cy + dy);
    updateSpot();
    void dot.offsetWidth;   // 让 0.04 的起始缩放先落地，展开才会走过渡
    dot.classList.remove('pcl-instant');
    dot.classList.add('pcl-melt');
    dot.style.scale = '1';
  }

  /** 根据指针下的元素切换球体 / 选中框 */
  function applyTarget(target) {
    if (!dot || !(target instanceof Element)) return;

    if (target.closest(TEXT_SEL)) {
      hideAll(true);
      return;
    }

    // 作品播放器等媒体区域不参与吸附形变，球体保持普通大小
    if (target.closest(PLAYER_SEL)) {
      hideFrame();
      setDotNormal();
      mode = 'plain';
      return;
    }

    // 离开输入框后恢复球体与“无系统光标”状态
    html.classList.remove('pcl-native-cursor');

    const container = resolveContainer(target);
    if (container.type === 'control') {
      showFrame(container.el);
      return;
    }

    hideFrame();
    setDotNormal();
    mode = container.type; // card | plain
  }

  function onPointerMove(e) {
    // 指针移出窗口时浏览器可能补发被归零的坐标，与上次位置相差过大就直接丢弃，
    // 避免球体瞬间闪回页面左上角
    if (e.clientX === 0 && e.clientY === 0
      && (Math.abs(mouseX) > 32 || Math.abs(mouseY) > 32)) return;
    // 视口外的坐标不参与绘制
    if (e.clientX < 0 || e.clientY < 0
      || e.clientX > window.innerWidth || e.clientY > window.innerHeight) return;
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!dot) return;

    if (mode === 'control') {
      if (frameEl && frameMetrics && document.contains(frameEl)) {
        // 粘滞偏移：球体以容器中心为基准向指针靠 FOLLOW_RATE，跟手但不会乱飞
        const m = frameMetrics;
        const rate = cursorFollow ? FOLLOW_RATE : 0;
        placeDot(m.cx + (mouseX - m.cx) * rate,
          m.cy + (mouseY - m.cy) * rate);
        scheduleSpot(); // 同帧更新选中框、辉光与控件本体的位移
        return;
      }
      // 容器被 SPA 移除：退回普通态
      resetFollow(true);
      setDotNormal();
      mode = 'normal';
    }

    if (mode === 'hidden') {
      // 指针重新回到页面：恢复自绘光标；仍在输入框内则继续让位
      applyTarget(e.target);
      return;
    }

    placeDot(mouseX, mouseY);

    // 普通 / 卡片态：滚动后重新命中一次容器，其余移动不再重复向上查找
    if (needsResolve) {
      needsResolve = false;
      applyTarget(e.target);
    }
  }

  function onPointerOver(e) {
    applyTarget(e.target);
  }

  function onPointerDown() {
    if (!dot) return;
    dot.style.background = cursorPref ? 'rgba(128,128,128,1)' : 'rgba(128,128,128,.4)';
  }

  function onPointerUp() {
    if (!dot) return;
    if (mode === 'control') dot.style.background = 'rgba(128,128,128,.12)';
    else setDotNormal();
  }

  function onViewportChange() {
    // 滚动 / 缩放后容器位置失效：只收起选中框，普通态不做多余写入
    if (spotRaf) {
      cancelAnimationFrame(spotRaf);
      spotRaf = 0;
    }
    if (mode === 'control') {
      hideFrame();
      setDotNormal();
    }
    mode = 'normal';
    needsResolve = true;
  }

  /**
   * 指针离开页面：只收起自绘光标，不切换系统指针。
   * 若在这里恢复系统指针，Chrome 会把光标重新绘制在最后一次布局的位置（常见为左上角），
   * 看起来就像指针被“锁定”后闪回去。
   */
  function onPointerLeave() {
    mode = 'hidden';
    needsResolve = false;
    resetFollow(true);
    if (dot) {
      dot.style.opacity = '0';
      clearTimeout(shrinkTimer);
      shrinkTimer = 0;
      dot.classList.remove('pcl-shrink', 'pcl-melt');
      dot.style.scale = '1';
      dot.style.transformOrigin = '50% 50%';
    }
    frameEl = null;
    frameMetrics = null;
    if (spotRaf) {
      cancelAnimationFrame(spotRaf);
      spotRaf = 0;
    }
  }

  function enableCursor() {
    if (cursorOn) return;
    if (!finePointer.matches || reduceMotion.matches) return;
    if (!document.body) return;

    cursorOn = true;
    dot = document.createElement('div');
    dot.className = 'pcl-cursor-dot';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);

    html.classList.add('pcl-cursor-on');
    // 隐藏鼠标球（小点模式）时保留系统指针，完整球体时隐藏系统指针
    html.classList.toggle('pcl-dot-mode', cursorPref);
    // pointerrawupdate 比 pointermove 更早、更密，能进一步降低跟随延迟
    const moveEvent = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
    document.addEventListener(moveEvent, onPointerMove, { passive: true });
    document.addEventListener('pointerover', onPointerOver, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointerup', onPointerUp, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    window.addEventListener('scroll', onViewportChange, { passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  function disableCursor() {
    if (!cursorOn) return;
    cursorOn = false;
    html.classList.remove('pcl-cursor-on', 'pcl-native-cursor', 'pcl-dot-mode');
    document.removeEventListener('pointerrawupdate', onPointerMove);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('resize', onViewportChange);
    // 关闭光标时直接还原，不再播放归位动画
    resetFollow(false);
    clearTimeout(shrinkTimer);
    shrinkTimer = 0;
    if (dot) dot.remove();
    dot = null;
    frameEl = null;
    frameMetrics = null;
    mode = 'normal';
    if (spotRaf) {
      cancelAnimationFrame(spotRaf);
      spotRaf = 0;
    }
  }

  // ============================ 3. 开关 ============================

  function apply(value) {
    enabled = !!value;
    if (enabled) {
      html.dataset.luma = 'on';
      bindScroll(true);
    } else {
      delete html.dataset.luma;
      bindScroll(false);
    }
    syncCursor();
  }

  /** 鼠标球只受总开关控制；隐藏小点只是普通态的尺寸差异 */
  function syncCursor() {
    if (enabled) enableCursor();
    else disableCursor();
  }

  /**
   * 跟随开关变化时立即让当前吸附状态回到静止位置，
   * 避免控件带着上一帧的位移卡住。
   */
  function syncFollow() {
    if (!dot) return;
    if (mode === 'control') {
      hideFrame();
      setDotNormal();
      mode = 'normal';
      needsResolve = true;
    }
  }

  function init() {
    try {
      chrome.storage.local.get([LUMA_KEY, CURSOR_KEY, CURSOR_FOLLOW_KEY], (raw) => {
        cursorPref = raw[CURSOR_KEY] === true;
        cursorFollow = raw[CURSOR_FOLLOW_KEY] !== false && raw[CURSOR_FOLLOW_KEY] !== '0';
        apply(raw[LUMA_KEY] !== false && raw[LUMA_KEY] !== '0');
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[LUMA_KEY]) {
          const v = changes[LUMA_KEY].newValue;
          apply(v !== false && v !== '0');
        }
        if (changes[CURSOR_KEY]) {
          cursorPref = changes[CURSOR_KEY].newValue === true;
          // 小点模式显示系统指针，完整球体模式隐藏系统指针
          if (cursorOn) html.classList.toggle('pcl-dot-mode', cursorPref);
          // 只在普通态直接换尺寸；吸附中保持当前形变，离开后自然变小
          if (mode !== 'control') setDotNormal();
        }
        if (changes[CURSOR_FOLLOW_KEY]) {
          const v = changes[CURSOR_FOLLOW_KEY].newValue;
          cursorFollow = v !== false && v !== '0';
          syncFollow();
        }
      });
    } catch (e) {
      // 非扩展环境（本地预览）按默认开启处理
      apply(true);
    }

    // 系统偏好变化时重新判定鼠标球是否可用
    const onPrefChange = () => {
      if (!enabled) return;
      if (finePointer.matches && !reduceMotion.matches) enableCursor();
      else disableCursor();
    };
    finePointer.addEventListener('change', onPrefChange);
    reduceMotion.addEventListener('change', onPrefChange);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();

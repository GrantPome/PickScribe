/**
 * 新手引导（命名空间 pcg）。
 *
 * 三种形态：
 *   1. 欢迎流程：首装后在信息流页出现一次，居中模态 + 全屏黑色半透明遮罩。
 *      一屏一个功能大类（欢迎 + 4 类功能 + 准备就绪），只由按钮推进；
 *      遮罩点击、滚动、Esc 都不会关闭。
 *      在它结束（结束 / 跳过）之前，分步引导不会开始。
 *   2. 分步引导（Tour）：首次打开帖子浮层并落定后播放，卡片贴在目标元素旁边，
 *      用单元素扩散阴影挖空遮罩，卡片带指向箭头；目标不可见 / 不在视口时跳过该步。
 *   3. 场景气泡（Hint）：浮层内按场景命中，指向具体控件，自动消失。
 *
 * 与浮层的协作只走 window 自定义事件，不互相引用内部变量：
 *   pco-guide:overlay-settled  { composerTools }
 *   pco-guide:topic-rendered   { headingCount, hasToc }
 *   pco-guide:composer-focus   { toolsEnabled }
 *   pco-guide:ai-blocked
 *   pco-guide:select-blocked
 *   pco-guide:overlay-closed
 *
 * 状态全部落在 chrome.storage.local：
 *   pco_guide       整体与步骤级（state / done[] / welcomeDone / replay）
 *   pco_guide_hints 气泡级（每个 id 的展示次数与时间）
 */

(() => {
  'use strict';

  if (window.PCOGuide) return;

  // ============================ 0. 常量 ============================

  /** 引导内容版本：只有步骤有增删时才 +1，与扩展版本号无关 */
  const GUIDE_VERSION = 2;
  const KEY_STATE = 'pco_guide';
  const KEY_HINTS = 'pco_guide_hints';
  const KEY_CFG = 'pco_config';

  /** 视为信息流的路径：只有这些页面出欢迎卡 */
  const FEED_PATH = /^\/$|^\/forum(?:\/category\/[^/?#]+)?$|^\/search$/;

  /** 分步引导：顺序即播放顺序，步数与进度点都按这个数组算；每一步都指向一个真实元素，找不到就跳过 */
  const STEPS = [
    {
      id: 'layout',
      icon: 'layout',
      anchor: '.pco-shell',
      center: true,
      pad: 0,
      radius: 22,
      title: '一层装下整篇帖子',
      body: '左边读正文，右边看回复，最右一栏管点赞、收藏、目录和 AI；标题栏还能加宽或全屏。关掉就回到信息流原位。'
    },
    {
      id: 'ai',
      icon: 'sparkles',
      anchor: '[data-act="ai-summarize"]',
      prefer: 'bottom',
      title: '让 AI 先替你读一遍',
      body: '标题右侧的「总结本帖」会把要点送到左侧面板，长帖不用逐段翻；总结会缓存，再开秒出。'
    },
    {
      id: 'nav',
      icon: 'nav',
      // 用左边那颗按钮做锚点：.pco-nav 是覆盖整卡的容器，圈整卡没有指示意义
      anchor: '.pco-nav-btn',
      prefer: 'right',
      title: '不回头，也能连着看',
      body: '两侧箭头切换上一篇 / 下一篇，相邻帖子已经提前加载好，几乎瞬时；没有相邻帖子时按钮会淡化。'
    },
    {
      id: 'select',
      icon: 'cursor',
      anchor: '[data-act="select"]',
      prefer: 'left',
      title: '想复制就划选',
      body: '浮层默认禁止划选以免误选；点这颗按钮临时开启文本选中，正文和图片都能拖选复制，再点一次就关闭。'
    },
    {
      id: 'dismiss',
      icon: 'up',
      anchor: '.pco-grabber',
      prefer: 'top',
      title: '想走随时走',
      body: '向上拖动底部横条、按 Esc 或点空白处都能关闭；关掉就回到原来的位置。'
    }
  ];

  /**
   * 欢迎流程：一屏一个类别，只讲本类别的能力。
   * 顺序固定为 欢迎 → 刷帖与阅读 → 发帖与回复 → AI 能力 → 外观与动效 → 准备就绪。
   * 添加 / 删除类别时只改这个数组：屏数、进度点与「结束」判断都会跟着变。
   */
  const WELCOME_FLOW = [
    {
      kind: 'welcome',
      title: '欢迎使用 PickScribe',
      sub: '社区里的阅读与互动都做了优化：少跳页、少打断，把注意力留给内容。下面按类别过一遍。'
    },
    {
      kind: 'feature',
      id: 'reading',
      icon: 'layout',
      title: '刷帖与阅读',
      lead: '在信息流里就能把一篇帖子读完，不用来回跳页。',
      points: [
        { icon: 'grid', text: '<b>一屏多看几帖</b>：信息流可在列表与网格之间切换，选择会记住。' },
        { icon: 'layout', text: '<b>点帖不跳页</b>：正文和回复在原卡片位置展开，关掉回到原来的位置。' },
        { icon: 'book', text: '<b>长帖也能顺着读</b>：目录直达章节、一键回顶部，两侧箭头切上一篇 / 下一篇。' },
        { icon: 'expand', text: '<b>想放大就放大</b>：浮层可加宽或全屏，正文与回复里的图片点开看大图。' }
      ]
    },
    {
      kind: 'feature',
      id: 'composing',
      icon: 'edit',
      title: '发帖与回复',
      lead: '发帖和回复都换成所见即所得的编辑体验，排版不用再手写 Markdown。',
      points: [
        { icon: 'edit', text: '<b>发帖像写文档</b>：颜色、高亮、对齐、表格、公式、视频都能排，发出仍是标准 Markdown。' },
        { icon: 'wand', text: '<b>排版交给 AI</b>：把正文整理成规范的标题层级与列表，预览确认后再替换。' },
        { icon: 'reply', text: '<b>回复也能排版</b>：工具条支持表情、图片拖入与全屏编辑，还能指定回复某一楼。' },
        { icon: 'at', text: '<b>@ 提及显示真名</b>：正文与回复里的编号自动换成用户名，不用再猜是谁。' }
      ]
    },
    {
      kind: 'feature',
      id: 'ai',
      icon: 'sparkles',
      title: 'AI 能力',
      lead: '读长帖和写回复，都可以先让 AI 打个底，用不用由你决定。',
      points: [
        { icon: 'sparkles', text: '<b>先看要点再决定</b>：「总结本帖」把长帖压成几条，结果会缓存，再开秒出。' },
        { icon: 'chat', text: '<b>回复先起个头</b>：AI 按帖子写一条回复或润色草稿，只填进输入框，不自动发送。' },
        { icon: 'server', text: '<b>模型自己选</b>：支持多家在线服务商，也能接本机 Ollama；接口、提示词与输出长度可改。' },
        { icon: 'chart', text: '<b>用量心里有数</b>：输入、输出与请求次数按次统计，配置可导出备份。' }
      ]
    },
    {
      kind: 'feature',
      id: 'appearance',
      icon: 'type',
      title: '外观与动效',
      lead: '让整站的文字和动态效果更合你的习惯。',
      points: [
        { icon: 'type', text: '<b>字体可换</b>：整站可换鸿蒙字体，也能上传自己的字体文件，只存在本机。' },
        { icon: 'sliders', text: '<b>动效可调</b>：卡片 3D 倾斜、背景模糊与缩放、打开动画都能单独开关。' },
        { icon: 'reduce', text: '<b>动静能收住</b>：动画速度可调；系统开启「减少动态效果」时自动降级。' }
      ]
    },
    {
      kind: 'finish',
      title: '一切已准备就绪',
      sub: '打开任意一张帖子卡片，就会看到这层浮层。想改设置时，点右上角头像打开账号菜单，选「PickScribe 设置」。'
    }
  ];

  // ============ 引导内的快捷配置：与设置页共用同一份 chrome.storage.local ============

  const AI_CONFIG_KEY = 'pcai_config';
  const LAYOUT_KEY = 'pcr_feed_layout';
  const IMAGE_ZOOM_KEY = 'pcr_image_zoom';
  const FONT_KEY = 'pcr_harmony_font';
  const FONT_MODE_KEY = 'pcr_font_mode';
  const FONT_CUSTOM_KEY = 'pcr_custom_font';

  /** 服务商预设：只用于引导里的下拉与默认地址，真实配置仍写回 pcai_config */
  const AI_PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'doubao', name: '豆包 · 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-250615'] },
    { id: 'qwen', name: '通义千问 · 阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
    { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0711-preview'] },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-air'] },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-7B-Instruct'] },
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat-v3-0324:free'] },
    { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5:7b'], keyless: true },
    { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', models: [], custom: true }
  ];

  function aiProvider(id) {
    return AI_PROVIDERS.find((p) => p.id === id) || AI_PROVIDERS[0];
  }

  /** 设置页「动画速度」只有 0.7 / 1 / 1.4 三档；旧版本写入的其它值显示时吸附到最近一档 */
  const ANIM_SPEEDS = [0.7, 1, 1.4];
  function animSpeedOption(value) {
    let best = ANIM_SPEEDS[1];
    let gap = Infinity;
    for (let i = 0; i < ANIM_SPEEDS.length; i += 1) {
      const d = Math.abs(ANIM_SPEEDS[i] - Number(value));
      if (d < gap) { gap = d; best = ANIM_SPEEDS[i]; }
    }
    return String(best);
  }

  function normalizeOverlayCfg(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const speed = Number(c.animSpeed);
    return {
      enabled: c.enabled !== false,
      composerTools: !!c.composerTools,
      blur: c.blur !== false,
      pageScale: c.pageScale !== false,
      animSpeed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1,
      cardTilt: c.cardTilt !== false,
      openTilt: c.openTilt !== false
    };
  }

  function cfgSwitch(name, label) {
    return '<label class="pcg-cfg-row pcg-cfg-row--switch">' +
      '<span class="pcg-cfg-label">' + label + '</span>' +
      '<input type="checkbox" data-cfg="' + name + '" />' +
      '<span class="pcg-cfg-switch" aria-hidden="true"></span>' +
    '</label>';
  }

  function cfgSelect(name, label, options) {
    return '<label class="pcg-cfg-row">' +
      '<span class="pcg-cfg-label">' + label + '</span>' +
      '<select class="pcg-cfg-input" data-cfg="' + name + '">' +
        options.map((item) => '<option value="' + item[0] + '">' + item[1] + '</option>').join('') +
      '</select>' +
    '</label>';
  }

  function aiTestFrameHtml() {
    let url = '';
    try { url = chrome.runtime.getURL('shared/guide-ai-test.html'); } catch (e) { url = ''; }
    if (!url) return '<button type="button" class="pcg-cfg-btn" disabled>测试连接</button>';
    return '<iframe class="pcg-cfg-testframe" data-role="ai-test-frame" src="' + url + '" ' +
      'title="测试连接" scrolling="no"></iframe>';
  }

  /** 每个类别屏自己的配置区；控件全部对应设置页现有的存储键 */
  function configHtml(id) {
    if (id === 'reading') {
      return '<div class="pcg-config">' +
        cfgSelect('layout', '信息流默认视图', [['grid', '网格'], ['list', '列表']]) +
        cfgSwitch('imageZoom', '点击图片查看大图') +
      '</div>';
    }
    if (id === 'composing') {
      return '<div class="pcg-config">' +
        cfgSwitch('composerTools', '回复框显示排版工具条') +
        '<p class="pcg-config-note">打开后可在回复框加粗、插表情、拖图上传，也能让 AI 帮写。</p>' +
      '</div>';
    }
    if (id === 'ai') {
      // 总开关放配置区第一行：关闭后下面的分项一起置灰，也不再发请求
      return '<div class="pcg-config" data-config="ai">' +
        cfgSwitch('aiEnabled', '启用 AI 功能') +
        '<p class="pcg-config-note" data-role="ai-off-note" hidden>总开关已关闭，下面的分项暂时不可用。</p>' +
        '<div class="pcg-cfg-group" data-role="ai-subs">' +
          cfgSwitch('enabled', '帖子总结') +
          cfgSwitch('aiAuto', '自动总结') +
          cfgSwitch('aiChat', '面板内提问') +
          cfgSwitch('aiReply', 'AI 回信 / 润色') +
          cfgSwitch('aiFormat', 'AI 排版') +
          cfgSwitch('aiWriter', 'AI 写作助手') +
        '</div>' +
        '<label class="pcg-cfg-row">' +
          '<span class="pcg-cfg-label">服务商</span>' +
          '<select class="pcg-cfg-input" data-cfg="aiProvider">' +
            AI_PROVIDERS.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('') +
          '</select>' +
        '</label>' +
        '<label class="pcg-cfg-row" data-role="ai-base-row" hidden>' +
          '<span class="pcg-cfg-label">接口地址</span>' +
          '<input class="pcg-cfg-input" data-cfg="aiBaseUrl" placeholder="https://…/v1" spellcheck="false" />' +
        '</label>' +
        '<label class="pcg-cfg-row" data-role="ai-model-row" hidden>' +
          '<span class="pcg-cfg-label">模型名</span>' +
          '<input class="pcg-cfg-input" data-cfg="aiModel" placeholder="模型 ID" spellcheck="false" />' +
        '</label>' +
        '<label class="pcg-cfg-row" data-role="ai-key-row">' +
          '<span class="pcg-cfg-label">API Key</span>' +
          '<input class="pcg-cfg-input" type="password" data-cfg="aiKey" placeholder="sk-…" autocomplete="off" spellcheck="false" />' +
        '</label>' +
        '<div class="pcg-cfg-actions">' +
          aiTestFrameHtml() +
          '<span class="pcg-cfg-status" data-role="ai-status">只存在本机，不填也能先下一步</span>' +
        '</div>' +
      '</div>';
    }
    if (id === 'appearance') {
      // 与设置页「站点外观 / 刷帖体验优化」同一套键、同一组文案与默认值
      return '<div class="pcg-config">' +
        cfgSelect('fontMode', '字体', [
          ['site', '使用站点原字体'],
          ['harmony', '鸿蒙字体（内置）'],
          ['custom', '自定义字体（上传）']
        ]) +
        '<p class="pcg-config-note" data-role="font-note" hidden></p>' +
        cfgSwitch('blur', '遮罩使用背景模糊（毛玻璃）') +
        cfgSwitch('pageScale', '打开浮层时背景页面同步缩放') +
        cfgSwitch('cardTilt', '信息流卡片 3D 倾斜（悬停时卡片跟随鼠标视角轻微转动）') +
        cfgSwitch('openTilt', '打开浮层时 3D 倾斜回正（面板带透视倾角展开后转正）') +
        cfgSelect('animSpeed', '动画速度', [
          ['0.7', '慢速（0.7×）'],
          ['1', '标准（1×）'],
          ['1.4', '快速（1.4×）']
        ]) +
      '</div>';
    }
    return '';
  }

  /** 场景气泡：每个 id 只出现一次；value.anchor 找不到时静默跳过 */
  const HINTS = {
    'composer-tools': {
      anchor: '.pco-composer-box',
      prefer: 'top',
      title: '回复也能排版',
      body: '在设置里打开「回复框工具条」，就能加粗、插表情、贴图片、拖图上传，也能让 AI 帮你写或润色，只填不发。',
      action: { label: '去开启', run: openOptions }
    },
    'ai-setup': {
      anchor: '[data-act="ai-summarize"]',
      prefer: 'bottom',
      title: '还差一个 API Key',
      body: '选一个服务商、填入密钥，就能用「总结本帖」和 AI 回复；本机 Ollama 不需要 Key。',
      action: { label: '去设置', run: openOptions }
    },
    toc: {
      anchor: '[data-act="toc"]',
      prefer: 'left',
      title: '这篇有点长',
      body: '点这里展开文章目录，可以直接跳到任意章节；标题不足两个时入口会自动隐藏。'
    },
    select: {
      anchor: '[data-act="select"]',
      prefer: 'left',
      title: '想复制正文？',
      body: '浮层默认禁止划选，点这个按钮可以临时开启文本选中，正文和图片都能正常拖选。'
    }
  };

  /** 图标：与浮层同一套 Mingcute 线条风格 */
  const ICONS = {
    layout: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9 4.5v15"/><path d="M16 4.5v15"/>',
    sparkles: '<path d="m12 3 1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z"/><path d="M18.2 16.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z"/>',
    nav: '<path d="M9.5 6 4 12l5.5 6"/><path d="m14.5 6 5.5 6-5.5 6"/>',
    up: '<path d="M12 19.5V5m0 0-6.2 6.2M12 5l6.2 6.2"/>',
    cursor: '<path d="M9 4h6"/><path d="M12 4v16"/><path d="M9 20h6"/>',
    reply: '<path d="M4.5 5.5h15v11h-9.5l-5.5 4v-15Z"/><path d="M8 9.5h8"/>',
    welcome: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7.5 9h9"/><path d="M7.5 12.5h5.5"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    book: '<path d="M12 6.5C10.5 5.2 8.6 4.5 6 4.5H4v13h2c2.6 0 4.5.7 6 2 1.5-1.3 3.4-2 6-2h2v-13h-2c-2.6 0-4.5.7-6 2Z"/><path d="M12 6.5v13"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="m14.5 6.5 3 3"/>',
    expand: '<path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M4 15v5h5"/>',
    wand: '<path d="m4 20 9.5-9.5"/><path d="M15.5 4.5 16.3 7l2.5.8-2.5.8-.8 2.5-.8-2.5-2.5-.8 2.5-.8.8-2.5Z"/><path d="m19 14.5.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L17 16.5l1.5-.5.5-1.5Z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1A10 10 0 1 0 18.6 19.4"/>',
    chat: '<path d="M4.5 5.5h15v10H11L6 19v-3.5H4.5v-10Z"/><path d="M8 9.5h8"/><path d="M8 12.5h5"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="6.5" rx="2"/><rect x="3.5" y="13" width="17" height="6.5" rx="2"/><path d="M7 7.75h.01"/><path d="M7 16.25h.01"/>',
    chart: '<path d="M4 19.5V4.5"/><path d="M4 19.5h16"/><path d="M8 16v-4"/><path d="M12.5 16V8.5"/><path d="M17 16v-6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.4-3.4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V9H8"/><path d="M12 8v4.5l3 1.8"/>',
    home: '<path d="m4 10.5 8-6.5 8 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20v-9.5Z"/><path d="M9.5 21.5v-6h5v6"/>',
    bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 4.2 1.5 5.5 1.5 5.5h-15S6 13.7 6 9.5Z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0"/>',
    badge: '<path d="M4 6.5h9"/><path d="M4 12h9"/><path d="M4 17.5h9"/><circle cx="18" cy="6.5" r="2.8"/>',
    type: '<path d="M5 6.5V4.5h14v2"/><path d="M12 4.5V20"/><path d="M9 20h6"/>',
    sliders: '<path d="M4 8h9"/><path d="M17 8h3"/><circle cx="15" cy="8" r="2"/><path d="M4 16h4"/><path d="M12 16h8"/><circle cx="10" cy="16" r="2"/>',
    reduce: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>'
  };

  // ============================ 1. 工具 ============================

  function h(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /** chrome.storage.local 的 Promise 包装；扩展上下文失效时静默降级 */
  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (raw) => resolve(raw || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function isFeedPage() {
    const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    return FEED_PATH.test(path);
  }

  /** 元素存在且真的占位（隐藏的按钮不能当锚点） */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function resolveEl(selector) {
    if (!selector) return null;
    const el = document.querySelector(selector);
    return isVisible(el) ? el : null;
  }

  function openOptions() {
    try { chrome.runtime.sendMessage({ type: 'open-options' }); } catch (e) { /* 忽略 */ }
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // ============================ 2. 状态 ============================

  function freshState() {
    return {
      v: GUIDE_VERSION,
      state: 'pending',     // pending | welcome | waiting | tour | done | skipped
      done: [],
      welcomeDone: false,
      skipped: false,
      skippedAt: 0,
      replay: false,
      updatedAt: 0
    };
  }

  let state = freshState();
  let hints = {};
  let ready = false;
  let animSpeed = 1;

  let root = null;
  let welcomeEl = null;
  let welcomeScreen = 0;
  let confettiRaf = 0;
  let confettiTimer = 0;
  /** 被引导临时视觉隐藏的「分享你的想法」输入框及其外层容器 */
  let shareBoxRestore = [];
  let tourEl = null;
  let spotEl = null;
  let bubbleEl = null;
  let bubbleTimer = 0;
  let tourIndex = 0;
  let tourSteps = [];
  let tourActive = false;
  let tourScheduled = false;

  let overlayOpen = false;
  let settled = false;
  let topicInfo = { headingCount: 0, hasToc: false, tocOpen: false };
  let composerTools = false;
  let sessionHinted = false;

  /** guide 脚本可能晚于浮层落定，先把事件缓存下来 */
  let pendingSettle = null;
  let pendingTopic = null;

  function persist() {
    state.updatedAt = Date.now();
    storageSet({ [KEY_STATE]: state });
  }

  function persistHints() {
    storageSet({ [KEY_HINTS]: hints });
  }

  function pendingSteps(force) {
    return STEPS.filter((step) => {
      if (!force && state.done.indexOf(step.id) !== -1) return false;
      // 目标不可见 / 不在视口（例如窄屏没有左右箭头）时整步跳过
      if (!resolveStepTarget(step)) return false;
      return true;
    });
  }

  // ============================ 3. 根节点与节奏 ============================

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.id = 'pcg-root';
    applySpeed();
    document.body.appendChild(root);
    // 根节点重建时，已挂载的浮层类元素会一起丢失，这里同步清空引用；
    // 欢迎卡若还开着，先把被隐藏的站点输入框恢复，避免它永久消失
    if (welcomeEl) {
      stopConfetti();
      restoreShareBox();
    }
    welcomeEl = null;
    tourEl = null;
    bubbleEl = null;
    spotEl = null;
    return root;
  }

  function applySpeed() {
    if (!root) return;
    const n = Number(animSpeed);
    root.style.setProperty('--pcg-dur', String(Number.isFinite(n) && n > 0 ? 1 / n : 1));
  }

  // ============================ 4. 欢迎卡 ============================

  function maybeWelcome() {
    if (!ready || welcomeEl || tourActive) return;
    if (state.welcomeDone) return;
    if (!isFeedPage()) return;
    showWelcome();
  }

  /** 插件 LOGO：优先用扩展图标（需在 web_accessible_resources 里声明） */
  function logoMark() {
    let url = '';
    try { url = chrome.runtime.getURL('icons/logo.svg'); } catch (e) { url = ''; }
    if (!url) return '<span class="pcg-logo-fallback">' + svgIcon('welcome') + '</span>';
    return '<img src="' + url + '" alt="" width="56" height="56">';
  }

  /** 按 WELCOME_FLOW 生成每一屏；只有第一屏带 is-on，后续只由按钮切换 */
  function renderWelcomeScreens() {
    return WELCOME_FLOW.map((screen, index) => {
      const on = index === 0;
      const head = '<section class="pcg-screen' + (on ? ' is-on' : '') + '" data-screen="' + index + '"' +
        (on ? '' : ' aria-hidden="true"') + '>';

      if (screen.kind === 'welcome') {
        return head +
          '<div class="pcg-logo">' + logoMark() + '</div>' +
          '<h2 class="pcg-welcome-title">' + screen.title + '</h2>' +
          '<p class="pcg-welcome-sub">' + screen.sub + '</p>' +
        '</section>';
      }

      if (screen.kind === 'finish') {
        return head +
          '<div class="pcg-finish">' +
            '<span class="pcg-finish-ico">' +
              '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
                '<path class="pcg-check-path" pathLength="1" d="M13 25.5 L20.5 33 L35.5 16.5" />' +
              '</svg>' +
            '</span>' +
            '<h2 class="pcg-screen-title">' + screen.title + '</h2>' +
            '<p class="pcg-welcome-sub">' + screen.sub + '</p>' +
          '</div>' +
        '</section>';
      }

      return head +
        '<span class="pcg-cat-ico">' + svgIcon(screen.icon) + '</span>' +
        '<h2 class="pcg-screen-title">' + screen.title + '</h2>' +
        '<p class="pcg-screen-lead">' + screen.lead + '</p>' +
        '<ul class="pcg-feats">' +
          screen.points.map((point) =>
            '<li class="pcg-feat">' +
              '<span class="pcg-ico">' + svgIcon(point.icon) + '</span>' +
              '<p class="pcg-feat-text">' + point.text + '</p>' +
            '</li>').join('') +
        '</ul>' +
        configHtml(screen.id) +
      '</section>';
    }).join('');
  }

  async function patchOverlay(patch) {
    const raw = await storageGet(KEY_CFG);
    const cur = raw[KEY_CFG] && typeof raw[KEY_CFG] === 'object' ? raw[KEY_CFG] : {};
    await storageSet({ [KEY_CFG]: Object.assign({}, cur, patch) });
  }

  /** AI 配置写入串行化：连续切换开关时按顺序读改写，避免后一次覆盖前一次 */
  let aiWriteChain = Promise.resolve();

  function patchAi(patch) {
    aiWriteChain = aiWriteChain.then(async () => {
      const raw = await storageGet(AI_CONFIG_KEY);
      const cur = raw[AI_CONFIG_KEY] && typeof raw[AI_CONFIG_KEY] === 'object' ? raw[AI_CONFIG_KEY] : {};
      await storageSet({ [AI_CONFIG_KEY]: Object.assign({}, cur, patch) });
    }).catch(() => { /* 写失败不阻断后续写入 */ });
    return aiWriteChain;
  }

  /** 回填各屏配置控件，并把改动即时写回设置页同一份存储 */
  async function bindWelcomeConfig(modal) {
    const raw = await storageGet([KEY_CFG, AI_CONFIG_KEY, LAYOUT_KEY, IMAGE_ZOOM_KEY, FONT_KEY, FONT_MODE_KEY, FONT_CUSTOM_KEY]);
    if (!modal.isConnected) return;

    const overlay = normalizeOverlayCfg(raw[KEY_CFG]);
    const aiCfg = raw[AI_CONFIG_KEY] && typeof raw[AI_CONFIG_KEY] === 'object' ? raw[AI_CONFIG_KEY] : {};
    const faces = raw[FONT_CUSTOM_KEY] && Array.isArray(raw[FONT_CUSTOM_KEY].faces) ? raw[FONT_CUSTOM_KEY].faces : [];

    const cfg = (name) => modal.querySelector('[data-cfg="' + name + '"]');
    const setValue = (name, value) => { const el = cfg(name); if (el) el.value = value; };
    const setChecked = (name, value) => { const el = cfg(name); if (el) el.checked = !!value; };

    const fontMode = raw[FONT_KEY] === false || raw[FONT_KEY] === '0'
      ? 'site'
      : (raw[FONT_MODE_KEY] === 'custom' ? 'custom' : 'harmony');

    setValue('layout', raw[LAYOUT_KEY] === 'list' ? 'list' : 'grid');
    setChecked('imageZoom', raw[IMAGE_ZOOM_KEY] !== false);
    setChecked('composerTools', overlay.composerTools);
    setChecked('cardTilt', overlay.cardTilt);
    setChecked('blur', overlay.blur);
    setChecked('pageScale', overlay.pageScale);
    setChecked('openTilt', overlay.openTilt);
    setValue('animSpeed', animSpeedOption(overlay.animSpeed));
    setValue('fontMode', fontMode);

    // AI 开关一律按 !== false 判断：从未写入过 pcai_config 时显示为开启
    setChecked('aiEnabled', aiCfg.aiEnabled !== false);
    setChecked('enabled', aiCfg.enabled !== false);
    setChecked('aiAuto', aiCfg.aiAuto !== false);
    setChecked('aiChat', aiCfg.aiChat !== false);
    setChecked('aiReply', aiCfg.aiReply !== false);
    setChecked('aiFormat', aiCfg.aiFormat !== false);
    setChecked('aiWriter', aiCfg.aiWriter !== false);

    const on = (name, handler) => {
      const el = cfg(name);
      if (el) el.addEventListener('change', handler);
    };

    on('layout', (e) => storageSet({ [LAYOUT_KEY]: e.target.value === 'list' ? 'list' : 'grid' }));
    on('imageZoom', (e) => storageSet({ [IMAGE_ZOOM_KEY]: e.target.checked }));
    on('composerTools', (e) => patchOverlay({ composerTools: e.target.checked }));
    on('cardTilt', (e) => patchOverlay({ cardTilt: e.target.checked }));
    on('openTilt', (e) => patchOverlay({ openTilt: e.target.checked }));
    on('blur', (e) => patchOverlay({ blur: e.target.checked }));
    on('pageScale', (e) => patchOverlay({ pageScale: e.target.checked }));
    on('animSpeed', (e) => patchOverlay({ animSpeed: Number(e.target.value) || 1 }));

    const fontNote = modal.querySelector('[data-role="font-note"]');
    on('fontMode', (e) => {
      const mode = e.target.value;
      if (mode === 'custom' && !faces.length) {
        e.target.value = fontMode;
        if (fontNote) {
          fontNote.hidden = false;
          fontNote.textContent = '还没有上传字体文件，已打开设置页，可在「站点外观 → 字体」里添加。';
          syncScreensOverflow();
        }
        openOptions();
        return;
      }
      if (fontNote) fontNote.hidden = true;
      syncScreensOverflow();
      if (mode === 'site') storageSet({ [FONT_KEY]: false });
      else if (mode === 'custom') storageSet({ [FONT_KEY]: true, [FONT_MODE_KEY]: 'custom' });
      else storageSet({ [FONT_KEY]: true, [FONT_MODE_KEY]: 'harmony' });
    });

    // ---------- AI 屏：服务商 / 密钥 / 测试连接 ----------
    const providerSel = cfg('aiProvider');
    if (!providerSel) return;

    const baseRow = modal.querySelector('[data-role="ai-base-row"]');
    const modelRow = modal.querySelector('[data-role="ai-model-row"]');
    const keyRow = modal.querySelector('[data-role="ai-key-row"]');
    const baseInput = cfg('aiBaseUrl');
    const modelInput = cfg('aiModel');
    const keyInput = cfg('aiKey');
    const statusEl = modal.querySelector('[data-role="ai-status"]');
    const testFrame = modal.querySelector('[data-role="ai-test-frame"]');

    // ---------- AI 总开关与分项：关总开关时整组置灰且不可操作 ----------
    const aiMaster = cfg('aiEnabled');
    const aiSubs = modal.querySelector('[data-role="ai-subs"]');
    const aiOffNote = modal.querySelector('[data-role="ai-off-note"]');

    function paintAiSwitches() {
      const on = aiMaster ? aiMaster.checked : true;
      if (aiSubs) aiSubs.classList.toggle('is-off', !on);
      const subs = aiSubs ? aiSubs.querySelectorAll('input') : [];
      for (let i = 0; i < subs.length; i += 1) subs[i].disabled = !on;
      if (aiOffNote) aiOffNote.hidden = on;
      syncScreensOverflow();
    }

    paintAiSwitches();
    on('aiEnabled', (e) => {
      patchAi({ aiEnabled: e.target.checked });
      paintAiSwitches();
    });
    ['enabled', 'aiAuto', 'aiChat', 'aiReply', 'aiFormat', 'aiWriter'].forEach((key) => {
      on(key, (e) => patchAi({ [key]: e.target.checked }));
    });

    const aiState = {
      provider: aiProvider(aiCfg.provider).id,
      // 预设服务商即使还没保存过也有默认地址：测试连接要拿它申请域名授权
      baseUrl: aiCfg.baseUrl || aiProvider(aiCfg.provider).baseUrl || '',
      model: aiCfg.model || '',
      apiKey: aiCfg.apiKey || ''
    };

    /** 按卡片当前文字亮度判断深浅色，供扩展内测试按钮同步主题 */
    function frameTheme() {
      const parts = (getComputedStyle(modal).color || '').match(/\d+/g);
      if (!parts || parts.length < 3) return 'light';
      const [r, g, b] = parts.map(Number);
      return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? 'dark' : 'light';
    }

    function postFrameConfig() {
      if (!testFrame || !testFrame.contentWindow) return;
      testFrame.contentWindow.postMessage({
        source: 'pcs-guide-ai-test-config',
        baseUrl: aiState.baseUrl,
        theme: frameTheme(),
        // 让 iframe 里的按钮跟卡片主色一致
        primary: (getComputedStyle(modal).getPropertyValue('--pcg-primary') || '').trim()
      }, '*');
    }

    const onFrameMessage = (event) => {
      if (!modal.isConnected) {
        window.removeEventListener('message', onFrameMessage);
        return;
      }
      if (!testFrame || event.source !== testFrame.contentWindow || !event.data) return;
      const data = event.data;
      if (data.source === 'pcs-guide-ai-test-ready') {
        postFrameConfig();
        return;
      }
      if (data.source !== 'pcs-guide-ai-test-result' || !statusEl) return;
      if (data.ok) statusEl.textContent = '连接成功：' + (data.message || '正常');
      else if (data.needPermission) statusEl.textContent = '需要接口域名授权，请再点一次「测试连接」';
      else statusEl.textContent = '连接失败：' + (data.message || '未知错误');
    };
    window.addEventListener('message', onFrameMessage);

    function paintAi() {
      const preset = aiProvider(aiState.provider);
      providerSel.value = preset.id;
      baseRow.hidden = !(preset.custom || preset.id === 'ollama');
      modelRow.hidden = !preset.custom;
      // Ollama 与自定义（自建地址）都不要求密钥
      keyRow.hidden = !!(preset.keyless || preset.custom);
      baseInput.value = preset.custom
        ? (aiState.baseUrl || '')
        : (preset.baseUrl || aiState.baseUrl || '');
      modelInput.value = preset.custom ? (aiState.model || '') : (aiState.model || preset.models[0] || '');
      keyInput.value = aiState.apiKey || '';
      keyInput.placeholder = preset.keyless ? '本地服务无需密钥' : 'sk-…';
      if (statusEl) {
        statusEl.textContent = preset.keyless
          ? '本地服务无需密钥，先 ollama serve'
          : (preset.custom
            ? '自建地址无需密钥；填好地址与模型名后可直接下一步'
            : '只存在本机，不填也能先下一步');
      }
      syncScreensOverflow();
      postFrameConfig();
    }

    paintAi();

    providerSel.addEventListener('change', async () => {
      const preset = aiProvider(providerSel.value);
      const prevId = aiState.provider;
      aiState.provider = preset.id;
      // 切到「自定义」时清空旧服务商地址，避免把别家 URL 当成自建地址
      if (preset.custom) {
        if (prevId !== 'custom') aiState.baseUrl = '';
      } else {
        aiState.baseUrl = preset.baseUrl;
      }
      if (preset.id !== prevId) aiState.model = preset.models[0] || '';
      await patchAi({ provider: aiState.provider, baseUrl: aiState.baseUrl, model: aiState.model });
      paintAi();
    });

    let keyTimer = 0;
    keyInput.addEventListener('input', () => {
      aiState.apiKey = keyInput.value.trim();
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => {
        patchAi({ apiKey: aiState.apiKey });
        if (statusEl) statusEl.textContent = '密钥只存在本机';
      }, 500);
    });
    // 失焦 / 回车立刻落库：点「测试连接」前密钥一定已经写入同一份存储
    keyInput.addEventListener('change', () => {
      clearTimeout(keyTimer);
      aiState.apiKey = keyInput.value.trim();
      patchAi({ apiKey: aiState.apiKey });
      if (statusEl) statusEl.textContent = '密钥只存在本机';
    });

    let baseTimer = 0;
    baseInput.addEventListener('input', () => {
      aiState.baseUrl = baseInput.value.trim();
      // 让扩展内的测试按钮当场拿到新地址（域名授权要用它）
      postFrameConfig();
      clearTimeout(baseTimer);
      baseTimer = setTimeout(() => patchAi({ baseUrl: aiState.baseUrl }), 400);
    });
    baseInput.addEventListener('change', () => {
      clearTimeout(baseTimer);
      aiState.baseUrl = baseInput.value.trim();
      patchAi({ baseUrl: aiState.baseUrl });
      postFrameConfig();
    });

    modelInput.addEventListener('change', () => {
      aiState.model = modelInput.value.trim();
      patchAi({ model: aiState.model });
    });
  }

  // ---------- 落点：站点「分享你的想法」输入框 ----------

  /** 输入框候选：优先占位文案「分享你的想法」，再退回通用的想法 / 回复输入框 */
  const SHARE_BOX_SELECTORS = [
    'textarea[placeholder*="分享你的想法"]',
    'input[placeholder*="分享你的想法"]',
    '[contenteditable="true"][data-placeholder*="分享你的想法"]',
    '[contenteditable="true"][aria-label*="分享你的想法"]',
    'textarea[placeholder*="想法"]',
    '[contenteditable="true"][data-placeholder*="想法"]',
    'textarea[placeholder*="说点什么"]',
    'textarea.reply-composer-input',
    '[contenteditable="true"].reply-composer-input'
  ];

  function findShareBox() {
    for (let i = 0; i < SHARE_BOX_SELECTORS.length; i += 1) {
      let el = null;
      try { el = document.querySelector(SHARE_BOX_SELECTORS[i]); } catch (e) { el = null; }
      if (!el) continue;
      // 排除引导层 / 帖子浮层自己的输入框，只认站点原生的分享框
      if (el.closest('#pcg-root, #pco-root')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) continue;
      return el;
    }
    return null;
  }

  /**
   * 视觉隐藏输入框：只动 visibility / opacity / pointer-events，保留占位，
   * 不用 display:none，页面布局不会跳。顺带隐藏匹配到的外层输入框容器。
   */
  function hideShareBox(box) {
    if (!box) return;
    restoreShareBox();

    const targets = [box];
    let node = box.parentElement;
    for (let i = 0; i < 3 && node && node !== document.body; i += 1) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (/composer|editor|reply|comment|share|publish|write/i.test(cls)) {
        const r = node.getBoundingClientRect();
        if (r.height > 0 && r.height < window.innerHeight * 0.7) targets.push(node);
      }
      node = node.parentElement;
    }

    for (let i = 0; i < targets.length; i += 1) {
      const el = targets[i];
      if (el.getAttribute('data-pcg-share-hidden') === '1') continue;
      el.setAttribute('data-pcg-share-hidden', '1');
      // 记住原有内联值，恢复时原样写回
      el.setAttribute('data-pcg-share-vis', el.style.visibility || '');
      el.setAttribute('data-pcg-share-op', el.style.opacity || '');
      el.setAttribute('data-pcg-share-pe', el.style.pointerEvents || '');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    }
    shareBoxRestore = targets;
  }

  /** 恢复被引导隐藏的输入框；任何退出路径都要调用，避免它永久消失 */
  function restoreShareBox() {
    const list = shareBoxRestore;
    shareBoxRestore = [];
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (!el || el.getAttribute('data-pcg-share-hidden') !== '1') continue;
      const vis = el.getAttribute('data-pcg-share-vis') || '';
      const op = el.getAttribute('data-pcg-share-op') || '';
      const pe = el.getAttribute('data-pcg-share-pe') || '';
      if (vis) el.style.visibility = vis; else el.style.removeProperty('visibility');
      if (op) el.style.opacity = op; else el.style.removeProperty('opacity');
      if (pe) el.style.pointerEvents = pe; else el.style.removeProperty('pointer-events');
      el.removeAttribute('data-pcg-share-hidden');
      el.removeAttribute('data-pcg-share-vis');
      el.removeAttribute('data-pcg-share-op');
      el.removeAttribute('data-pcg-share-pe');
    }
  }

  /** 以输入框为锚点摆放卡片；找不到（或窄屏）就退回默认居中 */
  function anchorWelcome() {
    if (!welcomeEl) return;
    const modal = welcomeEl.querySelector('.pcg-modal');
    if (!modal) return;

    const box = shareBoxRestore.length ? shareBoxRestore[0] : findShareBox();
    if (!box || !box.isConnected || window.innerWidth < 560) {
      resetAnchor();
      return;
    }

    const r = box.getBoundingClientRect();
    if (!r || r.width < 40 || r.height < 8) {
      resetAnchor();
      return;
    }

    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // 输入框不在视口内（或已被滚走）时不要硬锚，退回居中更稳妥
    if (r.bottom < 0 || r.top > vh - 40) {
      resetAnchor();
      return;
    }
    // 顶边贴住输入框顶部，同时给卡片留出至少 660px 的高度，避免被顶出视口
    const top = Math.max(16, Math.min(Math.round(r.top - 12), Math.max(16, vh - 660 - 16)));
    welcomeEl.classList.add('is-anchored');
    welcomeEl.style.paddingTop = top + 'px';
    modal.style.maxHeight = Math.max(360, vh - top - 16) + 'px';

    // 横向也对准输入框中线，再夹在视口内（flex 居中时 margin 只生效一半，这里乘 2）
    const mw = modal.getBoundingClientRect().width || 600;
    const left = Math.max(16, Math.min(Math.round(r.left + r.width / 2 - mw / 2), vw - mw - 16));
    modal.style.marginLeft = Math.round((left - (vw - mw) / 2) * 2) + 'px';
  }

  function resetAnchor() {
    if (!welcomeEl) return;
    welcomeEl.classList.remove('is-anchored');
    welcomeEl.style.paddingTop = '';
    const modal = welcomeEl.querySelector('.pcg-modal');
    if (!modal) return;
    modal.style.maxHeight = '';
    modal.style.marginLeft = '';
  }

  function showWelcome() {
    ensureRoot();
    if (welcomeEl) return;

    const scrim = h('div', 'pcg-scrim');
    const modal = h('div', 'pcg-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '新手引导');

    modal.innerHTML =
      '<button type="button" class="pcg-welcome-skip" data-role="skip">跳过</button>' +
      '<div class="pcg-screens">' + renderWelcomeScreens() + '</div>' +
      '<div class="pcg-welcome-foot">' +
        '<div class="pcg-dots" data-role="dots" aria-hidden="true">' +
          WELCOME_FLOW.map((_, i) => '<i' + (i === 0 ? ' class="is-on"' : '') + '></i>').join('') +
        '</div>' +
        '<span class="pcg-welcome-tip">之后可在「更多 → 功能引导」重看</span>' +
        '<div class="pcg-welcome-actions">' +
          '<button type="button" class="pcg-ghost" data-role="back" hidden>上一步</button>' +
          '<button type="button" class="pcg-primary" data-role="next">下一步</button>' +
        '</div>' +
      '</div>' +
      // 彩带铺在整张卡片上：不放进可滚动的内容区，避免被裁
      '<canvas class="pcg-confetti" aria-hidden="true"></canvas>';

    // 遮罩只负责挡住页面，不绑定任何点击：点空白既不推进也不关闭
    modal.querySelector('[data-role="skip"]').addEventListener('click', () => dismissWelcome());
    const next = modal.querySelector('[data-role="next"]');
    next.addEventListener('click', () => {
      if (welcomeScreen >= WELCOME_FLOW.length - 1) dismissWelcome();
      else setWelcomeScreen(welcomeScreen + 1);
    });
    const back = modal.querySelector('[data-role="back"]');
    back.addEventListener('click', () => {
      if (welcomeScreen > 0) setWelcomeScreen(welcomeScreen - 1);
    });

    scrim.appendChild(modal);
    root.appendChild(scrim);
    welcomeEl = scrim;
    welcomeScreen = 0;
    state.state = 'welcome';
    persist();
    bindWelcomeConfig(modal);
    try { next.focus({ preventScroll: true }); } catch (e) { /* noop */ }

    // 落点：先以「分享你的想法」输入框为锚点，再把它视觉隐藏（保留占位）
    const shareBox = findShareBox();
    if (shareBox) hideShareBox(shareBox);
    anchorWelcome();
    // 首屏可能还没渲染出输入框：稍后再试两次，找到就补上锚点与隐藏
    [320, 960].forEach((ms) => setTimeout(() => {
      if (!welcomeEl || shareBoxRestore.length) return;
      const box = findShareBox();
      if (!box) return;
      hideShareBox(box);
      anchorWelcome();
    }, ms));
  }

  /**
   * 内容区高度随当前屏变化。滚动条由 CSS 固定为 0 宽，不存在「先撑出再收回」的
   * 竖条闪现；这里只负责让滚动能力始终可用，并在内容回落到不足一屏时归零滚动位置。
   */
  function syncScreensOverflow() {
    if (!welcomeEl) return;
    const wrap = welcomeEl.querySelector('.pcg-screens');
    if (!wrap) return;
    if (wrap.scrollHeight <= wrap.clientHeight + 1) wrap.scrollTop = 0;
  }

  /** 换屏时卡片上的尺寸动画；连续切屏先取消，避免两段高度动画叠在一起 */
  let modalSizeAnims = [];

  /**
   * 换屏的高度过渡：固定住高度做一次 CSS 动画，动画结束再交还 auto。
   * 用 fill:'both' 让起始帧立即生效，避免先闪一帧新高度；
   * 只动 height，不再叠加位移，避免和内容重排产生两段运动。
   * reduced-motion 时高度直接到位。
   */
  function transitionModalSize(modal, beforeHeight) {
    if (!modal) return;

    for (let i = 0; i < modalSizeAnims.length; i += 1) {
      try { modalSizeAnims[i].cancel(); } catch (e) { /* noop */ }
    }
    modalSizeAnims = [];
    modal.style.height = '';

    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const canAnimate = !reduced && typeof modal.animate === 'function';
    const afterHeight = modal.getBoundingClientRect().height;
    const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;

    if (!canAnimate || !beforeHeight || Math.abs(afterHeight - beforeHeight) < 1) return;

    const sizeAnim = modal.animate(
      [{ height: beforeHeight + 'px' }, { height: afterHeight + 'px' }],
      {
        duration: Math.round(340 / speed),
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both'
      }
    );
    sizeAnim.onfinish = () => {
      if (modalSizeAnims.indexOf(sizeAnim) === -1) return;
      modal.style.height = '';
      try { sizeAnim.cancel(); } catch (e) { /* noop */ }
    };
    modalSizeAnims.push(sizeAnim);
  }

  /** 只由按钮调用：换屏不换模态，也不重置已看状态 */
  function setWelcomeScreen(index) {
    if (!welcomeEl) return;
    const modal = welcomeEl.querySelector('.pcg-modal');
    // 先记下当前可见高度，作为高度过渡的起点
    const beforeHeight = modal ? modal.getBoundingClientRect().height : 0;
    welcomeScreen = index;

    const screens = welcomeEl.querySelectorAll('.pcg-screen');
    for (let i = 0; i < screens.length; i += 1) {
      const on = i === index;
      screens[i].classList.toggle('is-on', on);
      screens[i].setAttribute('aria-hidden', on ? 'false' : 'true');
    }

    const dots = welcomeEl.querySelectorAll('.pcg-dots i');
    for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-on', i === index);

    const back = welcomeEl.querySelector('[data-role="back"]');
    if (back) back.hidden = index === 0;

    // 内容多时内容区可滚动：换屏回到顶部，不从上一屏的滚动位置开始
    const wrap = welcomeEl.querySelector('.pcg-screens');
    if (wrap) {
      wrap.scrollTop = 0;
      syncScreensOverflow();
    }

    const last = WELCOME_FLOW.length - 1;
    const next = welcomeEl.querySelector('[data-role="next"]');
    if (next) {
      next.textContent = index >= last ? '结束' : '下一步';
      try { next.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    }

    // 离开收尾屏：清掉纸屑、取消排队与进行中的动画，并复位「播过」标记，
    // 保证下次切回收尾屏能完整重播
    if (index !== last) stopConfetti();

    transitionModalSize(modal, beforeHeight);

    // 高度过渡完成后再撒：此时 canvas 已经覆盖整张卡片，不会被卡在半截
    if (index >= last) {
      // 连续快速来回切时只保留最后一次排队，避免多段彩带叠加
      stopConfetti();
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;
      // 与 transitionModalSize 同一时长（340ms × 1/速度），再留一帧余量
      const wait = reduced ? 0 : Math.round(340 / speed) + 20;
      confettiTimer = setTimeout(() => {
        confettiTimer = 0;
        if (welcomeEl && welcomeScreen === last) playConfetti();
      }, wait);
    }
  }

  /** 离场或重播前复位彩带：取消排队 / 进行中的动画，清屏并移除已播标记 */
  function stopConfetti() {
    if (confettiTimer) {
      clearTimeout(confettiTimer);
      confettiTimer = 0;
    }
    if (confettiRaf) {
      cancelAnimationFrame(confettiRaf);
      confettiRaf = 0;
    }
    const canvas = welcomeEl && welcomeEl.querySelector('.pcg-confetti');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.removeAttribute('data-played');
  }

  /**
   * 收尾屏彩带：每次进入这一屏重播一次。
   * 时长乘 1 / 动画速度（等价于 --pcg-dur）；reduced-motion 时只画静态纸屑。
   */
  function playConfetti() {
    // 防御：任何情况下都先停掉上一轮，避免两段动画同时写同一块画布
    if (confettiTimer) {
      clearTimeout(confettiTimer);
      confettiTimer = 0;
    }
    if (confettiRaf) {
      cancelAnimationFrame(confettiRaf);
      confettiRaf = 0;
    }
    const canvas = welcomeEl && welcomeEl.querySelector('.pcg-confetti');
    if (!canvas || canvas.getAttribute('data-played') === '1') return;
    canvas.setAttribute('data-played', '1');

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.offsetWidth || 420;
    const h = canvas.offsetHeight || 300;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);

    const COLORS = ['#e5484d', '#f5a623', '#30a46c', '#3b82f6', '#a855f7'];
    const bits = [];
    for (let i = 0; i < 80; i += 1) {
      // 约 4 成纸屑从左右两侧飞入，其余从卡片顶部落下，覆盖整张卡片
      const fromSide = i % 5 < 2;
      if (fromSide) {
        const left = i % 2 === 0;
        bits.push({
          x: left ? -12 : w + 12,
          y: Math.random() * h * 0.55,
          vx: (left ? 1 : -1) * (60 + Math.random() * 110),
          vy: 50 + Math.random() * 120,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 6,
          size: 5 + Math.random() * 5,
          color: COLORS[i % COLORS.length]
        });
        continue;
      }
      bits.push({
        x: Math.random() * w,
        y: -20 - Math.random() * h * 0.6,
        vx: (Math.random() - 0.5) * 60,
        vy: 90 + Math.random() * 140,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 6,
        size: 5 + Math.random() * 5,
        color: COLORS[i % COLORS.length]
      });
    }

    const draw = (t, speed) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 0.92;
      for (let i = 0; i < bits.length; i += 1) {
        const b = bits[i];
        const y = b.y + b.vy * t * speed;
        if (y > h + 24) continue;
        ctx.save();
        ctx.translate(b.x + b.vx * t * speed, y);
        ctx.rotate(b.rot + b.vr * t * speed);
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
        ctx.restore();
      }
    };

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // 静态装饰：直接散落在画面里，不跑时间轴
      for (let i = 0; i < bits.length; i += 1) bits[i].y = Math.random() * h;
      draw(0, 0);
      return;
    }

    const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;
    const start = performance.now();
    const life = 2400 / speed;
    const tick = (now) => {
      const elapsed = now - start;
      draw(elapsed / 1000, speed);
      if (elapsed < life) {
        confettiRaf = requestAnimationFrame(tick);
      } else {
        confettiRaf = 0;
        ctx.clearRect(0, 0, w, h);
      }
    };
    confettiRaf = requestAnimationFrame(tick);
  }

  /** 首装时用户可能停在别的页面：轮询到信息流再出卡（只在未关闭期间运行，代价极低） */
  let welcomeWatch = 0;
  let welcomeWatchCount = 0;
  function watchWelcomeRoute() {
    if (welcomeWatch || state.welcomeDone) return;
    welcomeWatchCount = 0;
    welcomeWatch = setInterval(() => {
      welcomeWatchCount += 1;
      // 最多守 2 分钟：长时间停在非信息流页就等下次整页加载再出
      if (state.welcomeDone || welcomeEl || welcomeWatchCount > 100) {
        clearInterval(welcomeWatch);
        welcomeWatch = 0;
        return;
      }
      if (!isFeedPage()) return;
      clearInterval(welcomeWatch);
      welcomeWatch = 0;
      showWelcome();
    }, 1200);
  }

  /**
   * 结束欢迎流程：先播退场（遮罩淡出 + 卡片整体上滑飞出），动画结束再落状态。
   * reset() 传入 immediate，避免延迟写入覆盖刚重置的新状态。
   */
  function dismissWelcome(immediate) {
    if (!welcomeEl) return;
    stopConfetti();
    if (welcomeWatch) { clearInterval(welcomeWatch); welcomeWatch = 0; }

    // 先摘掉引用：退场期间再按 Esc / 重复点击都不会二次触发
    const el = welcomeEl;
    welcomeEl = null;
    welcomeScreen = 0;

    const finish = () => {
      el.remove();
      // 引导结束（含配置阶段）后才恢复站点输入框，之前一直保持隐藏
      restoreShareBox();
      state.welcomeDone = true;
      if (state.state !== 'done') state.state = 'waiting';
      persist();
      // 欢迎流程结束（结束 / 跳过）后才允许往下走
      maybeStartTour();
    };

    if (immediate) {
      finish();
      return;
    }

    const modal = el.querySelector('.pcg-modal');
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (modal) modal.removeEventListener('animationend', onEnd);
      finish();
    };
    const onEnd = (e) => {
      if (e.target !== modal) return;
      // 正常退场是 pcg-modal-out；reduced-motion 下换成纯淡出的 pcg-fade-out
      if (e.animationName === 'pcg-modal-out' || e.animationName === 'pcg-fade-out') settle();
    };
    const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;

    // 退场只有一种：整卡向下滑出视口；位移与缓动全部交给 CSS（pcg-modal-out）
    el.classList.add('is-leaving');
    if (modal) modal.addEventListener('animationend', onEnd);
    // 兜底：动画被系统跳过或事件丢失也要收尾
    setTimeout(settle, Math.round(620 / speed));
  }

  // ============================ 5. 分步引导 ============================

  function maybeStartTour() {
    if (!ready || tourActive || tourScheduled) return;
    if (!state.welcomeDone) return;         // 欢迎卡未关闭：卡住，不推进
    if (!overlayOpen || !settled) return;
    if (!state.replay && state.state !== 'waiting' && state.state !== 'pending') return;

    const force = !!state.replay;
    const steps = pendingSteps(force);
    if (!steps.length) {
      if (force) {
        state.replay = false;
        persist();
      } else if (state.state !== 'done') {
        state.state = 'done';
        persist();
      }
      return;
    }

    tourScheduled = true;
    const delay = Math.round(180 / (animSpeed || 1));
    setTimeout(() => {
      tourScheduled = false;
      if (!overlayOpen || !settled || tourActive) return;
      // 延迟期间可能被设置页「重新开始」重置：欢迎卡没关就不许开 Tour
      if (!state.welcomeDone) return;
      if (!force && state.state !== 'waiting' && state.state !== 'pending') return;
      startTour(steps, force);
    }, delay);
  }

  function startTour(steps, force) {
    ensureRoot();
    tourSteps = steps;
    tourIndex = 0;
    tourActive = true;
    state.state = 'tour';
    if (force) state.replay = false;
    persist();

    // 透明拦截层：只挡误触，不给整页加暗；暗场由挖空元素自己的扩散阴影负责
    const block = h('div', 'pcg-block');
    const card = h('div', 'pcg-card pcg-tour-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', '功能引导');
    card.innerHTML =
      '<div class="pcg-tour-head">' +
        '<div class="pcg-row" data-role="step"></div>' +
        '<button type="button" class="pcg-skip">跳过</button>' +
      '</div>' +
      '<div class="pcg-tour-foot">' +
        '<div class="pcg-dots" data-role="dots"></div>' +
        '<button type="button" class="pcg-primary" data-role="next">下一步</button>' +
      '</div>';

    card.querySelector('.pcg-skip').addEventListener('click', () => finishTour(true));
    card.querySelector('[data-role="next"]').addEventListener('click', () => {
      if (tourIndex + 1 >= tourSteps.length) finishTour(false);
      else { tourIndex += 1; paintTourStep(); }
    });

    root.appendChild(block);
    root.appendChild(card);
    tourEl = card;
    renderDots(card, tourSteps.length);
    paintTourStep();
  }

  function renderDots(wrap, total) {
    const dots = wrap.querySelector('[data-role="dots"]');
    dots.innerHTML = '';
    for (let i = 0; i < total; i += 1) dots.appendChild(h('i'));
  }

  function paintTourStep() {
    if (!tourEl) return;
    const step = tourSteps[tourIndex];
    if (!step) { finishTour(false); return; }

    const anchor = resolveStepTarget(step);
    // 切步时目标可能刚好消失（换帖、收起）：直接跳到下一步，不留没有锚点的卡片
    if (!anchor) {
      if (tourIndex + 1 < tourSteps.length) { tourIndex += 1; paintTourStep(); return; }
      finishTour(false);
      return;
    }

    const stepBox = tourEl.querySelector('[data-role="step"]');
    stepBox.className = 'pcg-row';
    stepBox.innerHTML =
      '<span class="pcg-ico">' + svgIcon(step.icon) + '</span>' +
      '<div>' +
        '<p class="pcg-title">' + step.title + '</p>' +
        '<p class="pcg-body">' + step.body + '</p>' +
      '</div>';
    // 强制一次回流让入场动画在每次切步时重新播放（仅在用户手动点下一步时发生）
    void stepBox.offsetWidth;
    stepBox.classList.add('pcg-step');

    const dots = tourEl.querySelectorAll('.pcg-dots i');
    for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-on', i === tourIndex);

    const next = tourEl.querySelector('[data-role="next"]');
    next.textContent = tourIndex + 1 >= tourSteps.length ? '完成' : '下一步';

    // 记录「这一步看过」：跳过也不算未看，避免下次重播同一段
    if (state.done.indexOf(step.id) === -1) {
      state.done.push(step.id);
      persist();
    }

    // 贴到目标旁边；整卡目标（三区结构）或四周都放不下时居中并隐掉箭头
    if (step.center || !placeNear(tourEl, anchor, step.prefer, 14)) centerTourCard(tourEl);

    paintSpotlight(anchor, step);

    try { next.focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }

  function centerTourCard(card) {
    card.removeAttribute('data-place');
    const w = card.offsetWidth || 360;
    const h = card.offsetHeight || 200;
    card.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
    card.style.top = Math.round((window.innerHeight - h) / 2) + 'px';
  }

  function finishTour(skipped) {
    if (!tourActive) return;
    tourActive = false;
    if (tourEl) {
      // 块与卡片一起移除
      const block = root && root.querySelector('.pcg-block');
      if (block) block.remove();
      tourEl.remove();
    }
    tourEl = null;
    paintSpotlight(null);
    state.state = skipped ? 'skipped' : 'done';
    if (skipped) {
      state.skipped = true;
      state.skippedAt = Date.now();
    }
    persist();
    // 正常看完才在 5 秒安静期后补场景气泡；主动跳过说明不想被打扰，本次不再弹
    if (!skipped) laterTocHint(Math.round(5000 / (animSpeed || 1)));
  }

  function teardownTour() {
    if (!tourActive) return;
    tourActive = false;
    if (root) {
      const block = root.querySelector('.pcg-block');
      if (block) block.remove();
    }
    if (tourEl) tourEl.remove();
    tourEl = null;
    paintSpotlight(null);
    // 中途关闭浮层：回到等待状态，下次只补没看过的步骤
    if (state.state === 'tour') state.state = 'waiting';
    persist();
  }

  // ============================ 6. 挖空遮罩 ============================

  /** 目标必须存在、可交互且与视口有交集，否则整步跳过 */
  function resolveStepTarget(step) {
    if (!step || !step.anchor) return null;
    const el = resolveEl(step.anchor);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) return null;
    if (r.right <= 0 || r.left >= window.innerWidth) return null;
    return el;
  }

  /**
   * 单个元素同时做两件事：目标处透明留白 + 盒阴影铺满其余画面。
   * 不叠全屏 DOM、不用 backdrop-filter。
   */
  function paintSpotlight(anchor, step) {
    if (!anchor) {
      if (spotEl) spotEl.remove();
      spotEl = null;
      return;
    }
    ensureRoot();
    if (!spotEl) {
      spotEl = h('div', 'pcg-spot');
      // 垫在卡片下面、拦截层上面
      root.insertBefore(spotEl, tourEl && tourEl.parentNode === root ? tourEl : null);
    }
    const pad = step && step.pad != null ? step.pad : 6;
    const radius = step && step.radius != null ? step.radius : 12;
    const r = anchor.getBoundingClientRect();
    spotEl.style.left = Math.round(r.left - pad) + 'px';
    spotEl.style.top = Math.round(r.top - pad) + 'px';
    spotEl.style.width = Math.round(r.width + pad * 2) + 'px';
    spotEl.style.height = Math.round(r.height + pad * 2) + 'px';
    spotEl.style.borderRadius = radius + 'px';
  }

  // ============================ 7. 场景气泡 ============================

  function hintsAllowed() {
    return ready && state.welcomeDone && !tourActive && overlayOpen && settled;
  }

  function hintCountToday() {
    const day = todayKey();
    let n = 0;
    Object.keys(hints).forEach((id) => {
      const item = hints[id];
      if (!item || !item.at) return;
      const d = new Date(item.at);
      if (d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() === day) n += 1;
    });
    return n;
  }

  function maybeHint(id) {
    if (!hintsAllowed()) return;
    if (sessionHinted) return;                 // 单次打开浮层最多 1 条
    const seen = hints[id];
    if (seen && seen.n >= 1) return;           // 每条只出现一次
    if (hintCountToday() >= 3) return;         // 单日上限
    const cfg = HINTS[id];
    if (!cfg) return;
    const anchor = resolveEl(cfg.anchor);
    if (!anchor) return;

    hints[id] = { n: 1, at: Date.now(), dismissed: false };
    persistHints();
    sessionHinted = true;
    showBubble(cfg, anchor);
  }

  function showBubble(cfg, anchor) {
    ensureRoot();
    hideBubble();

    const bubble = h('div', 'pcg-card pcg-bubble');
    bubble.innerHTML =
      '<p class="pcg-title">' + cfg.title + '</p>' +
      '<p class="pcg-body">' + cfg.body + '</p>' +
      (cfg.action ? '<div class="pcg-bubble-act"><button type="button" class="pcg-primary">' +
        cfg.action.label + '</button></div>' : '');

    if (cfg.action) {
      bubble.querySelector('.pcg-primary').addEventListener('click', () => {
        hideBubble();
        cfg.action.run();
      });
    }

    // 记录锚点，滚动 / 缩放后据此重新贴合
    bubble.setAttribute('data-anchor', cfg.anchor);
    bubble.setAttribute('data-prefer', cfg.prefer || 'left');
    root.appendChild(bubble);
    bubbleEl = bubble;
    placeNear(bubble, anchor, cfg.prefer);

    // 8 秒无操作自动收起；展示次数已在 maybeHint 里落库，不会再次出现
    bubbleTimer = setTimeout(hideBubble, 8000);
  }

  /** 把卡片贴到锚点旁边；四周都放不下时返回 false，由调用方决定是否居中 */
  function placeNear(el, anchor, prefer, gapSize) {
    const r = anchor.getBoundingClientRect();
    const bw = el.offsetWidth || 276;
    const bh = el.offsetHeight || 96;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 10;
    const gap = gapSize == null ? 12 : gapSize;

    let place = '';
    let x = 0;
    let y = 0;

    // place 表示箭头所在的一侧：气泡在锚点左边 → 箭头在右（left 规则）
    const left = () => {
      x = r.left - bw - gap;
      y = r.top + r.height / 2 - bh / 2;
      place = 'left';
      return x >= pad;
    };
    const right = () => {
      x = r.right + gap;
      y = r.top + r.height / 2 - bh / 2;
      place = 'right';
      return x + bw <= vw - pad;
    };
    const top = () => {
      x = r.left + r.width / 2 - bw / 2;
      y = r.top - bh - gap;
      place = 'top';
      return y >= pad;
    };
    const bottom = () => {
      x = r.left + r.width / 2 - bw / 2;
      y = r.bottom + gap;
      place = 'bottom';
      return y + bh <= vh - pad;
    };

    const order = prefer === 'top' ? [top, bottom, left, right]
      : prefer === 'bottom' ? [bottom, top, right, left]
        : prefer === 'right' ? [right, left, bottom, top]
          : [left, right, bottom, top];

    let fit = false;
    for (let i = 0; i < order.length; i += 1) {
      if (order[i]()) { fit = true; break; }
      x = 0;
      y = 0;
    }
    if (!fit) return false;

    x = clamp(x, pad, Math.max(pad, vw - bw - pad));
    y = clamp(y, pad, Math.max(pad, vh - bh - pad));
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.setAttribute('data-place', place || 'right');

    // 让箭头对准锚点中心：左右位置调纵坐标，上下位置调横坐标
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    if (place === 'left' || place === 'right') {
      el.style.setProperty('--pcg-arrow-y', clamp(cy - y - 4.5, 12, bh - 20) + 'px');
    } else {
      el.style.setProperty('--pcg-arrow-x', clamp(cx - x - 4.5, 12, bw - 20) + 'px');
    }
    return true;
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = 0; }
    if (bubbleEl) bubbleEl.remove();
    bubbleEl = null;
  }

  // ============================ 8. 浮层事件 ============================

  /** 目录气泡延后尝试：Tour 正在播时会被 maybeHint 里的 tourActive 拦掉 */
  function laterTocHint(delay) {
    setTimeout(() => {
      if (!overlayOpen || !settled || tourActive) return;
      if (topicInfo.hasToc && !topicInfo.tocOpen && topicInfo.headingCount >= 3) maybeHint('toc');
    }, delay);
  }

  function handleSettled(detail) {
    overlayOpen = true;
    settled = true;
    sessionHinted = false;
    composerTools = !!(detail && detail.composerTools);
    maybeStartTour();
    // 没有 Tour 要播（已经看完）时，第一次遇到长帖就提示目录
    laterTocHint(900);
  }

  function handleTopicRendered(detail) {
    topicInfo = {
      headingCount: Number(detail && detail.headingCount) || 0,
      hasToc: !!(detail && detail.hasToc),
      tocOpen: !!(detail && detail.tocOpen)
    };
    if (hintsAllowed() && topicInfo.hasToc && !topicInfo.tocOpen && topicInfo.headingCount >= 3) {
      // 稍等一拍，别在换帖 / 渲染的同一帧里弹气泡
      laterTocHint(600);
    }
  }

  window.addEventListener('pco-guide:overlay-settled', (e) => {
    if (!ready) { pendingSettle = e.detail || {}; return; }
    handleSettled(e.detail || {});
  });

  window.addEventListener('pco-guide:topic-rendered', (e) => {
    if (!ready) { pendingTopic = e.detail || {}; return; }
    handleTopicRendered(e.detail || {});
  });

  window.addEventListener('pco-guide:composer-focus', (e) => {
    const detail = e.detail || {};
    composerTools = !!detail.toolsEnabled;
    if (!composerTools) maybeHint('composer-tools');
  });

  window.addEventListener('pco-guide:ai-blocked', () => {
    maybeHint('ai-setup');
  });

  window.addEventListener('pco-guide:select-blocked', () => {
    maybeHint('select');
  });

  window.addEventListener('pco-guide:overlay-closed', () => {
    overlayOpen = false;
    settled = false;
    sessionHinted = false;
    teardownTour();
    hideBubble();
  });

  // ============================ 9. 全局交互 ============================

  /** 气泡之外按下即收起；欢迎模态的遮罩点击不绑定任何行为，避免误触丢进度 */
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (bubbleEl && t instanceof Element && !t.closest('.pcg-bubble')) hideBubble();
  }, true);

  /** 欢迎模态与 Tour 期间 Esc 都视为跳过（效果分别等于「跳过」与「跳过」本段引导） */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (welcomeEl) {
      e.preventDefault();
      e.stopPropagation();
      dismissWelcome();
      return;
    }

    if (!tourActive) return;
    e.preventDefault();
    e.stopPropagation();
    finishTour(true);
  }, true);

  /** 浮层内部滚动 / 窗口尺寸变化时，重新贴合锚点；锚点离开视口则收起气泡 */
  let repositionFrame = 0;
  function scheduleReposition() {
    if (!bubbleEl && !spotEl) return;
    if (repositionFrame) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0;

      if (bubbleEl) {
        const bubble = bubbleEl;
        const anchor = resolveEl(bubble.getAttribute('data-anchor'));
        if (!anchor) { hideBubble(); return; }
        const r = anchor.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
          hideBubble();
          return;
        }
        placeNear(bubble, anchor, bubble.getAttribute('data-prefer'));
        return;
      }

      // Tour 期间：挖空遮罩与贴边卡片一起跟随目标
      if (tourActive) {
        const step = tourSteps[tourIndex];
        const anchor = resolveStepTarget(step);
        if (!anchor) { paintSpotlight(null); return; }
        paintSpotlight(anchor, step);
        if (step.center || !placeNear(tourEl, anchor, step.prefer, 14)) centerTourCard(tourEl);
      }
    });
  }

  window.addEventListener('resize', scheduleReposition);
  window.addEventListener('scroll', scheduleReposition, true);
  // 引导开着时窗口尺寸变化，重新对准输入框
  window.addEventListener('resize', () => { if (welcomeEl) anchorWelcome(); });
  // 页面被卸载 / 切走时务必把输入框恢复，不能让它永久消失
  window.addEventListener('pagehide', restoreShareBox);
  window.addEventListener('beforeunload', restoreShareBox);

  // ============================ 10. 对外接口 ============================

  /** 手动重看：浮层「更多」菜单调用；立即重播，忽略已完成步骤 */
  function replay() {
    if (tourActive) return;
    state.replay = true;
    state.welcomeDone = true;
    state.skipped = false;
    if (state.state === 'done' || state.state === 'skipped') state.state = 'waiting';
    persist();
    if (overlayOpen && settled) maybeStartTour();
  }

  window.PCOGuide = {
    version: GUIDE_VERSION,
    replay,
    /** 仅供调试：清空引导记录 */
    reset() {
      dismissWelcome(true);
      teardownTour();
      hideBubble();
      state = freshState();
      hints = {};
      persist();
      persistHints();
      maybeWelcome();
    }
  };

  // ============================ 11. 初始化 ============================

  async function init() {
    const raw = await storageGet([KEY_STATE, KEY_HINTS, KEY_CFG]);

    state = Object.assign(freshState(), raw[KEY_STATE] || {});
    hints = raw[KEY_HINTS] || {};

    const cfg = raw[KEY_CFG] || {};
    const speed = Number(cfg.animSpeed);
    animSpeed = Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1;

    // 引导内容版本升级：不整段重播，只把没看过的步骤排进下一次
    if (state.v < GUIDE_VERSION) {
      state.v = GUIDE_VERSION;
      state.skipped = false;
      if (state.state === 'done' || state.state === 'skipped') state.state = 'waiting';
      persist();
    }

    ready = true;

    if (pendingTopic) {
      handleTopicRendered(pendingTopic);
      pendingTopic = null;
    }
    if (pendingSettle) {
      handleSettled(pendingSettle);
      pendingSettle = null;
    }

    maybeWelcome();
    watchWelcomeRoute();

    // 跨页面同步：设置页「重新开始新手引导」会整份重置记录，这里即时回到欢迎卡
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        // 外部重置：只认设置页写入的 resetAt，忽略自己 persist 触发的回声
        if (changes[KEY_STATE]) {
          const next = changes[KEY_STATE].newValue;
          if (next && next.resetAt && next.resetAt !== state.resetAt) {
            if (welcomeEl) {
              stopConfetti();
              welcomeEl.remove();
              welcomeEl = null;
              welcomeScreen = 0;
            }
            // 被外部重置 / 关闭时也要恢复站点输入框
            restoreShareBox();
            state = Object.assign(freshState(), next);
            teardownTour();
            hideBubble();
            sessionHinted = false;   // 新的一轮：本轮会话的气泡配额也清掉
            maybeWelcome();
            watchWelcomeRoute();
          }
        }

        // 气泡记录被清空后，允许重新出现
        if (changes[KEY_HINTS]) hints = changes[KEY_HINTS].newValue || {};

        // 设置里改动画速度时同步引导节奏
        if (changes[KEY_CFG]) {
          const next = changes[KEY_CFG].newValue || {};
          const n = Number(next.animSpeed);
          animSpeed = Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
          applySpeed();
        }
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  init().catch(() => { /* 引导失败不影响站点 */ });
})();

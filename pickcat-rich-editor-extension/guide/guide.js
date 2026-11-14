/**
 * 新手引导（命名空间 pcg）。
 *
 * 三种形态：
 *   1. 欢迎流程：首装后在信息流页出现一次，居中模态 + 全屏黑色半透明遮罩。
 *      一屏一个功能大类（欢迎 + 5 类功能 + 准备就绪），只由按钮推进；
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
  /**
   * 欢迎流程版本：升到这里就重播一次欢迎卡（含首屏粒子与打字动画）。
   * 完成（结束或跳过）后把版本写进记录，之后打开站点不再出现；
   * 没走完就关掉页面，下次打开会重新出卡。
   */
  const WELCOME_VERSION = '4.0.0';
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
   * 顺序固定为 欢迎 → 刷帖与阅读 → 发帖与回复 → AI 能力 → 站内通知 → 外观与动效 → 准备就绪。
   * 添加 / 删除类别时只改这个数组：屏数、进度点与「结束」判断都会跟着变。
   */
  const WELCOME_FLOW = [
    {
      kind: 'welcome',
      title: '欢迎使用 PickScribe',
      sub: '体验、阅读、发帖、回复和 AI 全面优化，灵动无缝动画，写作所见即所得'
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
      id: 'notify',
      icon: 'bell',
      title: '站内通知转系统推送',
      lead: '不用一直挂着社区页面，新回复、点赞和系统通知会直接弹到系统通知中心。',
      points: [
        { icon: 'bell', text: '<b>关掉页面也不错过</b>：后台按间隔检查未读，出现新消息才提醒，不会每轮都打扰。' },
        { icon: 'cursor', text: '<b>点通知直达帖子</b>：点开系统通知就是对应帖子，省掉回消息中心再翻一遍。' },
        { icon: 'server', text: '<b>收哪个站自己定</b>：Pickcat 与 CDSQ 可分别开关，只盯常用站点也行。' },
        { icon: 'sliders', text: '<b>间隔自己调</b>：1–15 分钟可选，越短越及时，也越耗电。' }
      ]
    },
    {
      kind: 'feature',
      id: 'appearance',
      icon: 'type',
      title: '外观与动效',
      lead: '让整站的文字、圆角与动态效果更合你的习惯。',
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
  const RADIUS_KEY = 'pcr_g2_radius';
  const NOTIFY_KEY = 'pco_notify';

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
    if (id === 'notify') {
      // 与设置页「站内通知」同一套键（pco_notify）与默认值：默认关闭
      return '<div class="pcg-config" data-config="notify">' +
        cfgSwitch('notifyEnabled', '启用系统通知推送') +
        cfgSelect('notifyInterval', '检查间隔', [
          ['1', '每 1 分钟（较耗电）'],
          ['2', '每 2 分钟'],
          ['3', '每 3 分钟'],
          ['5', '每 5 分钟'],
          ['10', '每 10 分钟'],
          ['15', '每 15 分钟']
        ]) +
        '<div class="pcg-cfg-group" data-role="notify-hosts">' +
          cfgSwitch('notifyPickcat', 'Pickcat 社区（pickcat.dao3.fun）') +
          cfgSwitch('notifyCdsq', 'CDSQ 社区（cdsq.dao3.fun）') +
        '</div>' +
        '<p class="pcg-config-note" data-role="notify-note" hidden>总开关已关闭，后台不会检查未读。</p>' +
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
        cfgSwitch('g2Radius', 'G2 连续圆角（曲率连续）') +
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
    reduce: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>',
    replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5V10h5.5"/>'
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

  /**
   * 会「画」出来的线性图标（标题上方的大图标用）。
   * pathLength=1 把每条子路径的长度归一化，CSS 就能用 0→1 的 dashoffset 沿线描出来；
   * 序号 --i 让各段前后错开一点、首尾略有重叠，观感上像一根线连着把整个图标勾完，
   * --shapes 交给 CSS 算出「全部画完」的时刻，好接上后面那个回弹小动作。
   */
  function drawIcon(name, cls) {
    const host = document.createElement('div');
    host.innerHTML = svgIcon(name);
    const svg = host.firstElementChild;
    if (!svg) return svgIcon(name);
    svg.setAttribute('class', cls || 'pcg-draw');
    const shapes = svg.querySelectorAll('path, rect, circle, line, polyline, polygon');
    for (let i = 0; i < shapes.length; i += 1) {
      shapes[i].setAttribute('pathLength', '1');
      shapes[i].setAttribute('data-draw', '');
      shapes[i].style.setProperty('--i', String(i));
    }
    svg.style.setProperty('--shapes', String(shapes.length || 1));
    // sparkles 的图形包围盒不居画布（视觉偏右上），放大到大图标后看得出来；
    // 挪一下 viewBox 把它拉回正中，其余图标本身居中，不用动
    if (name === 'sparkles') svg.setAttribute('viewBox', '0.7 -0.6 24 24');
    return svg.outerHTML;
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
      welcomeVer: '',       // 已完成的欢迎流程版本，与 WELCOME_VERSION 比对
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
  /** AI 能力屏的屏幕边缘光带：动画句柄、展开进度与色相漂移量 */
  let auraRaf = 0;
  let auraStart = 0;
  let auraPhase = 0;
  let auraUnfolded = false;
  let auraSoftEl = null;
  let auraCoreEl = null;
  let auraWaveEl = null;
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
    // 只要插件在这版还没走完欢迎流程，打开任意站点页面就先出卡；
    // 首屏锚点（信息流输入框）不在时自动退回居中
    showWelcome();
  }

  /**
   * 插件 LOGO：先用一根线把猫头轮廓勾出来，再淡入真实的实心 LOGO。
   * 线稿与 icons/logo.svg 共用同一份路径，所以「画出来的形状」和最终图标完全对得上；
   * 拿不到扩展图标时（比如上下文失效）只保留线稿，不至于空一块。
   */
  /**
   * 欢迎屏的大 LOGO：由粒子汇聚而成。
   * 结构是「粒子画布 → 实心图」，粒子聚齐后画布淡出、实心图淡入；
   * 取不到扩展内图标时退回线稿小图标，仍然能播。
   */
  function logoMark() {
    let url = '';
    try { url = chrome.runtime.getURL('icons/logo.svg'); } catch (e) { url = ''; }

    if (!url) {
      return '<span class="pcg-logo-fallback">' + drawIcon('welcome', 'pcg-draw pcg-logo-line') + '</span>';
    }
    return '<span class="pcg-logo-trace-wrap">' +
      '<span class="pcg-logo-wave" aria-hidden="true"></span>' +
      '<span class="pcg-logo-wave pcg-logo-wave--late" aria-hidden="true"></span>' +
      '<img class="pcg-logo-img" src="' + url + '" alt="" width="68" height="68">' +
      '</span>';
  }

  /** 与 icons/logo.svg 同一条路径（64 口径）：粒子采样靠它重绘，不依赖跨源图片 */
  const LOGO_HEAD = typeof Path2D === 'function'
    ? new Path2D('M32 53C21.5 53 15.5 46.5 15.5 36.5c0-5.5 1-9 3-12L13 12s8.5 4 13.5 6.5c3.5-1.3 7.5-1.3 11 0C42.5 16 51 12 51 12l-5.5 12.5c2 3 3 6.5 3 12 0 10-6 16.5-16.5 16.5Z')
    : null;
  const LOGO_FACE = typeof Path2D === 'function'
    ? new Path2D('M24.5 24h15c-.5 7.6-3.2 14.6-7.5 21.5-4.3-6.9-7-13.9-7.5-21.5Z')
    : null;

  /** 按 WELCOME_FLOW 生成每一屏；只有第一屏带 is-on，后续只由按钮切换 */
  function renderWelcomeScreens() {
    return WELCOME_FLOW.map((screen, index) => {
      const on = index === 0;
      const head = '<section class="pcg-screen' + (on ? ' is-on' : '') + '" data-screen="' + index + '"' +
        (on ? '' : ' aria-hidden="true"') + '>';

      if (screen.kind === 'welcome') {
        return head +
          '<div class="pcg-screen-body">' +
            // 外层只负责「从卡片正中滑回左栏」的位移，内层继续跑描线 / 回弹动画
            '<div class="pcg-logo-stage">' +
              '<div class="pcg-logo">' + logoMark() + '</div>' +
              // 粒子画布与打字机都放在卡片内：粒子在图标外一圈内活动，不越出容器
              '<canvas class="pcg-logo-particles" aria-hidden="true"></canvas>' +
              '<p class="pcg-typer" aria-hidden="true">' +
                '<span class="pcg-typer-text" data-role="typer"></span>' +
                '<i class="pcg-typer-caret"></i>' +
              '</p>' +
            '</div>' +
            '<div class="pcg-screen-main">' +
              '<h2 class="pcg-welcome-title">' + screen.title + '</h2>' +
              '<p class="pcg-welcome-sub">' + screen.sub + '</p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      if (screen.kind === 'finish') {
        return head +
          '<div class="pcg-screen-body">' +
            '<span class="pcg-finish-ico">' +
              '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
                '<path class="pcg-check-path" pathLength="1" d="M13 25.5 L20.5 33 L35.5 16.5" />' +
              '</svg>' +
            '</span>' +
            '<div class="pcg-screen-main">' +
              '<h2 class="pcg-screen-title">' + screen.title + '</h2>' +
              '<p class="pcg-welcome-sub">' + screen.sub + '</p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      return head +
        '<div class="pcg-screen-body">' +
          '<span class="pcg-cat-ico">' + drawIcon(screen.icon) + '</span>' +
          '<div class="pcg-screen-main">' +
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
          '</div>' +
        '</div>' +
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
    const raw = await storageGet([KEY_CFG, AI_CONFIG_KEY, LAYOUT_KEY, IMAGE_ZOOM_KEY, FONT_KEY, FONT_MODE_KEY, FONT_CUSTOM_KEY, RADIUS_KEY, NOTIFY_KEY]);
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
    // 与设置页同一判断：未写入过该键时按开启显示
    setChecked('g2Radius', raw[RADIUS_KEY] !== false && raw[RADIUS_KEY] !== '0');

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
    on('g2Radius', (e) => storageSet({ [RADIUS_KEY]: e.target.checked }));
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

    // ---------- 通知屏：站内通知转系统推送 ----------
    const notifyRaw = raw[NOTIFY_KEY] && typeof raw[NOTIFY_KEY] === 'object' ? raw[NOTIFY_KEY] : {};
    const notifyHostsRaw = notifyRaw.hosts && typeof notifyRaw.hosts === 'object' ? notifyRaw.hosts : {};
    // 与 shared/constants.js 的 NOTIFY_DEFAULTS 保持一致：默认关闭、2 分钟、两个站点都开
    const notifyState = {
      enabled: notifyRaw.enabled === true,
      intervalMinutes: Number(notifyRaw.intervalMinutes) || 2,
      hosts: {
        pickcat: notifyHostsRaw.pickcat !== false,
        cdsq: notifyHostsRaw.cdsq !== false
      }
    };

    setChecked('notifyEnabled', notifyState.enabled);
    setValue('notifyInterval',
      ['1', '2', '3', '5', '10', '15'].indexOf(String(notifyState.intervalMinutes)) >= 0
        ? String(notifyState.intervalMinutes)
        : '2');
    setChecked('notifyPickcat', notifyState.hosts.pickcat);
    setChecked('notifyCdsq', notifyState.hosts.cdsq);

    const notifyHosts = modal.querySelector('[data-role="notify-hosts"]');
    const notifyNote = modal.querySelector('[data-role="notify-note"]');
    const notifyIntervalSel = cfg('notifyInterval');
    const notifyMaster = cfg('notifyEnabled');

    function paintNotify() {
      const on = notifyMaster ? notifyMaster.checked : false;
      if (notifyHosts) {
        notifyHosts.classList.toggle('is-off', !on);
        const subs = notifyHosts.querySelectorAll('input');
        for (let i = 0; i < subs.length; i += 1) subs[i].disabled = !on;
      }
      if (notifyIntervalSel) notifyIntervalSel.disabled = !on;
      if (notifyNote) notifyNote.hidden = on;
      syncScreensOverflow();
    }

    // 配置整体写回：键 pco_notify 与后台轮询、设置页共用同一份对象
    const saveNotify = () => storageSet({ [NOTIFY_KEY]: notifyState });

    paintNotify();
    on('notifyEnabled', (e) => {
      notifyState.enabled = e.target.checked;
      paintNotify();
      saveNotify();
    });
    on('notifyInterval', (e) => {
      notifyState.intervalMinutes = Number(e.target.value) || 2;
      saveNotify();
    });
    on('notifyPickcat', (e) => {
      notifyState.hosts = Object.assign({}, notifyState.hosts, { pickcat: e.target.checked });
      saveNotify();
    });
    on('notifyCdsq', (e) => {
      notifyState.hosts = Object.assign({}, notifyState.hosts, { cdsq: e.target.checked });
      saveNotify();
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

  /**
   * 欢迎屏 LOGO 的粒子汇聚：用与 icons/logo.svg 相同的路径在离屏画布上重绘，
   * 逐点采样后把每个点变成一颗从四周飞入的小方块，聚齐后淡出、露出实心图。
   * 不直接 load 扩展里的 svg：跨源图会把画布标记为污染，getImageData 会抛错。
   * 聚齐的那一刻回调 onForm，由调用方接上「超出回」与光波。
   * 画布比 LOGO 大一圈（CSS inset: -90px），粒子才有地方起飞。
   */
  function runLogoParticles(canvas, onForm, speed, opts) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !LOGO_HEAD || !LOGO_FACE) { onForm(); return; }

    // ---- 离屏重绘 LOGO（放大到 128 口径，采样更密、轮廓更准）----
    const S = 128;
    const off = document.createElement('canvas');
    off.width = S;
    off.height = S;
    const octx = off.getContext('2d');
    const k = S / 64;
    octx.setTransform(k, 0, 0, k, 0, 0);

    const grad = octx.createLinearGradient(10, 8, 54, 56);
    grad.addColorStop(0, '#ff6a4d');
    grad.addColorStop(0.55, '#fa322d');
    grad.addColorStop(1, '#df1a15');
    octx.fillStyle = grad;
    octx.fill(LOGO_HEAD);
    octx.fillStyle = '#ffffff';
    octx.fill(LOGO_FACE);
    octx.fillStyle = '#fa322d';
    octx.beginPath();
    octx.arc(32, 31.5, 2.4, 0, Math.PI * 2);
    octx.fill();
    octx.strokeStyle = '#fa322d';
    octx.lineWidth = 1.5;
    octx.lineCap = 'round';
    octx.beginPath();
    octx.moveTo(32, 35);
    octx.lineTo(32, 43);
    octx.stroke();

    let data;
    try {
      data = octx.getImageData(0, 0, S, S).data;
    } catch (e) {
      onForm();
      return;
    }

    const box = canvas.getBoundingClientRect();
    const W = Math.max(160, Math.round(box.width || window.innerWidth));
    const H = Math.max(160, Math.round(box.height || window.innerHeight));

    // 画布包在图标外面一圈，全部落在卡片内；落点用实心图的实际矩形换算，保证与图标重合
    const logoBox = (opts && opts.logo) || document.querySelector('.pcg-modal .pcg-logo');
    const logoRect = logoBox ? logoBox.getBoundingClientRect() : null;
    const logoSize = (logoRect && logoRect.width) || 192;
    const cx = logoRect && logoRect.width ? logoRect.left + logoRect.width / 2 - box.left : W / 2;
    const cy = logoRect && logoRect.height ? logoRect.top + logoRect.height / 2 - box.top : H / 2;
    // 起点半径控制在画布内：粒子只在这个容器范围内活动
    const edge = Math.min(W, H) / 2 - 8;

    // 画布只在容器内：DPR 压到 1.25，粒子只有 1–2px，太高的分辨率看不出差别还拖首帧
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pts = [];
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        const i = (y * S + x) * 4;
        // 只取红色部分：白色面部留空，粒子聚起来就是 LOGO 的轮廓
        if (data[i + 3] < 110 || (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235)) continue;
        // 起点在画布边缘一圈的随机位置，始终不越出这个容器
        const ang = Math.random() * Math.PI * 2;
        const rad = edge * (0.72 + Math.random() * 0.28);
        pts.push({
          tx: cx + (x / S - 0.5) * logoSize * 1.18,
          ty: cy + (y / S - 0.5) * logoSize * 1.18,
          sx: cx + Math.cos(ang) * rad,
          sy: cy + Math.sin(ang) * rad,
          // 出场时刻：大多数粒子压到第二句文案的中段（区间 0.55–0.92）才浮现，
          // 前段只留一成零星颗粒，于是第二段打到一半时才初具雏形
          born: Math.random() < 0.12
            ? Math.random() * 0.45
            : 0.55 + Math.random() * 0.37,
          ph: Math.random() * Math.PI * 2,
          // 采样点变密后颗粒跟着变小，聚起来才像同一张图而不是一团点
          size: 0.9 + Math.random() * 0.9,
          color: 'rgb(' + data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ')'
        });
      }
    }
    // 密度上限：超采样后点数会到几千，等距抽稀，肉眼几乎看不出差别
    if (pts.length > 4200) {
      const stride = pts.length / 4200;
      const kept = [];
      for (let j = 0; j < pts.length; j += stride) kept.push(pts[Math.floor(j)]);
      pts.length = 0;
      for (let j = 0; j < kept.length; j += 1) pts.push(kept[j]);
    }

    const dur = Number(speed) > 0 ? 1 / Number(speed) : 1;
    const gather = 880 * dur;
    const fade = 240 * dur;
    const gate = opts && opts.gate;
    const span = Math.max(1, (opts && opts.duration) || 4000);
    const t0 = performance.now();
    let formed = false;
    let formedAt = 0;

    const tick = (now) => {
      if (!canvas.isConnected) return;
      const t = now - t0;
      // 区间进度：文字在打时按整段文案时长推进，没有文字时按固定汇聚时长
      const prog = gate
        ? (gate.done ? 1 : clamp(t / span, 0, 1))
        : clamp(t / gather, 0, 1);
      if (!formed && prog >= 1) {
        formed = true;
        formedAt = now;
        onForm();
      }
      const out = formed ? Math.max(0, 1 - (now - formedAt) / fade) : 1;
      ctx.clearRect(0, 0, W, H);
      for (let j = 0; j < pts.length; j += 1) {
        const p = pts[j];
        // 尚未出场：跳过，等区间走到它的出生点再出现
        if (p.born > prog) continue;
        // 每颗粒子的飞行进度从它自己的出生时刻算起，到区间结束刚好落到目标：
        // 出来之后一直在飞，不会停在半路，也不会一出现就贴着终点
        const own = clamp((prog - p.born) / Math.max(0.02, 1 - p.born), 0, 1);
        // 出场后快速淡入，避免成片「啪」地亮起来
        const life = clamp(own / 0.12, 0, 1);
        const wob = (1 - own) * 3;
        const x = p.sx + (p.tx - p.sx) * own + (wob ? Math.sin(t * 0.005 + p.ph) * wob : 0);
        const y = p.sy + (p.ty - p.sy) * own + (wob ? Math.cos(t * 0.0047 + p.ph) * wob : 0);
        ctx.globalAlpha = out * life * (0.2 + 0.8 * own);
        ctx.fillStyle = p.color;
        ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      if (!formed || now - formedAt < fade) {
        requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, W, H);
        canvas.style.opacity = '0';
      }
    };
    requestAnimationFrame(tick);
  }

  /**
   * 欢迎屏的打字机：一句一句「打」出来，打完第一句退格删光，再打第二句。
   * 全部打完后回调 onDone——粒子要等这一刻才允许完整成形。
   * 返回整段文案的总时长，粒子把它当作「汇聚区间」，区间内刚好把汇聚播完。
   */
  function playTyper(el, onDone, speed) {
    const dur = 1 / (Number(speed) > 0 ? Number(speed) : 1);
    const TYPE = Math.round(70 * dur);
    const ERASE = Math.round(40 * dur);
    const HOLD = Math.round(520 * dur);
    const GAP = Math.round(220 * dur);
    const name = ((WELCOME_FLOW[0] && WELCOME_FLOW[0].title) || '').replace(/^欢迎使用\s*/, '') || 'PickScribe';
    const first = 'Pickcat 已焕然一新';
    const second = '欢迎使用 ' + name + ' 增强插件';

    const typeText = (text, after) => {
      let i = 0;
      const step = () => {
        if (!el.isConnected) return;
        i += 1;
        el.textContent = text.slice(0, i);
        if (i >= text.length) { setTimeout(after, HOLD); return; }
        setTimeout(step, TYPE);
      };
      step();
    };

    const eraseText = (text, after) => {
      let i = text.length;
      const step = () => {
        if (!el.isConnected) return;
        i -= 1;
        el.textContent = text.slice(0, Math.max(0, i));
        if (i <= 0) { setTimeout(after, GAP); return; }
        setTimeout(step, ERASE);
      };
      step();
    };

    typeText(first, () => eraseText(first, () => typeText(second, onDone)));

    // 整段文案的总时长：粒子把它当汇聚区间，区间内匀速推进到接近成形
    return TYPE * first.length + HOLD + ERASE * first.length + GAP + TYPE * second.length;
  }

  /**
   * 每次入场编排的序号：重播会让上一轮遗留的 setTimeout 失效，
   * 避免旧的收尾逻辑把新一轮刚加上的入场类提前摘掉。
   */
  let welcomeIntroRun = 0;

  /**
   * 欢迎屏的入场编排：先把 LOGO 挪到卡片正中，让粒子汇聚 → 超出回 → 光波演完；
   * 然后再加 is-reveal，图标滑回左栏，文案与底部按钮同时渐显上移。
   * 位移由这里量出来写成 --pcg-intro-x/y，CSS 只负责过渡，所以换屏、缩放都不用另算。
   * reduced-motion 下不排队，直接显示最终状态。
   */
  function playWelcomeIntro(modal) {
    const run = ++welcomeIntroRun;
    const stage = modal.querySelector('.pcg-screen.is-on .pcg-logo-stage');
    const logo = modal.querySelector('.pcg-screen.is-on .pcg-logo');
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (!stage) return;
    if (reduced) {
      if (logo) logo.classList.add('is-formed');
      return;
    }

    modal.classList.add('is-intro');

    // 卡片自身还在做入场位移，但图标是它的后代，两者的 rect 差不受共同位移影响
    const box = modal.getBoundingClientRect();
    const spot = stage.getBoundingClientRect();
    if (box.width && spot.width) {
      stage.style.setProperty('--pcg-intro-x', Math.round(box.left + box.width / 2 - (spot.left + spot.width / 2)) + 'px');
      stage.style.setProperty('--pcg-intro-y', Math.round(box.top + box.height / 2 - (spot.top + spot.height / 2)) + 'px');
    }

    const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;
    const dur = 1 / speed;
    let formedOnce = false;

    // 粒子画布与打字机都留在卡片里（跟随卡片与图标，不铺到视口外）
    const canvas = modal.querySelector('.pcg-screen.is-on .pcg-logo-particles');
    const typer = modal.querySelector('.pcg-screen.is-on .pcg-typer');
    const typerEl = typer && typer.querySelector('[data-role="typer"]');

    // 文字没打完之前，粒子不许完整成形：契约由打字机的总时长决定
    const gate = { done: false, progress: 0 };
    let revealed = false;

    const reveal = () => {
      if (revealed) return;
      revealed = true;
      if (run !== welcomeIntroRun) return;
      if (!modal.isConnected || !modal.classList.contains('is-intro')) return;
      modal.classList.add('is-reveal');
      // 过渡走完就摘掉入场类，后续换屏不再受入场样式影响
      setTimeout(() => {
        if (run !== welcomeIntroRun) return;
        modal.classList.remove('is-intro', 'is-reveal', 'is-typing');
      }, Math.round(900 * dur));
    };

    // 粒子聚齐：先做超出回与光波，等光波散完再停一小拍，才滑回左栏、渐显文案
    const form = () => {
      if (run !== welcomeIntroRun || formedOnce) return;
      formedOnce = true;
      if (logo) logo.classList.add('is-formed');
      setTimeout(reveal, Math.round(1040 * dur));
    };

    // 兜底：无论粒子是否回话，文字打完后都要把交接进行下去
    const formWhenReady = () => {
      if (run !== welcomeIntroRun) return;
      if (!gate.done) { setTimeout(formWhenReady, 100); return; }
      form();
    };

    // 卡片的上滑入场先走完（0.52s），再留一小拍，之后文字才开始出现、粒子才开始动
    const lead = Math.round(520 * dur) + 300;
    setTimeout(() => {
      if (run !== welcomeIntroRun) return;
      if (!modal.isConnected || !modal.classList.contains('is-intro')) return;
      modal.classList.add('is-typing');
      // 文案总时长交给粒子：从这个时刻到最后一个字落定，正好是整段汇聚区间
      let span = 0;
      if (typerEl) {
        span = playTyper(typerEl, () => { gate.done = true; }, speed);
      } else {
        gate.done = true;
      }
      if (canvas) {
        runLogoParticles(canvas, form, speed, { gate, logo, card: modal, duration: span });
        // 图片加载失败等极端情况兜底，保证文案最终会出现
        setTimeout(formWhenReady, Math.round((span || 4000) * dur + 1400));
      } else {
        setTimeout(formWhenReady, Math.round(1200 * dur));
      }
    }, lead);
  }

  /**
   * 首屏「重播动画」：把上一轮留下的终态复位，再把入场编排原样重放一遍。
   * 不重建卡片；位移量由 playWelcomeIntro 按当前布局重新量。
   */
  function replayWelcomeIntro(modal) {
    if (!modal || !modal.isConnected) return;
    const screen = modal.querySelector('.pcg-screen.is-on');
    if (!screen) return;

    const stage = screen.querySelector('.pcg-logo-stage');
    const logo = screen.querySelector('.pcg-logo');
    const canvas = screen.querySelector('.pcg-logo-particles');
    const typerEl = screen.querySelector('[data-role="typer"]');

    // 回到「未入场」：撤销入场类，图标退回模糊态、粒子层与文案清空
    modal.classList.remove('is-intro', 'is-reveal', 'is-typing');
    if (logo) logo.classList.remove('is-formed');
    if (typerEl) typerEl.textContent = '';
    if (canvas) {
      canvas.style.opacity = '';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (stage) {
      // 先清零：沿用上一轮的位移量会让测量把图标当成已经在卡片中央
      stage.style.setProperty('--pcg-intro-x', '0px');
      stage.style.setProperty('--pcg-intro-y', '0px');
    }

    // 只有重播这一轮需要「滑回中央」的过渡，首次入场仍是直接定位
    modal.classList.add('is-replaying');
    playWelcomeIntro(modal);
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
          // 首屏专属：重放图标汇聚与打字；换到其它屏时由 setWelcomeScreen 隐藏
          '<button type="button" class="pcg-ghost pcg-replay" data-role="replay" ' +
            'title="重播动画" aria-label="重播动画">' + svgIcon('replay') + '</button>' +
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
    // 首屏的「重播动画」：入场演完才会显示，重放图标汇聚与打字
    const replayBtn = modal.querySelector('[data-role="replay"]');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        replayBtn.blur();
        replayWelcomeIntro(modal);
      });
    }

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
    playWelcomeIntro(modal);
    syncScreensOverflow();
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
    const tall = wrap.scrollHeight > wrap.clientHeight + 1;
    // 内容超过一屏时（如 AI 能力屏）图标不能再按内容正中排：那样它会停在初始视图下方，
    // 看着和别的屏错位。加类让 CSS 用 sticky 把图标钉在可视区正中，滚动时也不动。
    wrap.classList.toggle('is-scroll', tall);
    const icon = wrap.querySelector(
      '.pcg-screen.is-on > .pcg-screen-body > .pcg-logo-stage, ' +
      '.pcg-screen.is-on > .pcg-screen-body > .pcg-cat-ico, ' +
      '.pcg-screen.is-on > .pcg-screen-body > .pcg-finish-ico'
    );
    if (tall && icon) {
      // sticky 的 top 相对滚动容器：正好让图标在可视区里垂直居中
      wrap.style.setProperty('--pcg-ico-top', Math.max(0, Math.round((wrap.clientHeight - icon.offsetHeight) / 2)) + 'px');
    }
    if (!tall) wrap.scrollTop = 0;
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

    if (!canAnimate || !beforeHeight || Math.abs(afterHeight - beforeHeight) < 1) {
      syncScreensOverflow();
      return;
    }

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
      // 高度落定后重算一次：sticky 图标的居中偏移是按可视区高度算的
      syncScreensOverflow();
    };
    modalSizeAnims.push(sizeAnim);
  }

  /** 只由按钮调用：换屏不换模态，也不重置已看状态 */
  function setWelcomeScreen(index) {
    if (!welcomeEl) return;
    const modal = welcomeEl.querySelector('.pcg-modal');
    // 入场编排还没走完就被键盘推进：直接结束编排，避免新屏文案一直是透明的
    if (modal) modal.classList.remove('is-intro', 'is-reveal', 'is-typing');
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

    // AI 能力屏：屏幕边缘挂一圈彩色光带，由一颗白色光点引导着绕一圈展开
    const aiScreen = WELCOME_FLOW[index];
    if (aiScreen && aiScreen.id === 'ai') startAura();
    else stopAura(false);

    const back = welcomeEl.querySelector('[data-role="back"]');
    if (back) back.hidden = index === 0;
    // 重播只对首屏有意义：换到其它屏时藏起来，首屏时排在「下一步」左侧
    const replayBtn = welcomeEl.querySelector('[data-role="replay"]');
    if (replayBtn) replayBtn.hidden = index !== 0;

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

  /* ============================ AI 能力屏：屏幕边缘光带 ============================ */

  const AURA_COLORS = ['#ff5c8a', '#ffb648', '#7ee0a0', '#4cc9f0', '#b07cff', '#ff5c8a'];
  /** 光带离屏幕边缘的距离：贴着视口边画，光晕自然往内散开 */
  const AURA_PAD = 2;

  /**
   * 两层画布直接挂在 #pcg-root 下（不在遮罩里），位置与尺寸都写死成视口大小，
   * 保证光带贴的是浏览器窗口边缘，而不是卡片或任何容器的边缘。
   */
  function ensureAura() {
    if (!root) return null;
    if (auraSoftEl && auraSoftEl.isConnected && auraCoreEl && auraCoreEl.isConnected && auraWaveEl && auraWaveEl.isConnected) {
      return { soft: auraSoftEl, core: auraCoreEl, wave: auraWaveEl };
    }
    const make = (tag, cls, z) => {
      const el = document.createElement(tag);
      el.className = cls;
      el.setAttribute('aria-hidden', 'true');
      el.style.position = 'fixed';
      el.style.left = '0';
      el.style.top = '0';
      el.style.width = '100vw';
      el.style.height = '100vh';
      el.style.zIndex = String(z);
      root.appendChild(el);
      return el;
    };
    auraSoftEl = make('canvas', 'pcg-ai-soft', 0);
    auraCoreEl = make('canvas', 'pcg-ai-core', 1);
    // 波前是一层带 backdrop-filter 的透明层：环带到哪儿，哪儿的画面就被折射
    auraWaveEl = make('div', 'pcg-ai-wave', 2);
    return { soft: auraSoftEl, core: auraCoreEl, wave: auraWaveEl };
  }

  function removeAura() {
    if (auraSoftEl) auraSoftEl.remove();
    if (auraCoreEl) auraCoreEl.remove();
    if (auraWaveEl) auraWaveEl.remove();
    auraSoftEl = null;
    auraCoreEl = null;
    auraWaveEl = null;
  }

  /** 画布按视口铺满。软层只需要糊，位图 1x 就够；亮边按 DPR 画，细线才不毛糙 */
  function auraSize(canvas, dprCap) {
    if (!canvas) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, canvas.offsetWidth || window.innerWidth);
    const h = Math.max(1, canvas.offsetHeight || window.innerHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /** 沿周长取点的位置：右上 → 右下 → 左下 → 左上，与光带的绘制方向一致 */
  function auraPoint(len, ww, hh, right, bottom) {
    if (len <= hh) return { x: right, y: AURA_PAD + len };
    if (len <= hh + ww) return { x: right - (len - hh), y: bottom };
    if (len <= 2 * hh + ww) return { x: AURA_PAD, y: bottom - (len - hh - ww) };
    return { x: AURA_PAD + (len - 2 * hh - ww), y: AURA_PAD };
  }

  /**
   * 画一帧。progress 0..1 是光带按周长展开的比例，phase 是锥形渐变的起始角（弧度），
   * 展开完成后让 phase 慢慢转，颜色就沿着边缘一直流动。
   */
  function auraFrame(soft, core, progress, phase) {
    if (!soft || !core) return;
    const w = soft.w;
    const h = soft.h;
    const right = w - AURA_PAD;
    const bottom = h - AURA_PAD;
    const ww = right - AURA_PAD;
    const hh = bottom - AURA_PAD;
    const peri = 2 * (ww + hh);
    const len = Math.max(0, Math.min(1, progress)) * peri;

    const trace = (ctx) => {
      ctx.beginPath();
      ctx.moveTo(right, AURA_PAD);
      ctx.lineTo(right, bottom);
      ctx.lineTo(AURA_PAD, bottom);
      ctx.lineTo(AURA_PAD, AURA_PAD);
      ctx.lineTo(right, AURA_PAD);
    };

    const paint = (ctx, lineWidth) => {
      ctx.clearRect(0, 0, w, h);
      if (len <= 0) return;
      const g = ctx.createConicGradient(phase, w / 2, h / 2);
      for (let i = 0; i < AURA_COLORS.length; i += 1) {
        g.addColorStop(i / (AURA_COLORS.length - 1), AURA_COLORS[i]);
      }
      ctx.strokeStyle = g;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      // 虚线只留已展开的那一段，剩下的用超长间隔推到看不见
      ctx.setLineDash([len, peri + 8]);
      trace(ctx);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // 软层：宽的实心光带，模糊交给 CSS，避免每帧在画布里算 blur
    paint(soft.ctx, 20);
    // 里层只做更浓一点的晕，CSS 大幅模糊后不露出彩色光带的实体
    paint(core.ctx, 6);

    // 白色光点当前导：先铺大范围柔光，再点亮核心；临近终点淡出，不会突然消失
    if (progress < 1 && len > 0) {
      const p = auraPoint(len, ww, hh, right, bottom);
      const ctx = core.ctx;
      ctx.globalAlpha = progress > 0.9 ? (1 - progress) / 0.1 : 1;
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 38);
      halo.addColorStop(0, 'rgba(255,255,255,1)');
      halo.addColorStop(0.3, 'rgba(255,255,255,0.55)');
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 38, 0, Math.PI * 2);
      ctx.fill();
      // 近处再补一层亮芯，让白点从彩色光雾里透出来
      const core0 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 9);
      core0.addColorStop(0, 'rgba(255,255,255,1)');
      core0.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = core0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 波前：一层透明的 backdrop-filter 环带，半径从右上角推到全屏对角。
   * 环带扫过的地方，下层画面被模糊并提亮，看上去就是被水波折射过；
   * mask 用径向渐变切成环，环外完全不受影响，所以扩散到哪、扭曲到哪。
   */
  function drawWave(wave, progress) {
    if (!wave) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = Math.hypot(w, h) * (1 - Math.pow(1 - progress, 2));
    wave.style.setProperty('--pcg-wave-r', r.toFixed(1) + 'px');
    // 起手 15% 淡入，之后一路衰减，扫到对角时已经完全消失
    const fade = progress < 0.15
      ? progress / 0.15
      : 1 - (progress - 0.15) / 0.85;
    wave.style.opacity = Math.max(0, fade).toFixed(3);
  }

  /** 进入 AI 能力屏：白点从右上角出发绕一圈，彩色光带跟着展开，之后颜色持续流动 */
  function startAura() {
    stopAura(true);
    const el = ensureAura();
    if (!el) return;
    const s = auraSize(el.soft, 1);
    // 内层会被 CSS 糊一道，位图不需要高倍率，1x 就够，省掉全屏重绘的开销
    const c = auraSize(el.core, 1);
    if (!s || !c) return;

    el.soft.classList.add('is-on');
    el.core.classList.add('is-on');

    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    auraPhase = 0;
    auraUnfolded = false;
    if (reduced) {
      auraUnfolded = true;
      auraFrame(s, c, 1, 0);
      return;
    }

    const speed = Number(animSpeed) > 0 ? Number(animSpeed) : 1;
    // 快进快出：时长再压短；缓动从四次方改成二次方，后半段不再拖沓
    const unfold = 600 / speed;
    // 波纹略长于光带，光带跑完时波前已扫过大半屏
    const waveTime = 720 / speed;
    auraStart = performance.now();
    let prev = auraStart;

    const tick = (now) => {
      if (!welcomeEl || !el.soft.isConnected) return;
      const dt = Math.min(64, Math.max(0, now - prev));
      prev = now;
      const elapsed = now - auraStart;
      const t = Math.min(1, elapsed / unfold);
      const e = 1 - Math.pow(1 - t, 2);
      if (t >= 1) auraUnfolded = true;
      // 展开完成后色相慢慢漂移（约 0.35 弧度 / 秒），光带看起来一直在流动
      if (auraUnfolded) auraPhase += 0.00035 * dt;
      auraFrame(s, c, e, auraPhase);
      drawWave(el.wave, Math.min(1, elapsed / waveTime));
      auraRaf = requestAnimationFrame(tick);
    };
    auraRaf = requestAnimationFrame(tick);
  }

  /** 离开 AI 能力屏：停帧并淡出；留着的画面让 opacity 过渡自然收掉 */
  function stopAura(clear) {
    if (auraRaf) {
      cancelAnimationFrame(auraRaf);
      auraRaf = 0;
    }
    auraUnfolded = false;
    const list = [auraSoftEl, auraCoreEl];
    for (let i = 0; i < list.length; i += 1) {
      const cv = list[i];
      if (!cv) continue;
      cv.classList.remove('is-on');
      if (!clear) continue;
      const ctx = cv.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    }
    // 波前是 DOM 层，不走 is-on：离开屏幕时直接收掉，避免残留在画面上
    if (auraWaveEl) auraWaveEl.style.opacity = '0';
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
    // 光带先淡出，卡片飞走后再摘掉画布
    stopAura(false);
    if (welcomeWatch) { clearInterval(welcomeWatch); welcomeWatch = 0; }

    // 先摘掉引用：退场期间再按 Esc / 重复点击都不会二次触发
    const el = welcomeEl;
    welcomeEl = null;
    welcomeScreen = 0;

    const finish = () => {
      el.remove();
      removeAura();
      // 引导结束（含配置阶段）后才恢复站点输入框，之前一直保持隐藏
      restoreShareBox();
      state.welcomeDone = true;
      state.welcomeVer = WELCOME_VERSION;
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

  /** 首次出卡的等待时间：等首屏资源落定即可，太长会显得没反应 */
  const WELCOME_DELAY = 900;
  const bootAt = Date.now();
  let welcomeDelayTimer = 0;

  /**
   * 排队出欢迎卡：load 之后稍等一下再出。已经手动出过卡 / 已看过就直接返回，
   * 设置页「重新开始」走的是另一条路，不受这里的延迟影响。
   */
  function scheduleWelcome() {
    if (welcomeDelayTimer || welcomeEl || state.welcomeDone) return;
    const run = () => {
      welcomeDelayTimer = 0;
      maybeWelcome();
      watchWelcomeRoute();
    };
    const later = () => {
      if (welcomeEl || state.welcomeDone) return;
      const wait = Math.max(400, WELCOME_DELAY - (Date.now() - bootAt));
      welcomeDelayTimer = setTimeout(run, wait);
    };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
  }

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

    // 欢迎流程版本门：4.0.0 起，打开插件后先走一遍新手引导；
    // 记录里已经是当前版本（说明走完了）就不再出卡，没走完下次打开继续出
    if (state.welcomeVer !== WELCOME_VERSION) {
      state.welcomeDone = false;
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

    // 首次出卡排队等页面加载完，不给首屏添堵
    scheduleWelcome();

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

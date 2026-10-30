/**
 * Pickcat AI 回帖助手（前缀 pcrr）
 *
 * 只在帖子详情页（/forum/post/<id>）工作：
 *   1. 在回复框的工具行里插入一个「AI」按钮（与表情、图片按钮同一行）；
 *   2. 面板提供两个 Tab：帮我写（按帖子内容生成回复）、润色草稿（复用发帖端的润色能力）；
 *   3. 结果只填充到站点回复框，绝不自动发送。
 *
 * 复用后台 Port 协议（name 'pcai'，{type:'start', id, messages, cacheKey, bypass}），
 * 与 ai/content.js 的总结面板、编辑器写作助手互不干扰（各自独立 Port 与 DOM）。
 */
(() => {
  'use strict';

  // 扩展被重载 / 更新后，旧内容脚本里的异步 chrome.* 调用会以
  // "Extension context invalidated" 拒绝；这是预期内的噪音，直接吞掉。
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  const NS = 'pcrr';
  const CFG_KEY = 'pcai_config';
  const MAX_POST_BODY = 6000;     // 帖子正文截断上限
  const MAX_COMMENTS = 1800;      // 已有评论截断上限
  const MAX_DRAFT = 4000;         // 草稿截断上限

  const DEFAULTS = { enabled: true, provider: 'deepseek', model: 'deepseek-chat', apiKey: '' };

  // 回复输入框候选选择器：站点主选择器 → 文案兜底（textarea 与 contenteditable 两种情况都兼容）
  const INPUT_SELECTORS = [
    'textarea.reply-composer-input',
    'textarea[placeholder*="Markdown"]',
    'textarea[placeholder*="回复"]',
    'textarea[placeholder*="评论"]',
    'textarea[placeholder*="想法"]',
    'textarea[placeholder*="说点什么"]',
    '[contenteditable="true"].reply-composer-input',
    '[contenteditable="true"][data-placeholder*="想法"]',
    '[contenteditable="true"][data-placeholder*="回复"]',
    '[contenteditable="true"][data-placeholder*="评论"]'
  ];

  const WRITE_SYSTEM = '你是 Pickcat 社区的回帖助手。根据用户给出的帖子标题、正文和已有评论，写一条可以直接发布的中文回复。'
    + '只输出回复正文本身：不要开场白、解释、总结或“以下是”之类的话；不要编造帖子中不存在的事实；'
    + '语气像真实用户，自然、有信息量，不堆砌套话；除非内容确实需要分点，否则不要使用 Markdown 标题或列表。';

  const POLISH_SYSTEM = '你是中文写作润色助手。用户会给出回复草稿和修改要求，你只输出修改后的文本本身：'
    + '不要解释、不要对比、不要加“修改后：”之类的前缀，也不要用代码围栏包裹。'
    + '保持原意与事实不变，不要添加原文没有的信息；保留 @提及、链接、代码与专有名词。';

  // 写回复：语气与长度选项
  const TONES = [
    { id: 'agree', name: '赞同', hint: '先认同作者的关键观点，再补一句自己的感受，语气友好。' },
    { id: 'ask', name: '提问', hint: '以好奇、具体的问题追问一个细节，避免质问语气。' },
    { id: 'add', name: '补充', hint: '补充一条自己的经验或相关信息，提供增量价值。' },
    { id: 'pro', name: '专业', hint: '用克制、专业的措辞分析，避免情绪化表达。' },
    { id: 'light', name: '轻松', hint: '语气轻松幽默一点，但不要油腻、不要玩烂梗。' }
  ];

  const LENGTHS = [
    { id: 'short', name: '简短', hint: '1-2 句，40 字以内，直接表态。' },
    { id: 'medium', name: '适中', hint: '3-5 句，60-150 字，说清一个观点。' },
    { id: 'long', name: '详细', hint: '6 句以上，150-300 字，可适当分点。' }
  ];

  // 润色草稿：按「改表达 / 调语气 / 理结构」分组，避免一长排按钮堆在一起
  const POLISH_GROUPS = [
    {
      label: '改表达',
      items: [
        { id: 'polish', name: '润色', hint: '在保持原意的前提下，让表达更通顺、准确、有层次。' },
        { id: 'natural', name: '更自然', hint: '改写成更口语、更自然的表达，像日常说话。' },
        { id: 'concise', name: '更精炼', hint: '压缩到尽量少的字数，只保留核心信息和必要细节。' },
        { id: 'expand', name: '扩写', hint: '在不编造事实的前提下，补充一两个具体细节，让内容更充实。' }
      ]
    },
    {
      label: '调语气',
      items: [
        { id: 'polite', name: '更礼貌', hint: '语气更礼貌、友善，避免生硬或攻击性表达。' },
        { id: 'expert', name: '更专业', hint: '用更专业、克制的措辞，减少口语与情绪词。' },
        { id: 'relaxed', name: '更轻松', hint: '语气更轻松幽默，但不要油腻。' }
      ]
    },
    {
      label: '理结构',
      items: [
        { id: 'points', name: '分点表达', hint: '把内容整理成 2-3 个要点，每个要点一句话，用短列表输出。' }
      ]
    }
  ];

  // ============================ 1. 工具 ============================

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function extAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  const isPostPage = () => /^\/forum\/post\/[^/]+/.test(location.pathname);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    // 部分富文本组件在未聚焦时高度为 0，这里只要求有宽度，避免漏掉输入框
    return r.width > 0 && (r.height > 0 || el.offsetParent !== null);
  }

  function isOurs(el) {
    return !!(el.closest && el.closest('#pcrr-panel, .pcai-root'));
  }

  /** 当前站点回复输入框（找不到返回 null） */
  function getReplyInput() {
    for (const sel of INPUT_SELECTORS) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        if (!isOurs(el) && isVisible(el)) return el;
      }
    }
    // 兜底：取最后一个可见 textarea，排除本站 AI 面板自带的输入框
    const all = Array.from(document.querySelectorAll('textarea'))
      .filter((el) => !isOurs(el) && isVisible(el));
    return all.length ? all[all.length - 1] : null;
  }

  /** 读取输入框内容（textarea 与 contenteditable 都支持） */
  function readInput(el) {
    if (!el) return '';
    return String((el.isContentEditable ? el.innerText : el.value) || '');
  }

  // ============================ 2. 站点内容提取 ============================

  function extractPost() {
    const art = document.querySelector('article.relative') || document.body;
    let title = '';
    const h = art.querySelector('h1') || document.querySelector('h1');
    if (h) title = (h.innerText || '').trim();
    if (!title) title = (document.title || '').split(/[|｜\-–—]/)[0].trim();

    const bodyEl = document.querySelector('.markdown-body');
    let content = bodyEl ? (bodyEl.innerText || '') : '';
    content = content.replace(/\n{3,}/g, '\n\n').trim();
    if (content.length > MAX_POST_BODY) content = content.slice(0, MAX_POST_BODY) + '\n……（正文过长，已截断）';

    let author = '';
    const head = document.querySelector('div[aria-label="作者与帖子操作"]');
    if (head) {
      const link = head.querySelector('a[href*="/profile/"]');
      if (link) author = (link.innerText || '').trim();
    }
    return { title, author, content };
  }

  /** 已有评论：抓回复列表的纯文本，作为「不要重复」的参考 */
  function extractComments() {
    const box = document.querySelector('div.post-comment-replies');
    if (!box) return '';
    const items = box.querySelectorAll('[class*="comment"], [class*="reply"]');
    const parts = [];
    const scan = items.length ? items : [box];
    scan.forEach((el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > 4 && parts.indexOf(t) === -1) parts.push(t);
    });
    let text = parts.slice(0, 8).join('\n- ');
    if (text.length > MAX_COMMENTS) text = text.slice(0, MAX_COMMENTS) + '……';
    return text;
  }

  // ============================ 3. 配置与后台 Port ============================

  let config = { ...DEFAULTS };
  let port = null;
  let seq = 0;
  const pending = new Map();
  let busy = false;
  let reqId = null;
  let streamText = '';
  let lastRun = null;       // { kind, payload } 用于「再生成」

  function loadConfig() {
    if (!extAlive()) return;
    try {
      chrome.storage.local.get([CFG_KEY], (raw) => {
        config = { ...DEFAULTS, ...((raw && raw[CFG_KEY]) || {}) };
        if (ui && ui.model) ui.model.textContent = config.model || '未选择模型';
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  function ensurePort() {
    if (port) return port;
    if (!extAlive()) return null;
    try { port = chrome.runtime.connect({ name: 'pcai' }); } catch (e) { port = null; return null; }
    port.onMessage.addListener((msg) => {
      const cb = pending.get(msg && msg.id);
      if (!cb) return;
      if (msg.type === 'chunk') { if (cb.onChunk) cb.onChunk(msg.delta); }
      else if (msg.type === 'done') { pending.delete(msg.id); if (cb.onDone) cb.onDone(msg); }
      else if (msg.type === 'error') { pending.delete(msg.id); if (cb.onError) cb.onError(msg); }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      pending.forEach((cb) => { if (cb.onError) cb.onError({ message: '后台连接已断开，请重试' }); });
      pending.clear();
      if (busy) { busy = false; reqId = null; renderError('后台连接已断开，请重试'); syncButtons(); }
    });
    return port;
  }

  function request(messages, onChunk, onDone, onError) {
    const id = 'r' + (++seq);
    const p = ensurePort();
    if (!p) { onError({ message: '扩展已更新或已停用，请刷新页面后再试' }); return id; }
    pending.set(id, { onChunk, onDone, onError });
    try {
      p.postMessage({ type: 'start', id, messages, cacheKey: null, bypass: true });
    } catch (e) {
      pending.delete(id);
      onError({ message: '后台连接失败，请重新加载页面后再试' });
    }
    return id;
  }

  function abort() {
    if (reqId && port) { try { port.postMessage({ type: 'abort', id: reqId }); } catch (e) { /* 忽略 */ } }
    if (reqId) pending.delete(reqId);
    reqId = null;
  }

  // ============================ 4. 提示词 ============================

  function buildWriteMessages(payload) {
    const post = extractPost();
    const comments = extractComments();
    const tone = TONES.find((t) => t.id === payload.tone) || TONES[0];
    const len = LENGTHS.find((l) => l.id === payload.length) || LENGTHS[1];

    const parts = [
      '帖子标题：' + (post.title || '（无标题）'),
      '帖子正文：\n' + (post.content || '（正文为空）')
    ];
    if (comments) parts.push('已有评论（仅供理解讨论氛围，不要重复别人的观点）：\n- ' + comments);
    parts.push('写作要求：\n- 语气：' + tone.hint + '\n- 长度：' + len.hint);
    if (payload.quote) parts.push('- 自然引用或回应楼主的一个具体观点，不要生硬复述。');
    if (payload.extra) parts.push('- 额外要求：' + payload.extra);

    return [
      { role: 'system', content: WRITE_SYSTEM },
      { role: 'user', content: parts.join('\n\n') }
    ];
  }

  function buildPolishMessages(payload, draft) {
    const action = findPolishAction(payload.action);
    const text = draft.length > MAX_DRAFT ? draft.slice(0, MAX_DRAFT) + '\n……（草稿过长，已截断）' : draft;
    const parts = ['修改要求：' + action.hint];
    if (payload.extra) parts.push('额外要求：' + payload.extra);
    parts.push('草稿：\n' + text);
    return [
      { role: 'system', content: POLISH_SYSTEM },
      { role: 'user', content: parts.join('\n\n') }
    ];
  }

  function findPolishAction(id) {
    for (const g of POLISH_GROUPS) {
      const hit = g.items.find((it) => it.id === id);
      if (hit) return hit;
    }
    return POLISH_GROUPS[0].items[0];
  }

  // ============================ 5. 轻量 Markdown 渲染 ============================

  function renderLite(text) {
    const lines = escapeHtml(text).replace(/\r\n?/g, '\n').split('\n');
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

    lines.forEach((line) => {
      const t = line.trim();
      if (!t) { closeList(); return; }
      const m = t.match(/^([-*+•]|\d+[.)])\s+(.*)$/);
      if (m) {
        const tag = /^\d/.test(m[1]) ? 'ol' : 'ul';
        if (list !== tag) { closeList(); out.push('<' + tag + '>'); list = tag; }
        out.push('<li>' + inline(m[2]) + '</li>');
        return;
      }
      closeList();
      out.push('<p>' + inline(t) + '</p>');
    });
    closeList();
    return out.join('');
  }

  // ============================ 6. 界面 ============================

  let panel = null;
  let ui = null;
  let open = false;
  let activeTab = 'write';
  let toneId = 'agree';
  let lengthId = 'medium';
  let quote = false;
  let polishAction = 'polish';

  /** 与站点一致的单色图标：继承当前文字颜色（主色 / 按钮色） */
  function icon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">'
      + '<path d="M10 2.5 11.7 8.3 17.5 10 11.7 11.7 10 17.5 8.3 11.7 2.5 10 8.3 8.3Z"/>'
      + '<path d="M17.8 3 18.5 5.5 21 6.2 18.5 6.9 17.8 9.4 17.1 6.9 14.6 6.2 17.1 5.5Z" opacity=".55"/>'
      + '</svg>';
  }

  const svgIco = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';

  function chipsHtml(list, group, current) {
    return list.map((it) =>
      '<button type="button" class="' + NS + '-chip' + (it.id === current ? ' is-on' : '') + '"'
      + ' data-group="' + group + '" data-id="' + it.id + '">' + escapeHtml(it.name) + '</button>'
    ).join('');
  }

  function polishGroupsHtml() {
    return POLISH_GROUPS.map((g) =>
      '<div class="' + NS + '-group">'
      + '<span class="' + NS + '-label">' + g.label + '</span>'
      + '<div class="' + NS + '-chips">' + chipsHtml(g.items, 'polish', polishAction) + '</div>'
      + '</div>'
    ).join('');
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.id = NS + '-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'AI 回帖助手');

    el.innerHTML =
      '<div class="' + NS + '-head">' +
        '<span class="' + NS + '-title">' + icon() + '<span>AI 回帖助手</span></span>' +
        '<span class="' + NS + '-model"></span>' +
        '<button type="button" class="' + NS + '-ico ' + NS + '-stop ' + NS + '-hide" data-act="stop" title="停止生成">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>' +
        '</button>' +
        '<button type="button" class="' + NS + '-ico" data-act="settings" title="打开 AI 设置">' +
          svgIco('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>') +
        '</button>' +
        '<button type="button" class="' + NS + '-ico" data-act="close" title="关闭（Esc）">' +
          svgIco('<path d="M6 6l12 12M18 6L6 18"/>') +
        '</button>' +
      '</div>' +

      '<div class="' + NS + '-tabs" role="tablist">' +
        '<span class="' + NS + '-ink"></span>' +
        '<button type="button" class="' + NS + '-tab is-on" role="tab" data-tab="write">帮我写</button>' +
        '<button type="button" class="' + NS + '-tab" role="tab" data-tab="polish">润色草稿</button>' +
      '</div>' +

      '<div class="' + NS + '-body">' +
        '<section class="' + NS + '-pane is-on" data-pane="write">' +
          '<div class="' + NS + '-group">' +
            '<span class="' + NS + '-label">语气</span>' +
            '<div class="' + NS + '-chips">' + chipsHtml(TONES, 'tone', toneId) + '</div>' +
          '</div>' +
          '<div class="' + NS + '-group">' +
            '<span class="' + NS + '-label">长度</span>' +
            '<div class="' + NS + '-chips">' + chipsHtml(LENGTHS, 'length', lengthId) +
              '<button type="button" class="' + NS + '-chip" data-group="quote" data-id="quote">引用要点</button>' +
            '</div>' +
          '</div>' +
          '<input class="' + NS + '-extra" data-kind="write" type="text" maxlength="120" ' +
            'placeholder="补充要求（可选），如：以路人视角，别太长" />' +
          '<button type="button" class="' + NS + '-run" data-act="run-write">生成回复草稿</button>' +
        '</section>' +

        '<section class="' + NS + '-pane" data-pane="polish">' +
          '<div class="' + NS + '-draft is-empty" data-role="draft">先在下方回复框里写几句，再回来润色。</div>' +
          polishGroupsHtml() +
          '<input class="' + NS + '-extra" data-kind="polish" type="text" maxlength="120" ' +
            'placeholder="补充要求（可选），如：保留第一人称、别改专业词" />' +
          '<button type="button" class="' + NS + '-run" data-act="run-polish">润色这段草稿</button>' +
        '</section>' +

        '<div class="' + NS + '-out" data-role="out">' +
          '<div class="' + NS + '-ph">选择语气和长度后点「生成回复草稿」；也可以在「润色草稿」里修改自己写好的回复。<br>结果只会填入回复框，不会自动发送。</div>' +
        '</div>' +
      '</div>' +

      '<div class="' + NS + '-foot">' +
        '<span class="' + NS + '-tip">只填充，不发送</span>' +
        '<span class="' + NS + '-usage"></span>' +
        '<button type="button" class="' + NS + '-btn is-primary" data-act="fill" disabled>填入输入框</button>' +
        '<button type="button" class="' + NS + '-btn" data-act="copy" disabled>复制</button>' +
        '<button type="button" class="' + NS + '-btn" data-act="again" disabled>再生成</button>' +
      '</div>';

    ui = {
      el,
      model: el.querySelector('.' + NS + '-model'),
      ink: el.querySelector('.' + NS + '-ink'),
      tabs: Array.from(el.querySelectorAll('.' + NS + '-tab')),
      panes: Array.from(el.querySelectorAll('.' + NS + '-pane')),
      draft: el.querySelector('[data-role="draft"]'),
      out: el.querySelector('[data-role="out"]'),
      fill: el.querySelector('[data-act="fill"]'),
      copy: el.querySelector('[data-act="copy"]'),
      again: el.querySelector('[data-act="again"]'),
      stop: el.querySelector('[data-act="stop"]'),
      usage: el.querySelector('.' + NS + '-usage')
    };

    el.addEventListener('click', onClick);

    // 标题栏可拖动：pointerdown 起手，pointermove 跟随，pointerup 收尾
    const head = el.querySelector('.' + NS + '-head');
    if (head) {
      head.title = '拖动可移动窗口';
      head.addEventListener('pointerdown', onDragStart);
    }
    return el;
  }

  // ============================ 7. 打开 / 关闭 / 定位 ============================

  let tools = null;

  /** 工具栏入口：一个「AI」按钮，面板内再切换「帮我写 / 润色草稿」 */
  function buildTools() {
    const el = document.createElement('span');
    el.className = NS + '-tools';
    el.innerHTML =
      '<button type="button" class="' + NS + '-tool" data-tool="write" ' +
        'title="AI 回帖助手：生成回复或润色草稿" aria-label="AI 回帖助手">' +
        icon() + '<span>AI</span></button>';

    // 按下时阻止默认行为：否则输入框失焦后站点会收起工具行，按钮还没点就被移除
    el.addEventListener('mousedown', (e) => { e.preventDefault(); });
    el.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button[data-tool]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) { closePanel(); return; }
      openPanel('write');
    });
    return el;
  }

  /** 两个节点的最近公共祖先 */
  function lca(a, b) {
    const set = new Set();
    for (let n = a; n; n = n.parentElement) set.add(n);
    for (let n = b; n; n = n.parentElement) if (set.has(n)) return n;
    return null;
  }

  /**
   * 找站点回复框自带的工具行（表情 / 图片按钮）。
   * 返回 { parent, after }：把我们的按钮插到 after 之后；找不到返回 null。
   */
  function findToolbarSlot(ta) {
    // 发送/发布属于操作按钮，不参与「工具行图标」判定，否则按钮会被插到它后面
    const isSubmit = (b) => {
      if (b.type === 'submit') return true;
      const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
      return /发送|发布|提交|send|submit/.test(t);
    };
    let node = ta.parentElement;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      const icons = Array.from(node.querySelectorAll('button, [role="button"]'))
        .filter((b) => {
          if (isOurs(b) || isSubmit(b) || (b.textContent || '').trim() || !b.querySelector('svg')) return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.width <= 48 && r.height > 0 && r.height <= 48;
        });
      if (icons.length >= 2) {
        // 插到最右侧图标之后：工具行左端常与输入框占位文案重叠，靠右放才不会被文字压住
        const last = icons[icons.length - 1];
        const group = lca(icons[0], last) || last.parentElement;
        return { parent: group, after: last };
      }
    }
    return null;
  }

  /** 把「AI」入口放到回复框的工具栏里（工具行未渲染时先贴在输入框下方） */
  function ensureInlineTools() {
    const ta = getReplyInput();
    if (!ta) { removeInlineTools(); return; }

    const slot = findToolbarSlot(ta);
    if (tools && tools.isConnected) {
      // 位置已经正确就不动，避免反复操作站点 DOM
      if (slot ? (tools.parentElement === slot.parent && tools.previousElementSibling === slot.after)
               : (tools.parentElement === ta.parentElement && tools.previousElementSibling === ta)) {
        return;
      }
    } else {
      tools = buildTools();
    }

    if (slot) {
      slot.parent.insertBefore(tools, slot.after.nextSibling);
    } else if (ta.parentElement) {
      ta.parentElement.insertBefore(tools, ta.nextSibling);
    }
  }

  function removeInlineTools() {
    if (tools && tools.isConnected) tools.remove();
  }

  function openPanel(tab) {
    const ta = getReplyInput();
    if (!ta) { toast('还没找到回复输入框，先点开评论框试试'); return; }

    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    loadConfig();
    if (ui && ui.model) ui.model.textContent = config.model || '未选择模型';
    open = true;
    panel.classList.add('is-open');
    if (tab === 'write' || tab === 'polish') switchTab(tab);
    else refreshDraft();

    positionPanel();
    requestAnimationFrame(() => moveInk(false));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', positionPanel, true);
    window.addEventListener('resize', onResize);
  }

  /** 窗口尺寸变化：重定位面板，同时按新宽度重新对齐 Tab 底块 */
  function onResize() {
    positionPanel();
    moveInk(false);
  }

  function closePanel() {
    open = false;
    abort();
    busy = false;
    if (panel) panel.classList.remove('is-open');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', positionPanel, true);
    window.removeEventListener('resize', onResize);
  }

  /** 回复框整体（含表情/图片工具行），用于让面板避让整个输入区而不是只避让 textarea */
  function getComposerBox(ta) {
    const slot = findToolbarSlot(ta);
    if (!slot || !slot.parent) return ta;
    let node = slot.parent;
    while (node && !node.contains(ta)) node = node.parentElement;
    return node || ta;
  }

  /** 面板优先贴在回复框上方，空间不足时放到下方，最后兜底居中 */
  function positionPanel() {
    if (!open || !panel) return;
    // 用户拖动过：保持手动位置，只做视口内的边界收敛
    if (userPos) { applyUserPos(); return; }
    if (window.matchMedia('(max-width: 560px)').matches) {
      panel.style.maxHeight = '';   // 窄屏由 CSS 贴底
      return;
    }
    const ta = getReplyInput();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const w = panel.offsetWidth || 480;
    const gap = 12;
    const minH = 300;

    let left = Math.round((vw - w) / 2);
    let top = 0;

    if (ta) {
      const r = getComposerBox(ta).getBoundingClientRect();
      const above = r.top - gap * 2;
      const below = vh - r.bottom - gap * 2;
      // 面板高度跟着可用空间收缩，内容区内部滚动，避免盖住回复框
      const avail = Math.max(above, below);
      panel.style.maxHeight = Math.max(minH, Math.min(640, avail)) + 'px';
      const h = panel.offsetHeight || 560;
      const useAbove = above >= minH || above >= below;
      left = Math.min(Math.max(gap, r.left + (r.width - w) / 2), vw - w - gap);
      top = useAbove ? r.top - h - gap : r.bottom + gap;
    } else {
      panel.style.maxHeight = '';
      top = Math.round((vh - (panel.offsetHeight || 560)) / 2);
    }
    const h = panel.offsetHeight || 560;
    left = Math.max(gap, Math.min(left, vw - w - gap));
    top = Math.max(gap, Math.min(top, vh - h - gap));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  // ---------------------------- 拖动移动窗口 ----------------------------

  /**
   * 拖动标题栏移动面板。
   * userPos 为空表示面板仍自动贴靠回复框；一旦拖动过，就保持用户放下的位置，
   * 只随视口尺寸变化做边界收敛，滚页面时不再跟着回复框跑。
   */
  let userPos = null;
  let dragState = null;
  const DRAG_MARGIN = 8;

  function applyUserPos() {
    if (!userPos || !panel) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    userPos.left = Math.max(DRAG_MARGIN, Math.min(userPos.left, vw - w - DRAG_MARGIN));
    userPos.top = Math.max(DRAG_MARGIN, Math.min(userPos.top, vh - h - DRAG_MARGIN));
    panel.style.left = Math.round(userPos.left) + 'px';
    panel.style.top = Math.round(userPos.top) + 'px';
  }

  function onDragStart(e) {
    if (!panel || e.button !== 0) return;
    // 窄屏是贴底抽屉，不允许拖动
    if (window.matchMedia('(max-width: 560px)').matches) return;
    // 点标题栏上的按钮 / 输入框时交给它们自己处理
    if (e.target.closest && e.target.closest('button, a, input, textarea, select')) return;

    panel.style.maxHeight = '';   // 让面板展开到自然高度再量尺寸
    const r = panel.getBoundingClientRect();
    dragState = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
    panel.classList.add('is-dragging');
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragState || !panel) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const h = Math.max(dragState.h, panel.offsetHeight);
    const left = Math.max(DRAG_MARGIN, Math.min(dragState.left + e.clientX - dragState.x, vw - dragState.w - DRAG_MARGIN));
    const top = Math.max(DRAG_MARGIN, Math.min(dragState.top + e.clientY - dragState.y, vh - h - DRAG_MARGIN));
    userPos = { left, top };
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function onDragEnd() {
    dragState = null;
    if (panel) panel.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragEnd);
  }

  function onKey(e) {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }

  // ============================ 8. Tab / 选项 ============================

  function moveInk(animate) {
    if (!ui) return;
    const btn = ui.tabs.find((b) => b.getAttribute('data-tab') === activeTab);
    if (!btn) return;
    if (!animate) ui.ink.style.transition = 'none';
    ui.ink.style.left = (btn.offsetLeft + 3) + 'px';
    ui.ink.style.width = (btn.offsetWidth - 6) + 'px';
    if (!animate) {
      void ui.ink.offsetWidth;
      ui.ink.style.transition = '';
    }
  }

  function switchTab(name) {
    activeTab = name;
    ui.tabs.forEach((b) => {
      const on = b.getAttribute('data-tab') === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ui.panes.forEach((p) => p.classList.toggle('is-on', p.getAttribute('data-pane') === name));
    moveInk(true);
    if (name === 'polish') refreshDraft();
    schedulePosition();
  }

  /** 面板高度变化后（切 Tab / 出结果）重新定位，避免遮挡回复框 */
  function schedulePosition() {
    requestAnimationFrame(() => requestAnimationFrame(positionPanel));
  }

  function selectChip(btn) {
    const group = btn.getAttribute('data-group');
    const id = btn.getAttribute('data-id');
    if (group === 'quote') {
      quote = !quote;
      btn.classList.toggle('is-on', quote);
      return;
    }
    if (group === 'tone') { toneId = id; renderChipGroup('tone', id); return; }
    if (group === 'length') { lengthId = id; renderChipGroup('length', id); return; }
    if (group === 'polish') { polishAction = id; renderChipGroup('polish', id); return; }
  }

  function renderChipGroup(group, activeId) {
    if (!ui) return;
    ui.el.querySelectorAll('.' + NS + '-chip[data-group="' + group + '"]').forEach((b) => {
      b.classList.toggle('is-on', b.getAttribute('data-id') === activeId);
    });
  }

  function refreshDraft() {
    if (!ui) return;
    const ta = getReplyInput();
    const text = readInput(ta).trim();
    if (!text) {
      ui.draft.classList.add('is-empty');
      ui.draft.innerHTML = '先在下方回复框里写几句，再回来润色。';
      return;
    }
    ui.draft.classList.remove('is-empty');
    const brief = text.length > 120 ? text.slice(0, 120) + '…' : text;
    ui.draft.innerHTML = '<strong>当前草稿：</strong>' + escapeHtml(brief);
  }

  function extraOf(kind) {
    const input = ui.el.querySelector('.' + NS + '-extra[data-kind="' + kind + '"]');
    return input ? input.value.trim() : '';
  }

  // ============================ 9. 生成 ============================

  function onClick(e) {
    const chip = e.target.closest('[data-group]');
    if (chip) { selectChip(chip); return; }

    const tab = e.target.closest('[data-tab]');
    if (tab) { switchTab(tab.getAttribute('data-tab')); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');

    if (act === 'close') closePanel();
    else if (act === 'settings') sendOpenOptions();
    else if (act === 'run-write') runWrite();
    else if (act === 'run-polish') runPolish();
    else if (act === 'fill') fillToInput();
    else if (act === 'copy') copyResult();
    else if (act === 'again') rerun();
    else if (act === 'stop') stopGen();
  }

  /** 停止当前生成：保留已经输出的内容，不再回填未完成的片段 */
  function stopGen() {
    if (!busy) return;
    abort();
    busy = false;
    clearUsageChip();
    if (streamText.trim()) renderFinal();
    else renderNote('已停止生成。');
    toast('已停止生成');
    syncButtons();
  }

  function runWrite() {
    if (busy) return;
    const payload = { tone: toneId, length: lengthId, quote, extra: extraOf('write') };
    lastRun = { kind: 'write', payload };
    runRequest(buildWriteMessages(payload));
  }

  function runPolish() {
    if (busy) return;
    const ta = getReplyInput();
    const draft = readInput(ta).trim();
    if (!draft) {
      switchTab('polish');
      refreshDraft();
      renderNote('回复框里还没有内容。先写几句，再回来润色。');
      if (ta) ta.focus();
      return;
    }
    const payload = { action: polishAction, extra: extraOf('polish') };
    lastRun = { kind: 'polish', payload };
    runRequest(buildPolishMessages(payload, draft));
  }

  function rerun() {
    if (busy || !lastRun) return;
    if (lastRun.kind === 'polish') {
      const ta = getReplyInput();
      const draft = readInput(ta).trim();
      if (!draft) { renderNote('回复框里没有内容了，无法继续润色。'); return; }
      runRequest(buildPolishMessages(lastRun.payload, draft));
    } else {
      runRequest(buildWriteMessages(lastRun.payload));
    }
  }

  function runRequest(messages) {
    if (!extAlive()) { renderError('扩展已更新或已停用，请刷新页面后再试'); return; }
    if (!config.apiKey && config.provider !== 'ollama' && config.provider !== 'custom') {
      renderError('还没有填写 API Key。请先在扩展设置里配置模型与密钥。', true);
      return;
    }

    busy = true;
    streamText = '';
    syncButtons();
    renderLoading();
    reqId = request(
      messages,
      (delta) => {
        streamText += delta;
        renderStream();
      },
      (msg) => {
        busy = false;
        reqId = null;
        streamText = (msg && msg.text) || streamText;
        if (!streamText.trim()) { renderError('模型返回了空内容，请重试或更换模型。'); clearUsageChip(); }
        else { renderFinal(); setUsage(msg && msg.usage); }
        syncButtons();
      },
      (err) => {
        busy = false;
        reqId = null;
        renderError((err && err.message) || '生成失败，请稍后重试');
        clearUsageChip();
        syncButtons();
      }
    );
  }

  // ============================ 10. 结果渲染与操作 ============================

  /** 窄容器里的 Token 缩写：1234 → 1.2k */
  function fmtToken(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  /** 底栏 Token 胶囊：真实 usage 直接显示，估算值前加 ≈ */
  function setUsage(u) {
    if (!ui || !ui.usage) return;
    if (!u || !u.total) { clearUsageChip(); return; }
    const est = !!u.estimated;
    ui.usage.textContent = (est ? '≈' : '') + '↑' + fmtToken(u.prompt) + ' ↓' + fmtToken(u.completion);
    ui.usage.classList.toggle('is-est', est);
    ui.usage.title = [
      est ? '服务商未返回 usage，以下为本地估算值' : '本次用量（服务商返回）',
      '输入 ' + u.prompt + ' Tokens',
      '输出 ' + u.completion + ' Tokens',
      '合计 ' + u.total + ' Tokens'
    ].join('\n');
  }

  function clearUsageChip() {
    if (!ui || !ui.usage) return;
    ui.usage.textContent = '';
    ui.usage.classList.remove('is-est');
    ui.usage.title = '';
  }

  function renderLoading() {
    ui.out.innerHTML = '<div class="' + NS + '-loading"><span class="' + NS + '-spin"></span>正在生成…</div>';
    clearUsageChip();
    schedulePosition();
  }

  function renderStream() {
    ui.out.innerHTML = '<div class="' + NS + '-out-inner">' + renderLite(streamText) + '</div>';
    ui.out.scrollTop = ui.out.scrollHeight;
  }

  function renderFinal() {
    ui.out.innerHTML = '<div class="' + NS + '-out-inner">' + renderLite(streamText) + '</div>';
    schedulePosition();
  }

  function renderNote(text) {
    ui.out.innerHTML = '<div class="' + NS + '-ph">' + escapeHtml(text) + '</div>';
    schedulePosition();
  }

  function renderError(text, withSettings) {
    ui.out.innerHTML = '<div class="' + NS + '-err">' + escapeHtml(text)
      + (withSettings ? '<br><button type="button" data-act="settings">打开设置</button>' : '')
      + '</div>';
    schedulePosition();
  }

  function syncButtons() {
    if (!ui) return;
    const has = !!streamText && !busy;
    ui.fill.disabled = !has;
    ui.copy.disabled = !has;
    ui.again.disabled = busy || !lastRun;
    if (ui.stop) ui.stop.classList.toggle(NS + '-hide', !busy);
  }

  function fillToInput() {
    if (!streamText || busy) return;
    const ta = getReplyInput();
    if (!ta) { toast('没找到回复输入框，请先点开评论框'); return; }
    ta.focus();

    if (ta.isContentEditable) {
      // 富文本回复框：写入纯文本并派发 input，交给站点的编辑器同步
      ta.textContent = streamText;
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: streamText }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try {
        // 用原型上的 setter 写值，确保 Vue 的 v-model 能感知变化
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, streamText);
      } catch (e) {
        ta.value = streamText;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      try { ta.setSelectionRange(streamText.length, streamText.length); } catch (e) { /* 忽略 */ }
      ta.scrollTop = ta.scrollHeight;
    }

    toast('已填入回复框，请检查后再发送');
    closePanel();
  }

  function copyResult() {
    if (!streamText) return;
    navigator.clipboard.writeText(streamText)
      .then(() => toast('已复制到剪贴板'))
      .catch(() => toast('复制失败，请手动选择文本'));
  }

  function sendOpenOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'open-options' }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* 忽略 */ }
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = NS + '-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2000);
  }

  // ============================ 11. 生命周期 ============================

  let lastHref = location.href;

  function tick() {
    if (!document.body) return;

    if (location.href !== lastHref) {
      lastHref = location.href;
      if (open) closePanel();
    }

    if (!isPostPage()) {
      removeInlineTools();
      if (open) closePanel();
      return;
    }

    // 回复框工具栏入口（不依赖「AI 总结面板」开关，那个开关只管总结面板）
    ensureInlineTools();

    // 面板开着时同步草稿预览，避免用户改动输入框后预览过期
    if (open && activeTab === 'polish') refreshDraft();
  }

  /** 合并短时间内的多次触发，避免频繁扫描 DOM */
  let tickTimer = null;
  function scheduleTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(() => { tickTimer = null; tick(); }, 120);
  }

  function boot() {
    // 不能在非帖子页提前 return：站点是 SPA，从列表点进帖子时不会重新注入脚本，
    // 提前返回会让回帖助手一直处于休眠状态，只有刷新帖子页才恢复。
    document.documentElement.dataset.pcrr = '1';
    try { console.info('[Pickcat AI] 回帖助手已加载'); } catch (e) { /* 忽略 */ }
    loadConfig();
    // 先挂一次，之后交给看护轮询（站点评论区往往异步渲染）
    tick();
    setInterval(tick, 900);

    // 站点评论区与工具行会被异步渲染 / 反复重渲染。只靠 900ms 轮询可能错过
    // 输入框刚出现或刚被重建的窗口，这里在 DOM 变化时尽快补挂一次。
    try {
      const mo = new MutationObserver((records) => {
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) {
            scheduleTick();
            return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }

    // 滚动到评论区时站点才渲染输入框的情况：滚动后立即补挂
    document.addEventListener('scroll', scheduleTick, { passive: true, capture: true });
  }

  if (window.__pickscribeReplyLoaded) return;
  window.__pickscribeReplyLoaded = true;
  boot();
})();

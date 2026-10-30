/**
 * Pickcat AI 帖子总结助手 —— 内容脚本（命名空间 pcai）
 *
 * 仅在帖子详情页（/forum/post/<id>）工作：
 *   1. 常驻看护监听 SPA 路由，进入详情页且正文就绪后挂载面板；
 *   2. 面板插在「作者与帖子操作」头行之后（即分隔线下方、正文之前）；
 *   3. 提取正文 → 通过 Port 交给 Service Worker 调模型 → 流式渲染总结。
 *
 * 与编辑器模块（content.js / 命名空间 pcr）完全隔离，互不干扰。
 */
(() => {
  'use strict';

  // 扩展被重载 / 更新后，旧内容脚本里的异步 chrome.* 调用会以
  // "Extension context invalidated" 拒绝；这是预期内的噪音，直接吞掉。
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  const NS = 'pcai';
  const COLLAPSE_KEY = 'pcai_collapsed';   // 折叠状态（localStorage）
  const WIDTH_KEY = 'pcai_wide';           // 加宽状态（localStorage）：'1' 占满正文宽度
  const MAX_CHARS = 12000;                 // 正文截断上限（字符），避免超上下文
  const CACHE_PREFIX = 'sum:';

  // ============================ 0. 配置默认值（与 shared/constants.js 保持一致） ============================
  // 内容脚本是经典脚本、无法 import，这里内联一份只读默认值用于兜底合并。
  const DEFAULTS = {
    enabled: true,
    provider: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 1200,
    systemPrompt: '',
    userPrompt: '',
    lang: 'auto',
    length: 'medium',
    trigger: 'manual',
    minChars: 100,      // 自动总结最小字数门槛（低于此值跳过；0 不限制）
    stream: true
  };
  const DEFAULT_SYSTEM_PROMPT = '你是一个严谨的阅读助手。只依据用户提供的帖子内容作答，不要编造原文没有的信息。'
    + '所有回答都必须用 Markdown 排版：可用小标题（##）、要点列表（-）、**加粗**关键词；不要输出 HTML 或整段无格式纯文本。';
  const DEFAULT_USER_PROMPT =
    '请阅读下面的帖子，提炼它的核心信息，并直接用 Markdown 排版输出。{{lang}}{{length}}\n\n标题：{{title}}\n\n正文：\n{{content}}';
  const LENGTH_HINTS = {
    short: '控制在 3 行以内，只给结论。',
    medium: '用 5-8 条要点分点说明，重点突出。',
    long: '用不超过 12 条要点分点说明，可加小标题分节。'
  };
  const LANG_HINTS = { auto: '', zh: '请使用简体中文输出。', en: 'Please respond in English.' };
  const PROVIDER_NAMES = {
    deepseek: 'DeepSeek', doubao: '豆包', qwen: '通义千问', moonshot: 'Kimi',
    zhipu: '智谱 GLM', siliconflow: '硅基流动', openrouter: 'OpenRouter',
    ollama: '本地 Ollama', custom: '自定义'
  };

  // ============================ 1. 工具函数 ============================

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 轻量哈希（djb2）：用于缓存键，避免把整篇正文塞进键名 */
  function hash(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  const debounce = (fn, wait) => {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  };

  /** 统计正文字数（去掉空白字符），用于自动总结前的本地质检，不消耗任何模型调用 */
  const countChars = (text) => String(text || '').replace(/\s+/g, '').length;

  /**
   * 扩展上下文是否仍然有效。
   * 扩展被「重新加载 / 更新 / 停用」后，已注入到旧页面的内容脚本会被孤立，
   * 其 chrome.runtime 随之失效；此后任何 chrome.* 调用都会抛 “Extension context invalidated”。
   * 探测 chrome.runtime.id 是否还在，可据此提前收手，避免持续报错。
   */
  function extAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  /** 当前是否帖子详情页 */
  const isPostPage = () => /^\/forum\/post\/[^/]+/.test(location.pathname);

  /** 帖子 UUID（从 URL 提取，作为缓存键的一部分） */
  function getPostId() {
    const m = location.pathname.match(/\/forum\/post\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve({});
      try { chrome.storage.local.get(keys, resolve); } catch (e) { resolve({}); }
    });
  }

  // ============================ 2. 站点内容提取 ============================

  const SEL = {
    article: 'article.relative',
    header: 'div[aria-label="作者与帖子操作"]',
    body: '.markdown-body'
  };

  /**
   * 找面板挂载锚点（防御式降级）。
   * 返回 { mode:'after', el } —— 插在 el 之后；或 { mode:'before', el } —— 插在 el 之前。
   */
  function findAnchor() {
    const body = document.querySelector(SEL.body);

    // 优先级 1：实测存在的头行（含分隔线的 border-bottom）
    const head = document.querySelector(SEL.header);
    if (head && head.parentElement) return { mode: 'after', el: head };

    // 优先级 2：正文之前、同级里带 border-b + pb-4 的头行 div
    if (body && body.parentElement) {
      let p = body.previousElementSibling;
      while (p) {
        const cls = String(p.className || '');
        if (cls.includes('border-b')) return { mode: 'after', el: p };
        p = p.previousElementSibling;
      }
      // 优先级 3：直接插在正文之前
      return { mode: 'before', el: body };
    }

    // 优先级 4：文章根节点内的第一个正文之前
    const art = document.querySelector(SEL.article);
    if (art) {
      const b = art.querySelector(SEL.body);
      if (b) return { mode: 'before', el: b };
    }
    return null;
  }

  /** 提取标题 / 作者 / 正文 */
  function extractPost() {
    const art = document.querySelector(SEL.article) || document.body;
    const bodyEl = document.querySelector(SEL.body);

    let title = '';
    const h = art.querySelector('h1') || document.querySelector('h1');
    if (h) title = (h.innerText || '').trim();
    if (!title) title = document.title.split(/[|｜\-–—]/)[0].trim();

    let author = '';
    const head = document.querySelector(SEL.header);
    if (head) {
      const link = head.querySelector('a[href*="/profile/"]');
      if (link) author = (link.innerText || '').trim();
      if (!author) {
        const img = head.querySelector('img[alt]');
        if (img) author = (img.getAttribute('alt') || '').trim();
      }
    }

    const raw = bodyEl ? (bodyEl.innerText || '') : '';
    const content = raw.replace(/\n{3,}/g, '\n\n').trim();

    return { title, author, content, truncated: content.length > MAX_CHARS };
  }

  // ============================ 3. 提示词组装 ============================

  function buildMessages(config, post) {
    const content = post.content.length > MAX_CHARS
      ? post.content.slice(0, MAX_CHARS) + '\n……（正文过长，已截断）'
      : post.content;

    const tpl = (config.userPrompt || '').trim() || DEFAULT_USER_PROMPT;
    const user = tpl
      .replace(/\{\{lang\}\}/g, LANG_HINTS[config.lang] || '')
      .replace(/\{\{length\}\}/g, LENGTH_HINTS[config.length] || '')
      .replace(/\{\{title\}\}/g, post.title || '（无标题）')
      .replace(/\{\{author\}\}/g, post.author || '未知')
      .replace(/\{\{content\}\}/g, content);

    return [
      { role: 'system', content: (config.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: user }
    ];
  }

  /** 缓存键：帖子 + 模型 + 提示词哈希 */
  function cacheKeyOf(config, messages) {
    const payload = (config.model || '') + '|' + messages.map((m) => m.content).join('\n');
    return CACHE_PREFIX + getPostId() + ':' + hash(payload);
  }

  // ============================ 4. Markdown 轻量渲染 ============================
  // 覆盖模型输出常用的 Markdown 语法，输出受控 HTML（文本均已转义），不引入第三方库。

  /** 行内语法：行内代码 / 链接 / 加粗 / 斜体 */
  function renderInline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
  }

  /**
   * 轻量 Markdown 渲染：标题 / 有序无序列表（支持缩进嵌套）/ 引用 / 分割线 / 表格 /
   * 加粗 / 斜体 / 行内代码 / 链接 / 段落。
   */
  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const stack = [];   // 列表栈，元素为 { tag: 'ul'|'ol', indent: number }

    // 关闭缩进层级大于 indent 的列表；closeAll 用于空行/段落等需要收尾的场景
    const closeLists = (indent) => {
      while (stack.length && stack[stack.length - 1].indent > indent) {
        out.push('</' + stack.pop().tag + '>');
      }
    };
    const closeAll = () => closeLists(-1);

    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/.test(l);
    const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();

      // 空行：收尾所有列表
      if (!line.trim()) { closeAll(); continue; }

      // 分割线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeAll(); out.push('<hr>'); continue; }

      // 表格：当前行是 |…| 且下一行是分隔行
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        closeAll();
        const head = cellsOf(line);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && isRow(lines[j]); j++) rows.push(cellsOf(lines[j]));
        out.push('<table><thead><tr>' +
          head.map((c) => '<th>' + renderInline(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + renderInline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>');
        i = j - 1;
        continue;
      }

      // 标题（面板内不出现超大标题，因此整体降 2 级）
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeAll();
        const lv = Math.min(6, heading[1].length + 2);
        out.push('<h' + lv + '>' + renderInline(heading[2]) + '</h' + lv + '>');
        continue;
      }

      // 引用
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) { closeAll(); out.push('<blockquote>' + renderInline(quote[1]) + '</blockquote>'); continue; }

      // 列表（按行首缩进支持嵌套）
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
        out.push('<li>' + renderInline(item[3]) + '</li>');
        continue;
      }

      // 普通段落
      closeAll();
      out.push('<p>' + renderInline(line) + '</p>');
    }
    closeAll();
    return out.join('');
  }

  // ============================ 5. 样式注入 ============================

  const FALLBACK = {
    primary: '#fa322d', border: 'oklch(92.2% 0 none)', surface: '#ffffff',
    canvas: 'oklch(97% 0 none)', input: 'oklch(94.6% 0 none)',
    text: 'oklch(26.9% 0 none)', subtle: 'oklch(43.9% 0 none)',
    error: 'oklch(50.5% 0.213 27.5)'
  };

  function injectStyle() {
    if (document.getElementById(NS + '-style')) return;
    const css = `
:root{
  /* 直接映射站点实测的 Nuxt UI 设计令牌，深浅色随站点自动翻转；
     同时保留旧版 --ui-accent / --ui-surface 兜底，避免站点改版时样式丢失 */
  --pcai-primary: var(--ui-primary, var(--ui-accent, ${FALLBACK.primary}));
  --pcai-primary-soft: color-mix(in oklab, var(--pcai-primary) 12%, transparent);
  --pcai-border: var(--ui-border, ${FALLBACK.border});
  --pcai-surface: var(--ui-bg-elevated, var(--ui-surface, ${FALLBACK.surface}));
  --pcai-canvas: var(--ui-bg-muted, var(--ui-canvas, ${FALLBACK.canvas}));
  --pcai-input: var(--ui-bg-input, var(--ui-canvas, ${FALLBACK.input}));
  --pcai-text: var(--ui-text, var(--ui-foreground, ${FALLBACK.text}));
  --pcai-subtle: var(--ui-text-muted, var(--ui-muted, ${FALLBACK.subtle}));
  --pcai-error: var(--ui-error, ${FALLBACK.error});
  --pcai-hover: color-mix(in oklab, var(--pcai-text) 7%, transparent);
  --pcai-r: var(--ui-radius, .5rem);
  --pcai-rc: var(--ui-radius-sm, .375rem);
  --pcai-font: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
}
.${NS}-root{
  font-family: var(--pcai-font); color: var(--pcai-text);
  margin: 0 0 16px; font-size: 14px; line-height: 1.7;
  /* 默认限制可读宽度，避免总结在宽屏上横跨整行影响阅读 */
  max-width: 760px;
  animation: ${NS}-in .4s cubic-bezier(.22,1,.36,1) both;
}
.${NS}-root *{box-sizing:border-box;}
/* 加宽：占满正文宽度 */
.${NS}-root.${NS}-is-wide{max-width:100%;}
@media (max-width:820px){ .${NS}-root{max-width:100%;} }

/* 全屏：脱离正文流，居中浮层展示 */
.${NS}-root.${NS}-is-full{
  position:fixed; inset:0; z-index:2147483000;
  max-width:none; margin:0;
  display:flex; align-items:center; justify-content:center;
  padding:clamp(14px,3vw,40px);
  background:rgba(15,23,42,.38);
  -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
  animation:${NS}-full-in .3s cubic-bezier(.22,1,.36,1) both;
}
@keyframes ${NS}-full-in{from{opacity:0;}to{opacity:1;}}
.${NS}-root.${NS}-is-full > .${NS}-card{
  display:flex; flex-direction:column;
  width:min(1080px,100%); max-height:min(88vh,100%);
  box-shadow:0 30px 80px rgba(15,23,42,.28);
  animation:${NS}-full-card .42s cubic-bezier(.22,1,.36,1) both;
}
@keyframes ${NS}-full-card{from{opacity:0;transform:translateY(14px) scale(.98);}to{opacity:1;transform:none;}}
.${NS}-root.${NS}-is-full > .${NS}-card > .${NS}-head,
.${NS}-root.${NS}-is-full > .${NS}-card > .${NS}-tabs,
.${NS}-root.${NS}-is-full > .${NS}-card > .${NS}-foot{flex:none;}
.${NS}-root.${NS}-is-full > .${NS}-card > .${NS}-body{
  flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden;
}
.${NS}-root.${NS}-is-full .${NS}-pane{flex:1; min-height:0; overflow-y:auto;}
.${NS}-root.${NS}-is-full .${NS}-pane[data-pane="chat"]{display:flex;flex-direction:column;overflow:hidden;}
.${NS}-root.${NS}-is-full .${NS}-msgs{max-height:none; flex:1; overflow-y:auto;}
html.${NS}-lock,html.${NS}-lock body{overflow:hidden !important;}
@keyframes ${NS}-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
.${NS}-card{
  border:1px solid var(--pcai-border); border-radius:var(--pcai-r);
  background:var(--pcai-surface); overflow:hidden;
}
html.dark .${NS}-card{box-shadow:0 1px 2px rgba(0,0,0,.24);}
.${NS}-head{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 12px;border-bottom:1px solid var(--pcai-border);
}
.${NS}-head.is-plain{border-bottom:0;}
.${NS}-title{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:13px;}
.${NS}-title svg{width:16px;height:16px;color:var(--pcai-primary);}
.${NS}-model{
  font-weight:400;font-size:11px;color:var(--pcai-subtle);
  background:var(--pcai-canvas);border:1px solid var(--pcai-border);
  border-radius:999px;padding:1px 8px;
}
.${NS}-actions{display:flex;align-items:center;gap:2px;}
.${NS}-act{
  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border:0;background:transparent;color:var(--pcai-subtle);
  border-radius:var(--pcai-rc);cursor:pointer;
  transition:background .26s cubic-bezier(.22,1,.36,1),color .26s;
}
.${NS}-act svg{width:15px;height:15px;}
.${NS}-act:hover{background:var(--pcai-hover);color:var(--pcai-text);}
.${NS}-act.is-on{background:var(--pcai-primary-soft);color:var(--pcai-primary);}
.${NS}-act:disabled{opacity:.4;cursor:default;}
.${NS}-stop{color:var(--pcai-primary);}

.${NS}-body{padding:0;}

/* 内容区排版 */
.${NS}-content h3,.${NS}-content h4,.${NS}-content h5,.${NS}-content h6{
  margin:10px 0 4px;font-size:14px;font-weight:600;
}
.${NS}-content h3:first-child,.${NS}-content h4:first-child,.${NS}-content p:first-child,
.${NS}-content ul:first-child,.${NS}-content ol:first-child{margin-top:0;}
.${NS}-content p{margin:0 0 8px;white-space:pre-wrap;}
.${NS}-content ul,.${NS}-content ol{margin:0 0 8px;padding-left:20px;}
.${NS}-content li{margin:2px 0;}
.${NS}-content code{
  background:var(--pcai-canvas);border:1px solid var(--pcai-border);
  border-radius:var(--pcai-rc);padding:1px 5px;font-size:12.5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.${NS}-content strong{font-weight:600;color:var(--pcai-text);}
.${NS}-content a{color:var(--pcai-primary);text-decoration:none;border-bottom:1px solid transparent;transition:border-color .26s cubic-bezier(.22,1,.36,1);}
.${NS}-content a:hover{border-bottom-color:var(--pcai-primary);}
.${NS}-content hr{border:0;border-top:1px solid var(--pcai-border);margin:10px 0;}
.${NS}-content blockquote{
  margin:0 0 8px;padding:6px 10px;border-left:3px solid var(--pcai-primary);
  background:var(--pcai-canvas);border-radius:0 var(--pcai-rc) var(--pcai-rc) 0;color:var(--pcai-subtle);
}
.${NS}-content blockquote p{margin:0 0 4px;white-space:normal;}
.${NS}-content blockquote p:last-child{margin:0;}
.${NS}-content table{
  width:100%;border-collapse:collapse;margin:0 0 9px;font-size:13px;
  display:block;overflow-x:auto;
}
.${NS}-content th,.${NS}-content td{
  border:1px solid var(--pcai-border);padding:5px 8px;text-align:left;vertical-align:top;
}
.${NS}-content th{background:var(--pcai-canvas);font-weight:600;}

/* 光标：流式输出时闪烁 */
.${NS}-caret{display:inline-block;width:2px;height:1em;vertical-align:-2px;
  background:var(--pcai-primary);margin-left:2px;animation:${NS}-blink 1s steps(1) infinite;}
@keyframes ${NS}-blink{50%{opacity:0;}}

/* 待触发 / 加载 / 出错 */
.${NS}-cta{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
}
.${NS}-cta-text{color:var(--pcai-subtle);font-size:13px;}
.${NS}-btn{
  display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--pcai-border);background:var(--pcai-surface);color:var(--pcai-text);
  font:inherit;font-size:12.5px;padding:6px 14px;border-radius:var(--pcai-rc);cursor:pointer;
  transition:background .26s cubic-bezier(.22,1,.36,1),color .26s,border-color .26s;
}
.${NS}-btn svg{width:15px;height:15px;}
.${NS}-btn:hover{background:var(--pcai-hover);}
.${NS}-btn.is-primary{
  background:var(--pcai-primary);border-color:var(--pcai-primary);
  color:var(--ui-text-inverted, #fff);font-weight:500;
}
.${NS}-btn.is-primary:hover{filter:brightness(.94);}
.${NS}-btn:disabled{opacity:.55;cursor:default;}

.${NS}-loading{display:flex;align-items:center;gap:9px;color:var(--pcai-subtle);font-size:13px;}
.${NS}-spin{
  width:14px;height:14px;border-radius:50%;
  border:2px solid var(--pcai-primary-soft);border-top-color:var(--pcai-primary);
  animation:${NS}-rot .7s linear infinite;
}
@keyframes ${NS}-rot{to{transform:rotate(360deg);}}
.${NS}-err{font-size:13px;color:var(--pcai-text);}
.${NS}-err-tip{color:var(--pcai-subtle);font-size:12.5px;margin-top:4px;}
.${NS}-foot{
  padding:6px 12px 8px;font-size:11px;color:var(--pcai-subtle);
  display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.${NS}-foot-right{display:inline-flex;align-items:center;gap:6px;min-width:0;}
.${NS}-usage{
  display:inline-flex;align-items:center;gap:4px;
  padding:1px 7px;border:1px solid var(--pcai-border);border-radius:999px;
  background:var(--pcai-canvas);color:var(--pcai-subtle);
  font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.${NS}-usage:empty{display:none;}
.${NS}-usage.is-est{opacity:.86;}
.${NS}-hide{display:none !important;}

/* 分段 Tab：与站点 / 回帖助手一致的胶囊滑块 */
.${NS}-tabs{
  position:relative;display:flex;gap:4px;margin:8px 12px 0;
  padding:3px;border-radius:999px;background:var(--pcai-canvas);
}
.${NS}-ink{
  position:absolute;top:3px;bottom:3px;left:0;z-index:0;
  border-radius:999px;background:var(--pcai-surface);
  box-shadow:0 1px 3px rgba(15,23,42,.12);pointer-events:none;
  transition:left .32s cubic-bezier(.22,1,.36,1),width .32s cubic-bezier(.22,1,.36,1);
}
html.dark .${NS}-ink{box-shadow:0 1px 3px rgba(0,0,0,.4);}
.${NS}-tab{
  position:relative;z-index:1;flex:1;height:28px;
  border:0;background:transparent;color:var(--pcai-subtle);font:inherit;font-size:12.5px;
  border-radius:999px;cursor:pointer;transition:color .22s;
}
.${NS}-tab:hover{color:var(--pcai-text);}
.${NS}-tab.is-on{color:var(--pcai-text);font-weight:500;}

/* 两个内容面板：总结区与提问区 */
.${NS}-pane{padding:12px;}
.${NS}-pane[data-pane="chat"]{padding:0;display:flex;flex-direction:column;}
.${NS}-empty{padding:12px;color:var(--pcai-subtle);font-size:12.5px;line-height:1.7;}
.${NS}-asks{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 12px;}
.${NS}-ask{
  border:1px solid var(--pcai-border);background:var(--pcai-surface);color:var(--pcai-text);
  font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;
  transition:background .22s cubic-bezier(.22,1,.36,1),color .22s,border-color .22s;
}
.${NS}-ask:hover{background:var(--pcai-primary-soft);color:var(--pcai-primary);border-color:var(--pcai-primary);}
.${NS}-msgs{
  padding:12px 12px 2px;max-height:340px;overflow-y:auto;
  display:flex;flex-direction:column;gap:9px;
}
.${NS}-msg{display:flex;flex-direction:column;gap:3px;animation:${NS}-in .3s cubic-bezier(.22,1,.36,1) both;}
.${NS}-msg-role{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--pcai-subtle);}
.${NS}-msg-usage{font-variant-numeric:tabular-nums;opacity:.8;}
.${NS}-msg-body{padding:7px 10px;border-radius:var(--pcai-rc);font-size:13.5px;}
.${NS}-msg.is-user .${NS}-msg-body{background:var(--pcai-primary-soft);}
.${NS}-msg.is-ai .${NS}-msg-body{background:var(--pcai-canvas);}
.${NS}-msg.is-ai .${NS}-content p:last-child{margin-bottom:0;}
.${NS}-msg-err{color:var(--pcai-error);font-size:12.5px;}

/* 提问输入行 */
.${NS}-ask-row{
  display:flex;gap:8px;align-items:flex-end;
  padding:8px 12px 12px;border-top:1px solid var(--pcai-border);
}
.${NS}-q{
  flex:1;min-width:0;resize:none;overflow-y:auto;
  min-height:34px;max-height:110px;
  padding:7px 10px;border:1px solid var(--pcai-border);border-radius:var(--pcai-rc);
  background:var(--pcai-input);color:var(--pcai-text);
  font:inherit;font-size:13.5px;line-height:1.5;
  transition:border-color .26s cubic-bezier(.22,1,.36,1),box-shadow .26s cubic-bezier(.22,1,.36,1);
}
.${NS}-q:focus{outline:none;border-color:var(--pcai-primary);box-shadow:0 0 0 3px var(--pcai-primary-soft);}
.${NS}-q:disabled{opacity:.6;}
.${NS}-send{flex:none;padding:7px 12px;}
`;
    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================ 6. 图标 ============================

  const svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';

  const ICONS = {
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    redo: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
    collapse: svg('<path d="M6 9l6 6 6-6"/>'),
    widen: svg('<path d="M4 12h16"/><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>'),
    full: svg('<path d="M9 4H4v5"/><path d="M15 20h5v-5"/><path d="M9 20H4v-5"/><path d="M15 4h5v5"/>'),
    shrink: svg('<path d="M4 9h5V4"/><path d="M20 15h-5v5"/><path d="M4 15h5v5"/><path d="M20 9h-5V4"/>'),
    send: svg('<path d="M5 12h13"/><path d="M12 5l7 7-7 7"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>')
  };

  // ============================ 7. 状态 ============================

  let config = { ...DEFAULTS };
  let panel = null;         // 面板根节点
  let refs = null;          // 面板内节点引用
  let currentPostId = '';   // 当前已挂载的帖子 id
  let autoRanFor = '';      // 已自动总结过的帖子 id
  let shortSkip = null;     // 自动总结因字数不足被跳过的帖子 { pid, chars, min }
  let closedFor = '';       // 用户手动关闭的帖子 id（本页会话内不再显示）
  let reqId = null;         // 当前进行中的【总结】请求
  let streamText = '';      // 总结的流式累积文本

  // 展示尺寸：标准宽度（限宽）/ 加宽 / 全屏
  let isFull = false;                       // 全屏状态（仅本页会话，不持久化）
  let inlineParent = null;                  // 全屏前在正文中的父节点，退出时原位归还
  let inlineNext = null;                    // 全屏前的下一个兄弟节点

  // 提问（对话）状态
  let activeTab = 'sum';    // 'sum' 总结 | 'chat' 提问
  let chatMessages = [];    // 对话历史 [{ role:'user'|'ai', text, error }]
  let chatReqId = null;     // 当前进行中的【提问】请求
  let sessionUsage = { prompt: 0, completion: 0, total: 0, calls: 0 };   // 本页累计 Token

  // Port：与 Service Worker 的长连接（断线自动重连）
  let port = null;
  const pending = new Map();
  let seq = 0;

  function ensurePort() {
    if (port) return port;
    if (!extAlive()) return null;   // 扩展上下文已失效，无法再与后台通信
    try {
      port = chrome.runtime.connect({ name: 'pcai' });
    } catch (e) {
      port = null;                  // 连接失败（含上下文失效），交给调用方按错误处理
      return null;
    }
    port.onMessage.addListener((msg) => {
      const cb = pending.get(msg && msg.id);
      if (!cb) return;
      if (msg.type === 'chunk') { if (cb.onChunk) cb.onChunk(msg.delta); }
      else if (msg.type === 'done') { pending.delete(msg.id); if (cb.onDone) cb.onDone(msg); }
      else if (msg.type === 'error') { pending.delete(msg.id); if (cb.onError) cb.onError(msg); }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // 请求途中被断开：把未完成的回调统一转成错误，避免面板卡在「正在总结」
      pending.forEach((cb) => {
        if (cb.onError) cb.onError({ code: 'disconnect', message: '后台连接已断开，请重试' });
      });
      pending.clear();
      reqId = null;
    });
    return port;
  }

  function requestSummary({ messages, cacheKey, bypass, onChunk, onDone, onError }) {
    const id = 'r' + (++seq);
    const p = ensurePort();
    if (!p) {
      onError({ code: 'context', message: '扩展已更新或已停用，请刷新页面后再试' });
      return id;
    }
    pending.set(id, { onChunk, onDone, onError });
    try {
      p.postMessage({ type: 'start', id, messages, cacheKey, bypass });
    } catch (e) {
      pending.delete(id);
      onError({ code: 'port', message: '后台连接失败，请重新加载页面后再试' });
    }
    return id;
  }

  function abortCurrent() {
    if (reqId && port) {
      try { port.postMessage({ type: 'abort', id: reqId }); } catch (_) { /* 忽略 */ }
    }
    if (reqId) pending.delete(reqId);
    reqId = null;
  }

  // ============================ 8. 面板 UI ============================

  const collapsed = () => localStorage.getItem(COLLAPSE_KEY) === '1';

  function buildPanel() {
    const root = document.createElement('div');
    root.className = NS + '-root';
    root.id = NS + '-panel';

    root.innerHTML =
      '<div class="' + NS + '-card">' +
        '<div class="' + NS + '-head">' +
          '<div class="' + NS + '-title">' + ICONS.spark +
            '<span>AI 助手</span><span class="' + NS + '-model"></span>' +
          '</div>' +
          '<div class="' + NS + '-actions">' +
            '<button class="' + NS + '-act ' + NS + '-stop ' + NS + '-hide" data-act="stop" title="停止生成">' + ICONS.stop + '</button>' +
            '<button class="' + NS + '-act" data-act="copy" title="复制 Markdown">' + ICONS.copy + '</button>' +
            '<button class="' + NS + '-act" data-act="redo" title="重新总结（忽略缓存）">' + ICONS.redo + '</button>' +
            '<button class="' + NS + '-act" data-act="width" title="加宽显示">' + ICONS.widen + '</button>' +
            '<button class="' + NS + '-act" data-act="full" title="全屏查看">' + ICONS.full + '</button>' +
            '<button class="' + NS + '-act" data-act="fold" title="折叠 / 展开">' + ICONS.collapse + '</button>' +
            '<button class="' + NS + '-act" data-act="close" title="关闭（本页不再显示）">' + ICONS.close + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="' + NS + '-tabs" role="tablist">' +
          '<span class="' + NS + '-ink"></span>' +
          '<button class="' + NS + '-tab is-on" role="tab" data-tab="sum">总结</button>' +
          '<button class="' + NS + '-tab" role="tab" data-tab="chat">提问</button>' +
        '</div>' +
        '<div class="' + NS + '-body">' +
          '<div class="' + NS + '-pane" data-pane="sum"></div>' +
          '<div class="' + NS + '-pane ' + NS + '-hide" data-pane="chat"></div>' +
        '</div>' +
        '<div class="' + NS + '-foot">' +
          '<span class="' + NS + '-foot-left">由 AI 生成，仅供参考</span>' +
          '<span class="' + NS + '-foot-right">' +
            '<span class="' + NS + '-usage"></span>' +
            '<span class="' + NS + '-provider"></span>' +
          '</span>' +
        '</div>' +
      '</div>';

    refs = {
      head: root.querySelector('.' + NS + '-head'),
      body: root.querySelector('.' + NS + '-body'),
      tabsRow: root.querySelector('.' + NS + '-tabs'),
      ink: root.querySelector('.' + NS + '-ink'),
      foot: root.querySelector('.' + NS + '-foot'),
      model: root.querySelector('.' + NS + '-model'),
      usage: root.querySelector('.' + NS + '-usage'),
      provider: root.querySelector('.' + NS + '-provider'),
      tabs: Array.from(root.querySelectorAll('[data-tab]')),
      paneSum: root.querySelector('[data-pane="sum"]'),
      paneChat: root.querySelector('[data-pane="chat"]'),
      stopBtn: root.querySelector('[data-act="stop"]'),
      copyBtn: root.querySelector('[data-act="copy"]'),
      redoBtn: root.querySelector('[data-act="redo"]'),
      widthBtn: root.querySelector('[data-act="width"]'),
      fullBtn: root.querySelector('[data-act="full"]'),
      foldBtn: root.querySelector('[data-act="fold"]')
    };

    syncPanelInfo();

    // 折叠状态回填（折叠时把 Tab 行、内容区、底栏一起收起）
    refs.body.classList.toggle(NS + '-hide', collapsed());
    refs.tabsRow.classList.toggle(NS + '-hide', collapsed());
    refs.head.classList.toggle('is-plain', collapsed());
    refs.foot.classList.toggle(NS + '-hide', collapsed());
    refs.foldBtn.style.transform = collapsed() ? 'rotate(180deg)' : '';

    // 事件：Tab 切换与工具按钮统一在根节点上代理
    root.addEventListener('click', (e) => {
      // 全屏时点击卡片外的遮罩区域退出
      if (isFull && e.target === root) return exitFull();

      const ask = e.target.closest('[data-ask]');
      if (ask) return askQuestion(ask.getAttribute('data-ask'));

      const tab = e.target.closest('[data-tab]');
      if (tab) return switchTab(tab.getAttribute('data-tab'));

      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'copy') return copyCurrent();
      if (act === 'redo') return runSummary({ bypass: true });
      if (act === 'width') return toggleWidth();
      if (act === 'full') return isFull ? exitFull() : enterFull();
      if (act === 'fold') return toggleFold();
      if (act === 'close') return closePanel();
      if (act === 'stop') return stopActive();
    });

    return root;
  }

  /** 加宽状态：持久化到 localStorage，跨帖子沿用 */
  const wide = () => localStorage.getItem(WIDTH_KEY) === '1';

  /** Tab 胶囊滑块：跟随当前激活的 Tab 定位（与站点分段控件同款） */
  function moveInk(animate) {
    if (!refs || !refs.ink) return;
    const btn = refs.tabs.find((b) => b.getAttribute('data-tab') === activeTab);
    if (!btn) return;
    if (!animate) refs.ink.style.transition = 'none';
    refs.ink.style.left = btn.offsetLeft + 'px';
    refs.ink.style.width = btn.offsetWidth + 'px';
    if (!animate) {
      void refs.ink.offsetWidth;
      refs.ink.style.transition = '';
    }
  }

  /** 把当前宽度 / 全屏状态同步到 DOM 与按钮 */
  function applyMode() {
    if (!panel) return;
    const w = wide();
    panel.classList.toggle(NS + '-is-wide', w);
    panel.classList.toggle(NS + '-is-full', isFull);

    const root = document.documentElement;
    root.classList.toggle(NS + '-lock', isFull);

    if (refs) {
      refs.widthBtn.classList.toggle('is-on', w);
      refs.widthBtn.title = w ? '恢复标准宽度' : '加宽显示';
      refs.fullBtn.classList.toggle('is-on', isFull);
      refs.fullBtn.innerHTML = isFull ? ICONS.shrink : ICONS.full;
      refs.fullBtn.title = isFull ? '退出全屏（Esc）' : '全屏查看';
    }
    requestAnimationFrame(() => moveInk(false));
  }

  function toggleWidth() {
    localStorage.setItem(WIDTH_KEY, wide() ? '0' : '1');
    applyMode();
  }

  /** 进入全屏：把面板移到 body 下，避免被正文容器裁切或层叠上下文限制 */
  function enterFull() {
    if (!panel || isFull) return;
    inlineParent = panel.parentElement;
    inlineNext = panel.nextElementSibling;
    document.body.appendChild(panel);
    isFull = true;
    document.addEventListener('keydown', onFullKey, true);
    applyMode();
  }

  /** 退出全屏：优先按原位置归还，原位失效时回退到当前锚点 */
  function exitFull(restore) {
    if (!isFull) return;
    isFull = false;
    document.removeEventListener('keydown', onFullKey, true);

    if (restore !== false && panel) {
      if (inlineParent && inlineParent.isConnected) {
        if (inlineNext && inlineNext.parentNode === inlineParent) {
          inlineParent.insertBefore(panel, inlineNext);
        } else {
          inlineParent.appendChild(panel);
        }
      } else {
        const anchor = findAnchor();
        if (anchor && anchor.el && anchor.el.parentElement) {
          if (anchor.mode === 'after') anchor.el.parentElement.insertBefore(panel, anchor.el.nextSibling);
          else anchor.el.parentElement.insertBefore(panel, anchor.el);
        }
      }
    }
    inlineParent = null;
    inlineNext = null;
    applyMode();
  }

  /** 全屏下的键盘处理：Esc 退出，并拦截站点可能绑定的同键快捷键 */
  function onFullKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitFull();
    }
  }

  function toggleFold() {
    const next = !collapsed();
    // 全屏下折叠会只剩一个标题条，先退回正文流
    if (next && isFull) exitFull();
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    if (!refs) return;
    refs.body.classList.toggle(NS + '-hide', next);
    refs.tabsRow.classList.toggle(NS + '-hide', next);
    refs.head.classList.toggle('is-plain', next);
    refs.foot.classList.toggle(NS + '-hide', next);
    refs.foldBtn.style.transform = next ? 'rotate(180deg)' : '';
    // 展开后 Tab 才有实际宽度，补一次滑块定位
    if (!next) requestAnimationFrame(() => moveInk(false));
  }

  function removePanel() {
    abortCurrent();
    abortChat();
    exitFull(false);   // 若在全屏中：清滚动锁与 Esc 监听，不还原位置
    if (panel && panel.parentElement) panel.parentElement.removeChild(panel);
    panel = null;
    refs = null;
  }

  function closePanel() {
    closedFor = currentPostId;
    removePanel();
  }

  /** 配置变化后同步面板上展示的模型名与服务商（不要覆盖同一行的 Token 胶囊） */
  function syncPanelInfo() {
    if (!refs) return;
    refs.model.textContent = config.model || '';
    if (refs.provider) refs.provider.textContent = PROVIDER_NAMES[config.provider] || '';
  }

  // —— Token 用量展示 ——

  /** 千分位缩写：1234 → 1.2k；只用于窄容器里的概览，详情放 Tooltip */
  function fmtToken(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  /** 累计本页会话用量（缓存命中不计入） */
  function addSessionUsage(u) {
    if (!u) return;
    sessionUsage.prompt += Number(u.prompt) || 0;
    sessionUsage.completion += Number(u.completion) || 0;
    sessionUsage.total += Number(u.total) || 0;
    sessionUsage.calls += 1;
  }

  /** 底栏 Token 胶囊：本次用量 + 本页累计（详情见 Tooltip） */
  function setUsage(u, cached) {
    if (!refs || !refs.usage) return;
    if (cached) {
      refs.usage.textContent = '缓存命中 · 0 Token';
      refs.usage.classList.remove('is-est');
      refs.usage.title = '本次结果来自本地缓存，没有调用模型，不消耗 Token';
      return;
    }
    if (!u || !u.total) { clearUsageChip(); return; }

    const est = !!u.estimated;
    refs.usage.textContent =
      (est ? '≈' : '') + '↑' + fmtToken(u.prompt) + ' ↓' + fmtToken(u.completion) + ' · ' + fmtToken(u.total);
    refs.usage.classList.toggle('is-est', est);

    const lines = [
      est
        ? '服务商未返回 usage，以下为本地估算值（按字符数折算）'
        : '本次用量（服务商返回）',
      '输入 ' + u.prompt + ' Tokens',
      '输出 ' + u.completion + ' Tokens',
      '合计 ' + u.total + ' Tokens'
    ];
    if (sessionUsage.calls) {
      lines.push('', '本页累计：' + sessionUsage.calls + ' 次请求 · ' + sessionUsage.total + ' Tokens');
    }
    refs.usage.title = lines.join('\n');
  }

  function clearUsageChip() {
    if (!refs || !refs.usage) return;
    refs.usage.textContent = '';
    refs.usage.classList.remove('is-est');
    refs.usage.title = '';
  }

  /** 停止当前生成：总结请求中断后保留已生成片段，提问请求保留已输出内容 */
  function stopActive() {
    if (reqId) {
      abortCurrent();
      if (streamText) {
        renderDone(streamText, false);
        if (refs) refs.foot.querySelector('.' + NS + '-foot-left').textContent = '已停止生成 · 仅供参考';
      } else {
        renderIdle('已停止生成，可重新开始总结。');
      }
      toast('已停止生成');
    } else if (chatReqId) {
      abortChat();
      const a = chatMessages[chatMessages.length - 1];
      if (a && a.role === 'ai') {
        a.stopped = true;
        if (!a.text) a.error = '已停止生成。';
      }
      renderChatMsgs();
      scrollChatBottom();
      toast('已停止生成');
    }
    syncButtons();
  }

  /** 复制按钮：总结 Tab 复制总结，提问 Tab 复制最后一条回答 */
  function copyCurrent() {
    const text = activeTab === 'chat'
      ? (lastAiText() || '')
      : (streamText || '');
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      toast('已复制到剪贴板');
    }).catch(() => {
      toast('复制失败，请手动选择文本');
    });
  }

  /** 最后一条有内容的 AI 回答 */
  function lastAiText() {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.role === 'ai' && m.text) return m.text;
    }
    return '';
  }

  /** 按当前 Tab 同步顶部工具按钮的可用状态 */
  function syncButtons() {
    if (!refs) return;
    const busy = !!reqId || !!chatReqId;
    refs.redoBtn.disabled = activeTab !== 'sum' || busy;
    refs.copyBtn.disabled = activeTab === 'sum' ? !streamText : !lastAiText();
    if (refs.stopBtn) refs.stopBtn.classList.toggle(NS + '-hide', !busy);
  }

  function toast(msg) {
    const old = document.getElementById(NS + '-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = NS + '-toast';
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(8px);' +
      'background:var(--pcai-text);color:var(--pcai-surface);padding:7px 16px;border-radius:999px;' +
      'font-size:13px;z-index:2147483000;opacity:0;transition:opacity .32s cubic-bezier(.22,1,.36,1),' +
      'transform .32s cubic-bezier(.22,1,.36,1);font-family:var(--pcai-font);';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(8px)';
      setTimeout(() => el.remove(), 400);
    }, 1600);
  }

  // ============================ 9. 面板状态机 ============================

  /** 自动总结因字数不足被跳过时的提示文案 */
  const shortSkipNote = (chars, min) =>
    '这篇帖子约 ' + chars + ' 字，低于自动总结门槛（' + min + ' 字），已跳过；仍可手动总结。';

  function renderIdle(note) {
    if (!refs) return;
    // 注意：这里不动 -hide 类，保留用户上次的折叠状态
    refs.paneSum.classList.add(NS + '-is-empty');
    const text = note || '点一下，让 AI 把这篇帖子读成要点；也可以切到「提问」直接追问';
    refs.paneSum.innerHTML =
      '<div class="' + NS + '-cta">' +
        '<span class="' + NS + '-cta-text">' + escapeHtml(text) + '</span>' +
        '<button class="' + NS + '-btn is-primary" data-run="1">' + ICONS.spark + '开始总结</button>' +
      '</div>';
    refs.paneSum.querySelector('[data-run]').addEventListener('click', () => runSummary({}));
    clearUsageChip();
    syncButtons();
  }

  function renderLoading(cachedHint) {
    if (!refs) return;
    refs.paneSum.classList.remove(NS + '-is-empty');
    refs.paneSum.innerHTML =
      '<div class="' + NS + '-loading"><span class="' + NS + '-spin"></span>' +
      '<span>' + (cachedHint ? '读取缓存…' : '正在阅读并总结…') + '</span></div>';
    clearUsageChip();
    syncButtons();
  }

  function renderStream() {
    if (!refs) return;
    refs.paneSum.classList.remove(NS + '-is-empty');
    refs.paneSum.innerHTML =
      '<div class="' + NS + '-content">' + renderMarkdown(streamText) + '<span class="' + NS + '-caret"></span></div>';
    syncButtons();
  }

  function renderDone(text, cached) {
    if (!refs) return;
    streamText = text;
    refs.paneSum.classList.remove(NS + '-is-empty');
    refs.paneSum.innerHTML = '<div class="' + NS + '-content">' + renderMarkdown(text) + '</div>';
    refs.foot.querySelector('.' + NS + '-foot-left').textContent =
      cached ? '来自本地缓存 · 仅供参考' : '由 AI 生成 · 仅供参考';
    syncButtons();
  }

  function renderError(msg) {
    if (!refs) return;
    refs.paneSum.classList.remove(NS + '-is-empty');
    refs.paneSum.innerHTML =
      '<div class="' + NS + '-err">' +
        '<div>' + escapeHtml(msg) + '</div>' +
        '<div class="' + NS + '-err-tip">可在扩展设置里检查模型配置，或稍后重试。</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;">' +
          '<button class="' + NS + '-btn" data-run="1">重试</button>' +
          '<button class="' + NS + '-btn" data-open-settings="1">打开设置</button>' +
        '</div>' +
      '</div>';
    refs.paneSum.querySelector('[data-run]').addEventListener('click', () => runSummary({ bypass: true }));
    refs.paneSum.querySelector('[data-open-settings]').addEventListener('click', () => {
      // 回调形式，避免扩展重载后 sendMessage 返回的 Promise 触发未处理 rejection
      try { chrome.runtime.sendMessage({ type: 'open-options' }, () => { void chrome.runtime.lastError; }); }
      catch (e) { /* 上下文失效忽略 */ }
    });
    clearUsageChip();
    syncButtons();
  }

  // ============================ 9.5 提问（对话） ============================

  /** 切换 Tab：总结 / 提问 */
  function switchTab(tab) {
    activeTab = tab === 'chat' ? 'chat' : 'sum';
    applyTab();
    moveInk(true);
    if (activeTab === 'chat') {
      ensureChatDom();
      renderChatMsgs();
      const ta = refs.paneChat.querySelector('.' + NS + '-q');
      if (ta && !ta.disabled) ta.focus();
    }
  }

  /** 按当前 Tab 切换显示与按钮状态 */
  function applyTab() {
    if (!refs) return;
    refs.tabs.forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-tab') === activeTab));
    refs.paneSum.classList.toggle(NS + '-hide', activeTab !== 'sum');
    refs.paneChat.classList.toggle(NS + '-hide', activeTab !== 'chat');
    syncButtons();
  }

  /** 提问区 DOM 只建一次，之后只刷新消息列表（避免输入框失焦、已输入内容丢失） */
  function ensureChatDom() {
    if (!refs || refs.paneChat.dataset.ready === '1') return;
    refs.paneChat.dataset.ready = '1';
    refs.paneChat.innerHTML =
      '<div class="' + NS + '-msgs"></div>' +
      '<div class="' + NS + '-ask-row">' +
        '<textarea class="' + NS + '-q" rows="1" placeholder="就这篇帖子提问，回车发送，Shift+回车换行"></textarea>' +
        '<button class="' + NS + '-btn is-primary ' + NS + '-send" title="发送">' + ICONS.send + '</button>' +
      '</div>';

    const ta = refs.paneChat.querySelector('.' + NS + '-q');
    const send = () => submitQuestion();
    refs.paneChat.querySelector('.' + NS + '-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    ta.addEventListener('input', () => autoGrow(ta));
  }

  /** 输入框随内容长高（上限 110px） */
  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(110, ta.scrollHeight) + 'px';
  }

  /** 渲染消息列表 */
  function renderChatMsgs() {
    if (!refs) return;
    const box = refs.paneChat.querySelector('.' + NS + '-msgs');
    if (!box) return;

    if (!chatMessages.length) {
      const asks = [
        '这篇帖子的核心结论是什么？',
        '帮我提炼 3 个关键要点',
        '作者给出的依据有哪些？'
      ];
      box.innerHTML =
        '<div class="' + NS + '-empty">还没有提问。AI 会结合这篇帖子的内容回答，并支持连续追问。</div>' +
        '<div class="' + NS + '-asks">' +
          asks.map((q) => '<button class="' + NS + '-ask" data-ask="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('') +
        '</div>';
      syncButtons();
      return;
    }

    box.innerHTML = chatMessages.map((m, i) => {
      const isUser = m.role === 'user';
      const last = i === chatMessages.length - 1;
      let body;
      if (isUser) {
        body = '<div class="' + NS + '-msg-body">' + escapeHtml(m.text).replace(/\n/g, '<br>') + '</div>';
      } else if (m.error) {
        body = '<div class="' + NS + '-msg-err">' + escapeHtml(m.error) + '</div>';
      } else if (!m.text && last && chatReqId) {
        body = '<div class="' + NS + '-loading"><span class="' + NS + '-spin"></span><span>思考中…</span></div>';
      } else {
        body = '<div class="' + NS + '-msg-body"><div class="' + NS + '-content">' + renderMarkdown(m.text) +
          (last && chatReqId ? '<span class="' + NS + '-caret"></span>' : '') + '</div></div>';
      }

      let role = isUser ? '你' : 'AI';
      if (!isUser && m.usage) {
        role += '<span class="' + NS + '-msg-usage">' +
          (m.usage.estimated ? '≈' : '') + '↑' + fmtToken(m.usage.prompt) + ' ↓' + fmtToken(m.usage.completion) +
          '</span>';
      }
      if (!isUser && m.stopped) role += '<span class="' + NS + '-msg-usage">已停止</span>';

      return '<div class="' + NS + '-msg ' + (isUser ? 'is-user' : 'is-ai') + '">' +
        '<span class="' + NS + '-msg-role">' + role + '</span>' + body + '</div>';
    }).join('');

    syncButtons();
  }

  function scrollChatBottom() {
    if (!refs) return;
    const box = refs.paneChat.querySelector('.' + NS + '-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  const scheduleChat = debounce(() => { renderChatMsgs(); scrollChatBottom(); }, 80);

  /** 提交输入框里的问题 */
  function submitQuestion() {
    if (!refs) return;
    const ta = refs.paneChat.querySelector('.' + NS + '-q');
    if (!ta) return;
    const q = (ta.value || '').trim();
    if (!q) return;
    ta.value = '';
    autoGrow(ta);
    askQuestion(q);
  }

  /** 组装提问消息：每轮都带上帖子正文做依据，附上最近若干轮对话 */
  function buildChatMessages(config, post, history) {
    const content = post.content.length > MAX_CHARS
      ? post.content.slice(0, MAX_CHARS) + '\n……（正文过长，已截断）'
      : post.content;

    const system = ((config.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT) +
      '\n你会拿到一篇帖子的内容，请只依据它回答用户的问题；' +
      '如果帖子中没有相关信息，请如实说明，不要编造。回答同样使用 Markdown 排版。' +
      (LANG_HINTS[config.lang] || '');

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: '这是帖子内容，供你参考：\n\n标题：' + (post.title || '（无标题）') + '\n\n' + content },
      { role: 'assistant', content: '好的，我已读完这篇帖子，请提问。' }
    ];

    // 只带最近 6 轮（12 条），控制上下文长度
    history.slice(-12).forEach((m) => {
      if (m.role === 'user') messages.push({ role: 'user', content: m.text });
      else if (m.text) messages.push({ role: 'assistant', content: m.text });
    });
    return messages;
  }

  /** 向模型提问（不写缓存，每次都是新问题） */
  function askQuestion(q) {
    if (!refs) return;
    if (collapsed()) toggleFold();

    const post = extractPost();
    chatMessages.push({ role: 'user', text: q });
    const answer = { role: 'ai', text: '' };
    chatMessages.push(answer);

    if (!post.content) {
      answer.error = '没有读到帖子正文，稍等页面渲染完再试。';
      renderChatMsgs();
      return;
    }
    if (!config.apiKey && config.provider !== 'ollama') {
      answer.error = '还没有配置 API Key，请先在扩展设置里填写。';
      renderChatMsgs();
      return;
    }

    renderChatMsgs();
    scrollChatBottom();

    abortChat();
    chatReqId = requestSummary({
      messages: buildChatMessages(config, post, chatMessages),
      cacheKey: null,
      bypass: true,
      onChunk(delta) {
        answer.text += delta;
        if (activeTab === 'chat') scheduleChat();
      },
      onDone(msg) {
        chatReqId = null;
        answer.text = msg.text || answer.text;
        if (msg.usage) {
          answer.usage = msg.usage;
          addSessionUsage(msg.usage);
          setUsage(msg.usage, false);
        }
        renderChatMsgs();
        scrollChatBottom();
      },
      onError(err) {
        chatReqId = null;
        answer.error = err && err.message ? err.message : '回答失败，请稍后重试';
        renderChatMsgs();
        scrollChatBottom();
        syncButtons();
      }
    });
  }

  function abortChat() {
    if (chatReqId && port) {
      try { port.postMessage({ type: 'abort', id: chatReqId }); } catch (_) { /* 忽略 */ }
    }
    if (chatReqId) pending.delete(chatReqId);
    chatReqId = null;
  }

  // ============================ 10. 主流程 ============================

  async function runSummary({ bypass = false } = {}) {
    if (!refs) return;
    if (collapsed()) toggleFold();
    const post = extractPost();
    if (!post.content) {
      renderError('没有读到帖子正文，可能是页面还没渲染完，稍等片刻再试。');
      return;
    }
    if (!config.apiKey && config.provider !== 'ollama') {
      renderError('还没有配置 API Key，请先在扩展设置里填写所选服务商的密钥。');
      return;
    }

    const messages = buildMessages(config, post);
    const cacheKey = cacheKeyOf(config, messages);

    abortCurrent();
    streamText = '';
    renderLoading(!bypass);

    reqId = requestSummary({
      messages,
      cacheKey,
      bypass,
      onChunk(delta) {
        streamText += delta;
        scheduleStream();
      },
      onDone(msg) {
        reqId = null;
        if (msg.usage) addSessionUsage(msg.usage);
        setUsage(msg.usage || null, !!msg.cached);
        renderDone(msg.text || streamText, !!msg.cached);
      },
      onError(err) {
        reqId = null;
        renderError(err && err.message ? err.message : '总结失败，请稍后重试');
      }
    });
    syncButtons();
  }

  const scheduleStream = debounce(() => { renderStream(); }, 80);

  // ============================ 11. 挂载与 SPA 看护 ============================

  /** 正文是否已就绪（避免在 SPA 异步渲染完成前提取到空内容） */
  function contentReady() {
    const el = document.querySelector(SEL.body);
    return !!(el && (el.innerText || '').trim().length > 20);
  }

  function mount() {
    if (!isPostPage() || !config.enabled) return;
    const pid = getPostId();
    if (!pid || pid === closedFor) return;
    if (!contentReady()) return;

    injectStyle();

    const alive = panel && document.body.contains(panel);
    if (alive && pid === currentPostId) {
      // 面板健在：仅同步模型名
      syncPanelInfo();
      return;
    }

    // 帖子切换 / 面板被站点重渲染冲掉 → 重建
    if (pid !== currentPostId) shortSkip = null;
    removePanel();
    currentPostId = pid;
    streamText = '';
    chatMessages = [];
    const anchor = findAnchor();
    if (!anchor || !anchor.el || !anchor.el.parentElement) return;

    panel = buildPanel();
    if (anchor.mode === 'after') {
      anchor.el.parentElement.insertBefore(panel, anchor.el.nextSibling);
    } else {
      anchor.el.parentElement.insertBefore(panel, anchor.el);
    }
    applyMode();   // 回填上次选择的宽度（全屏不跨帖子保留）

    // 若本篇曾因字数不足被跳过，重建后仍展示同一条提示
    renderIdle(shortSkip && shortSkip.pid === pid ? shortSkipNote(shortSkip.chars, shortSkip.min) : undefined);
    applyTab();
    if (activeTab === 'chat') { ensureChatDom(); renderChatMsgs(); }

    // 自动模式：每篇帖子只自动跑一次
    if (config.trigger === 'auto' && autoRanFor !== pid) {
      autoRanFor = pid;
      // 自动总结前先做本地质检（不调用模型）：正文过短视为低质量内容，直接跳过，省 token
      const chars = countChars(extractPost().content);
      const min = Number(config.minChars) || 0;
      if (min > 0 && chars < min) {
        shortSkip = { pid: pid, chars: chars, min: min };
        renderIdle(shortSkipNote(chars, min));
        return;
      }
      runSummary({});
    }
  }

  function unmountIfNeeded() {
    if (isPostPage()) return;
    removePanel();
    currentPostId = '';
  }

  // ============================ 12. 启动 ============================

  (async () => {
    const raw = await storageGet(['pcai_config']);
    if (!extAlive()) return;           // 上下文已失效（扩展刚被重载）：不再启动
    config = { ...DEFAULTS, ...(raw.pcai_config || {}) };

    // 配置变化（在设置页 / 弹窗改动后即时生效）
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.pcai_config) return;
        config = { ...DEFAULTS, ...(changes.pcai_config.newValue || {}) };
        syncPanelInfo();
        if (config.enabled) mount();
        else unmountIfNeeded();
      });
    } catch (e) { /* 上下文失效忽略 */ }

    // 常驻看护：SPA 路由变化 / 面板被站点重渲染冲掉 / 正文晚到
    let lastHref = location.href;
    const timer = setInterval(() => {
      // 扩展被重新加载 / 更新 / 停用：清理面板并停止看护，避免持续抛错
      if (!extAlive()) { clearInterval(timer); removePanel(); return; }
      if (location.href !== lastHref) {
        lastHref = location.href;
        abortCurrent();
      }
      unmountIfNeeded();
      if (!panel || !document.body.contains(panel)) mount();
    }, 600);

    // 配置就绪后首次尝试（避免用默认值先渲染出错的服务商名）
    if (config.enabled) mount();
  })();

  // 调试句柄（不影响站点）
  window.__pickcatAi = {
    get config() { return config; },
    mount,
    runSummary,
    extractPost
  };
})();

/* PickScribe 浮层富文本编辑器
 * 评论回复框的「所见即所得」内核：contenteditable 与 Markdown 双向转换。
 * 只服务浮层，不依赖站点编辑器，避免与帖子编辑页的 pcr 面板互相干扰。
 */
(function () {
  'use strict';

  const NS = 'pco-ed';

  // ============================ 基础工具 ============================

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /** 只允许 http(s)、站内相对路径与 // 开头的地址，挡掉 javascript: 等危险协议 */
  function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^(?:javascript|data|vbscript):/i.test(s)) return '';
    if (/^\/\//.test(s)) return 'https:' + s;
    return s;
  }

  /** 把 rgb()/rgba() 颜色统一成 #rrggbb，透明色返回空 */
  function normColor(c) {
    const s = String(c || '').trim();
    if (!s) return '';
    if (s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return '';
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!m) return s;
    if (m[4] != null && parseFloat(m[4]) === 0) return '';
    const hex = '#' + [m[1], m[2], m[3]]
      .map((n) => ('0' + Math.max(0, Math.min(255, parseInt(n, 10))).toString(16)).slice(-2))
      .join('');
    return hex;
  }

  // ============================ Markdown → HTML ============================

  /** 行内 Markdown：先保护原始 HTML / 代码 / 公式 / 站点引用，再转义与替换 */
  function inlineMd(text, opts) {
    const stash = [];
    const keep = (html) => {
      stash.push(html);
      return '\u0000' + (stash.length - 1) + '\u0000';
    };
    const mentionName = (opts && opts.getMentionName) || (() => '');

    let s = String(text == null ? '' : text);

    // 1) 保护已有行内 HTML 标签
    s = s.replace(/<\/?(?:span|u|mark|sub|sup|br|a|em|strong|b|i|s|del|code|kbd|font|img)\b[^>]*>/gi,
      (m) => keep(m));

    // 2) 行内代码
    s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + escapeHtml(c) + '</code>'));

    // 3) 行内公式 $...$（尽量避开「$5 和 $10」这类普通金额）
    s = s.replace(/\$(?!\s)([^\$\n]*?[^\s\$])\$(?!\d)/g,
      (m, tex) => keep('<span class="' + NS + '-math-inline">' + escapeHtml(tex) + '</span>'));

    // 4) 还原反斜杠转义
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

    // 5) 站点 @ 提及：@{uuid}
    s = s.replace(/@\{([0-9a-fA-F-]{8,})\}/g, (m, id) => {
      const name = mentionName(id) || id;
      return keep('<span class="markdown-user-mention" contenteditable="false" data-user-id="' +
        escapeAttr(id) + '" title="@' + escapeAttr(name) + '">@' + escapeHtml(name) + '</span>');
    });

    // 6) 站点表情：![emoji:id]
    s = s.replace(/!\[emoji:([A-Za-z0-9_-]+)\]/g, (m, id) =>
      keep('<img class="markdown-emoji ' + NS + '-emoji" src="/api/v1/emojis/' +
        encodeURIComponent(id) + '/image" alt="[emoji:' + escapeAttr(id) + ']" data-emoji="' +
        escapeAttr(id) + '" contenteditable="false" draggable="false">'));

    // 7) 哔哩哔哩播放器地址（提交后由站点渲染为视频）
    s = s.replace(/https?:\/\/player\.bilibili\.com\/player\.html\?[^\s<>"'\u3002\uff09\uff0c\u3001]*/gi, (m) => {
      const bv = (m.match(/[?&](?:bvid|bvid2)=([0-9A-Za-z]+)/i) || [])[1] || '';
      return keep('<span class="' + NS + '-video-ref" contenteditable="false" data-url="' +
        escapeAttr(m) + '" title="哔哩哔哩视频（提交后由站点渲染为播放器）">哔哩哔哩视频' +
        (bv ? ' · ' + escapeHtml(bv) : '') + '</span>');
    });

    // 8) 转义剩余文本
    s = escapeHtml(s);

    // 9) 普通图片 ![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
      const url = safeUrl(src);
      if (!url) return m;
      return keep('<img src="' + escapeAttr(url) + '" alt="' + escapeAttr(alt) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + '>');
    });

    // 10) 站点图片引用 ![uuid]（站点渲染时解析）
    s = s.replace(/!\[([0-9A-Za-z_-]{8,})\]/g, (m, id) =>
      keep('<img class="' + NS + '-img-ref" src="/api/v1/files/' + encodeURIComponent(id) +
        '" alt="' + escapeAttr(id) + '" data-ref="' + escapeAttr(id) + '"' +
        ' title="图片引用：' + escapeAttr(id) + '（提交后由站点渲染）" contenteditable="false">'));

    // 11) 链接
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, txt, url, title) => {
      const u = safeUrl(url);
      if (!u) return m;
      return keep('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + '>' + txt + '</a>');
    });

    // 12) 加粗 / 删除线 / 斜体（先长后短）
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>');

    // 13) 还原被保护的片段
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
    return s;
  }

  /** 解析连续列表行（支持一级嵌套） */
  function consumeList(lines, i, n, opts) {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
    const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
    let html = ordered ? '<ol>' : '<ul>';
    while (i < n) {
      const line = lines[i];
      if (/^\s*$/.test(line)) break;
      const mo = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      const mu = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const mm = ordered ? mo : mu;
      if (!mm) break;
      if (mm[1].length < baseIndent) break;
      if (mm[1].length > baseIndent) break;
      i++;
      html += '<li>' + inlineMd(mm[2], opts);
      if (i < n) {
        const nm = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+/);
        if (nm && nm[1].length > baseIndent) {
          const sub = consumeList(lines, i, n, opts);
          html += sub.html;
          i = sub.next;
        }
      }
      html += '</li>';
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html: html, next: i };
  }

  /** 整篇 Markdown → HTML */
  function mdToHtml(md, opts) {
    const src = String(md == null ? '' : md).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const n = lines.length;
    let html = '';
    let i = 0;

    while (i < n) {
      const line = lines[i];

      // 围栏代码块
      let m = line.match(/^\s*```(.*)$/);
      if (m) {
        const lang = m[1].trim();
        const buf = [];
        i++;
        while (i < n && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' +
          escapeHtml(buf.join('\n')) + '</code></pre>';
        continue;
      }

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // 块级公式 $$ ... $$
      if (/^\s*\$\$\s*$/.test(line)) {
        const buf = [];
        i++;
        while (i < n && !/^\s*\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<div class="' + NS + '-math-block">' + escapeHtml(buf.join('\n')) + '</div>';
        continue;
      }

      // 分割线
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }

      // 标题
      m = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (m) {
        const lv = m[1].length;
        html += '<h' + lv + '>' + inlineMd(m[2].trim(), opts) + '</h' + lv + '>';
        i++;
        continue;
      }

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < n && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const header = parseRow(line);
        i += 2;
        const rows = [];
        while (i < n && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
        html += '<table><thead><tr>' + header.map((h) => '<th>' + inlineMd(h, opts) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + header.map((_, ci) =>
            '<td>' + inlineMd(r[ci] || '', opts) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>';
        continue;
      }

      // 引用块
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < n && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote>' + mdToHtml(buf.join('\n'), opts) + '</blockquote>';
        continue;
      }

      // 任务列表（必须放在普通列表之前）
      if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        let tl = '<ul class="' + NS + '-task-list">';
        while (i < n) {
          const tm = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
          if (!tm) break;
          tl += '<li class="' + NS + '-task-item" data-checked="' +
            (tm[1].toLowerCase() === 'x' ? '1' : '0') + '">' + inlineMd(tm[2], opts) + '</li>';
          i++;
        }
        tl += '</ul>';
        html += tl;
        continue;
      }

      // 普通列表
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const r = consumeList(lines, i, n, opts);
        html += r.html;
        i = r.next;
        continue;
      }

      // 段落对齐
      m = line.match(/^\s*<p\s+style="text-align:\s*(left|center|right)\s*;?"\s*>([\s\S]*)<\/p>\s*$/i);
      if (m) {
        html += '<p style="text-align:' + m[1].toLowerCase() + '">' + inlineMd(m[2], opts) + '</p>';
        i++;
        continue;
      }

      // 原始 HTML 块
      if (/^\s*</.test(line)) {
        const buf = [];
        while (i < n && !/^\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        const raw = buf.join('\n');
        if (/<\s*(?:div|p|h[1-6]|ul|ol|blockquote|pre|table|hr|section|article|figure)\b/i.test(raw)) {
          html += raw;
        } else {
          html += '<p>' + inlineMd(raw, opts) + '</p>';
        }
        continue;
      }

      // 普通段落
      const buf = [];
      while (
        i < n &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*(?:#{1,6}\s|>|```|-{3,}|\*{3,}|_{3,})/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !/^\s*\|.*\|\s*$/.test(lines[i]) &&
        !/^\s*</.test(lines[i])
      ) { buf.push(lines[i]); i++; }
      html += '<p>' + inlineMd(buf.join('\n'), opts).replace(/\n/g, '<br>') + '</p>';
    }

    return html;
  }

  // ============================ HTML → Markdown ============================

  function wrapNonEmpty(s, open, close) { return s ? open + s + close : s; }

  function inlineToMd(node) {
    if (node.nodeType === 3) {
      return String(node.nodeValue || '')
        .replace(/\\/g, '\\\\')
        .replace(/([`*_\[\]~])/g, '\\$1');
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    // 站点 @ 提及
    if (node.classList && node.classList.contains('markdown-user-mention')) {
      const id = node.getAttribute('data-user-id') || '';
      return id ? '@{' + id + '}' : (node.textContent || '');
    }

    // 行内公式
    if (node.classList && node.classList.contains(NS + '-math-inline')) {
      return '$' + (node.textContent || '') + '$';
    }

    // 站点表情
    if (tag === 'img' && (node.getAttribute('data-emoji') ||
        /^\[emoji:[\w-]+\]$/.test(node.getAttribute('alt') || ''))) {
      const id = node.getAttribute('data-emoji') ||
        (node.getAttribute('alt') || '').replace(/^\[emoji:|\]$/g, '');
      return id ? '![emoji:' + id + ']' : '';
    }

    // 站点图片引用
    if (tag === 'img' && node.getAttribute('data-ref')) {
      return '![' + node.getAttribute('data-ref') + ']';
    }

    // 哔哩哔哩视频
    if (node.classList && node.classList.contains(NS + '-video-ref')) {
      return node.getAttribute('data-url') || '';
    }

    if (tag === 'br') return '  \n';

    if (tag === 'img') {
      const src = safeUrl(node.getAttribute('src') || '');
      if (!src) return '';
      const alt = node.getAttribute('alt') || '';
      const title = node.getAttribute('title');
      return '![' + alt + '](' + src + (title ? ' "' + title + '"' : '') + ')';
    }

    if (tag === 'a') {
      const href = safeUrl(node.getAttribute('href') || '');
      const inner = childInline(node);
      if (!href) return inner;
      return '[' + inner + '](' + href + ')';
    }

    if (tag === 'code' && (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre')) {
      return '`' + (node.textContent || '').replace(/`/g, '\\`') + '`';
    }

    if (tag === 'strong' || tag === 'b') return wrapNonEmpty(childInline(node), '**', '**');
    if (tag === 'em' || tag === 'i') return wrapNonEmpty(childInline(node), '*', '*');
    if (tag === 'del' || tag === 's' || tag === 'strike') return wrapNonEmpty(childInline(node), '~~', '~~');
    if (tag === 'u') return wrapNonEmpty(childInline(node), '<u>', '</u>');
    if (tag === 'mark') return wrapNonEmpty(childInline(node), '<mark>', '</mark>');
    if (tag === 'sub') return wrapNonEmpty(childInline(node), '<sub>', '</sub>');
    if (tag === 'sup') return wrapNonEmpty(childInline(node), '<sup>', '</sup>');

    if (tag === 'span' || tag === 'font') {
      const inner = childInline(node);
      if (!inner) return '';
      const st = node.style || {};
      const color = normColor(st.color || node.getAttribute('color') || '');
      const bg = normColor(st.backgroundColor || '');
      const fw = (st.fontWeight || '').toLowerCase();
      const italic = (st.fontStyle || '').toLowerCase() === 'italic';
      const deco = (st.textDecorationLine || st.textDecoration || '').toLowerCase();
      const bold = fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600;

      let s = inner;
      if (color) s = '<span style="color:' + color + '">' + s + '</span>';
      if (bg) s = '<span style="background-color:' + bg + '">' + s + '</span>';
      if (deco.indexOf('underline') >= 0) s = '<u>' + s + '</u>';
      if (deco.indexOf('line-through') >= 0) s = '~~' + s + '~~';
      if (italic) s = '*' + s + '*';
      if (bold) s = '**' + s + '**';
      return s;
    }

    return childInline(node);
  }

  function childInline(node) {
    let out = '';
    node.childNodes.forEach((c) => { out += inlineToMd(c); });
    return out;
  }

  const BLOCK_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'ul', 'ol',
    'blockquote', 'pre', 'hr', 'table', 'section', 'article',
    'header', 'footer', 'figure', 'figcaption', 'li'
  ]);

  function isBlockNode(node) {
    return node.nodeType === 1 && BLOCK_TAGS.has(node.tagName.toLowerCase());
  }

  function childrenBlocks(node) {
    const out = [];
    let inlineBuf = '';
    const flush = () => {
      const t = inlineBuf.trim();
      if (t) out.push(t);
      inlineBuf = '';
    };
    node.childNodes.forEach((c) => {
      if (isBlockNode(c)) {
        flush();
        const b = blockToMd(c);
        if (b && b.trim()) out.push(b.trim());
      } else {
        inlineBuf += inlineToMd(c);
      }
    });
    flush();
    return out.join('\n\n');
  }

  function listToMd(listEl, depth) {
    const ordered = listEl.tagName.toLowerCase() === 'ol';
    const indent = '  '.repeat(depth);
    const lines = [];
    let idx = 1;
    const isTask = !!(listEl.classList && listEl.classList.contains(NS + '-task-list'));
    [...listEl.children].forEach((li) => {
      if (li.tagName.toLowerCase() !== 'li') return;
      let marker;
      if (isTask || (li.classList && li.classList.contains(NS + '-task-item'))) {
        const box = li.querySelector ? li.querySelector('input[type="checkbox"]') : null;
        const checked = (li.dataset && li.dataset.checked === '1') || !!(box && box.checked);
        marker = '- [' + (checked ? 'x' : ' ') + '] ';
      } else {
        marker = ordered ? (idx++) + '. ' : '- ';
      }
      let text = '';
      let nested = '';
      li.childNodes.forEach((c) => {
        if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) {
          nested += listToMd(c, depth + 1);
        } else {
          text += inlineToMd(c);
        }
      });
      text = text.replace(/\n/g, ' ').trim();
      lines.push(indent + marker + text);
      if (nested) lines.push(nested);
    });
    return lines.join('\n');
  }

  function tableToMd(table) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return '';
    const grid = rows.map((r) => [...r.children].map((c) => childInline(c).replace(/\n/g, ' ').trim()));
    const cols = Math.max(...grid.map((r) => r.length));
    const pad = (r) => { while (r.length < cols) r.push(''); return r; };
    const head = pad(grid[0].slice());
    let md = '| ' + head.join(' | ') + ' |\n';
    md += '| ' + head.map(() => '---').join(' | ') + ' |';
    for (let i = 1; i < grid.length; i++) {
      md += '\n| ' + pad(grid[i].slice()).join(' | ') + ' |';
    }
    return md;
  }

  function blockToMd(node) {
    if (node.nodeType === 3) {
      const t = String(node.nodeValue || '').trim();
      return t ? t : '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    if (node.classList && node.classList.contains('markdown-user-mention')) {
      const id = node.getAttribute('data-user-id') || '';
      return id ? '@{' + id + '}' : (node.textContent || '');
    }

    if (node.classList && node.classList.contains(NS + '-math-inline')) {
      return '$' + (node.textContent || '') + '$';
    }

    if (/^h[1-6]$/.test(tag)) {
      const lv = parseInt(tag.slice(1), 10);
      return '#'.repeat(lv) + ' ' + childInline(node).replace(/\n/g, ' ').trim();
    }

    if (tag === 'p') {
      const st = node.style || {};
      const align = (st.textAlign || node.getAttribute('align') || '').toLowerCase();
      const inner = childInline(node).replace(/\n/g, ' ').trim();
      if (!inner) return '';
      if (align && align !== 'left' && align !== 'start') {
        return '<p style="text-align:' + align + '">' + inner + '</p>';
      }
      return inner;
    }

    if (tag === 'div') {
      if (node.classList && node.classList.contains(NS + '-math-block')) {
        return '$$\n' + (node.textContent || '').trim() + '\n$$';
      }
      const st = node.style || {};
      const align = (st.textAlign || node.getAttribute('align') || '').toLowerCase();
      if (align && align !== 'left' && align !== 'start') {
        return '<p style="text-align:' + align + '">' + childInline(node).replace(/\n/g, ' ').trim() + '</p>';
      }
      return childrenBlocks(node);
    }

    if (tag === 'ul' || tag === 'ol') return listToMd(node, 0);

    if (tag === 'blockquote') {
      return childrenBlocks(node).split('\n').map((l) => '> ' + l).join('\n');
    }

    if (tag === 'pre') {
      const codeEl = node.querySelector('code');
      const cls = codeEl ? (codeEl.className || '') : (node.className || '');
      const lm = cls.match(/language-([\w+#-]+)/i);
      const lang = lm ? lm[1] : '';
      const code = (codeEl ? codeEl.textContent : node.textContent) || '';
      return '```' + lang + '\n' + code.replace(/\n$/, '') + '\n```';
    }

    if (tag === 'hr') return '---';
    if (tag === 'table') return tableToMd(node);
    if (tag === 'img') return inlineToMd(node);

    const inline = childInline(node).trim();
    return inline;
  }

  function htmlToMd(rootEl) {
    let md = childrenBlocks(rootEl);
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return md;
  }

  // ============================ 粘贴净化 ============================

  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike',
    'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
    'a', 'img', 'span', 'mark', 'sub', 'sup', 'font',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div'
  ]);
  const TAG_ALIAS = { b: 'strong', i: 'em', strike: 'del', s: 'del' };
  const KEEP_ATTR = {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan']
  };
  const KEEP_STYLE = ['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'];

  function sanitizeNode(node, doc) {
    if (node.nodeType === 3) return doc.createTextNode(node.nodeValue);
    if (node.nodeType !== 1) return doc.createDocumentFragment();

    const rawTag = node.tagName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'svg', 'canvas']
      .indexOf(rawTag) >= 0) {
      return doc.createDocumentFragment();
    }

    const tag = TAG_ALIAS[rawTag] || rawTag;

    // 站点 @ 提及
    if (tag === 'span' && node.classList && node.classList.contains('markdown-user-mention')) {
      const id = node.getAttribute('data-user-id') || '';
      if (!id) return doc.createDocumentFragment();
      const chip = doc.createElement('span');
      chip.className = 'markdown-user-mention';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-user-id', id);
      chip.setAttribute('title', node.getAttribute('title') || '@' + id);
      chip.textContent = node.textContent || '@' + id;
      return chip;
    }

    // 站点表情 / 图片引用
    if (tag === 'img') {
      const emojiId = node.getAttribute('data-emoji') ||
        ((node.getAttribute('alt') || '').match(/^\[emoji:([\w-]+)\]$/) || [])[1];
      if (emojiId) {
        const img = doc.createElement('img');
        img.className = 'markdown-emoji ' + NS + '-emoji';
        img.setAttribute('src', '/api/v1/emojis/' + encodeURIComponent(emojiId) + '/image');
        img.setAttribute('alt', '[emoji:' + emojiId + ']');
        img.setAttribute('data-emoji', emojiId);
        img.setAttribute('contenteditable', 'false');
        img.setAttribute('draggable', 'false');
        return img;
      }
      const ref = node.getAttribute('data-ref') || '';
      if (ref) {
        const img = doc.createElement('img');
        img.className = NS + '-img-ref';
        img.setAttribute('src', '/api/v1/files/' + encodeURIComponent(ref));
        img.setAttribute('alt', ref);
        img.setAttribute('data-ref', ref);
        img.setAttribute('title', '图片引用：' + ref + '（提交后由站点渲染）');
        img.setAttribute('contenteditable', 'false');
        return img;
      }
      const src = safeUrl(node.getAttribute('src') || '');
      if (!src) return doc.createDocumentFragment();
      const img = doc.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', node.getAttribute('alt') || '');
      return img;
    }

    // 行内公式
    if (tag === 'span' && node.classList && node.classList.contains(NS + '-math-inline')) {
      const span = doc.createElement('span');
      span.className = NS + '-math-inline';
      span.textContent = node.textContent || '';
      return span;
    }

    // 视频占位
    if (tag === 'span' && node.classList && node.classList.contains(NS + '-video-ref')) {
      const url = node.getAttribute('data-url') || '';
      if (!url) return doc.createDocumentFragment();
      const chip = doc.createElement('span');
      chip.className = NS + '-video-ref';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-url', url);
      chip.setAttribute('title', '哔哩哔哩视频（提交后由站点渲染为播放器）');
      chip.textContent = node.textContent || '哔哩哔哩视频';
      return chip;
    }

    // 块级公式
    if (tag === 'div' && node.classList && node.classList.contains(NS + '-math-block')) {
      const div = doc.createElement('div');
      div.className = NS + '-math-block';
      div.textContent = node.textContent || '';
      return div;
    }

    // 任务列表
    if (tag === 'ul' && node.classList && node.classList.contains(NS + '-task-list')) {
      const ul = doc.createElement('ul');
      ul.className = NS + '-task-list';
      node.childNodes.forEach((c) => ul.appendChild(sanitizeNode(c, doc)));
      return ul;
    }
    if (tag === 'li' && node.classList && node.classList.contains(NS + '-task-item')) {
      const li = doc.createElement('li');
      li.className = NS + '-task-item';
      li.setAttribute('data-checked', node.getAttribute('data-checked') === '1' ? '1' : '0');
      node.childNodes.forEach((c) => li.appendChild(sanitizeNode(c, doc)));
      return li;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      const frag = doc.createDocumentFragment();
      node.childNodes.forEach((c) => frag.appendChild(sanitizeNode(c, doc)));
      return frag;
    }

    const el = doc.createElement(tag);

    // 代码块语言
    if (tag === 'code') {
      const cls = node.getAttribute('class') || '';
      const lm = cls.match(/language-[\w+#-]+/i);
      if (lm) el.setAttribute('class', lm[0]);
    }

    (KEEP_ATTR[tag] || []).forEach((name) => {
      const v = node.getAttribute(name);
      if (v == null) return;
      if (name === 'href' || name === 'src') {
        const u = safeUrl(v);
        if (!u) return;
        el.setAttribute(name, u);
      } else {
        el.setAttribute(name, v);
      }
    });
    if (tag === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }

    const srcStyle = node.style;
    if (srcStyle) {
      const kept = [];
      KEEP_STYLE.forEach((prop) => {
        const val = srcStyle.getPropertyValue(prop);
        if (val) kept.push(prop + ':' + val.trim());
      });
      if (kept.length) el.setAttribute('style', kept.join(';'));
    }
    if (tag === 'font' && node.getAttribute('color')) {
      el.setAttribute('style', (el.getAttribute('style') ? el.getAttribute('style') + ';' : '') +
        'color:' + node.getAttribute('color'));
    }

    node.childNodes.forEach((c) => el.appendChild(sanitizeNode(c, doc)));

    if ((tag === 'span' || tag === 'font') && !el.textContent.trim() && !el.querySelector('img')) {
      return doc.createDocumentFragment();
    }
    return el;
  }

  function sanitizeHtml(html) {
    try {
      const doc = document.implementation.createHTMLDocument('pco-ed');
      const body = doc.createElement('body');
      body.innerHTML = String(html);
      const frag = doc.createDocumentFragment();
      body.childNodes.forEach((c) => frag.appendChild(sanitizeNode(c, doc)));
      const holder = doc.createElement('div');
      holder.appendChild(frag);
      return holder.innerHTML;
    } catch (e) {
      return escapeHtml(String(html)).replace(/\n/g, '<br>');
    }
  }

  // ============================ 编辑器 ============================

  let caretSeq = 0;

  function PCOEditor(host, options) {
    if (!host) throw new Error('PCOEditor: host is required');
    this.host = host;
    this.options = options || {};
    this.savedRange = null;
    this.stateFrame = 0;
    this.growFrame = 0;

    host.setAttribute('contenteditable', 'true');
    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-multiline', 'true');
    host.setAttribute('spellcheck', 'true');
    if (!host.hasAttribute('data-placeholder')) {
      host.setAttribute('data-placeholder', '说说你的看法…');
    }

    this._bind();
  }

  PCOEditor.prototype._notify = function () {
    if (typeof this.options.onChange === 'function') this.options.onChange(this);
    this.autoGrow();
    this.refreshState();
  };

  PCOEditor.prototype._bind = function () {
    const self = this;
    const host = this.host;

    host.addEventListener('input', function (e) {
      // 输入法组合期间不处理，避免把候选中的文字拆开
      if (e.isComposing) return;
      // 删空后浏览器会留下 <br> / <p><br></p>，清掉骨架让 placeholder 重新出现
      if (!host.textContent.trim() && !host.querySelector('img,table,hr,pre,blockquote')) {
        const only = host.innerHTML.replace(/\s+/g, '');
        if (only === '<br>' || only === '<p><br></p>' || only === '<div><br></div>') {
          host.innerHTML = '';
          self.placeCaretEnd();
        }
      }
      self.applyInputRule();
      self._notify();
    });

    host.addEventListener('keyup', function () { self.saveSelection(); self.refreshState(); });
    host.addEventListener('mouseup', function () { self.saveSelection(); self.refreshState(); });
    host.addEventListener('blur', function () { self.saveSelection(); });

    this._onSelectionChange = function () {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      if (!host.contains(sel.anchorNode)) return;
      self.saveSelection();
      self.refreshState();
    };
    document.addEventListener('selectionchange', this._onSelectionChange);

    // 点击任务列表可切换勾选
    host.addEventListener('click', function (e) {
      const item = e.target.closest && e.target.closest('.' + NS + '-task-item');
      if (!item || !host.contains(item)) return;
      if (e.target.tagName === 'INPUT') return;
      item.setAttribute('data-checked', item.getAttribute('data-checked') === '1' ? '0' : '1');
      self.saveSelection();
      self._notify();
    });

    // 粘贴：保留站点富文本，剔除脚本与冗余样式
    host.addEventListener('paste', function (e) {
      const data = e.clipboardData;
      if (!data) return;
      const html = data.getData('text/html');
      const text = data.getData('text/plain');
      if (!html && !text) return;
      e.preventDefault();
      self.ensureRange();
      if (html) {
        document.execCommand('insertHTML', false, sanitizeHtml(html));
      } else {
        document.execCommand('insertText', false, text);
      }
      self._notify();
    });

    // 回车后在空任务项/空引用里保持合理结构
    host.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        const li = self.currentListItem();
        if (!li) return;
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent', false, null);
        self._notify();
      }
    });
  };

  PCOEditor.prototype.currentListItem = function () {
    try {
      let node = window.getSelection().anchorNode;
      while (node && node !== this.host) {
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'li') return node;
        node = node.parentNode;
      }
    } catch (e) { /* noop */ }
    return null;
  };

  PCOEditor.prototype.isFocused = function () {
    return document.activeElement === this.host;
  };

  PCOEditor.prototype.ensureRange = function () {
    const host = this.host;
    host.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (sel && sel.rangeCount && host.contains(sel.anchorNode)) return sel;
    if (this.savedRange && host.contains(this.savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
      return sel;
    }
    this.placeCaretEnd();
    return window.getSelection();
  };

  PCOEditor.prototype.saveSelection = function () {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (!this.host.contains(sel.anchorNode)) return;
    this.savedRange = sel.getRangeAt(0).cloneRange();
  };

  PCOEditor.prototype.placeCaretEnd = function () {
    const host = this.host;
    const range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this.savedRange = range.cloneRange();
  };

  PCOEditor.prototype.focus = function () {
    this.ensureRange();
  };

  PCOEditor.prototype.focusEnd = function () {
    this.host.focus({ preventScroll: true });
    this.placeCaretEnd();
  };

  PCOEditor.prototype.getSelectedText = function () {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.host.contains(sel.anchorNode)) return '';
    return sel.toString();
  };

  /** 在光标处插入 HTML，并把光标放到插入内容之后 */
  PCOEditor.prototype.insertHtml = function (html) {
    if (!html) return;
    this.ensureRange();
    const marker = 'pco-ed-caret-' + (++caretSeq);
    let ok = false;
    try {
      ok = document.execCommand('insertHTML', false, html +
        '<span id="' + marker + '"></span>');
    } catch (e) { ok = false; }
    if (!ok) {
      this.host.insertAdjacentHTML('beforeend', html);
      this.placeCaretEnd();
    } else {
      const m = this.host.querySelector('#' + marker);
      if (m) {
        const range = document.createRange();
        range.setStartAfter(m);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        m.parentNode.removeChild(m);
        this.savedRange = range.cloneRange();
      }
    }
    this._notify();
  };

  PCOEditor.prototype.insertText = function (text) {
    if (!text) return;
    this.ensureRange();
    try {
      document.execCommand('insertText', false, text);
    } catch (e) {
      this.host.insertAdjacentText('beforeend', text);
    }
    this._notify();
  };

  PCOEditor.prototype.exec = function (cmd, val) {
    this.ensureRange();
    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, val == null ? null : val);
    } catch (e) { /* noop */ }
    this.saveSelection();
    this._notify();
  };

  PCOEditor.prototype.currentBlockTag = function () {
    try {
      let node = window.getSelection().anchorNode;
      while (node && node !== this.host) {
        if (node.nodeType === 1) {
          const t = node.tagName.toLowerCase();
          if (/^(h[1-6]|p|div|blockquote|li|pre)$/.test(t)) return t;
        }
        node = node.parentNode;
      }
    } catch (e) { /* noop */ }
    return '';
  };

  PCOEditor.prototype.toggleHeading = function (level) {
    this.ensureRange();
    const cur = this.currentBlockTag();
    const target = !level || cur === 'h' + level ? 'P' : 'H' + level;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('formatBlock', false, target);
    } catch (e) { /* noop */ }
    this.saveSelection();
    this._notify();
  };

  PCOEditor.prototype.toggleBlock = function (tag) {
    this.ensureRange();
    const cur = this.currentBlockTag();
    const target = cur === tag ? 'P' : tag;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('formatBlock', false, target);
    } catch (e) { /* noop */ }
    this.saveSelection();
    this._notify();
  };

  PCOEditor.prototype.toggleList = function (ordered) {
    this.exec(ordered ? 'insertOrderedList' : 'insertUnorderedList');
  };

  PCOEditor.prototype.insertTaskList = function () {
    const sel = this.getSelectedText();
    const items = (sel || '待办事项').split('\n').map((t) => t.trim()).filter(Boolean);
    const html = '<ul class="' + NS + '-task-list">' +
      items.map((t) => '<li class="' + NS + '-task-item" data-checked="0">' +
        escapeHtml(t) + '</li>').join('') + '</ul><p><br></p>';
    this.insertHtml(html);
  };

  PCOEditor.prototype.insertInlineCode = function () {
    const sel = this.getSelectedText();
    this.insertHtml('<code>' + escapeHtml(sel || 'code') + '</code>');
  };

  PCOEditor.prototype.insertCodeBlock = function () {
    const sel = this.getSelectedText();
    this.insertHtml('<pre><code>' + escapeHtml(sel || '代码') + '</code></pre><p><br></p>');
  };

  PCOEditor.prototype.insertLink = function (url, text) {
    const u = safeUrl(url);
    if (!u) return false;
    const label = text || this.getSelectedText() || '链接文字';
    this.insertHtml('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(label) + '</a>');
    return true;
  };

  PCOEditor.prototype.insertHr = function () {
    this.insertHtml('<hr><p><br></p>');
  };

  PCOEditor.prototype.insertInlineMath = function () {
    const sel = this.getSelectedText();
    this.insertHtml('<span class="' + NS + '-math-inline">' + escapeHtml(sel || 'a^2+b^2=c^2') +
      '</span>');
  };

  PCOEditor.prototype.insertBlockMath = function () {
    const sel = this.getSelectedText();
    this.insertHtml('<div class="' + NS + '-math-block">' + escapeHtml(sel || 'E = mc^2') +
      '</div><p><br></p>');
  };

  PCOEditor.prototype.insertTable = function (rows, cols) {
    let r = rows;
    let c = cols;
    if (r == null) {
      const rs = window.prompt('请输入表格行数（不含表头）：', '3');
      if (rs === null) return;
      r = parseInt(rs, 10) || 1;
    }
    if (c == null) {
      const cs = window.prompt('请输入表格列数：', '3');
      if (cs === null) return;
      c = parseInt(cs, 10) || 1;
    }
    r = Math.max(1, Math.min(30, r));
    c = Math.max(1, Math.min(12, c));
    let html = '<table><thead><tr>';
    for (let j = 0; j < c; j++) html += '<th>表头 ' + (j + 1) + '</th>';
    html += '</tr></thead><tbody>';
    for (let k = 0; k < r; k++) {
      html += '<tr>';
      for (let j = 0; j < c; j++) html += '<td> </td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    this.insertHtml(html);
  };

  PCOEditor.prototype.insertEmoji = function (id) {
    if (!id) return;
    this.insertHtml('<img class="markdown-emoji ' + NS + '-emoji" src="/api/v1/emojis/' +
      encodeURIComponent(id) + '/image" alt="[emoji:' + escapeAttr(id) + ']" data-emoji="' +
      escapeAttr(id) + '" contenteditable="false" draggable="false">');
  };

  PCOEditor.prototype.insertImageRef = function (id) {
    if (!id) return;
    this.insertHtml('<img class="' + NS + '-img-ref" src="/api/v1/files/' + encodeURIComponent(id) +
      '" alt="' + escapeAttr(id) + '" data-ref="' + escapeAttr(id) +
      '" title="图片引用：' + escapeAttr(id) + '（提交后由站点渲染）" contenteditable="false">');
  };

  PCOEditor.prototype.insertVideo = function (url) {
    const m = String(url || '').trim().match(
      /https?:\/\/player\.bilibili\.com\/player\.html\?[^\s<>"']*/i);
    if (!m) return false;
    const bv = (m[0].match(/[?&](?:bvid|bvid2)=([0-9A-Za-z]+)/i) || [])[1] || '';
    this.insertHtml('<span class="' + NS + '-video-ref" contenteditable="false" data-url="' +
      escapeAttr(m[0]) + '" title="哔哩哔哩视频（提交后由站点渲染为播放器）">哔哩哔哩视频' +
      (bv ? ' · ' + escapeHtml(bv) : '') + '</span>');
    return true;
  };

  PCOEditor.prototype.clearFormat = function () {
    this.ensureRange();
    try {
      document.execCommand('removeFormat', false, null);
      document.execCommand('unlink', false, null);
    } catch (e) { /* noop */ }
    this._notify();
  };

  PCOEditor.prototype.undo = function () {
    try { document.execCommand('undo', false, null); } catch (e) { /* noop */ }
    this._notify();
  };

  PCOEditor.prototype.redo = function () {
    try { document.execCommand('redo', false, null); } catch (e) { /* noop */ }
    this._notify();
  };

  /** 简单查找替换：只替换文本节点，跳过表情 / 图片 / @ 等占位块 */
  PCOEditor.prototype.findReplace = function () {
    const find = window.prompt('查找内容：', '');
    if (find == null || !find) return;
    const replace = window.prompt('替换为（留空则删除）：', '');
    if (replace == null) return;
    const walker = document.createTreeWalker(this.host, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue || node.nodeValue.indexOf(find) < 0) return NodeFilter.FILTER_REJECT;
        let p = node.parentNode;
        while (p && p !== this.host) {
          if (p.nodeType === 1 && p.getAttribute('contenteditable') === 'false') {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    nodes.forEach((node) => { node.nodeValue = node.nodeValue.split(find).join(replace); });
    this._notify();
  };

  PCOEditor.prototype.openPalette = function (anchor, type) {
    if (!anchor) return;
    const root = document.getElementById('pco-root') || document.body;
    const old = root.querySelector('.' + NS + '-palette');
    if (old) old.parentNode.removeChild(old);

    const colors = type === 'color'
      ? ['#171717', '#f03e46', '#e8590c', '#f59f00', '#2f9e44', '#1c7ed6', '#7048e8', '#e64980',
        '#868e96', '#ffffff', '#ffc9c9', '#ffec99', '#b2f2bb', '#a5d8ff', '#d0bfff', '#fcc2d7']
      : ['#fff2a8', '#ffd43b', '#ffa94d', '#ff8787', '#b2f2bb', '#a5d8ff', '#d0bfff', '#fcc2d7',
        '#ffec99', '#e9ecef', '#ffffff', 'transparent'];

    const pop = document.createElement('div');
    pop.className = NS + '-palette';
    const grid = document.createElement('div');
    grid.className = NS + '-swatches';
    const self = this;
    colors.forEach((color) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = NS + '-swatch';
      sw.title = color === 'transparent' ? '清除背景' : color;
      sw.style.background = color === 'transparent'
        ? 'repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/8px 8px'
        : color;
      sw.addEventListener('mousedown', (e) => e.preventDefault());
      sw.addEventListener('click', (e) => {
        e.preventDefault();
        if (type === 'color') self.exec('foreColor', color);
        else self.exec('hiliteColor', color === 'transparent' ? 'transparent' : color);
        close();
      });
      grid.appendChild(sw);
    });
    pop.appendChild(grid);
    root.appendChild(pop);

    const rect = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const gap = 8;
    let left = Math.max(gap, Math.min(rect.left, window.innerWidth - w - gap));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - gap) top = Math.max(gap, rect.top - h - 6);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';

    function close() {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      if (pop.parentNode) pop.parentNode.removeChild(pop);
    }
    function onDocDown(e) {
      if (!pop.contains(e.target) && e.target !== anchor) close();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  };

  /** 刷新工具栏选中态 */
  PCOEditor.prototype.refreshState = function () {
    if (this.stateFrame) return;
    this.stateFrame = requestAnimationFrame(() => {
      this.stateFrame = 0;
      const host = this.host;
      const box = host.closest('.pco-composer-box') || host.parentNode;
      if (!box) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !host.contains(sel.anchorNode)) return;

      box.querySelectorAll('[data-ed-cmd]').forEach((btn) => {
        let on = false;
        try { on = document.queryCommandState(btn.getAttribute('data-ed-cmd')); } catch (e) { on = false; }
        btn.classList.toggle('is-on', !!on);
      });

      const cur = this.currentBlockTag();
      box.querySelectorAll('[data-ed-heading]').forEach((btn) => {
        const lv = btn.getAttribute('data-ed-heading');
        btn.classList.toggle('is-on', lv === 'p' ? (cur === 'p' || !cur) : cur === 'h' + lv);
      });

      let align = 'left';
      try {
        if (document.queryCommandState('justifyCenter')) align = 'center';
        else if (document.queryCommandState('justifyRight')) align = 'right';
      } catch (e) { /* noop */ }
      box.querySelectorAll('[data-ed-align]').forEach((btn) => {
        btn.classList.toggle('is-on', btn.getAttribute('data-ed-align') === align);
      });
    });
  };

  PCOEditor.prototype.autoGrow = function () {
    if (this.growFrame) return;
    this.growFrame = requestAnimationFrame(() => {
      this.growFrame = 0;
      const host = this.host;
      if (!host.isConnected) return;
      if (host.closest('.pco-composer-box--full')) {
        host.style.height = '';
        return;
      }
      host.style.height = 'auto';
      host.style.height = Math.min(140, Math.max(56, host.scrollHeight)) + 'px';
    });
  };

  /** 输入规则：刚输入完成的 **粗体** / *斜体* / ~~删除~~ / `代码` / @{id} / ![emoji:id] 立即渲染 */
  PCOEditor.prototype.applyInputRule = function () {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || !this.host.contains(node)) return;
    const text = node.nodeValue || '';
    const off = sel.anchorOffset;
    const before = text.slice(0, off);
    const patterns = [
      /(?:^|\s)(\*\*[^\s*][^*\n]*[^\s*]\*\*)$/,
      /(?:^|\s)(\*[^\s*][^*\n]*[^\s*]\*)$/,
      /(?:^|\s)(~~[^\s~][^~\n]*[^\s~]~~)$/,
      /(?:^|\s)(`[^`\n]+`)$/,
      /(?:^|\s)(!\[[^\]]+\])$/,
      /(?:^|\s)(@\{[0-9a-fA-F-]{8,}\})$/
    ];
    let token = '';
    for (let i = 0; i < patterns.length; i++) {
      const m = before.match(patterns[i]);
      if (m) { token = m[1]; break; }
    }
    if (!token) return;
    const start = off - token.length;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, off);
    range.deleteContents();

    const holder = document.createElement('div');
    holder.innerHTML = inlineMd(token, this.options);
    const frag = document.createDocumentFragment();
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    const last = frag.lastChild;
    range.insertNode(frag);

    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      this.savedRange = after.cloneRange();
    }
    // 刚输入的 @ 提及需要异步补用户名
    if (/@\{/.test(token) && typeof this.options.onRendered === 'function') {
      this.options.onRendered(this.host);
    }
  };

  PCOEditor.prototype.getMarkdown = function () {
    return htmlToMd(this.host).trim();
  };

  PCOEditor.prototype.getText = function () {
    return String(this.host.textContent || '').replace(/\u200b/g, '').trim();
  };

  PCOEditor.prototype.isEmpty = function () {
    return !this.getText() && !this.host.querySelector('img,table,hr,pre,blockquote');
  };

  /** 用 Markdown 重绘编辑区；保留光标到末尾 */
  PCOEditor.prototype.setMarkdown = function (md) {
    const html = mdToHtml(md, this.options);
    this.host.innerHTML = html ? sanitizeHtml(html) : '';
    this.savedRange = null;
    this.autoGrow();
    if (typeof this.options.onRendered === 'function') this.options.onRendered(this.host);
  };

  PCOEditor.prototype.clear = function () {
    this.host.innerHTML = '';
    this.savedRange = null;
    this.autoGrow();
  };

  PCOEditor.prototype.destroy = function () {
    if (this.stateFrame) cancelAnimationFrame(this.stateFrame);
    if (this.growFrame) cancelAnimationFrame(this.growFrame);
    if (this._onSelectionChange) {
      document.removeEventListener('selectionchange', this._onSelectionChange);
      this._onSelectionChange = null;
    }
    this.stateFrame = 0;
    this.growFrame = 0;
  };

  window.PCOEditor = PCOEditor;
  // 暴露纯转换函数便于排查格式问题（不参与运行时流程）
  PCOEditor.mdToHtml = mdToHtml;
  PCOEditor.htmlToMd = htmlToMd;
  PCOEditor.sanitizeHtml = sanitizeHtml;
})();

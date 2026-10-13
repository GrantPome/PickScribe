

/*
 * 设计说明（便于后续维护）
 * 1. 只做“前端增强”：最终仍然把标准 Markdown 字符串写回原来的 textarea#post-content，
 *    并派发 input 事件，让 Nuxt(Vue) 的 v-model 同步到组件状态，完全复用站点原有提交逻辑。
 * 2. 富文本区用 contenteditable + document.execCommand 实现，零第三方依赖，体积小、加载快。
 * 3. Markdown ↔ HTML 的转换全部自研，覆盖工具栏涉及的全部格式；对颜色/高亮/对齐这类
 *    Markdown 标准之外的样式，用内联 HTML（<span style>、<u>、<p style="text-align">）承载，
 *    保证“所见即所得”且格式不丢失。
 * 4. UI 直接复用站点设计令牌（--ui-accent / --bg-surface / --ui-border / --radius-* 等），
 *    因此自动适配站点的浅色 / 深色主题，无需硬编码配色。
 * 5. 版本 2.0.1：Chrome 扩展（Manifest V3）content script，由早期油猴脚本迁移而来。
 */

(function () {
  'use strict';

  // ============================ 0. 基础常量与工具 ============================

  const NS = 'pcr';                       // 样式与类名统一前缀，避免污染站点样式
  const MOUNT_FLAG = 'pcrMounted';        // textarea 上的挂载标记，防止重复注入
  const HINT_KEY = 'pcr_hint_closed';     // 新手提示是否已关闭

  /** 该页面是否是帖子编辑页（SPA 路由变化时用于兜底判断） */
  const isEditorPage = () => /\/forum\/editor(\/|$|\?)/.test(location.pathname + location.search);

  /** HTML 文本转义 */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 属性值转义（用于拼接到 HTML 属性中） */
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** URL 安全校验：拦截 javascript: 等危险协议，避免 XSS */
  function safeUrl(url) {
    const u = String(url || '').trim();
    if (/^\s*javascript:/i.test(u)) return '';
    if (/^\s*(https?:|mailto:|tel:|data:image\/|\/|#|\.)/i.test(u)) return u;
    // 允许相对路径（无协议）如 images/a.png
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '';
  }

  /** rgb()/rgba() 颜色统一转成 #rrggbb，便于 Markdown 里更干净 */
  function normColor(c) {
    const v = String(c || '').trim();
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return v;
    const hex = (n) => ('0' + parseInt(n, 10).toString(16)).slice(-2);
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }

  /** 简易防抖 */
  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ============================ 1. Markdown → HTML ============================

  /**
   * 行内 Markdown → HTML。
   * 处理顺序很关键：先“保护”原始 HTML 标签与行内代码，再转义、再做各种标记替换，最后还原。
   */
  function inlineMd(text) {
    const stash = [];
    const keep = (html) => {
      stash.push(html);
      return '\u0000' + (stash.length - 1) + '\u0000';
    };

    let s = String(text == null ? '' : text);

    // 1) 保护已经存在的行内 HTML 标签（颜色、高亮、下划线、链接等由本脚本生成或用户粘贴）
    s = s.replace(/<\/?(?:span|u|mark|sub|sup|br|a|em|strong|b|i|s|del|code|kbd|font|img)\b[^>]*>/gi, (m) => keep(m));

    // 2) 保护行内代码 `code`
    s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + escapeHtml(c) + '</code>'));

    // 2.5) 保护行内公式 $...$（其中的 < > & _ ^ 不能被转义，也不能被当成 Markdown 标记）
    //      规则：开头 $ 后不能紧跟空格，结尾 $ 前不能是空格，且结尾 $ 后不能紧跟数字，
    //      以尽量避免把 "$5 和 $10" 这类普通文本误判成公式。
    s = s.replace(/\$(?!\s)([^\$\n]*?[^\s\$])\$(?!\d)/g, (m, tex) => keep('<span class="pcr-math-inline">' + escapeHtml(tex) + '</span>'));

    // 3) 还原 Markdown 反斜杠转义（\* \_ \` 等）
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

    // 4) 转义剩余文本，避免与后续拼装的 HTML 冲突
    s = escapeHtml(s);

    // 5) 图片：![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
      const url = safeUrl(src);
      if (!url) return m;
      return keep('<img src="' + escapeAttr(url) + '" alt="' + escapeAttr(alt) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + '>');
    });

    // 6) 链接：[text](url "title")
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, txt, url, title) => {
      const u = safeUrl(url);
      if (!u) return m;
      return keep('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + '>' + txt + '</a>');
    });

    // 7) 加粗 / 删除线 / 斜体（先长后短，避免 ** 被 * 抢先匹配）
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>');

    // 8) 还原被保护的片段
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
    return s;
  }

  /** 解析一段连续列表行（支持一级嵌套） */
  function consumeList(lines, i, n) {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
    const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
    let html = ordered ? '<ol>' : '<ul>';
    while (i < n) {
      const line = lines[i];
      if (/^\s*$/.test(line)) break; // 空行结束列表
      const mo = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      const mu = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const mm = ordered ? mo : mu;
      if (!mm) break;
      if (mm[1].length < baseIndent) break;
      if (mm[1].length > baseIndent) break; // 更深的缩进在下面按“子列表”处理
      i++;
      html += '<li>' + inlineMd(mm[2]);
      // 子列表：紧随其后、缩进“更深”的列表行（必须严格大于当前层级，避免同级误判）
      if (i < n) {
        const nm = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+/);
        if (nm && nm[1].length > baseIndent) {
          const sub = consumeList(lines, i, n);
          html += sub.html;
          i = sub.next;
        }
      }
      html += '</li>';
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html, next: i };
  }

  /** 整篇 Markdown → HTML */
  function mdToHtml(md) {
    const src = String(md == null ? '' : md).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const n = lines.length;
    let html = '';
    let i = 0;

    while (i < n) {
      const line = lines[i];

      // 围栏代码块 ```lang ... ```
      let m = line.match(/^\s*```(.*)$/);
      if (m) {
        const lang = m[1].trim();
        const buf = [];
        i++;
        while (i < n && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        html += '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' +
          escapeHtml(buf.join('\n')) + '</code></pre>';
        continue;
      }

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // 块级公式 $$ ... $$（站点模板为单独成行的 $$ 包裹）
      if (/^\s*\$\$\s*$/.test(line)) {
        const buf = [];
        i++;
        while (i < n && !/^\s*\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束的 $$
        html += '<div class="pcr-math-block">' + escapeHtml(buf.join('\n')) + '</div>';
        continue;
      }

      // 分割线
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }

      // 标题 # ~ ######
      m = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (m) {
        const lv = m[1].length;
        html += '<h' + lv + '>' + inlineMd(m[2].trim()) + '</h' + lv + '>';
        i++;
        continue;
      }

      // Markdown 表格
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < n && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const header = parseRow(line);
        i += 2;
        const rows = [];
        while (i < n && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
        html += '<table><thead><tr>' + header.map((h) => '<th>' + inlineMd(h) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + header.map((_, ci) => '<td>' + inlineMd(r[ci] || '') + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>';
        continue;
      }

      // 引用块
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < n && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>';
        continue;
      }

      // 任务列表 - [ ] / - [x]（必须放在普通列表之前判断）
      if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        let tl = '<ul class="pcr-task-list">';
        while (i < n) {
          const tm = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
          if (!tm) break;
          tl += '<li class="pcr-task-item" data-checked="' + (tm[1].toLowerCase() === 'x' ? '1' : '0') + '">' +
            inlineMd(tm[2]) + '</li>';
          i++;
        }
        tl += '</ul>';
        html += tl;
        continue;
      }

      // 列表
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const r = consumeList(lines, i, n);
        html += r.html;
        i = r.next;
        continue;
      }

      // 单行内联对齐段落：<p style="text-align:center">…</p>
      m = line.match(/^\s*<p\s+style="text-align:\s*(left|center|right)\s*;?"\s*>([\s\S]*)<\/p>\s*$/i);
      if (m) {
        html += '<p style="text-align:' + m[1].toLowerCase() + '">' + inlineMd(m[2]) + '</p>';
        i++;
        continue;
      }

      // 其他原始 HTML 块：若整块是“行内级”HTML（颜色 span、<u>、<mark> 等）则包进 <p>，
      // 否则（含 div/p/table 等块级标签）按块级原样透传，避免破坏结构。
      if (/^\s*</.test(line)) {
        const buf = [];
        while (i < n && !/^\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        const raw = buf.join('\n');
        if (/<\s*(?:div|p|h[1-6]|ul|ol|blockquote|pre|table|hr|section|article|figure)\b/i.test(raw)) {
          html += raw;
        } else {
          html += '<p>' + inlineMd(raw) + '</p>';
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
      html += '<p>' + inlineMd(buf.join('\n')).replace(/\n/g, '<br>') + '</p>';
    }

    return html;
  }

  // ============================ 2. HTML → Markdown ============================

  /** 行内节点 → Markdown */
  function inlineToMd(node) {
    if (node.nodeType === 3) { // 文本节点
      return String(node.nodeValue || '')
        .replace(/\\/g, '\\\\')
        .replace(/([`*_\[\]~])/g, '\\$1');
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    // 行内公式
    if (node.classList && node.classList.contains('pcr-math-inline')) {
      return '$' + (node.textContent || '') + '$';
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

    // span / font：解析内联样式，映射为 Markdown 或内联 HTML
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

    // 其他行内标签：直接递归其子节点
    return childInline(node);
  }

  function wrapNonEmpty(s, open, close) { return s ? open + s + close : s; }

  function childInline(node) {
    let out = '';
    node.childNodes.forEach((c) => { out += inlineToMd(c); });
    return out;
  }

  /** 块级节点 → Markdown */
  function blockToMd(node) {
    if (node.nodeType === 3) {
      const t = String(node.nodeValue || '').trim();
      return t ? t : '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    // 行内公式
    if (node.classList && node.classList.contains('pcr-math-inline')) {
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
      // 块级公式
      if (node.classList && node.classList.contains('pcr-math-block')) {
        return '$$\n' + (node.textContent || '').trim() + '\n$$';
      }
      const st = node.style || {};
      const align = (st.textAlign || node.getAttribute('align') || '').toLowerCase();
      const blocks = childrenBlocks(node);
      if (align && align !== 'left' && align !== 'start') {
        return '<p style="text-align:' + align + '">' + childInline(node).replace(/\n/g, ' ').trim() + '</p>';
      }
      return blocks;
    }

    if (tag === 'ul' || tag === 'ol') return listToMd(node, 0);

    if (tag === 'blockquote') {
      const inner = childrenBlocks(node);
      return inner.split('\n').map((l) => '> ' + l).join('\n');
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

    // 兜底：按行内处理
    const inline = childInline(node).trim();
    return inline;
  }

  /** 块级标签集合，用于区分“块”与“行内”，保证根层级的行内内容被合并成一个段落 */
  const BLOCK_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'ul', 'ol',
    'blockquote', 'pre', 'hr', 'table', 'section', 'article',
    'header', 'footer', 'figure', 'figcaption', 'li'
  ]);
  function isBlockNode(node) {
    return node.nodeType === 1 && BLOCK_TAGS.has(node.tagName.toLowerCase());
  }

  /**
   * 把子节点转成“块级 Markdown”。
   * 关键点：连续的“行内节点”（文本、span、a、img、br…）会先累积、再合并成一个段落，
   * 避免富文本区根层级的行内元素被逐个拆成独立段落、并丢失自身的颜色/链接等样式。
   */
  function childrenBlocks(node) {
    const out = [];
    let inlineBuf = '';
    const flush = () => {
      const t = inlineBuf.replace(/[ \t]+\n/g, '\n').trim();
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
    const isTask = !!(listEl.classList && listEl.classList.contains('pcr-task-list'));
    [...listEl.children].forEach((li) => {
      if (li.tagName.toLowerCase() !== 'li') return;
      let marker;
      if (isTask || (li.classList && li.classList.contains('pcr-task-item'))) {
        // 任务列表：输出 - [ ] / - [x]
        const box = li.querySelector ? li.querySelector('input[type="checkbox"]') : null;
        const checked = (li.dataset && li.dataset.checked === '1') || !!(box && box.checked);
        marker = '- [' + (checked ? 'x' : ' ') + '] ';
      } else {
        marker = ordered ? (idx++) + '. ' : '- ';
      }
      // 分离 li 的直接行内内容与嵌套列表
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

  /** 整篇 HTML → Markdown */
  function htmlToMd(root) {
    let md = childrenBlocks(root);
    md = md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    return md;
  }

  // ============================ 3. 粘贴净化 ============================

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

  /**
   * 递归净化节点：只保留白名单标签与白名单属性，剔除 Word / 网页带来的冗余样式。
   * 返回一个可直接插入编辑器的 DocumentFragment。
   */
  function sanitizeNode(node, doc) {
    if (node.nodeType === 3) {
      return doc.createTextNode(node.nodeValue);
    }
    if (node.nodeType !== 1) {
      return doc.createDocumentFragment();
    }

    const rawTag = node.tagName.toLowerCase();

    // 危险 / 无语义标签：整块丢弃
    if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'svg', 'canvas'].indexOf(rawTag) >= 0) {
      return doc.createDocumentFragment();
    }

    const tag = TAG_ALIAS[rawTag] || rawTag;

    // 不在白名单内的标签：解包（保留其文字内容）
    if (!ALLOWED_TAGS.has(tag)) {
      const frag = doc.createDocumentFragment();
      node.childNodes.forEach((c) => frag.appendChild(sanitizeNode(c, doc)));
      return frag;
    }

    // 图片：校验 URL，非法则丢弃
    if (tag === 'img') {
      const src = safeUrl(node.getAttribute('src') || '');
      if (!src) return doc.createDocumentFragment();
      const img = doc.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', node.getAttribute('alt') || '');
      return img;
    }

    const el = doc.createElement(tag);

    // 保留白名单属性
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
    if (tag === 'a') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }

    // 保留白名单内联样式（颜色/高亮/对齐/粗细/斜体/下划线）
    const srcStyle = node.style;
    if (srcStyle) {
      const kept = [];
      KEEP_STYLE.forEach((prop) => {
        const val = srcStyle.getPropertyValue(prop);
        if (val) kept.push(prop + ':' + val.trim());
      });
      if (kept.length) el.setAttribute('style', kept.join(';'));
    }
    // 兼容 <font color> 老式写法
    if (tag === 'font' && node.getAttribute('color')) {
      el.setAttribute('style', (el.getAttribute('style') ? el.getAttribute('style') + ';' : '') + 'color:' + node.getAttribute('color'));
    }

    // 递归子节点
    node.childNodes.forEach((c) => el.appendChild(sanitizeNode(c, doc)));

    // 丢弃空的 span / font（Word 常见）
    if ((tag === 'span' || tag === 'font') && !el.textContent.trim() && !el.querySelector('img')) {
      return doc.createDocumentFragment();
    }
    return el;
  }

  /** 净化一段 HTML 字符串，返回可插入的 HTML 字符串 */
  function sanitizeHtml(html) {
    try {
      const doc = document.implementation.createHTMLDocument('pcr');
      const body = doc.createElement('body');
      body.innerHTML = String(html);
      const frag = doc.createDocumentFragment();
      body.childNodes.forEach((c) => frag.appendChild(sanitizeNode(c, doc)));
      const holder = doc.createElement('div');
      holder.appendChild(frag);
      return holder.innerHTML;
    } catch (e) {
      // 容错：净化失败时退化为纯文本
      return escapeHtml(String(html)).replace(/\n/g, '<br>');
    }
  }

  /** 纯文本 → HTML（保留换行） */
  function textToHtml(text) {
    const parts = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    return parts.map((p) => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
  }

  // ============================ 4. 图标与样式 ============================

  const svg = (inner, extra) =>
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' + (extra || '') + '>' + inner + '</svg>';

  const ICONS = {
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
    color: svg('<path d="M5 19h14"/><path d="M8.6 15.5 12 6l3.4 9.5"/><path d="M9.8 12.4h4.4"/>'),
    highlight: svg('<path d="M15.5 3.8 20.2 8.5 11 17.7H6.2v-4.8z"/><path d="M4 21h16"/>'),
    ol: svg('<path d="M10 6h10M10 12h10M10 18h10"/><text x="2.5" y="9" font-size="7.5" fill="currentColor" stroke="none">1</text><text x="2.5" y="15" font-size="7.5" fill="currentColor" stroke="none">2</text>'),
    ul: svg('<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="4.6" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.3" fill="currentColor" stroke="none"/>'),
    quote: svg('<path d="M7.5 8H5.5v4h3V8z" fill="currentColor" stroke="none"/><path d="M15.5 8h-2v4h3V8z" fill="currentColor" stroke="none"/><path d="M5.5 12c0 3 1.2 4.4 3 4.8"/><path d="M13.5 12c0 3 1.2 4.4 3 4.8"/>'),
    code: svg('<path d="m9 8-5 4 5 4"/><path d="m15 8 5 4-5 4"/>'),
    link: svg('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>'),
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16.5-5-5L5 20"/>'),
    hr: svg('<path d="M3 12h18"/><path d="M6.5 8.5v7M12 8.5v7M17.5 8.5v7" stroke-dasharray="1 2.5"/>'),
    alignLeft: svg('<path d="M3 6h18M3 10h12M3 14h18M3 18h12"/>'),
    alignCenter: svg('<path d="M3 6h18M6 10h12M3 14h18M6 18h12"/>'),
    alignRight: svg('<path d="M3 6h18M9 10h12M3 14h18M9 18h12"/>'),
    table: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4.5v15M15 4.5v15"/>'),
    mathInline: svg('<path d="M4.5 8.5h5.5M7.25 8.5v7M4.5 15.5h5.5"/><path d="M14.5 9.5 18 15M18 9.5 14.5 15"/>'),
    mathBlock: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M6.5 9.5h6M6.5 12.5h9M6.5 15.5h6"/>'),
    fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    clear: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1 .9-1 1.7v.2"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>'),
    rich: svg('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>'),
    split: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M12 4.5v15"/>'),
    source: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5h6M7 13.5h10"/>'),
    text: (t, style) => '<span class="pcr-glyph" style="' + (style || '') + '">' + t + '</span>'
  };

  /** 站点令牌 + 兜底色，注入到 <head> 一次即可 */
  function injectStyle() {
    if (document.getElementById(NS + '-style')) return;
    const css = `
/* CSS 变量定义在 :root 上：帮助浮层 / 提示条等是挂到 body 的，
   不在 .pcr-root 内部，只有定义在 :root 才能取到这些变量，
   否则 var(--pcr-surface) 失效会导致背景透明。 */
:root{
  --pcr-accent: var(--ui-accent, #f03e46);
  --pcr-accent-soft: var(--ui-accent-soft, rgba(240,62,70,.12));
  --pcr-border: var(--ui-border, #d4dbe4);
  --pcr-surface: var(--bg-surface, #ffffff);
  --pcr-surface-hover: var(--bg-surface-hover, rgba(0,0,0,.045));
  --pcr-canvas: var(--bg-canvas, #f3f4f6);
  --pcr-text: var(--text-foreground, #171717);
  --pcr-subtle: var(--text-subtle, #5f6875);
  --pcr-r-surface: var(--radius-surface, .5rem);
  --pcr-r-control: var(--radius-control, .375rem);
  --pcr-font: var(--font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
}
.${NS}-root{
  font-family: var(--pcr-font);
  color: var(--pcr-text);
  margin-bottom: 12px;
  font-size: 14px;
  line-height: 1.6;
}
.${NS}-root *{box-sizing:border-box;}

/* —— 顶部：模式切换 + 状态 —— */
.${NS}-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap;}
.${NS}-tabs{display:inline-flex;padding:3px;gap:2px;background:var(--pcr-canvas);border:1px solid var(--pcr-border);border-radius:var(--pcr-r-surface);}
.${NS}-tab{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--pcr-subtle);
  font:inherit;font-size:13px;padding:5px 12px;border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .26s cubic-bezier(.22,1,.36,1),color .26s;}
.${NS}-tab svg{width:15px;height:15px;}
.${NS}-tab:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-tab.is-on{background:var(--pcr-surface);color:var(--pcr-accent);box-shadow:0 1px 2px rgba(0,0,0,.08);}
.${NS}-head-right{display:flex;align-items:center;gap:10px;}
.${NS}-synced{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--pcr-subtle);}
.${NS}-synced .dot{width:6px;height:6px;border-radius:50%;background:#37c26b;box-shadow:0 0 0 3px rgba(55,194,107,.16);}
.${NS}-synced.is-busy .dot{background:var(--pcr-accent);box-shadow:0 0 0 3px var(--pcr-accent-soft);}

/* —— 工具栏 —— */
.${NS}-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:6px 8px;
  background:var(--pcr-surface);border:1px solid var(--pcr-border);border-bottom:0;
  border-radius:var(--pcr-r-surface) var(--pcr-r-surface) 0 0;}
.${NS}-sep{width:1px;height:18px;background:var(--pcr-border);margin:0 5px;}
.${NS}-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;border:0;border-radius:var(--pcr-r-control);background:transparent;
  color:var(--pcr-subtle);cursor:pointer;font:inherit;
  transition:background .24s cubic-bezier(.22,1,.36,1),color .24s;}
.${NS}-btn:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-btn:active{transform:scale(.94);}
.${NS}-btn.is-on{background:var(--pcr-accent-soft);color:var(--pcr-accent);}
.${NS}-btn.wide{width:auto;padding:0 8px;font-weight:600;font-size:13px;}
.${NS}-glyph{font-size:14px;line-height:1;font-weight:700;font-family:Georgia,'Times New Roman',serif;}
.${NS}-glyph.italic{font-style:italic;font-weight:600;}
.${NS}-glyph.under{text-decoration:underline;text-underline-offset:2px;}
.${NS}-glyph.strike{text-decoration:line-through;}

/* 悬浮提示（新手引导） */
.${NS}-btn[data-tip]::after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 6px);
  transform:translateX(-50%) translateY(-3px);white-space:nowrap;font-size:12px;font-weight:400;
  background:#1f2328;color:#fff;padding:4px 8px;border-radius:6px;opacity:0;pointer-events:none;
  transition:opacity .24s,transform .24s cubic-bezier(.22,1,.36,1);z-index:60;}
.${NS}-btn[data-tip]:hover::after{opacity:1;transform:translateX(-50%) translateY(0);}

/* —— 编辑区 —— */
.${NS}-editor-wrap{background:var(--pcr-surface);border:1px solid var(--pcr-border);
  border-radius:0 0 var(--pcr-r-surface) var(--pcr-r-surface);overflow:hidden;}
/* 切换视图时给编辑区一个轻微淡入，避免内容“硬切” */
@keyframes ${NS}FadeIn{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:translateY(0);}}
.${NS}-fade{animation:${NS}FadeIn .3s cubic-bezier(.16,1,.3,1) both;}
.${NS}-editor{min-height:320px;max-height:640px;overflow:auto;padding:16px 18px;outline:none;
  font-size:15px;line-height:1.75;color:var(--pcr-text);word-break:break-word;}
.${NS}-editor:empty::before{content:attr(data-placeholder);color:var(--pcr-subtle);opacity:.75;pointer-events:none;}
.${NS}-editor:focus{background:var(--pcr-surface);}
.${NS}-editor h1{font-size:26px;line-height:1.35;margin:.6em 0 .4em;font-weight:700;}
.${NS}-editor h2{font-size:22px;line-height:1.35;margin:.6em 0 .4em;font-weight:700;}
.${NS}-editor h3{font-size:18px;line-height:1.4;margin:.5em 0 .35em;font-weight:650;}
.${NS}-editor h4{font-size:16px;line-height:1.4;margin:.5em 0 .3em;font-weight:650;}
.${NS}-editor p{margin:.45em 0;}
.${NS}-editor blockquote{margin:.6em 0;padding:.4em .9em;border-left:3px solid var(--pcr-border);
  background:var(--pcr-canvas);color:var(--pcr-subtle);border-radius:0 var(--pcr-r-control) var(--pcr-r-control) 0;}
.${NS}-editor pre{margin:.6em 0;padding:12px 14px;background:var(--pcr-canvas);border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-control);overflow:auto;}
.${NS}-editor pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:none;padding:0;}
.${NS}-editor code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;
  background:var(--pcr-canvas);padding:1px 5px;border-radius:4px;}
.${NS}-editor ul,.${NS}-editor ol{margin:.45em 0;padding-left:1.6em;}
.${NS}-editor li{margin:.2em 0;}
.${NS}-editor img{max-width:100%;border-radius:var(--pcr-r-control);}
.${NS}-editor hr{border:0;border-top:1px solid var(--pcr-border);margin:1em 0;}
.${NS}-editor a{color:var(--pcr-accent);text-decoration:underline;}
.${NS}-editor table{border-collapse:collapse;margin:.6em 0;width:100%;}
.${NS}-editor th,.${NS}-editor td{border:1px solid var(--pcr-border);padding:6px 10px;}
.${NS}-editor th{background:var(--pcr-canvas);font-weight:600;}
.${NS}-editor mark{background:#fff2a8;color:inherit;}
/* 任务列表（复选框可点击切换） */
.${NS}-editor ul.${NS}-task-list{list-style:none;padding-left:2px;}
.${NS}-editor li.${NS}-task-item{position:relative;padding-left:25px;}
.${NS}-editor li.${NS}-task-item::before{content:'';position:absolute;left:1px;top:.34em;width:15px;height:15px;
  border:1.5px solid var(--pcr-border);border-radius:4px;background:var(--pcr-surface);cursor:pointer;
  transition:background .24s,border-color .24s;}
.${NS}-editor li.${NS}-task-item[data-checked="1"]::before{background:var(--pcr-accent);border-color:var(--pcr-accent);}
.${NS}-editor li.${NS}-task-item[data-checked="1"]::after{content:'';position:absolute;left:5px;top:.55em;width:4px;height:8px;
  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);cursor:pointer;}
.${NS}-editor li.${NS}-task-item[data-checked="1"]{color:var(--pcr-subtle);text-decoration:line-through;}
/* 公式：仅做可视化区分，真正渲染由 Pickcat 的 KaTeX 完成 */
.${NS}-editor .${NS}-math-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;
  background:var(--pcr-canvas);border:1px solid var(--pcr-border);border-radius:4px;padding:0 5px;color:var(--pcr-accent);}
.${NS}-editor .${NS}-math-block{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;
  background:var(--pcr-canvas);border:1px dashed var(--pcr-border);border-radius:var(--pcr-r-control);
  padding:10px 12px;margin:.6em 0;text-align:center;color:var(--pcr-accent);white-space:pre-wrap;}
/* 全屏编辑 */
.${NS}-root.is-fullscreen{position:fixed;inset:0;z-index:9999;margin:0;padding:14px 16px;
  background:var(--pcr-canvas);display:flex;flex-direction:column;overflow:auto;}
.${NS}-root.is-fullscreen .${NS}-editor-wrap{flex:1;display:flex;flex-direction:column;min-height:0;}
.${NS}-root.is-fullscreen .${NS}-editor{max-height:none;flex:1;min-height:0;}

/* —— 新手提示条 —— */
.${NS}-hint{display:flex;align-items:flex-start;gap:8px;margin-top:8px;padding:8px 12px;
  font-size:12.5px;color:var(--pcr-subtle);background:var(--pcr-canvas);
  border:1px dashed var(--pcr-border);border-radius:var(--pcr-r-control);
  animation:${NS}PopIn .42s cubic-bezier(.16,1,.3,1) both;}
.${NS}-hint b{color:var(--pcr-text);font-weight:600;}
.${NS}-hint-close{margin-left:auto;border:0;background:transparent;color:var(--pcr-subtle);
  cursor:pointer;font-size:15px;line-height:1;padding:0 2px;}

/* —— 浮层统一入场动画：淡入 + 轻微下落 + 缩放，长尾缓动收得更优雅 —— */
@keyframes ${NS}PopIn{
  from{opacity:0;transform:translateY(-7px) scale(.96);}
  to{opacity:1;transform:translateY(0) scale(1);}
}
/* —— 调色板 / 帮助浮层 —— */
.${NS}-pop{position:absolute;z-index:70;background:var(--pcr-surface);border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-surface);box-shadow:0 8px 28px rgba(0,0,0,.16);padding:8px;
  transform-origin:top right;animation:${NS}PopIn .34s cubic-bezier(.16,1,.3,1) both;}
.${NS}-swatches{display:grid;grid-template-columns:repeat(6,20px);gap:6px;}
.${NS}-swatch{width:20px;height:20px;border-radius:5px;border:1px solid rgba(0,0,0,.12);cursor:pointer;
  transition:transform .22s cubic-bezier(.22,1,.36,1);}
.${NS}-swatch:hover{transform:scale(1.15);}
.${NS}-pop-help{max-width:290px;font-size:12.5px;line-height:1.7;color:var(--pcr-subtle);padding:12px 14px;}
.${NS}-pop-help b{color:var(--pcr-text);}
.${NS}-pop-help ul{margin:6px 0 0;padding-left:1.1em;}

/* —— 选中浮动菜单 —— */
.${NS}-float{position:absolute;z-index:80;display:flex;align-items:center;gap:2px;padding:4px;
  background:#1f2328;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);
  transform-origin:bottom center;animation:${NS}PopIn .32s cubic-bezier(.16,1,.3,1) both;}
.${NS}-float button{width:28px;height:28px;border:0;background:transparent;color:#e6e8eb;cursor:pointer;
  border-radius:6px;font:inherit;display:inline-flex;align-items:center;justify-content:center;
  transition:background .24s;}
.${NS}-float button:hover{background:rgba(255,255,255,.16);}
.${NS}-float .sep{width:1px;height:16px;background:rgba(255,255,255,.2);margin:0 3px;}

/* —— 轻提示 —— */
.${NS}-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(10px);
  background:#1f2328;color:#fff;font-size:13px;line-height:1.5;max-width:80vw;text-align:center;
  padding:9px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.24);
  opacity:0;pointer-events:none;transition:opacity .32s,transform .32s cubic-bezier(.16,1,.3,1);z-index:90;}
.${NS}-toast.is-show{opacity:1;transform:translateX(-50%) translateY(0);}
.${NS}-hidden{display:none !important;}

/* 可视化模式下隐藏站点原生编辑器容器。
   站点弹窗（作品分享 / 表情 / 图片）挂在原生容器内、并按原生按钮坐标定位，
   因此点击这些按钮时脚本会临时切到源码视图，让原生编辑器完整显示后再点击，
   弹窗才能定位正确；操作完成后自动切回可视化。 */
.${NS}-native-collapsed{display:none !important;}
`;
    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================ 5. 编辑器构建 ============================

  let editor = null;       // contenteditable 富文本区
  let textarea = null;     // 站点原始 Markdown 输入框
  let root = null;         // 整个面板根节点
  let origWrapper = null;  // 站点原生编辑器容器（工具栏 + textarea + 字数统计）
  let mode = 'rich';       // rich | split | source
  let lock = false;        // 同步锁，防止双向同步互相触发形成死循环
  let pendingBack = null;  // 站点弹窗完成后「自动切回可视化」的一次性监听，切视图时需清理
  let lastTaValue = null;  // 最近一次「脚本自己写入」的 textarea 值，用于识别外部（框架）改写

  /** 工具按钮工厂 */
  function makeBtn(opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = NS + '-btn' + (opts.wide ? ' wide' : '');
    b.dataset.pcrOwn = '1';   // 标记为脚本自身按钮，避免站点按钮查找时误命中自己
    b.innerHTML = opts.html;
    if (opts.tip) b.setAttribute('data-tip', opts.tip);
    if (opts.title) b.title = opts.title;
    // 关键：阻止默认行为，避免点击工具栏时编辑区失去焦点 / 选区丢失
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.preventDefault(); opts.onClick(b); });
    if (opts.key) b.dataset.key = opts.key;
    return b;
  }

  function makeSep() {
    const s = document.createElement('span');
    s.className = NS + '-sep';
    return s;
  }

  /** 在编辑区光标处插入 HTML */
  function insertHtml(html) {
    editor.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) {
      placeCaretAtEnd(editor);
    }
    try {
      document.execCommand('insertHTML', false, html);
    } catch (e) {
      editor.insertAdjacentHTML('beforeend', html);
    }
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function getSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !editor.contains(sel.anchorNode)) return '';
    return sel.toString();
  }

  /** 执行 execCommand 并同步。styleWithCSS 让颜色/高亮/加粗等统一输出 span 内联样式，
   *  便于 HTML→Markdown 稳定解析（本脚本已同时兼容 <b>/<font> 等语义标签写法）。 */
  function exec(cmd, val) {
    editor.focus();
    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, val == null ? null : val);
    } catch (e) { /* 忽略个别浏览器差异 */ }
    refreshToolbarState();
    richToSource();
  }

  /** 切换标题级别（再次点击同一级别则还原为正文） */
  function toggleHeading(level) {
    editor.focus();
    const cur = currentBlockTag();
    const target = cur === 'h' + level ? 'P' : 'H' + level;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('formatBlock', false, target);
    } catch (e) { /* noop */ }
    refreshToolbarState();
    richToSource();
  }

  function currentBlockTag() {
    try {
      let node = window.getSelection().anchorNode;
      while (node && node !== editor) {
        if (node.nodeType === 1) {
          const t = node.tagName.toLowerCase();
          if (/^(h[1-6]|p|div|blockquote|li|pre)$/.test(t)) return t;
        }
        node = node.parentNode;
      }
    } catch (e) { /* noop */ }
    return '';
  }

  /** 刷新工具栏按钮的选中态 */
  function refreshToolbarState() {
    if (!editor) return;
    const map = {
      bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strike'
    };
    Object.keys(map).forEach((cmd) => {
      const b = root && root.querySelector('.' + NS + '-btn[data-key="' + map[cmd] + '"]');
      if (!b) return;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch (e) { /* noop */ }
      b.classList.toggle('is-on', !!on);
    });
    // 标题按钮选中态
    const cur = currentBlockTag();
    ['h1', 'h2', 'h3', 'h4'].forEach((h) => {
      const b = root && root.querySelector('.' + NS + '-btn[data-key="' + h + '"]');
      if (b) b.classList.toggle('is-on', cur === h);
    });
    // 对齐按钮选中态
    const aligns = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right' };
    Object.keys(aligns).forEach((cmd) => {
      const b = root && root.querySelector('.' + NS + '-btn[data-key="align-' + aligns[cmd] + '"]');
      if (!b) return;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch (e) { /* noop */ }
      b.classList.toggle('is-on', !!on);
    });
  }

  /** 打开颜色 / 高亮调色板 */
  function openPalette(anchorBtn, type) {
    closePopups();
    const colors = type === 'color'
      ? ['#171717', '#f03e46', '#e8590c', '#f59f00', '#2f9e44', '#1c7ed6', '#7048e8', '#e64980',
         '#868e96', '#ffffff', '#ffc9c9', '#ffec99', '#b2f2bb', '#a5d8ff', '#d0bfff', '#fcc2d7']
      : ['#fff2a8', '#ffd43b', '#ffa94d', '#ff8787', '#b2f2bb', '#a5d8ff', '#d0bfff', '#fcc2d7',
         '#ffec99', '#e9ecef', '#ffffff', 'transparent'];
    const pop = document.createElement('div');
    pop.className = NS + '-pop ' + NS + '-palette';
    const grid = document.createElement('div');
    grid.className = NS + '-swatches';
    colors.forEach((c) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = NS + '-swatch';
      sw.style.background = c === 'transparent' ? 'repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/8px 8px' : c;
      sw.title = c === 'transparent' ? '清除背景' : c;
      sw.addEventListener('mousedown', (e) => e.preventDefault());
      sw.addEventListener('click', () => {
        if (type === 'color') exec('foreColor', c);
        else exec('hiliteColor', c === 'transparent' ? 'transparent' : c);
        closePopups();
      });
      grid.appendChild(sw);
    });
    pop.appendChild(grid);
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
    pop.style.left = (window.scrollX + r.left) + 'px';
  }

  /** 打开新手帮助浮层 */
  function openHelp(anchorBtn) {
    closePopups();
    const pop = document.createElement('div');
    pop.className = NS + '-pop ' + NS + '-pop-help';
    pop.innerHTML =
      '<b>可视化编辑小贴士</b>' +
      '<ul>' +
      '<li>直接在编辑区输入，排版<b>所见即所得</b>。</li>' +
      '<li>选中文字会弹出<b>快捷格式菜单</b>。</li>' +
      '<li>切到「<b>源码</b>」可查看/编辑 Markdown，两边<b>实时同步</b>。</li>' +
      '<li>从 Word / 网页粘贴会自动<b>清理冗余格式</b>。</li>' +
      '<li>最终提交的仍是标准 Markdown，与站点原生逻辑一致。</li>' +
      '</ul>';
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, window.scrollX + r.right - 290) + 'px';
  }

  function closePopups() {
    document.querySelectorAll('.' + NS + '-pop, .' + NS + '-float').forEach((el) => el.remove());
  }

  /** 轻量非阻塞提示（替代 alert，体验更顺滑） */
  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.' + NS + '-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = NS + '-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    // 强制回流后再加类，保证过渡动画每次都生效
    void el.offsetWidth;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 2600);
  }

  // ============================ 5.1 站点原生能力复用 ============================

  /**
   * 站点按钮候选标签。
   * 站点文案可能随版本变化，这里为每个功能留多个候选，按 aria-label / title / 文本 模糊匹配，
   * 命中后直接复用站点原生按钮的图标与点击逻辑，保证「图标用原来网站那一套」且行为一致。
   */
  const SITE_LABELS = {
    undo: ['撤销'],
    redo: ['重做', '恢复'],
    work: ['Kitten作品分享', 'Kitten 作品分享', '作品分享', '添加作品', '作品'],
    emoji: ['添加表情', '表情'],
    image: ['插入图片', '添加图片', '上传图片', '图片'],
    bold: ['加粗', '粗体'],
    italic: ['斜体'],
    strike: ['删除线'],
    underline: ['下划线'],
    h1: ['一级标题', '标题1', 'H1'],
    h2: ['二级标题', '标题2', 'H2'],
    h3: ['三级标题', '标题3', 'H3'],
    h4: ['四级标题', '标题4', 'H4'],
    ul: ['无序列表', '项目符号'],
    ol: ['有序列表', '编号列表'],
    task: ['任务列表', '待办列表', '待办'],
    quote: ['引用块', '引用'],
    inlinecode: ['行内代码'],
    codeblock: ['代码块'],
    link: ['插入链接', '链接'],
    table: ['插入表格', '表格'],
    mathinline: ['行内公式'],
    mathblock: ['块级公式'],
    hr: ['分割线', '水平线'],
    fullscreen: ['全屏编辑', '全屏']
  };

  /** 在站点原生编辑器区域内查找按钮（优先原生工具栏，其次全文档） */
  function findSiteButton(labels) {
    const list = (Array.isArray(labels) ? labels : [labels]).filter(Boolean);
    if (!list.length) return null;
    const scopes = [];
    if (origWrapper && document.body.contains(origWrapper)) scopes.push(origWrapper);
    scopes.push(document);
    for (const scope of scopes) {
      const nodes = scope.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
      for (const el of nodes) {
        if (el.dataset && el.dataset.pcrOwn === '1') continue;  // 跳过脚本自身按钮
        if (root && root.contains(el)) continue;                // 跳过本面板
        // 汇总所有可读文案来源：常用属性 + 全部属性值（含 data-*、class 之外的标识）+ 文本
        let hay = (el.getAttribute('aria-label') || '') + ' ' +
          (el.getAttribute('title') || '') + ' ' +
          (el.textContent || '').trim();
        for (const a of el.attributes) {
          if (a.name === 'class') continue;                     // class 太宽泛，容易误匹配
          hay += ' ' + a.value;
        }
        for (const lb of list) {
          if (lb && hay.indexOf(lb) >= 0) return el;
        }
      }
    }
    return null;
  }

  /** 列出页面上可用的站点按钮文案，便于排查「找不到按钮」 */
  function listSiteButtonLabels() {
    const out = [];
    const scope = (origWrapper && document.body.contains(origWrapper)) ? origWrapper : document;
    scope.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      if (el.dataset && el.dataset.pcrOwn === '1') return;
      const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 24);
      if (t) out.push(t);
    });
    return out;
  }

  /**
   * 把富文本光标位置同步到原生 textarea。
   * 站点原生弹窗是把 Markdown 插入到 textarea 光标处的，可视化模式下 textarea 隐藏、
   * 光标位置失效，这里把插入点放到文末，保证内容能落到正确位置。
   * force=true 时即使 textarea 已聚焦也强制放到文末（脚本主动切视图时用）。
   */
  function syncCaretToTextarea(force) {
    if (!textarea) return;
    try {
      if (!force && document.activeElement === textarea) return; // 用户自己在源码模式编辑时尊重其光标
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    } catch (e) { /* noop */ }
  }

  /** 运行时读取站点原生按钮的图标，保证风格与站点完全一致；缺失时用内置图标兜底 */
  function siteIcon(labels, fallback) {
    const btn = findSiteButton(labels);
    if (btn) {
      const graphic = btn.querySelector('svg, img, i');
      if (graphic && graphic.outerHTML) return graphic.outerHTML;
    }
    return fallback;
  }

  /**
   * 委托点击站点原生按钮，复用其上传 / 图盘 / 选择器逻辑，不重复造轮子。
   *
   * 站点弹窗（作品分享 / 表情 / 图片）都挂在原生编辑器容器内、按原生按钮坐标定位，
   * 可视化模式下容器被隐藏，弹窗会定位错误 / 不可见。因此统一切到源码视图后再点击，
   * 让原生编辑器完整显示、弹窗定位正确；插入内容后（textarea 触发 input）自动切回。
   *
   * 两个关键点（之前「跳过去不弹窗 / 回来后再点没反应」就是这里出的问题）：
   *  1. 切换视图会让 Vue 重渲染原生工具栏，之前抓到的按钮节点已失效 —— 所以必须
   *     在切换之后「重新查找」按钮再点击，不能复用旧引用。
   *  2. setMode 内部会异步 focus 原生输入框，会打断刚打开的弹窗 —— 所以点击要
   *     延后到 focus 执行完之后。
   */
  function delegateSiteAction(labels, friendlyName) {
    const clickNative = () => {
      const btn = findSiteButton(labels);   // 每次重新查找，避免用到已被重渲染替换的旧节点
      if (!btn) {
        console.warn('[Pickcat 富文本编辑器] 未找到站点原生按钮：' + friendlyName,
          '\n候选标签=', labels, '\n页面可用按钮文案=', listSiteButtonLabels());
        toast('未找到站点的「' + friendlyName + '」按钮，请改用站点原生工具栏');
        return;
      }
      syncCaretToTextarea(true);            // 让站点把内容插入到文末
      btn.click();
    };

    // 已经是源码 / 分屏视图时，原生编辑器可见，直接点击即可
    if (mode !== 'rich') { clickNative(); return; }

    setMode('source');
    toast('已切到源码视图以显示「' + friendlyName + '」窗口，选择完成后会自动返回可视化');
    // 等 setMode 的异步 focus 执行完再点击，避免弹窗刚打开就被焦点变化打断
    setTimeout(clickNative, 80);
    // 站点把内容写回 textarea 后会触发 input，捕获到就自动切回可视化（一次性）
    const back = () => {
      textarea.removeEventListener('input', back);
      if (pendingBack === back) pendingBack = null;
      setTimeout(() => { if (mode === 'source') setMode('rich'); }, 500);
    };
    pendingBack = back;
    textarea.addEventListener('input', back);
  }

  // ============================ 5.2 插入类命令 ============================

  /** 插入任务列表（复选框可在编辑区点击切换勾选） */
  function insertTaskList() {
    const sel = getSelectedText();
    const items = (sel || '待办事项').split('\n').map((t) => t.trim()).filter(Boolean);
    const html = '<ul class="' + NS + '-task-list">' +
      items.map((t) => '<li class="' + NS + '-task-item" data-checked="0">' + escapeHtml(t) + '</li>').join('') +
      '</ul><p><br></p>';
    insertHtml(html);
    richToSource();
  }

  /** 插入行内代码 */
  function insertInlineCode() {
    const sel = getSelectedText();
    insertHtml('<code>' + escapeHtml(sel || 'code') + '</code>');
    richToSource();
  }

  /** 插入行内公式 */
  function insertInlineMath() {
    const sel = getSelectedText();
    insertHtml('<span class="' + NS + '-math-inline">' + escapeHtml(sel || 'a^2+b^2=c^2') + '</span>');
    richToSource();
  }

  /** 插入块级公式 */
  function insertBlockMath() {
    const sel = getSelectedText();
    insertHtml('<div class="' + NS + '-math-block">' + escapeHtml(sel || 'E = mc^2') + '</div><p><br></p>');
    richToSource();
  }

  /** 插入表格（弹窗询问行列数，默认 3 行 3 列） */
  function insertTable() {
    const rs = window.prompt('请输入表格行数（不含表头）：', '3');
    if (rs === null) return;
    const cs = window.prompt('请输入表格列数：', '3');
    if (cs === null) return;
    const rows = Math.max(1, Math.min(30, parseInt(rs, 10) || 1));
    const cols = Math.max(1, Math.min(12, parseInt(cs, 10) || 1));
    let html = '<table><thead><tr>';
    for (let c = 0; c < cols; c++) html += '<th>表头 ' + (c + 1) + '</th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += '<td> </td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    insertHtml(html);
    richToSource();
  }

  /** 全屏编辑开关（再次点击退出） */
  function toggleFullscreen() {
    if (!root) return;
    const on = root.classList.toggle('is-fullscreen');
    const b = root.querySelector('.' + NS + '-btn[data-key="fullscreen"]');
    if (b) b.classList.toggle('is-on', on);
    document.documentElement.style.overflow = on ? 'hidden' : '';
  }

  /** 构建整个面板 DOM */
  function buildPanel() {
    root = document.createElement('div');
    root.className = NS + '-root';

    // —— 顶部：模式切换 + 同步状态 + 帮助 ——
    const head = document.createElement('div');
    head.className = NS + '-head';

    const tabs = document.createElement('div');
    tabs.className = NS + '-tabs';
    [
      { m: 'rich', icon: ICONS.rich, label: '可视化' },
      { m: 'split', icon: ICONS.split, label: '分屏对照' },
      { m: 'source', icon: ICONS.source, label: 'Markdown 源码' }
    ].forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = NS + '-tab';
      b.dataset.mode = t.m;
      b.innerHTML = t.icon + '<span>' + t.label + '</span>';
      b.addEventListener('click', () => setMode(t.m));
      tabs.appendChild(b);
    });
    head.appendChild(tabs);

    const headRight = document.createElement('div');
    headRight.className = NS + '-head-right';
    const synced = document.createElement('span');
    synced.className = NS + '-synced';
    synced.innerHTML = '<span class="dot"></span><span>已与 Markdown 实时同步</span>';
    headRight.appendChild(synced);
    const helpBtn = makeBtn({ html: ICONS.help, tip: '新手帮助', onClick: (b) => openHelp(b) });
    headRight.appendChild(helpBtn);
    head.appendChild(headRight);
    root.appendChild(head);

    // —— 工具栏 ——
    const bar = document.createElement('div');
    bar.className = NS + '-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '富文本编辑工具');

    const add = (b) => { bar.appendChild(b); };
    const addSep = () => add(makeSep());
    const I = siteIcon; // 站点原生图标（运行时从站点工具栏读取，缺失时用内置图标兜底）

    // —— 撤销 / 重做 ——
    add(makeBtn({ key: 'undo', html: ICONS.undo, tip: '撤销 (Ctrl+Z)', onClick: () => exec('undo') }));
    add(makeBtn({ key: 'redo', html: ICONS.redo, tip: '重做 (Ctrl+Y)', onClick: () => exec('redo') }));
    addSep();

    // —— 作品 / 表情 / 图片（复用站点原生选择器，保证上传与图盘逻辑一致）——
    add(makeBtn({ key: 'work', html: I(SITE_LABELS.work, ICONS.image), tip: 'Kitten 作品分享', onClick: () => delegateSiteAction(SITE_LABELS.work, 'Kitten 作品分享') }));
    add(makeBtn({ key: 'emoji', html: I(SITE_LABELS.emoji, ICONS.text('☺')), tip: '添加表情', onClick: () => delegateSiteAction(SITE_LABELS.emoji, '添加表情') }));
    add(makeBtn({ key: 'image', html: I(SITE_LABELS.image, ICONS.image), tip: '插入图片', onClick: () => delegateSiteAction(SITE_LABELS.image, '插入图片') }));
    addSep();

    // —— 行内样式 ——
    add(makeBtn({ key: 'bold', html: I(SITE_LABELS.bold, ICONS.text('B')), tip: '加粗 (Ctrl+B)', onClick: () => exec('bold') }));
    add(makeBtn({ key: 'italic', html: I(SITE_LABELS.italic, ICONS.text('I', 'font-style:italic')), tip: '斜体 (Ctrl+I)', onClick: () => exec('italic') }));
    add(makeBtn({ key: 'strike', html: I(SITE_LABELS.strike, ICONS.text('S', 'text-decoration:line-through')), tip: '删除线', onClick: () => exec('strikeThrough') }));
    add(makeBtn({ key: 'underline', html: I(SITE_LABELS.underline, ICONS.text('U', 'text-decoration:underline;text-underline-offset:2px')), tip: '下划线 (Ctrl+U)', onClick: () => exec('underline') }));
    addSep();

    // —— 标题 ——
    add(makeBtn({ key: 'h1', html: I(SITE_LABELS.h1, ICONS.text('H1')), tip: '一级标题', onClick: () => toggleHeading(1) }));
    add(makeBtn({ key: 'h2', html: I(SITE_LABELS.h2, ICONS.text('H2')), tip: '二级标题', onClick: () => toggleHeading(2) }));
    add(makeBtn({ key: 'h3', wide: true, html: 'H3', tip: '三级标题', onClick: () => toggleHeading(3) }));
    add(makeBtn({ key: 'h4', wide: true, html: 'H4', tip: '四级标题', onClick: () => toggleHeading(4) }));
    addSep();

    // —— 颜色 / 高亮 ——
    add(makeBtn({ key: 'color', html: ICONS.color, tip: '文字颜色', onClick: (b) => openPalette(b, 'color') }));
    add(makeBtn({ key: 'highlight', html: ICONS.highlight, tip: '文字背景高亮', onClick: (b) => openPalette(b, 'bg') }));
    addSep();

    // —— 列表 ——
    add(makeBtn({ key: 'ul', html: I(SITE_LABELS.ul, ICONS.ul), tip: '无序列表', onClick: () => exec('insertUnorderedList') }));
    add(makeBtn({ key: 'ol', html: I(SITE_LABELS.ol, ICONS.ol), tip: '有序列表', onClick: () => exec('insertOrderedList') }));
    add(makeBtn({ key: 'task', html: I(SITE_LABELS.task, ICONS.ul), tip: '任务列表', onClick: insertTaskList }));
    addSep();

    // —— 引用 / 代码 ——
    add(makeBtn({ key: 'quote', html: I(SITE_LABELS.quote, ICONS.quote), tip: '引用块', onClick: () => exec('formatBlock', 'blockquote') }));
    add(makeBtn({ key: 'inlinecode', html: I(SITE_LABELS.inlinecode, ICONS.code), tip: '行内代码', onClick: insertInlineCode }));
    add(makeBtn({
      key: 'codeblock', html: I(SITE_LABELS.codeblock, ICONS.code), tip: '代码块',
      onClick: () => {
        const sel = getSelectedText();
        insertHtml('<pre><code>' + escapeHtml(sel) + '</code></pre><p><br></p>');
        richToSource();
      }
    }));
    addSep();

    // —— 链接 / 表格 / 公式 / 分割线 ——
    add(makeBtn({
      key: 'link', html: I(SITE_LABELS.link, ICONS.link), tip: '插入链接',
      onClick: () => {
        const url = window.prompt('请输入链接地址：', 'https://');
        if (!url) return;
        const u = safeUrl(url);
        if (!u) { toast('链接地址不合法，请检查后重试'); return; }
        if (getSelectedText()) exec('createLink', u);
        else insertHtml('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(u) + '</a>');
        richToSource();
      }
    }));
    add(makeBtn({ key: 'table', html: I(SITE_LABELS.table, ICONS.table), tip: '插入表格', onClick: insertTable }));
    add(makeBtn({ key: 'mathinline', html: I(SITE_LABELS.mathinline, ICONS.mathInline), tip: '行内公式', onClick: insertInlineMath }));
    add(makeBtn({ key: 'mathblock', html: I(SITE_LABELS.mathblock, ICONS.mathBlock), tip: '块级公式', onClick: insertBlockMath }));
    add(makeBtn({ key: 'hr', html: I(SITE_LABELS.hr, ICONS.hr), tip: '分割线', onClick: () => { insertHtml('<hr><p><br></p>'); richToSource(); } }));
    addSep();

    // —— 对齐 ——
    add(makeBtn({ key: 'align-left', html: ICONS.alignLeft, tip: '左对齐', onClick: () => exec('justifyLeft') }));
    add(makeBtn({ key: 'align-center', html: ICONS.alignCenter, tip: '居中对齐', onClick: () => exec('justifyCenter') }));
    add(makeBtn({ key: 'align-right', html: ICONS.alignRight, tip: '右对齐', onClick: () => exec('justifyRight') }));
    addSep();

    // —— 清除格式 / 全屏 ——
    add(makeBtn({ key: 'clear', html: ICONS.clear, tip: '清除格式', onClick: () => exec('removeFormat') }));
    add(makeBtn({ key: 'fullscreen', html: I(SITE_LABELS.fullscreen, ICONS.fullscreen), tip: '全屏编辑', onClick: toggleFullscreen }));

    root.appendChild(bar);

    // —— 编辑区 ——
    const wrap = document.createElement('div');
    wrap.className = NS + '-editor-wrap';
    editor = document.createElement('div');
    editor.className = NS + '-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('spellcheck', 'false');
    editor.setAttribute('data-placeholder', '在这里开始写你的帖子…支持加粗、标题、列表、图片等，排版所见即所得');
    wrap.appendChild(editor);
    root.appendChild(wrap);

    // —— 新手提示条（可关闭，记忆状态）——
    if (localStorage.getItem(HINT_KEY) !== '1') {
      const hint = document.createElement('div');
      hint.className = NS + '-hint';
      hint.innerHTML = '<span>💡</span><span><b>新手提示：</b>直接在上方编辑区输入即可，选中文字会弹出快捷格式菜单；' +
        '切换「源码」可查看 Markdown，两边实时同步。粘贴 Word / 网页内容会自动清理格式。</span>';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = NS + '-hint-close';
      close.innerHTML = '&times;';
      close.title = '不再显示';
      close.addEventListener('click', () => { localStorage.setItem(HINT_KEY, '1'); hint.remove(); });
      hint.appendChild(close);
      root.appendChild(hint);
    }

    bindEditorEvents();
    return root;
  }

  // ============================ 6. 事件绑定 ============================

  function bindEditorEvents() {
    // 输入 → 同步到 Markdown 源码
    editor.addEventListener('input', () => { richToSource(); updateFloatMenu(); });
    editor.addEventListener('blur', () => setTimeout(closeFloatMenu, 180));

    // 任务列表：点击左侧复选框区域切换勾选状态（复选框由 CSS 伪元素绘制在 li 左侧）
    editor.addEventListener('click', (e) => {
      const li = e.target.closest && e.target.closest('li.' + NS + '-task-item');
      if (!li || !editor.contains(li)) return;
      const rect = li.getBoundingClientRect();
      if (e.clientX - rect.left > 24) return; // 点在正文上，交给正常编辑
      e.preventDefault();
      li.dataset.checked = li.dataset.checked === '1' ? '0' : '1';
      richToSource();
    });

    // 键盘快捷键兜底（部分浏览器 contenteditable 对 Ctrl+B 等支持不一致）
    editor.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); exec('bold'); }
      else if (k === 'i') { e.preventDefault(); exec('italic'); }
      else if (k === 'u') { e.preventDefault(); exec('underline'); }
    });

    // 粘贴：拦截并净化
    editor.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      // 粘贴的是图片/文件：contenteditable 无法直接上传，给出明确引导，避免插入失效的 blob 链接
      if (cd.files && cd.files.length) {
        e.preventDefault();
        toast('暂不支持直接粘贴图片文件，请点击工具栏「插入图片」并填写图片链接');
        return;
      }
      e.preventDefault();
      try {
        const html = cd.getData('text/html');
        const text = cd.getData('text/plain');
        let clean;
        if (html && html.trim()) clean = sanitizeHtml(html);
        else clean = textToHtml(text);
        // 净化后若为空，退化为纯文本，保证不丢内容
        if (!clean || !clean.replace(/<[^>]*>/g, '').trim()) clean = textToHtml(text);
        insertHtml(clean);
        richToSource();
      } catch (err) {
        // 任何异常都不阻断输入：退化为纯文本插入
        const text = cd.getData('text/plain') || '';
        insertHtml(textToHtml(text));
        richToSource();
      }
    });

    // 选中 → 显示浮动快捷菜单；并刷新工具栏选中态
    document.addEventListener('selectionchange', () => {
      if (!editor) return;
      if (document.activeElement === editor || editor.contains(window.getSelection() && window.getSelection().anchorNode)) {
        refreshToolbarState();
      }
    });
    editor.addEventListener('mouseup', () => setTimeout(updateFloatMenu, 0));
    editor.addEventListener('keyup', () => setTimeout(updateFloatMenu, 0));

    // 点击面板外关闭浮层
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest && (e.target.closest('.' + NS + '-pop') || e.target.closest('.' + NS + '-float') || e.target.closest('.' + NS + '-toolbar'))) return;
      closePopups();
    });
    window.addEventListener('resize', closeFloatMenu);
    window.addEventListener('scroll', closeFloatMenu, true);
  }

  // —— 选中浮动快捷菜单 ——
  let floatEl = null;
  function closeFloatMenu() {
    if (floatEl) { floatEl.remove(); floatEl = null; }
  }

  /** 创建浮动菜单。只在选中出现时创建一次并复用，避免拖动选择时反复重建导致入场动画闪烁。 */
  function buildFloatMenu() {
    const el = document.createElement('div');
    el.className = NS + '-float';
    const mk = (html, tip, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = html;
      b.title = tip;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.preventDefault(); fn(); closeFloatMenu(); });
      return b;
    };
    el.appendChild(mk(ICONS.text('B'), '加粗', () => exec('bold')));
    el.appendChild(mk(ICONS.text('I', 'font-style:italic'), '斜体', () => exec('italic')));
    el.appendChild(mk(ICONS.text('U', 'text-decoration:underline;text-underline-offset:2px'), '下划线', () => exec('underline')));
    el.appendChild(mk(ICONS.text('S', 'text-decoration:line-through'), '删除线', () => exec('strikeThrough')));
    const sp = document.createElement('span'); sp.className = 'sep'; el.appendChild(sp);
    el.appendChild(mk(ICONS.link, '插入链接', () => {
      const url = window.prompt('请输入链接地址：', 'https://');
      if (!url) return;
      const u = safeUrl(url);
      if (!u) { toast('链接地址不合法，请检查后重试'); return; }
      exec('createLink', u);
    }));
    el.appendChild(mk(ICONS.clear, '清除格式', () => exec('removeFormat')));
    return el;
  }

  function updateFloatMenu() {
    if (mode === 'source') { closeFloatMenu(); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { closeFloatMenu(); return; }
    if (!editor.contains(sel.anchorNode)) { closeFloatMenu(); return; }
    if (!sel.toString().trim()) { closeFloatMenu(); return; }

    // 同一个选中过程里复用同一个节点：入场动画只在它首次出现时播一次
    if (!floatEl) {
      floatEl = buildFloatMenu();
      document.body.appendChild(floatEl);
    }

    // 定位到选区上方
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const w = floatEl.offsetWidth;
    let left = window.scrollX + rect.left + rect.width / 2 - w / 2;
    let top = window.scrollY + rect.top - floatEl.offsetHeight - 8;
    left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 8));
    if (top < window.scrollY + 4) top = window.scrollY + rect.bottom + 8;
    floatEl.style.left = left + 'px';
    floatEl.style.top = top + 'px';
  }

  // ============================ 7. 双向同步 ============================

  /** 把 textarea 的值写回（兼容 Vue / React 等受控组件） */
  function setTextareaValue(val) {
    const proto = Object.getPrototypeOf(textarea);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(textarea, val);
    else textarea.value = val;
    // 派发 input 事件，让框架把新值同步进组件状态（提交时才会用最新内容）
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    lastTaValue = val;   // 记下这是脚本自己写入的，避免被外部变化检测误判
  }

  /** 富文本 → Markdown 源码 */
  function richToSource() {
    if (lock || !editor || !textarea) return;
    lock = true;
    try {
      const md = htmlToMd(editor);
      if (textarea.value !== md) setTextareaValue(md);
    } finally {
      lock = false;
    }
  }

  /** Markdown 源码 → 富文本 */
  function sourceToRich() {
    if (lock || !editor || !textarea) return;
    lock = true;
    try {
      const html = mdToHtml(textarea.value);
      if (editor.innerHTML !== html) editor.innerHTML = html;
    } finally {
      lock = false;
    }
  }

  /** 切换视图模式 */
  function setMode(next) {
    // 任何视图切换都先清掉上一轮遗留的「自动切回」监听，避免之后被意外触发
    if (pendingBack) {
      textarea && textarea.removeEventListener('input', pendingBack);
      pendingBack = null;
    }
    mode = next;
    if (!root) return;
    root.querySelectorAll('.' + NS + '-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.mode === next));
    const showToolbar = next !== 'source';
    root.querySelector('.' + NS + '-toolbar').classList.toggle(NS + '-hidden', !showToolbar);
    const wrap = root.querySelector('.' + NS + '-editor-wrap');
    wrap.classList.toggle(NS + '-hidden', !showToolbar);
    // 重播一次淡入动画（先移除再强制回流后加回，保证每次切换都能触发）
    if (showToolbar) {
      wrap.classList.remove(NS + '-fade');
      void wrap.offsetWidth;
      wrap.classList.add(NS + '-fade');
    }
    // 站点原生编辑器容器：可视化模式下整体隐藏（避免残留白色色块），
    // 需要用到站点弹窗时由 delegateSiteAction 临时切到源码视图再显示。
    if (origWrapper) origWrapper.classList.toggle(NS + '-native-collapsed', next === 'rich');

    if (next === 'source') {
      // 以富文本为准，刷新源码，并把焦点交给原生输入框
      richToSource();
      closeFloatMenu();
      setTimeout(() => textarea && textarea.focus(), 0);
    } else if (next === 'split') {
      // 分屏：以富文本为准刷新源码，两边同时可见
      richToSource();
    } else {
      // 回到可视化：以源码为准刷新富文本（用户可能刚在源码里改过）
      sourceToRich();
    }
  }

  // ============================ 8. 挂载与 SPA 监听 ============================

  function findTextarea() {
    return document.querySelector('textarea#post-content') ||
      document.querySelector('textarea[name="content"]') ||
      document.querySelector('form textarea') ||
      document.querySelector('textarea');
  }

  function mount() {
    if (!isEditorPage()) return;
    const ta = findTextarea();
    if (!ta) return;
    if (ta.offsetParent === null && !ta.closest('form')) return; // 尚未真正渲染

    const wired = ta.dataset[MOUNT_FLAG] === '1';
    const panelAlive = root && document.body.contains(root);
    if (wired && panelAlive) return;   // 已挂载且面板健在，无需处理

    textarea = ta;

    if (!wired) {
      // 首次为这个 textarea 挂载：注入样式、统一编辑行为、绑定一次性事件
      ta.dataset[MOUNT_FLAG] = '1';
      injectStyle();

      // 统一编辑行为：回车生成 <p>（利于转成 Markdown 段落），颜色类命令用 span 内联样式
      try {
        document.execCommand('defaultParagraphSeparator', false, 'p');
        document.execCommand('styleWithCSS', false, true);
      } catch (e) { /* noop */ }

      // 源码侧输入 → 同步到富文本。
      // 注意：站点原生功能（作品分享 / 表情 / 图片等）会在任意模式下把内容写回 textarea，
      // 所以这里不按 mode 过滤，统一同步回富文本；sourceToRich 内部有 lock 保护。
      ta.addEventListener('input', () => { lastTaValue = ta.value; sourceToRich(); });

      // 提交前兜底：确保 Markdown 已写入 textarea
      const form = ta.closest('form');
      if (form) form.addEventListener('submit', () => { richToSource(); }, true);
    } else {
      // 已挂载过，但面板被站点重渲染移除了（编辑帖子页加载内容后很常见）——
      // 清掉旧节点，下面重建一个新的，否则会表现为「脚本完全不生效」。
      if (root && root.parentElement) root.parentElement.removeChild(root);
      root = null;
    }

    // 定位站点原生编辑器容器（工具栏 + 输入框 的公共父级）
    origWrapper = ta.parentElement && ta.parentElement.parentElement ? ta.parentElement.parentElement : ta.parentElement;
    if (origWrapper && !origWrapper.querySelector('[role="toolbar"]')) {
      // 结构不符时退回到直接父级，保证“插到编辑器上方”依然成立
      origWrapper = ta.parentElement;
    }

    // 构建面板并插到原生编辑器上方
    const panel = buildPanel();
    if (origWrapper && origWrapper.parentElement) {
      origWrapper.parentElement.insertBefore(panel, origWrapper);
    } else {
      ta.parentElement.insertBefore(panel, ta);
    }

    // 用当前 textarea 内容渲染富文本（编辑页会带出已有帖子内容）
    editor.innerHTML = ta.value && ta.value.trim() ? mdToHtml(ta.value) : '';
    lastTaValue = ta.value;

    // 默认进入可视化模式
    setMode('rich');
  }

  // 页面可能异步渲染，用轮询 + MutationObserver 双保险
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    mount();
    if ((root && document.body.contains(root)) || tries > 60) clearInterval(timer);
  }, 400);

  const observer = new MutationObserver(debounce(() => {
    if (!isEditorPage()) return;
    mount();
  }, 300));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 常驻看护 1：面板被站点重渲染移除时自动重建。
  // 编辑帖子页会先加载帖子数据再渲染编辑器，Vue 重渲染容易把注入的节点冲掉，
  // 只靠「已挂载」标记会导致面板消失后不再恢复（表现为脚本完全不生效）。
  setInterval(() => {
    if (!isEditorPage()) return;
    if (!root || !document.body.contains(root)) mount();
  }, 1200);

  // 常驻看护 2：框架（Vue v-model）可能直接改写 textarea.value 且不派发 input，
  // 这里做兜底同步；脚本自己写入的值记录在 lastTaValue，不会被误判为外部变化。
  setInterval(() => {
    if (!textarea || !editor) return;
    if (textarea.value !== lastTaValue) {
      lastTaValue = textarea.value;
      if (mode !== 'source') sourceToRich();
    }
  }, 700);

  // 初始尝试
  mount();

  // 暴露一个调试句柄，便于排查（不影响站点）
  window.__pickcatRichEditor = {
    mount,
    mdToHtml,
    htmlToMd,
    sanitizeHtml,
    get editor() { return editor; },
    get textarea() { return textarea; }
  };
})();
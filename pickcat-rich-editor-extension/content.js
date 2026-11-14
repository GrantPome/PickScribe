

/*
 * 设计说明（便于后续维护）
 * 1. 只做“前端增强”：最终仍然把标准 Markdown 字符串写回原来的 textarea#post-content，
 *    并派发 input 事件，让 Nuxt(Vue) 的 v-model 同步到组件状态，完全复用站点原有提交逻辑。
 * 2. 富文本区用 contenteditable + document.execCommand 实现，零第三方依赖，体积小、加载快。
 * 3. Markdown ↔ HTML 的转换全部自研，覆盖工具栏涉及的全部格式；对颜色/高亮/对齐这类
 *    Markdown 标准之外的样式，用内联 HTML（<span style>、<u>、<p style="text-align">）承载，
 *    保证“所见即所得”且格式不丢失。
 * 4. UI 直接复用站点设计令牌（Nuxt UI 的 --ui-primary / --ui-bg / --ui-text /
 *    --ui-border / --ui-radius 等，并对旧版 --ui-accent 等令牌兜底），站点切换浅色 / 深色主题时令牌随之翻转，
 *    面板自动跟随，无需硬编码配色。
 * 5. 可选把整站字体替换为鸿蒙字体（HarmonyOS Sans，本扩展自带 woff2，覆盖站点 --font-sans 令牌），
 *    默认开启，面板右上角可随时切回站点原字体；等宽字体与 KaTeX 数学字体不受影响。
 * 6. 这是 Chrome 扩展（Manifest V3）的 content script，由早期油猴脚本迁移而来；版本号见 manifest.json。
 */

(function () {
  'use strict';

  // 扩展被重载 / 更新后，旧内容脚本里的异步 chrome.* 调用会以
  // "Extension context invalidated" 拒绝；这是预期内的噪音，直接吞掉。
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  // ============================ 0. 基础常量与工具 ============================

  const NS = 'pcr';                       // 样式与类名统一前缀，避免污染站点样式
  const MOUNT_FLAG = 'pcrMounted';        // textarea 上的挂载标记，防止重复注入
  const HINT_KEY = 'pcr_hint_closed';     // 新手提示是否已关闭
  const TOOLBAR_KEY = 'pcr_toolbar_style'; // 工具栏布局：compact（默认，紧凑单行）| line（仅分割线）| groups（仿 Word 功能组）
  const FONT_KEY = 'pcr_harmony_font';    // 字体增强总开关：由设置页写入 chrome.storage.local，默认开启
  const FONT_MODE_KEY = 'pcr_font_mode';  // 字体来源：'harmony'（内置鸿蒙）| 'custom'（用户上传）
  const FONT_CUSTOM_KEY = 'pcr_custom_font'; // 自定义字体描述符：{ faces:[{ id, name, size, weight }] }
  const FONT_STYLE_ID = NS + '-font-style'; // 字体样式节点 id，开关与兜底恢复都靠它定位
  const RADIUS_KEY = 'pcr_g2_radius';      // 全站 G2 圆角开关：默认开启，关掉恢复站点原圆角
  const RADIUS_STYLE_ID = NS + '-g2-style'; // G2 圆角样式节点 id
  let fontOn = true;                       // 字体增强开关状态（设置页写入 storage.local）
  let radiusOn = true;                     // G2 圆角开关状态
  let fontMode = 'harmony';                // 当前字体来源
  let customSpec = null;                   // 自定义字体描述符（字体字节在扩展域 IndexedDB）

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

    // 3.5) 站点「插入哔哩哔哩视频」写进源码的是一段裸播放器地址
    //      （https://player.bilibili.com/player.html?bvid=BV...&autoplay=0）。
    //      必须在下面的 HTML 转义之前处理，否则地址里的 & 会被转成 &amp;，
    //      写回源码时就变成了错的链接。这里转成视频占位块，写回时输出原地址，
    //      站点才能继续把它渲染成视频播放器。
    s = s.replace(/https?:\/\/player\.bilibili\.com\/player\.html\?[^\s<>"'\u3002\uff09\uff0c\u3001]*/gi, (m) => {
      const bv = (m.match(/[?&](?:bvid|bvid2)=([0-9A-Za-z]+)/i) || [])[1] || '';
      return keep('<span class="' + NS + '-video-ref" contenteditable="false" data-url="' + escapeAttr(m) +
        '" title="哔哩哔哩视频（提交后由站点渲染为播放器）">哔哩哔哩视频' + (bv ? ' · ' + escapeHtml(bv) : '') + '</span>');
    });

    // 4) 转义剩余文本，避免与后续拼装的 HTML 冲突
    s = escapeHtml(s);

    // 5) 图片：![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
      const url = safeUrl(src);
      if (!url) return m;
      return keep('<img src="' + escapeAttr(url) + '" alt="' + escapeAttr(alt) + '"' +
        (title ? ' title="' + escapeAttr(title) + '"' : '') + '>');
    });

    // 5b) 站点自定义图片引用：![<id>]（无网址，由站点渲染时解析）。
    //     必须转成占位元素并原样保留 —— 若当普通文字处理，提交时方括号会被转义成 \!\[…\]，
    //     站点就再也认不出这个图片标记，图片会直接消失。
    s = s.replace(/!\[([0-9A-Za-z_-]{8,})\]/g, (m, id) =>
      keep('<span class="' + NS + '-img-ref" contenteditable="false" data-ref="' + escapeAttr(id) + '"' +
        ' title="图片引用：' + escapeAttr(id) + '（提交后由站点渲染）">图片</span>'));

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

    // 站点自定义图片引用：原样写回 ![<id>]，绝不能转义，否则站点无法再识别
    if (node.classList && node.classList.contains(NS + '-img-ref')) {
      const ref = node.getAttribute('data-ref') || '';
      return ref ? '![' + ref + ']' : '';
    }

    // 哔哩哔哩视频占位块：原样写回站点写入的播放器地址，站点才能继续渲染成视频
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

    // 站点图片引用占位块：保留引用 id，复制粘贴后依然能原样写回 ![<id>]
    if (tag === 'span' && node.classList && node.classList.contains(NS + '-img-ref')) {
      const ref = node.getAttribute('data-ref') || '';
      if (!ref) return doc.createDocumentFragment();
      const chip = doc.createElement('span');
      chip.className = NS + '-img-ref';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-ref', ref);
      chip.setAttribute('title', '图片引用：' + ref + '（提交后由站点渲染）');
      chip.textContent = '图片';
      return chip;
    }

    // 任务列表：保留勾选状态（class / data-checked），否则净化后 - [ ] 语义会丢失
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

    // 哔哩哔哩视频占位块：保留原始播放器地址，复制粘贴后依然能原样写回源码
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
    // 作品分享：立方体（项目 / 作品集），刻意与图片的相框、视频的播放框区分开
    work: svg('<path d="M12 3.4 20.1 7.7v8.6L12 20.6 3.9 16.3V7.7z"/><path d="M3.9 7.7 12 12l8.1-4.3"/><path d="M12 12v8.6"/>'),
    video: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10.4 9.2 14.9 12l-4.5 2.8z" fill="currentColor" stroke="none"/>'),
    hr: svg('<path d="M3 12h18"/><path d="M6.5 8.5v7M12 8.5v7M17.5 8.5v7" stroke-dasharray="1 2.5"/>'),
    alignLeft: svg('<path d="M3 6h18M3 10h12M3 14h18M3 18h12"/>'),
    alignCenter: svg('<path d="M3 6h18M6 10h12M3 14h18M6 18h12"/>'),
    alignRight: svg('<path d="M3 6h18M9 10h12M3 14h18M9 18h12"/>'),
    table: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4.5v15M15 4.5v15"/>'),
    mathInline: svg('<path d="M4.5 8.5h5.5M7.25 8.5v7M4.5 15.5h5.5"/><path d="M14.5 9.5 18 15M18 9.5 14.5 15"/>'),
    mathBlock: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M6.5 9.5h6M6.5 12.5h9M6.5 15.5h6"/>'),
    fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    clear: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    layout: svg('<rect x="3" y="4.5" width="18" height="6" rx="1.6"/><rect x="3" y="13.5" width="18" height="6" rx="1.6"/>'),
    search: svg('<circle cx="10.7" cy="10.7" r="6.1"/><path d="m15.3 15.3 4.3 4.3"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1 .9-1 1.7v.2"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>'),
    rich: svg('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>'),
    split: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M12 4.5v15"/>'),
    source: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5h6M7 13.5h10"/>'),
    text: (t, style) => '<span class="pcr-glyph" style="' + (style || '') + '">' + t + '</span>'
  };

  // ============================ 4.1 鸿蒙字体（HarmonyOS Sans） ============================
  /* 整站换字体的思路：
     1. 字体文件随扩展分发（fonts/*.woff2），用 chrome.runtime.getURL 取到扩展内可访问 URL，
        所以 manifest.json 必须声明 web_accessible_resources，否则网页端加载不到这些字体。
     2. 站点把字体令牌统一挂在 :root 上（--font-sans，html 也直接引用它），因此只需覆盖这一个
        变量即可让正文 / 组件 / 本面板一起变成鸿蒙字体；--font-mono（代码块）与 KaTeX 数学
        字体不受影响，仍是各自专用字体。
     3. 字体是官方**可变字体**（VF，wght 轴 40–900）：一个文件覆盖全部字重，
        600 / 650 / 800 这些站点用到的中间字重可以精确渲染，不再按四档就近替代。
     4. 多语言：拉丁 / 希腊 / 西里尔用体积最小的 HarmonyOS Sans，中文用 SC 那份——
        它已包含繁体字形，因此不再单独带 TC 文件（繁体按简中字形显示，结构一致、笔形略有差异）；
        阿拉伯文单独一套 Naskh Arabic；浏览器逐字回退，缺字时自然落回系统字体，不会出现方框。
     5. 许可：HarmonyOS Sans 允许原样嵌入与再分发，但禁止修改字形与字符集，
        所以这里只做 TTF → WOFF2 的无损重封装，不做子集化。
     6. 开关：默认为开，状态存 localStorage；切换靠 <style disabled>，不增删节点、无需刷新页面。 */

  /** 各语言子字体族的字体文件与可用字重区间（阿拉伯文的轴下限是 100） */
  const FONT_FACES = [
    { family: 'HarmonyOS Sans PCR',        style: 'normal', file: 'HarmonyOS_Sans_VF.woff2',             range: '40 900' },
    { family: 'HarmonyOS Sans PCR',        style: 'italic', file: 'HarmonyOS_Sans_VF_Italic.woff2',      range: '40 900' },
    { family: 'HarmonyOS Sans SC PCR',     style: 'normal', file: 'HarmonyOS_Sans_SC_VF.woff2',          range: '40 900' },
    { family: 'HarmonyOS Sans Arabic PCR', style: 'normal', file: 'HarmonyOS_Sans_Naskh_Arabic_VF.woff2', range: '100 900' }
  ];

  /** 字体栈：鸿蒙各语言族在前，后面保留站点原有的系统兜底与 emoji 字体 */
  const FONT_STACK = "'HarmonyOS Sans PCR','HarmonyOS Sans SC PCR','HarmonyOS Sans Arabic PCR'," +
    "system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue'," +
    "'Noto Sans','Liberation Sans',Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji'," +
    "'Segoe UI Symbol','Noto Color Emoji'";

  /** 扩展内字体文件的可访问 URL；非扩展环境（油猴等）取不到，返回空串以便整体跳过注入 */
  function fontUrl(file) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL('fonts/' + file);
      }
    } catch (e) { /* noop */ }
    return '';
  }

  /** 字体增强是否开启（由设置页控制，默认开启） */
  function fontOnNow() {
    return fontOn;
  }

  /** 自定义字体的固定族名：用户上传的字体统一注册成这个名字，避免与站点字体撞名 */
  const CUSTOM_FAMILY = 'PCR Custom Font';

  /** 已注册到当前文档的自定义字体，切换 / 关闭时逐个移除 */
  let customFaces = [];

  /** 生成 @font-face 与 --font-sans 覆盖样式；custom 为 true 时把自定义字体排在最前 */
  function fontCss(custom) {
    const faces = [];
    FONT_FACES.forEach((f) => {
      const url = fontUrl(f.file);
      if (!url) return;
      // font-weight 写区间：可变字体声明自己覆盖 40–900 的连续字重
      faces.push('@font-face{font-family:\'' + f.family + '\';font-style:' + f.style +
        ';font-weight:' + f.range + ';font-display:swap;src:url("' + url + '") format(\'woff2\');}');
    });
    if (!faces.length) return '';
    // !important 压过站点（Nuxt UI / Tailwind）的令牌声明；未分层样式本身就优先于 @layer 内的声明
    const stack = custom ? "'" + CUSTOM_FAMILY + "'," + FONT_STACK : FONT_STACK;
    faces.push(':root{--font-sans:' + stack + ' !important;}');
    return faces.join('\n');
  }

  /**
   * 通过隐藏 iframe 从扩展域 IndexedDB 取用户上传的字体字节。
   * 走 MessageChannel 的私有端口：网页主世界的脚本拿不到端口，字体数据不会被页面读走。
   * 任何一步失败都返回空数组，由调用方回退到鸿蒙字体。
   */
  function loadCustomFaces(spec) {
    return new Promise((resolve) => {
      let url = '';
      try { url = chrome.runtime.getURL('shared/font-host.html'); } catch (e) { url = ''; }
      if (!url || !spec || !Array.isArray(spec.faces) || !spec.faces.length) return resolve([]);

      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';

      let done = false;
      const finish = (faces) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        iframe.remove();
        resolve(faces);
      };
      const timer = setTimeout(() => finish([]), 5000);

      iframe.addEventListener('load', () => {
        try {
          const ch = new MessageChannel();
          let asked = false;
          ch.port1.onmessage = (ev) => {
            const d = ev.data || {};
            if (d.ready && !asked) {
              asked = true;
              ch.port1.postMessage({ ids: spec.faces.map((f) => f.id) });
              return;
            }
            if (!Array.isArray(d.faces)) return;
            const list = [];
            d.faces.forEach((item) => {
              const meta = spec.faces.find((f) => f.id === item.id);
              if (!item.buffer || !meta) return;
              try {
                list.push(new FontFace(CUSTOM_FAMILY, item.buffer, {
                  weight: meta.weight || '400',
                  style: 'normal',
                  display: 'swap'
                }));
              } catch (e) { /* 单个文件损坏时跳过，不影响其余字重 */ }
            });
            finish(list);
          };
          iframe.contentWindow.postMessage({ __pcrFontInit: true }, '*', [ch.port2]);
        } catch (e) {
          finish([]);
        }
      });

      iframe.src = url;
      (document.body || document.documentElement).appendChild(iframe);
    });
  }

  /** 注入 / 更新字体样式节点，并同步当前开关状态 */
  function injectFontStyle(custom) {
    let style = document.getElementById(FONT_STYLE_ID);
    const css = fontCss(!!custom);
    if (!css) return;
    if (!style) {
      style = document.createElement('style');
      style.id = FONT_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
    applyFontState();
  }

  /** 开关状态直接落到样式节点的 disabled 上，切换即时生效且可逆 */
  function applyFontState() {
    const el = document.getElementById(FONT_STYLE_ID);
    if (el) el.disabled = !fontOnNow();
  }

  /**
   * 应用当前字体配置：
   * 先按鸿蒙字体渲染（保证首屏不空），自定义字体就绪后再把栈顶换成它；
   * 自定义字体取不到时静默保留鸿蒙，不会让整站掉回系统默认字体。
   */
  async function applyFontConfig() {
    if (customFaces.length) {
      customFaces.forEach((f) => { try { document.fonts.delete(f); } catch (e) { /* noop */ } });
      customFaces = [];
    }
    injectFontStyle(false);
    if (fontMode !== 'custom') return;
    if (!customSpec || !Array.isArray(customSpec.faces) || !customSpec.faces.length) return;

    const faces = await loadCustomFaces(customSpec);
    if (!faces.length) return;
    faces.forEach((f) => document.fonts.add(f));
    customFaces = faces;
    injectFontStyle(true);
    faces.forEach((f) => { f.load().catch(() => null); });
  }

  /**
   * 读取字体设置（默认鸿蒙），并在设置页改动后即时应用：
   * pcr_harmony_font —— 字体增强总开关
   * pcr_font_mode    —— 'harmony' | 'custom'
   * pcr_custom_font  —— { faces:[{ id, name, size, weight }] }
   */
  function loadFontSetting() {
    try {
      chrome.storage.local.get([FONT_KEY, FONT_MODE_KEY, FONT_CUSTOM_KEY], (raw) => {
        fontOn = raw[FONT_KEY] !== false && raw[FONT_KEY] !== '0';
        fontMode = raw[FONT_MODE_KEY] === 'custom' ? 'custom' : 'harmony';
        customSpec = raw[FONT_CUSTOM_KEY] || null;
        applyFontConfig();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[FONT_KEY] && !changes[FONT_MODE_KEY] && !changes[FONT_CUSTOM_KEY]) return;
        if (changes[FONT_KEY]) {
          const v = changes[FONT_KEY].newValue;
          fontOn = v !== false && v !== '0';
        }
        if (changes[FONT_MODE_KEY]) {
          fontMode = changes[FONT_MODE_KEY].newValue === 'custom' ? 'custom' : 'harmony';
        }
        if (changes[FONT_CUSTOM_KEY]) {
          customSpec = changes[FONT_CUSTOM_KEY].newValue || null;
        }
        applyFontConfig();
      });
    } catch (e) {
      // 非扩展环境（油猴等）不支持 storage，沿用默认开启
    }
  }

  /**
   * 全站 G2 圆角（曲率连续，squircle）。
   *
   * 只改转角轮廓、不改半径数值：`corner-shape` 与现有 border-radius 叠加。
   * 注意：这里绝不能写成 `*` 全量命中——图片、视频、画布等大元素一旦也要
   * 生成圆角遮罩，显存 / 内存会明显上涨。因此只挑「面」与控件，
   * 并用 :where(:not(img, video, canvas)) 排除媒体元素（不增加选择器权重）。
   * CSS 无法按计算后的半径筛选，所以「保圆名单」按类名兜住头像、圆形图标、
   * 胶囊按钮与开关圆点这些不该变形的写法；帖子浮层容器（.pco-shell）体量大、
   * 遮罩合成最贵，单独排除。
   * 不支持的浏览器会整段忽略 @supports，自动保持站点原圆角。
   */
  const G2_RADIUS_CSS = `
@supports (corner-shape: squircle) {
  :is(button, input, textarea, select,
      [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"],
      [class*="rounded-lg"], [class*="rounded-xl"], [class*="rounded-2xl"], [class*="rounded-3xl"],
      [class*="card"], [class*="panel"], [class*="modal"], [class*="dialog"],
      [class*="popover"], [class*="dropdown"], [class*="sheet"],
      [class*="pco-"], [class*="pcr-"], [class*="pch-"], [class*="pcs-"],
      [class*="pcg-"], [class*="pcai-"], [class*="pcrr-"]):where(:not(img, video, canvas)) {
    corner-shape: squircle;
  }
  :is([class*="rounded-full"], [class*="rounded-pill"], [class*="pill"],
      [class*="avatar"], [class*="circle"], [class*="dot"], [class*="switch"],
      [class*="btn"], [class*="button"], [class*="chip"], [class*="tag"],
      [class*="ghost"], [class*="primary"], [class*="toast"], [class*="wave"]),
  .pcg-dots i { corner-shape: round; }
  /* 帖子浮层容器体量最大，曲率连续圆角的遮罩合成开销也最明显，单独排除，保持站点原圆角 */
  #pco-root .pco-shell { corner-shape: round; }
}
`;

  /** 注入 G2 圆角样式；开关状态直接落到 disabled 上，切换即时生效且可逆 */
  function injectRadiusStyle() {
    let style = document.getElementById(RADIUS_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = RADIUS_STYLE_ID;
      style.textContent = G2_RADIUS_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    applyRadiusState();
  }

  function applyRadiusState() {
    const el = document.getElementById(RADIUS_STYLE_ID);
    if (el) el.disabled = !radiusOn;
  }

  /**
   * 读取 G2 圆角开关（默认开启），并跟随设置页改动即时切换：
   * pcr_g2_radius —— 布尔
   */
  function loadRadiusSetting() {
    try {
      chrome.storage.local.get([RADIUS_KEY], (raw) => {
        radiusOn = raw[RADIUS_KEY] !== false && raw[RADIUS_KEY] !== '0';
        applyRadiusState();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[RADIUS_KEY]) return;
        const v = changes[RADIUS_KEY].newValue;
        radiusOn = v !== false && v !== '0';
        applyRadiusState();
      });
    } catch (e) {
      // 非扩展环境（油猴等）不支持 storage，沿用默认开启
    }
  }

  /** 站点令牌 + 兜底色，注入到 <head> 一次即可 */
  function injectStyle() {
    // 用独立 id：PICKCAT Plus 等同类扩展也用 `pcr-style`，共用 id 会互相跳过注入 / 互相删除
    if (document.getElementById(NS + '-style-pcs')) return;
    const css = `
/* CSS 变量定义在 :root 上：帮助浮层 / 提示条等是挂到 body 的，
   不在 .pcr-root 内部，只有定义在 :root 才能取到这些变量，
   否则 var(--pcr-surface) 失效会导致背景透明。

   这里直接映射站点真实设计令牌（Nuxt UI 的 --ui-* 体系）：
   站点把令牌挂在 <html> 上，并按 [data-theme=light|dark|system] 翻转，
   因此深浅色切换时 --pcr-* 会随站点令牌一起自动翻转，面板无需额外 JS 监听。
   括号内为站点令牌缺失时的兜底浅色值。 */
:root{
  --pcr-accent: var(--ui-primary, var(--ui-accent, #fa322d));
  --pcr-accent-soft: color-mix(in oklab, var(--pcr-accent) 12%, transparent);
  --pcr-border: var(--ui-border, #d4dbe4);
  --pcr-surface: var(--ui-bg-elevated, var(--ui-surface, #ffffff));
  --pcr-surface-hover: color-mix(in oklab, var(--pcr-text) 7%, transparent);
  --pcr-canvas: var(--ui-bg-muted, var(--ui-canvas, #f3f4f6));
  --pcr-text: var(--ui-text, var(--ui-foreground, #171717));
  --pcr-subtle: var(--ui-text-muted, var(--ui-muted, #5f6875));
  --pcr-error: var(--ui-error, #dc2626);
  --pcr-r-surface: var(--ui-radius, .5rem);
  --pcr-r-control: var(--ui-radius-sm, .375rem);
  --pcr-font: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  /* 写作区纸面底色：跟随站点页面底色（浅色纯白、深色深底），与卡片背景一致，避免深浅色下与周边色块割裂 */
  --pcr-paper: var(--ui-bg, #ffffff);
  /* 全屏开合的补间令牌：沿用浮层 overlay.css 的口径（--pco-dur = 1 / 动画速度） */
  --pco-dur: 1;
  --pco-move: cubic-bezier(.16, 1.02, .32, 1);
  --pco-move-close: cubic-bezier(.3, .88, .26, 1);
}
.${NS}-root{
  font-family: var(--pcr-font);
  color: var(--pcr-text);
  margin-bottom: 12px;
  font-size: 14px;
  line-height: 1.6;
  box-sizing: border-box;
  max-width: 100%;
}
.${NS}-root *{box-sizing:border-box;}

/* —— 顶部：模式切换 + 状态 —— */
.${NS}-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;
  padding:4px 6px;background:transparent;border:0;flex-wrap:wrap;}
.${NS}-tabs{display:inline-flex;padding:3px;gap:2px;background:transparent;border:0;border-radius:var(--pcr-r-surface);}
.${NS}-tab{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--pcr-subtle);
  font:inherit;font-size:13px;padding:5px 12px;border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .26s cubic-bezier(.22,1,.36,1),color .26s;}
.${NS}-tab svg{width:15px;height:15px;}
.${NS}-tab:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-tab.is-on{background:var(--pcr-accent-soft);color:var(--pcr-accent);}
.${NS}-head-right{display:flex;align-items:center;gap:10px;}
/* 全屏模式（插件全屏或站点原生全屏）下隐藏视图切换滑块 */
.${NS}-no-tabs .${NS}-tabs{display:none;}
.${NS}-synced{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--pcr-subtle);}
.${NS}-synced .dot{width:6px;height:6px;border-radius:50%;background:#37c26b;box-shadow:0 0 0 3px rgba(55,194,107,.16);}
.${NS}-synced.is-busy .dot{background:var(--pcr-accent);box-shadow:0 0 0 3px var(--pcr-accent-soft);}

/* —— 工具栏 ——
   三种布局，只切换根节点类名、不重建 DOM，切换无闪烁：
   · 紧凑（默认）          ：单行按钮，组间只留一点空隙，无组名、无分割线
   · 分组线（tb-grouped）  ：组间细线 + 组高对齐，但不显示组名
   · 功能组（tb-grouped + tb-labels）：在分组线基础上再显示组名，仿 Word 功能区 */
.${NS}-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:5px 6px;
  background:transparent;border:0;border-bottom:1px solid var(--pcr-border);
  border-radius:0;}
.${NS}-group{display:flex;align-items:center;padding:0 4px;}
.${NS}-group-row{display:flex;align-items:center;gap:1px;}
.${NS}-group-label{display:none;}

/* 切换布局时给工具栏一次轻量淡入，避免硬切 */
@keyframes ${NS}TbSwap{from{opacity:.4;transform:translateY(-2px);}to{opacity:1;transform:none;}}
.${NS}-tb-anim{animation:${NS}TbSwap .32s cubic-bezier(.16,1,.3,1);}

/* 分组布局（分组线 / 功能组共用）：组间细线、组高对齐、窗口变窄时按组换行 */
.${NS}-root.${NS}-tb-grouped .${NS}-toolbar{align-items:stretch;gap:0;padding:6px 4px;}
.${NS}-root.${NS}-tb-grouped .${NS}-group{flex-direction:column;justify-content:space-between;
  align-items:center;padding:0 6px;border-right:1px solid var(--pcr-border);}
.${NS}-root.${NS}-tb-grouped .${NS}-group:last-child{border-right:0;}
.${NS}-root.${NS}-tb-grouped .${NS}-group-row{justify-content:center;}
/* 组名只在「功能组」下显示；「分组线」模式去掉分类文字，只保留分割线 */
.${NS}-root.${NS}-tb-grouped.${NS}-tb-labels .${NS}-toolbar{padding:6px 4px 2px;}
.${NS}-root.${NS}-tb-grouped.${NS}-tb-labels .${NS}-group{padding:0 6px 2px;}
.${NS}-root.${NS}-tb-grouped.${NS}-tb-labels .${NS}-group-label{display:block;font-size:10.5px;line-height:1;
  color:var(--pcr-subtle);opacity:.8;padding-top:4px;letter-spacing:.02em;
  user-select:none;pointer-events:none;}
.${NS}-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;border:0;border-radius:var(--pcr-r-control);background:transparent;
  color:var(--pcr-subtle);cursor:pointer;font:inherit;
  transition:background .24s cubic-bezier(.22,1,.36,1),color .24s;}
.${NS}-btn:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-btn:active{transform:scale(.94);}
.${NS}-btn.is-on{background:var(--pcr-accent-soft);color:var(--pcr-accent);}
/* 工具栏最右侧独立按钮（全屏）：用自动外边距把剩余空间全部吃掉 */
.${NS}-btn-end{margin-left:auto;}
.${NS}-glyph{font-size:14px;line-height:1;font-weight:700;font-family:Georgia,'Times New Roman',serif;}
.${NS}-glyph.italic{font-style:italic;font-weight:600;}
.${NS}-glyph.under{text-decoration:underline;text-underline-offset:2px;}
.${NS}-glyph.strike{text-decoration:line-through;}

/* 悬浮提示（新手引导）：单独挂在 body 上的浮层，由 JS 定位。
   站点卡片与编辑区普遍带 overflow:hidden，若用按钮的 ::after 定位，靠右按钮的提示会被容器边缘裁掉。 */
.${NS}-tip{position:fixed;z-index:10005;max-width:min(320px,calc(100vw - 16px));
  font-family:var(--pcr-font);font-size:12px;font-weight:400;line-height:1.5;text-align:center;
  background:#1f2328;color:#fff;padding:4px 8px;border-radius:6px;
  border:1px solid rgba(255,255,255,.12);  /* 深色页面上给暗色提示块留出边界，避免糊在一起 */
  opacity:0;pointer-events:none;transform:translateY(-3px);
  transition:opacity .24s,transform .24s cubic-bezier(.22,1,.36,1);}
.${NS}-tip.is-on{opacity:1;transform:translateY(0);}

/* —— 下拉框（标题 / 对齐 / 媒体 合并项）——
   触发器复用 .pcr-btn，只是宽度自适应并带一个小三角；菜单复用 .pcr-pop 浮层，仅覆盖列布局 */
.${NS}-dd{position:relative;display:inline-flex;}
.${NS}-dd-btn{width:auto;min-width:32px;padding:0 7px;gap:2px;}
.${NS}-dd-btn .${NS}-glyph{font-size:13px;}
.${NS}-dd-caret{width:0;height:0;margin-left:2px;border-left:3.5px solid transparent;
  border-right:3.5px solid transparent;border-top:4px solid currentColor;opacity:.65;}
.${NS}-pop.${NS}-dd-menu{display:flex;flex-direction:column;gap:1px;min-width:136px;padding:5px;
  transform-origin:top left;}
.${NS}-dd-item{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;
  color:var(--pcr-text);font:inherit;font-size:13px;padding:7px 9px;border-radius:var(--pcr-r-control);
  cursor:pointer;text-align:left;
  transition:background .2s cubic-bezier(.22,1,.36,1),color .2s;}
.${NS}-dd-item:hover{background:var(--pcr-surface-hover);}
.${NS}-dd-item.is-on{color:var(--pcr-accent);background:var(--pcr-accent-soft);}
.${NS}-dd-item svg{width:15px;height:15px;flex:none;}
.${NS}-dd-item .${NS}-glyph{font-size:12.5px;min-width:18px;text-align:center;}

/* —— 编辑区 —— */
.${NS}-editor-wrap{background:var(--pcr-paper);border:0;
  border-radius:0 0 var(--pcr-r-surface) var(--pcr-r-surface);overflow:hidden;}
/* 分屏对照：富文本区底部加横向分割线，与下方站点源码区区分（全屏左右对照时改为竖线） */
.${NS}-root.${NS}-is-split:not(.is-fullscreen) .${NS}-editor-wrap{border-bottom:1px solid var(--pcr-border);
  margin-bottom:10px;padding-bottom:4px;}
/* 编辑区容器：默认纵向，全屏分屏时改为左右两栏 */
.${NS}-row{display:flex;flex-direction:column;min-height:0;min-width:0;}
.${NS}-root.is-fullscreen .${NS}-row{flex:1;}
/* 全屏 + 分屏对照：插件编辑区在左，站点源码区在右 */
.${NS}-root.is-fullscreen.${NS}-fs-split .${NS}-row{flex-direction:row;}
.${NS}-root.is-fullscreen.${NS}-fs-split .${NS}-editor-wrap{flex:1 1 50%;min-width:0;border:0;
  border-right:1px solid var(--pcr-border);margin:0;padding:0;}
.${NS}-fs-native{flex:1 1 50%;min-width:0;overflow:auto;background:transparent;}
/* 切换视图时给编辑区一个轻微淡入，避免内容“硬切” */
@keyframes ${NS}FadeIn{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:translateY(0);}}
.${NS}-fade{animation:${NS}FadeIn .3s cubic-bezier(.16,1,.3,1) both;}
.${NS}-editor{min-height:320px;max-height:640px;overflow:auto;padding:16px 18px;outline:none;
  background:var(--pcr-paper);font-size:15px;line-height:1.75;color:var(--pcr-text);word-break:break-word;}
.${NS}-editor:empty::before{content:attr(data-placeholder);color:var(--pcr-subtle);opacity:.75;pointer-events:none;}
.${NS}-editor:focus{background:var(--pcr-paper);}
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
/* 站点自定义图片引用 ![<id>]（无网址，由站点渲染时解析）/ 哔哩哔哩视频播放器地址：
   编辑器里都显示为占位块，提交时原样写回 */
.${NS}-editor .${NS}-img-ref,.${NS}-editor .${NS}-video-ref{display:inline-flex;align-items:center;gap:5px;max-width:100%;
  padding:2px 9px;border:1px dashed var(--pcr-border);border-radius:var(--pcr-r-control);
  background:var(--pcr-surface-hover);color:var(--pcr-subtle);font-size:12px;line-height:1.7;
  vertical-align:baseline;}
.${NS}-editor .${NS}-img-ref svg{flex:none;}
.${NS}-editor hr{border:0;border-top:1px solid var(--pcr-border);margin:1em 0;}
.${NS}-editor a{color:var(--pcr-accent);text-decoration:underline;}
.${NS}-editor table{border-collapse:collapse;margin:.6em 0;width:100%;}
.${NS}-editor th,.${NS}-editor td{border:1px solid var(--pcr-border);padding:6px 10px;}
.${NS}-editor th{background:var(--pcr-canvas);font-weight:600;}
/* 高亮底色用半透明黄：叠在浅色/深色背景上都自然，无需按主题切换 */
.${NS}-editor mark{background:rgba(245,217,10,.32);color:inherit;}
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
/* 全屏开合：FLIP 补间只动 transform，不对宽高做动画，避免逐帧重排；
   时长 / 缓动沿用浮层的 --pco-dur 与同名 easing，退出用收尾更稳的曲线。
   will-change 只在补间期间挂，落定后移除，避免整层长期占显存。 */
.${NS}-root.${NS}-fs-anim{will-change:transform;transform-origin:0 0;
  transition:transform calc(.52s * var(--pco-dur)) var(--pco-move);}
.${NS}-root.${NS}-fs-anim.${NS}-fs-out{transition:transform calc(.54s * var(--pco-dur)) var(--pco-move-close);}
@media (prefers-reduced-motion:reduce){
  .${NS}-root.${NS}-fs-anim{transition:none;}
}
/* 全屏编辑 */
/* 只让正文区滚动：全屏根节点自身不出滚动条，避免与编辑区形成两条滚动条。
   带上 data-pcs-root 提高优先级，防止同类扩展的 overflow:auto 覆盖回来 */
.${NS}-root[data-pcs-root].is-fullscreen{position:fixed;inset:0;z-index:9999;margin:0;padding:14px 16px;
  background:var(--pcr-canvas);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;
  max-width:100vw;}
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
/* —— 调色板 / 帮助 / 查找浮层 ——
   z-index 高于全屏编辑（9999），否则全屏时浮层会被面板盖住。 */
.${NS}-pop{position:absolute;z-index:10001;background:var(--pcr-surface);border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-surface);box-shadow:0 8px 28px rgba(0,0,0,.16);padding:8px;
  transform-origin:top right;animation:${NS}PopIn .34s cubic-bezier(.16,1,.3,1) both;}
.${NS}-swatches{display:grid;grid-template-columns:repeat(6,20px);gap:6px;}
.${NS}-swatch{width:20px;height:20px;border-radius:5px;border:1px solid var(--pcr-border);cursor:pointer;
  transition:transform .22s cubic-bezier(.22,1,.36,1);}
.${NS}-swatch:hover{transform:scale(1.15);}
.${NS}-pop-help{max-width:290px;font-size:12.5px;line-height:1.7;color:var(--pcr-subtle);padding:12px 14px;}
.${NS}-pop-help b{color:var(--pcr-text);}
.${NS}-pop-help ul{margin:6px 0 0;padding-left:1.1em;}

/* —— 斜杠命令面板 ——
   复用 .pcr-pop 的边框 / 阴影 / 入场动画，这里只负责尺寸与列表布局。
   面板挂在 body 上、按光标 fixed 定位，避免被编辑区滚动容器裁掉。 */
.${NS}-slash{position:fixed;width:320px;max-height:340px;display:flex;flex-direction:column;padding:0;
  overflow:hidden;transform-origin:top left;}
.${NS}-slash-list{flex:1;min-height:0;overflow:auto;padding:5px;display:flex;flex-direction:column;gap:1px;}
.${NS}-slash-item{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;
  color:var(--pcr-text);font:inherit;font-size:13.5px;padding:8px 9px;
  border-radius:var(--pcr-r-control);cursor:pointer;text-align:left;
  transition:background .2s cubic-bezier(.22,1,.36,1),color .2s;}
.${NS}-slash-ico{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;
  justify-content:center;color:var(--pcr-subtle);}
.${NS}-slash-ico svg{width:16px;height:16px;}
.${NS}-slash-ico .${NS}-glyph{font-size:12.5px;min-width:16px;text-align:center;}
.${NS}-slash-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.${NS}-slash-tag{flex:none;font-size:11px;color:var(--pcr-subtle);opacity:.85;}
.${NS}-slash-item.is-on{background:var(--pcr-accent-soft);color:var(--pcr-accent);}
.${NS}-slash-item.is-on .${NS}-slash-ico,
.${NS}-slash-item.is-on .${NS}-slash-tag{color:var(--pcr-accent);}
.${NS}-slash-empty{padding:16px 10px;text-align:center;font-size:12.5px;color:var(--pcr-subtle);}
.${NS}-slash-foot{display:flex;gap:6px;padding:6px;border-top:1px solid var(--pcr-border);flex:none;}
.${NS}-slash-foot-btn{flex:1;height:28px;border:1px solid var(--pcr-border);background:var(--pcr-surface);
  color:var(--pcr-subtle);font:inherit;font-size:12px;border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .22s cubic-bezier(.22,1,.36,1),color .22s,border-color .22s;}
.${NS}-slash-foot-btn:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);
  border-color:var(--pcr-accent);}
.${NS}-slash-foot-btn:active{transform:scale(.97);}

/* —— 模板库弹窗 —— */
.${NS}-tpl-mask{position:fixed;inset:0;z-index:10004;display:flex;align-items:center;
  justify-content:center;padding:20px;background:rgba(0,0,0,.45);}
.${NS}-tpl-modal{width:min(520px,100%);max-height:min(620px,86vh);display:flex;flex-direction:column;
  overflow:hidden;background:var(--pcr-surface);color:var(--pcr-text);
  border:1px solid var(--pcr-border);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.32);
  font-family:var(--pcr-font);animation:${NS}TplIn .28s cubic-bezier(.16,1,.3,1) both;}
@keyframes ${NS}TplIn{from{opacity:0;transform:translateY(8px) scale(.984);}to{opacity:1;transform:none;}}
.${NS}-tpl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:16px 18px 10px;flex:none;}
.${NS}-tpl-title{font-size:15px;font-weight:600;}
.${NS}-tpl-close{width:28px;height:28px;border:0;border-radius:7px;background:transparent;
  color:var(--pcr-subtle);font:inherit;font-size:18px;line-height:1;cursor:pointer;
  transition:background .2s,color .2s;}
.${NS}-tpl-close:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-tpl-body{flex:1;min-height:0;overflow:auto;padding:0 12px 10px;}
.${NS}-tpl-row{display:flex;align-items:center;gap:8px;padding:8px 6px;
  border-bottom:1px solid var(--pcr-border);}
.${NS}-tpl-row:last-child{border-bottom:0;}
.${NS}-tpl-name{flex:1;min-width:0;height:30px;padding:0 8px;border:1px solid transparent;
  border-radius:7px;background:transparent;color:var(--pcr-text);font:inherit;font-size:13.5px;}
.${NS}-tpl-name:hover{border-color:var(--pcr-border);}
.${NS}-tpl-name:focus{outline:none;border-color:var(--pcr-accent);background:var(--pcr-canvas);}
.${NS}-tpl-meta{flex:none;font-size:11.5px;color:var(--pcr-subtle);font-variant-numeric:tabular-nums;}
.${NS}-tpl-act{flex:none;height:28px;padding:0 10px;border:1px solid var(--pcr-border);
  background:var(--pcr-surface);color:var(--pcr-text);font:inherit;font-size:12px;
  border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .2s,border-color .2s,color .2s,transform .18s;}
.${NS}-tpl-act:hover{background:var(--pcr-surface-hover);}
.${NS}-tpl-act:active{transform:scale(.96);}
.${NS}-tpl-act.is-danger{color:var(--pcr-error);border-color:var(--pcr-error);}
.${NS}-tpl-act.is-danger:hover{background:color-mix(in oklab,var(--pcr-error) 10%,transparent);}
.${NS}-tpl-empty{padding:28px 10px;text-align:center;font-size:13px;color:var(--pcr-subtle);}
.${NS}-tpl-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;flex:none;
  border-top:1px solid var(--pcr-border);}
.${NS}-tpl-btn{height:32px;padding:0 14px;border:1px solid var(--pcr-border);border-radius:var(--pcr-r-control);
  background:var(--pcr-surface);color:var(--pcr-text);font:inherit;font-size:13px;cursor:pointer;
  transition:background .2s,border-color .2s,transform .18s;}
.${NS}-tpl-btn:hover{background:var(--pcr-surface-hover);}
.${NS}-tpl-btn:active{transform:scale(.97);}
.${NS}-tpl-btn.is-primary{background:var(--pcr-accent);border-color:var(--pcr-accent);color:#fff;}
.${NS}-tpl-btn.is-primary:hover{filter:brightness(1.07);}
/* 命名弹窗复用模板弹窗结构，只收窄宽度 */
.${NS}-tpl-name-dialog{width:min(360px,100%);}
.${NS}-tpl-name-row{padding:4px 18px 8px;}
.${NS}-tpl-name-input{width:100%;height:36px;padding:0 10px;border:1px solid var(--pcr-border);
  border-radius:8px;background:var(--pcr-canvas);color:var(--pcr-text);font:inherit;font-size:14px;
  outline:none;transition:border-color .22s,background .22s;}
.${NS}-tpl-name-input:focus{border-color:var(--pcr-accent);background:var(--pcr-surface);}

@media (prefers-reduced-motion: reduce){
  .${NS}-tpl-modal,.${NS}-slash{animation:none;}
}

/* —— 查找替换浮层 —— */
.${NS}-find{width:314px;padding:10px;transform-origin:top left;}
.${NS}-find-row{display:flex;align-items:center;gap:6px;}
.${NS}-find-row + .${NS}-find-row{margin-top:6px;}
.${NS}-find-input,.${NS}-find-repl{flex:1;min-width:0;height:30px;padding:0 9px;font:inherit;font-size:13px;
  color:var(--pcr-text);background:var(--pcr-canvas);border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-control);outline:none;
  transition:border-color .24s cubic-bezier(.22,1,.36,1),background .24s;}
.${NS}-find-input:focus,.${NS}-find-repl:focus{border-color:var(--pcr-accent);background:var(--pcr-surface);}
.${NS}-find-count{flex:none;min-width:44px;text-align:right;font-size:11.5px;color:var(--pcr-subtle);
  font-variant-numeric:tabular-nums;}
.${NS}-find-acts{display:flex;gap:6px;margin-top:8px;}
.${NS}-find-btn{flex:1;height:30px;border:1px solid var(--pcr-border);background:var(--pcr-surface);
  color:var(--pcr-text);font:inherit;font-size:12.5px;border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .22s cubic-bezier(.22,1,.36,1),border-color .22s,color .22s,transform .18s;}
.${NS}-find-btn:hover{background:var(--pcr-surface-hover);}
.${NS}-find-btn:active{transform:scale(.96);}
.${NS}-find-btn.is-primary{background:var(--pcr-accent);border-color:var(--pcr-accent);color:#fff;}
.${NS}-find-btn.is-primary:hover{background:var(--pcr-accent);filter:brightness(1.07);}
.${NS}-find-opt{display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-size:12px;
  color:var(--pcr-subtle);cursor:pointer;user-select:none;}
.${NS}-find-opt input{margin:0;accent-color:var(--pcr-accent);}
/* 查找高亮：用 CSS Custom Highlight API 画在文字上，不改动 DOM，因此不影响 Markdown 转换 */
::highlight(${NS}-find-all){background-color:rgba(240,62,70,.2);}
::highlight(${NS}-find-cur){background-color:rgba(240,62,70,.55);color:#fff;}

/* —— 选中浮动菜单 —— */
.${NS}-float{position:absolute;z-index:10002;display:flex;align-items:center;gap:2px;padding:4px;
  background:#1f2328;border:1px solid rgba(255,255,255,.12);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);
  transform-origin:bottom center;animation:${NS}PopIn .32s cubic-bezier(.16,1,.3,1) both;}
.${NS}-float button{width:28px;height:28px;border:0;background:transparent;color:#e6e8eb;cursor:pointer;
  border-radius:6px;font:inherit;display:inline-flex;align-items:center;justify-content:center;
  transition:background .24s;}
.${NS}-float button:hover{background:rgba(255,255,255,.16);}
.${NS}-float .sep{width:1px;height:16px;background:rgba(255,255,255,.2);margin:0 3px;}

/* —— 轻提示 —— */
.${NS}-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(10px);
  background:#1f2328;color:#fff;border:1px solid rgba(255,255,255,.12);font-size:13px;line-height:1.5;max-width:80vw;text-align:center;
  padding:9px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.24);
  opacity:0;pointer-events:none;transition:opacity .32s,transform .32s cubic-bezier(.16,1,.3,1);z-index:10003;}
.${NS}-toast.is-show{opacity:1;transform:translateX(-50%) translateY(0);}
.${NS}-hidden{display:none !important;}

/* 可视化模式下隐藏站点原生编辑器容器。
   站点弹窗（作品分享 / 表情 / 图片）挂在原生容器内、并按原生按钮坐标定位，
   因此点击这些按钮时脚本会临时切到源码视图，让原生编辑器完整显示后再点击，
   弹窗才能定位正确；操作完成后自动切回可视化。 */
.${NS}-native-collapsed{display:none !important;}

/* 原生工具栏可能被站点重渲染成新节点，元素级标记会丢；
   在编辑器卡片上打标记，用后代选择器兜底，避免和插件工具栏重复显示。 */
.${NS}-native-off [role="toolbar"]:not(.${NS}-toolbar),
.${NS}-native-off [data-pcr-native-bar="1"]{display:none !important;}

/* —— AI 写作助手窗口 ——
   沿用通用浮层的变量与交互约定，但覆盖为「固定在视口上的独立窗口」：
   尺寸更大、内部用纵向 flex 分区（结果区自适应占满剩余高度）；
   空白点击不关闭，只能通过右上角 × / Esc / 面板内「关闭」按钮收起。 */
.${NS}-ai{
  position:fixed;z-index:10002;transform-origin:center top;
  width:min(720px,calc(100vw - 48px));
  height:min(640px,calc(100vh - 48px));
  padding:0;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 18px 56px rgba(0,0,0,.2);
}
.${NS}-ai-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:1px solid var(--pcr-border);cursor:move;}
.${NS}-ai-title{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:13.5px;}
.${NS}-ai-title svg{width:16px;height:16px;flex:none;color:var(--pcr-accent);}
.${NS}-ai-sub{margin-left:auto;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  font-size:11.5px;color:var(--pcr-subtle);background:var(--pcr-canvas);
  border:1px solid var(--pcr-border);border-radius:999px;padding:1px 8px;}
.${NS}-ai-x{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border:0;background:transparent;color:var(--pcr-subtle);
  border-radius:6px;cursor:pointer;transition:background .22s cubic-bezier(.22,1,.36,1),color .22s;}
.${NS}-ai-x:hover{background:var(--pcr-surface-hover);color:var(--pcr-text);}
.${NS}-ai-x svg{width:15px;height:15px;}
/* 侧边栏模式：贴靠视口右侧并撑满高度（坐标交给 CSS，取消内联定位） */
.${NS}-ai.is-dock{
  left:auto;right:0;top:0;bottom:0;
  width:min(560px,calc(100vw - 40px));height:auto;
  border-radius:0;box-shadow:-8px 0 32px rgba(0,0,0,.14);
}
.${NS}-ai.is-dock .${NS}-ai-head{cursor:default;}
/* 拖动中：全局禁止选中，避免拖出文本选区 */
.${NS}-dragging,.${NS}-dragging *{user-select:none !important;}
.${NS}-dragging .${NS}-ai-head{cursor:grabbing;}
/* 快捷指令分组：左列标签、右列胶囊，多行时对齐，避免按钮堆成一片 */
.${NS}-ai-groups{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px 4px;}
.${NS}-ai-group{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;align-items:start;}
.${NS}-ai-glabel{font-size:11.5px;line-height:26px;color:var(--pcr-subtle);white-space:nowrap;}
.${NS}-ai-gchips{display:flex;flex-wrap:wrap;gap:6px;}
.${NS}-ai-chip{border:1px solid var(--pcr-border);background:var(--pcr-surface);color:var(--pcr-text);
  display:inline-flex;align-items:center;height:26px;padding:0 11px;border-radius:999px;cursor:pointer;
  font:inherit;font-size:12.5px;
  transition:background .22s cubic-bezier(.22,1,.36,1),color .22s,border-color .22s,transform .18s;}
.${NS}-ai-chip:hover{background:var(--pcr-accent-soft);color:var(--pcr-accent);border-color:var(--pcr-accent);}
.${NS}-ai-chip:active{transform:scale(.96);}
.${NS}-ai-custom{flex:none;display:flex;gap:6px;align-items:flex-end;padding:8px 12px 4px;}
.${NS}-ai-input{flex:1;min-width:0;resize:none;overflow-y:auto;min-height:34px;max-height:96px;
  padding:7px 10px;font:inherit;font-size:13px;line-height:1.5;color:var(--pcr-text);
  background:var(--pcr-canvas);border:1px solid var(--pcr-border);border-radius:var(--pcr-r-control);outline:none;
  transition:border-color .24s cubic-bezier(.22,1,.36,1),box-shadow .24s;}
.${NS}-ai-input:focus{border-color:var(--pcr-accent);box-shadow:0 0 0 3px var(--pcr-accent-soft);}
.${NS}-ai-gen{flex:none;height:34px;padding:0 14px;border:1px solid var(--pcr-accent);border-radius:var(--pcr-r-control);
  background:var(--pcr-accent);color:#fff;font:inherit;font-size:13px;font-weight:500;cursor:pointer;
  transition:filter .22s,transform .18s;}
.${NS}-ai-gen:hover{filter:brightness(1.06);}
.${NS}-ai-gen:active{transform:scale(.97);}
.${NS}-ai-gen:disabled,.${NS}-ai-chip:disabled{opacity:.5;cursor:default;filter:none;}
.${NS}-ai-result{flex:1;min-height:140px;margin:8px 12px 0;border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-control);background:var(--pcr-canvas);overflow:auto;}
.${NS}-ai-out{padding:10px 12px;font-size:13.5px;line-height:1.7;color:var(--pcr-text);word-break:break-word;}
.${NS}-ai-out>*:first-child{margin-top:0;}
.${NS}-ai-out>*:last-child{margin-bottom:0;}
.${NS}-ai-out p{margin:0 0 8px;white-space:pre-wrap;}
.${NS}-ai-out h1,.${NS}-ai-out h2{font-size:16px;margin:10px 0 5px;}
.${NS}-ai-out h3,.${NS}-ai-out h4,.${NS}-ai-out h5,.${NS}-ai-out h6{font-size:14px;margin:9px 0 4px;}
.${NS}-ai-out ul,.${NS}-ai-out ol{margin:0 0 8px;padding-left:20px;}
.${NS}-ai-out blockquote{margin:0 0 8px;padding:5px 10px;border-left:3px solid var(--pcr-accent);
  background:var(--pcr-surface);border-radius:0 var(--pcr-r-control) var(--pcr-r-control) 0;color:var(--pcr-subtle);}
.${NS}-ai-out code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;
  background:var(--pcr-surface);border:1px solid var(--pcr-border);border-radius:4px;padding:0 5px;}
.${NS}-ai-out pre{background:var(--pcr-surface);border:1px solid var(--pcr-border);
  border-radius:var(--pcr-r-control);padding:10px 12px;overflow:auto;}
.${NS}-ai-out pre code{background:none;border:0;padding:0;}
.${NS}-ai-out table{border-collapse:collapse;margin:0 0 8px;width:100%;font-size:12.5px;}
.${NS}-ai-out th,.${NS}-ai-out td{border:1px solid var(--pcr-border);padding:5px 8px;text-align:left;}
.${NS}-ai-out th{background:var(--pcr-surface);font-weight:600;}
.${NS}-ai-out a{color:var(--pcr-accent);}
.${NS}-ai-out hr{border:0;border-top:1px solid var(--pcr-border);margin:10px 0;}
.${NS}-ai-ph{padding:12px;color:var(--pcr-subtle);font-size:12.5px;line-height:1.7;}
.${NS}-ai-note{padding:12px;font-size:13px;color:var(--pcr-text);line-height:1.7;}
.${NS}-ai-tip{color:var(--pcr-subtle);font-size:12.5px;margin-top:4px;}
.${NS}-ai-note-act{margin-top:10px;display:flex;gap:8px;}
.${NS}-ai-loading{display:flex;align-items:center;gap:9px;padding:12px;color:var(--pcr-subtle);font-size:13px;}
.${NS}-ai-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--pcr-accent-soft);
  border-top-color:var(--pcr-accent);animation:${NS}AiRot .7s linear infinite;}
@keyframes ${NS}AiRot{to{transform:rotate(360deg);}}
.${NS}-ai-caret{display:inline-block;width:2px;height:1em;vertical-align:-2px;margin-left:2px;
  background:var(--pcr-accent);animation:${NS}AiBlink 1s steps(1) infinite;}
@keyframes ${NS}AiBlink{50%{opacity:0;}}
.${NS}-ai-actions{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;margin-top:10px;
  border-top:1px solid var(--pcr-border);}
.${NS}-ai-act{border:1px solid var(--pcr-border);background:var(--pcr-surface);color:var(--pcr-text);
  font:inherit;font-size:12.5px;padding:6px 12px;border-radius:var(--pcr-r-control);cursor:pointer;
  transition:background .22s cubic-bezier(.22,1,.36,1),color .22s,border-color .22s,transform .18s;}
.${NS}-ai-act:hover{background:var(--pcr-surface-hover);}
.${NS}-ai-act:active{transform:scale(.97);}
.${NS}-ai-act.is-primary{background:var(--pcr-accent);border-color:var(--pcr-accent);color:#fff;font-weight:500;}
.${NS}-ai-act.is-primary:hover{background:var(--pcr-accent);filter:brightness(1.06);}
.${NS}-ai-act:disabled{opacity:.45;cursor:default;}
/* 停止生成（标题栏）：复用 .pcr-ai-x 尺寸，主色提示 */
.${NS}-ai-stop{color:var(--pcr-accent);}
.${NS}-ai-stop:hover{background:var(--pcr-accent-soft);color:var(--pcr-accent);}
.${NS}-ai-hide{display:none !important;}
/* Token 胶囊：放在操作栏最左侧，详情进 title */
.${NS}-ai-usage{
  display:inline-flex;align-items:center;gap:4px;margin-right:auto;align-self:center;
  padding:1px 8px;border:1px solid var(--pcr-border);border-radius:999px;
  background:var(--pcr-canvas);color:var(--pcr-subtle);
  font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.${NS}-ai-usage:empty{display:none;}
.${NS}-ai-usage.is-est{opacity:.86;}

/* —— AI 排版窗口 ——
   复用写作助手窗口的结构与内部样式，仅覆盖为「居中弹出的固定窗口」，
   不参与拖动 / 侧边栏，避免与写作助手的窗口状态相互干扰。 */
.${NS}-af{
  left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(700px,calc(100vw - 40px));
  height:min(620px,calc(100vh - 48px));
  transform-origin:center center;
  animation:${NS}AfIn .34s cubic-bezier(.16,1,.3,1) both;
}
@keyframes ${NS}AfIn{
  from{opacity:0;transform:translate(-50%,-50%) translateY(10px) scale(.97);}
  to{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1);}
}
.${NS}-af .${NS}-ai-head{cursor:default;}
.${NS}-af-body{flex:1;min-height:0;display:flex;flex-direction:column;}
.${NS}-af-desc{padding:10px 12px 0;font-size:12.5px;line-height:1.7;color:var(--pcr-subtle);}
.${NS}-af-row{display:flex;align-items:flex-start;gap:8px;padding:8px 12px 0;}
.${NS}-af-label{flex:none;font-size:11.5px;line-height:26px;color:var(--pcr-subtle);white-space:nowrap;}
.${NS}-af-chips{display:flex;flex-wrap:wrap;gap:6px;}
.${NS}-af-chip.is-on{background:var(--pcr-accent-soft);color:var(--pcr-accent);
  border-color:var(--pcr-accent);font-weight:500;}
.${NS}-af .${NS}-ai-result{flex:1;min-height:120px;}
`;
    const style = document.createElement('style');
    style.id = NS + '-style-pcs';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================ 5. 编辑器构建 ============================

  let editor = null;       // contenteditable 富文本区
  let textarea = null;     // 站点原始 Markdown 输入框
  let root = null;         // 整个面板根节点
  let origWrapper = null;  // 站点原生编辑器容器（工具栏 + textarea + 字数统计）
  let nativeToolbar = null; // 站点原生工具栏（可视化模式下需一并隐藏）
  let nativeHiddenEls = [];  // 可视化模式下被隐藏的原生工具行 / 全屏 / 预览按钮
  let mode = 'rich';       // rich | split | source
  let lock = false;        // 同步锁，防止双向同步互相触发形成死循环
  let pendingBack = null;  // 站点弹窗「插入完成后自动返回可视化」的取消函数，切视图时需清理
  let lastTaValue = null;  // 最近一次「脚本自己写入」的 textarea 值，用于识别外部（框架）改写
  let editorBaselineMd = null; // 编辑器挂载时的正文快照，供开放接口判断是否有未保存改动
  let lastRichRange = null; // 最后一次落在富文本编辑区内的选区，供切到源码视图时映射光标

  /** 工具按钮工厂 */
  function makeBtn(opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = NS + '-btn';
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

  /** 下拉框：触发器本身就是 .pcr-btn（多一个小三角，宽度自适应），
      菜单是挂到 body 的浮层，复用 .pcr-pop 的关闭逻辑（点面板外 / 再次点触发器都能收起）。
      opts.items: [{ label, html?, tip?, isActive?, onSelect }] */
  function makeDropdown(opts) {
    const wrap = document.createElement('span');
    wrap.className = NS + '-dd';
    wrap.dataset.key = opts.key;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = NS + '-btn ' + NS + '-dd-btn';
    btn.dataset.pcrOwn = '1';
    btn.dataset.key = opts.key;
    if (opts.tip) btn.setAttribute('data-tip', opts.tip);
    // face 里放当前态图标（标题级别 / 当前对齐），由 refreshToolbarState 更新
    btn.innerHTML = '<span class="' + NS + '-dd-face">' + opts.triggerHtml + '</span>' +
      '<span class="' + NS + '-dd-caret"></span>';
    btn.addEventListener('mousedown', (e) => e.preventDefault());  // 保住编辑区焦点与选区
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const already = document.querySelector('.' + NS + '-dd-menu[data-for="' + opts.key + '"]');
      closePopups();
      if (!already) openDropdownMenu(btn, opts);   // 已展开则本次点击即为收起
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /** 打开下拉菜单：按触发器位置定位，点外部 / Esc 交给既有浮层逻辑关闭 */
  function openDropdownMenu(anchorBtn, opts) {
    const menu = document.createElement('div');
    menu.className = NS + '-pop ' + NS + '-dd-menu';
    menu.dataset.for = opts.key;
    menu.setAttribute('role', 'menu');
    opts.items.forEach((it) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = NS + '-dd-item';
      item.setAttribute('role', 'menuitem');
      if (it.tip) item.title = it.tip;
      let active = false;
      try { active = !!(it.isActive && it.isActive()); } catch (e) { /* noop */ }
      if (active) item.classList.add('is-on');
      item.innerHTML = (it.html || '') + '<span>' + it.label + '</span>';
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => { closePopups(); it.onSelect(); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const r = anchorBtn.getBoundingClientRect();
    menu.style.top = (window.scrollY + r.bottom + 6) + 'px';
    menu.style.left = (window.scrollX + r.left) + 'px';
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

  /** 当前对齐状态：left / center / right（下拉框选中态与触发器图标共用） */
  function alignState() {
    try {
      if (document.queryCommandState('justifyCenter')) return 'center';
      if (document.queryCommandState('justifyRight')) return 'right';
    } catch (e) { /* noop */ }
    return 'left';
  }

  /** 刷新工具栏按钮 / 下拉框触发器的选中态 */
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
    // 标题下拉框：触发器显示当前块级标题（非标题时显示 H）
    const hFace = root && root.querySelector('.' + NS + '-dd[data-key="heading"] .' + NS + '-dd-face');
    if (hFace) {
      const cur = currentBlockTag();
      hFace.innerHTML = ICONS.text(/^h[1-4]$/.test(cur) ? cur.toUpperCase() : 'H');
    }
    // 对齐下拉框：触发器显示当前对齐图标（默认左对齐）
    const aFace = root && root.querySelector('.' + NS + '-dd[data-key="align"] .' + NS + '-dd-face');
    if (aFace) {
      const a = alignState();
      aFace.innerHTML = a === 'center' ? ICONS.alignCenter : a === 'right' ? ICONS.alignRight : ICONS.alignLeft;
    }
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
    // AI 写作助手是独立窗口：用 :not 排除，空白点击 / 打开其他浮层都不会把它一并收起
    document.querySelectorAll('.' + NS + '-pop:not(.' + NS + '-ai):not(.' + NS + '-af), .' + NS + '-float').forEach((el) => el.remove());
    // 斜杠面板复用 .pcr-pop，被统一清掉时必须复位状态，否则下次输入不再触发
    slashEl = null;
    slashState.open = false;
    slashState.items = [];
    slashState.index = 0;
    slashState.query = '';
    // 浮层被统一清掉时同步重置查找状态，避免残留高亮与悬空的定时器
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    findPop = null;
    findMatches = [];
    findIndex = -1;
    clearFindHighlights();
    syncFindBtn();
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

  // ============================ 5.1 查找替换 ============================

  let findPop = null;        // 查找替换浮层（挂在 body 上，和调色板 / 帮助同一套样式）
  let findMatches = [];      // 当前匹配集合：[{ start, end }]，偏移基于「编辑区纯文本」
  let findIndex = -1;        // 当前定位到的匹配序号（-1 表示没有定位）
  let findTimer = null;      // 输入防抖
  const FIND_ALL = NS + '-find-all';   // 全部匹配的 CSS 高亮注册名
  const FIND_CUR = NS + '-find-cur';   // 当前匹配的 CSS 高亮注册名

  /** 收集富文本区内的文本节点，拼成纯文本，并记录每个节点对应的字符区间 */
  function collectTextNodes(rootEl) {
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
    }
    return { nodes, text };
  }

  /** 把纯文本偏移区间还原成 DOM Range（跨节点的匹配也能还原） */
  function rangeFromOffsets(seg, start, end) {
    let a = null, b = null;
    for (let i = 0; i < seg.nodes.length; i++) {
      const s = seg.nodes[i];
      if (!a && start >= s.start && start < s.end) a = { node: s.node, offset: start - s.start };
      if (!b && end > s.start && end <= s.end) b = { node: s.node, offset: end - s.start };
      if (a && b) break;
    }
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    } catch (e) { return null; }
  }

  /** 在文本里找出全部匹配（不重叠；大小写可选） */
  function matchAll(text, query, caseSensitive) {
    const out = [];
    if (!text || !query) return out;
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    let i = hay.indexOf(needle);
    while (i >= 0) {
      out.push({ start: i, end: i + needle.length });
      i = hay.indexOf(needle, i + needle.length);
    }
    return out;
  }

  /** 读取浮层里的查询词 / 替换词 / 选项 */
  function findInputs() {
    if (!findPop) return null;
    const q = findPop.querySelector('.' + NS + '-find-input');
    const c = findPop.querySelector('.' + NS + '-find-case');
    return {
      query: q ? q.value : '',
      repl: (findPop.querySelector('.' + NS + '-find-repl') || { value: '' }).value,
      caseSensitive: !!(c && c.checked)
    };
  }

  /** 按当前视图扫描一遍：源码视图查原生输入框，其余视图查富文本区 */
  function findScan() {
    const opt = findInputs();
    if (!opt) return null;
    if (mode === 'source' && textarea) {
      return { kind: 'textarea', text: textarea.value, matches: matchAll(textarea.value, opt.query, opt.caseSensitive), opt };
    }
    if (!editor) return null;
    const seg = collectTextNodes(editor);
    return { kind: 'rich', seg, text: seg.text, matches: matchAll(seg.text, opt.query, opt.caseSensitive), opt };
  }

  /** 浏览器是否支持 CSS Custom Highlight API（Chrome 105+） */
  function canHighlight() {
    return !!(window.CSS && CSS.highlights && typeof window.Highlight === 'function');
  }

  /** 用 CSS Custom Highlight API 画高亮：只画不改 DOM，所以不会污染 Markdown 转换 */
  function paintHighlights(seg, matches, current) {
    if (!canHighlight()) return;
    try {
      CSS.highlights.delete(FIND_ALL);
      CSS.highlights.delete(FIND_CUR);
      if (!seg || !matches.length) return;
      const others = [];
      let cur = null;
      matches.forEach((m, i) => {
        const r = rangeFromOffsets(seg, m.start, m.end);
        if (!r) return;
        if (i === current) cur = r; else others.push(r);
      });
      if (others.length) CSS.highlights.set(FIND_ALL, new Highlight(...others));
      if (cur) CSS.highlights.set(FIND_CUR, new Highlight(cur));
    } catch (e) { /* 不支持就静默降级，只是没有高亮 */ }
  }

  function clearFindHighlights() {
    if (!canHighlight()) return;
    try { CSS.highlights.delete(FIND_ALL); CSS.highlights.delete(FIND_CUR); } catch (e) { /* noop */ }
  }

  /** 把富文本区的匹配滚动到可视范围 */
  function scrollRichMatch(seg, m) {
    const r = rangeFromOffsets(seg, m.start, m.end);
    if (!r) return;
    const host = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* noop */ }
    }
  }

  /** 在源码视图里选中并滚动到匹配；focus=false 时只设置选区、不抢焦点 */
  function revealTextareaMatch(m, focus) {
    if (!textarea) return;
    try {
      if (focus) textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(m.start, m.end);
    } catch (e) { /* noop */ }
    const line = textarea.value.slice(0, m.start).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
    textarea.scrollTop = Math.max(0, line * lh - textarea.clientHeight / 2);
  }

  /**
   * 渲染一次查找结果：计数、高亮、滚动定位。
   * quiet=true 只更新计数与高亮，不动滚动与选区 —— 用于「编辑区内容变化后的自动刷新」，
   * 否则会把用户正在输入的光标位置抢走；focusTa=true 才把焦点交给源码视图的原生输入框。
   */
  function renderFind(scan, idx, opts) {
    const quiet = !!(opts && opts.quiet);
    const focusTa = !!(opts && opts.focusTa);
    findMatches = scan.matches;
    const n = findMatches.length;
    findIndex = n ? ((idx % n) + n) % n : -1;
    const count = findPop && findPop.querySelector('.' + NS + '-find-count');
    if (count) {
      count.textContent = !scan.opt.query ? '0/0' : (n ? (findIndex + 1) + '/' + n : '无结果');
    }
    if (scan.kind === 'rich') {
      paintHighlights(scan.seg, findMatches, findIndex);
      if (!quiet && findIndex >= 0) scrollRichMatch(scan.seg, findMatches[findIndex]);
    } else {
      clearFindHighlights();
      if (!quiet && findIndex >= 0) revealTextareaMatch(findMatches[findIndex], focusTa);
    }
  }

  /** 重新扫描并刷新；reset=true 时回到第一个匹配（输入查询词时用） */
  function runFind(reset, opts) {
    if (!findPop) return null;
    const scan = findScan();
    if (!scan) return null;
    const keep = !reset && findIndex >= 0 && findIndex < scan.matches.length;
    renderFind(scan, keep ? findIndex : 0, opts);
    return scan;
  }

  /** 上一个 / 下一个（循环）；显式导航时才把焦点交给源码输入框 */
  function stepFind(delta) {
    if (!findPop) return;
    const scan = findScan();
    if (!scan) return;
    if (!scan.matches.length) { renderFind(scan, -1, { quiet: true }); return; }
    const base = findIndex < 0 ? (delta > 0 ? -1 : 0) : findIndex;
    renderFind(scan, base + delta, { focusTa: true });
  }

  /** 替换当前匹配 */
  function replaceCurrent() {
    if (!findPop) return;
    const scan = findScan();
    if (!scan || !scan.matches.length) { toast('没有可替换的内容'); return; }
    const m = scan.matches[findIndex < 0 ? 0 : findIndex];
    const text = scan.opt.repl;
    if (scan.kind === 'textarea') {
      const v = textarea.value;
      setTextareaValue(v.slice(0, m.start) + text + v.slice(m.end));
    } else {
      const r = rangeFromOffsets(scan.seg, m.start, m.end);
      if (!r) return;
      r.deleteContents();
      if (text) r.insertNode(document.createTextNode(text));
      richToSource();
    }
    runFind(false, { quiet: true });
    toast('已替换 1 处');
  }

  /** 全部替换：从后往前改，保证前面的偏移始终有效 */
  function replaceAll() {
    if (!findPop) return 0;
    const scan = findScan();
    if (!scan || !scan.matches.length) { toast('没有可替换的内容'); return 0; }
    const text = scan.opt.repl;
    let n = 0;
    if (scan.kind === 'textarea') {
      let v = textarea.value;
      for (let i = scan.matches.length - 1; i >= 0; i--) {
        const m = scan.matches[i];
        v = v.slice(0, m.start) + text + v.slice(m.end);
        n++;
      }
      setTextareaValue(v);
    } else {
      for (let i = scan.matches.length - 1; i >= 0; i--) {
        const m = scan.matches[i];
        const r = rangeFromOffsets(scan.seg, m.start, m.end);
        if (!r) continue;
        r.deleteContents();
        if (text) r.insertNode(document.createTextNode(text));
        n++;
      }
      richToSource();
    }
    runFind(true, { quiet: true });
    toast('已替换 ' + n + ' 处');
    return n;
  }

  /** 同步查找按钮的选中态（浮层开着时按钮高亮） */
  function syncFindBtn() {
    const b = root && root.querySelector('.' + NS + '-btn[data-key="find"]');
    if (b) b.classList.toggle('is-on', !!findPop);
  }

  /** 打开 / 收起查找替换浮层 */
  function openFind(anchorBtn) {
    if (findPop) { closeFind(); return; }   // 再点一次即收起
    closePopups();
    const pop = document.createElement('div');
    pop.className = NS + '-pop ' + NS + '-find';
    pop.innerHTML =
      '<div class="' + NS + '-find-row">' +
        '<input type="text" class="' + NS + '-find-input" placeholder="查找内容" spellcheck="false">' +
        '<span class="' + NS + '-find-count">0/0</span>' +
      '</div>' +
      '<div class="' + NS + '-find-row">' +
        '<input type="text" class="' + NS + '-find-repl" placeholder="替换为（留空即删除）" spellcheck="false">' +
      '</div>' +
      '<div class="' + NS + '-find-acts">' +
        '<button type="button" class="' + NS + '-find-btn" data-act="prev">上一个</button>' +
        '<button type="button" class="' + NS + '-find-btn" data-act="next">下一个</button>' +
        '<button type="button" class="' + NS + '-find-btn" data-act="replace">替换</button>' +
        '<button type="button" class="' + NS + '-find-btn is-primary" data-act="replace-all">全部替换</button>' +
      '</div>' +
      '<label class="' + NS + '-find-opt">' +
        '<input type="checkbox" class="' + NS + '-find-case"><span>区分大小写</span>' +
      '</label>';
    document.body.appendChild(pop);
    findPop = pop;

    // 定位到工具栏按钮正下方，并夹在可视范围内
    const r = anchorBtn.getBoundingClientRect();
    const w = pop.offsetWidth || 314;
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(
      window.scrollX + r.left,
      window.scrollX + document.documentElement.clientWidth - w - 8
    )) + 'px';

    const q = pop.querySelector('.' + NS + '-find-input');
    const cs = pop.querySelector('.' + NS + '-find-case');
    // 输入防抖：边打字边高亮
    q.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => runFind(true), 120);
    });
    cs.addEventListener('change', () => runFind(true));
    pop.querySelectorAll('.' + NS + '-find-btn').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const act = b.dataset.act;
        if (act === 'prev') stepFind(-1);
        else if (act === 'next') stepFind(1);
        else if (act === 'replace') replaceCurrent();
        else replaceAll();
      });
    });

    // 编辑区里有选中文字时，直接带进来当查询词（和浏览器 Ctrl+F 习惯一致）
    const sel = getSelectedText();
    if (sel && sel.length <= 80 && !/\n/.test(sel)) q.value = sel;

    syncFindBtn();
    q.focus();
    q.select();
    if (q.value) runFind(true);
  }

  /** 收起查找浮层并清理高亮 / 状态 */
  function closeFind() {
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    if (findPop) { findPop.remove(); findPop = null; }
    findMatches = [];
    findIndex = -1;
    clearFindHighlights();
    syncFindBtn();
  }

  /** 内容变化时延迟刷新匹配（浮层没开就什么都不做） */
  function refreshFindSoon() {
    if (!findPop) return;
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(false, { quiet: true }), 160);
  }

  // 浮层打开时接管回车 / Esc：浮层内输入框、源码视图的原生输入框都生效；
  // 可视化编辑区里的回车不接管，正常换行。
  document.addEventListener('keydown', (e) => {
    // Esc 优先收起下拉菜单等浮层；查找浮层由下面的分支处理
    if (e.key === 'Escape' && document.querySelector('.' + NS + '-dd-menu')) {
      e.preventDefault(); closePopups(); return;
    }
    if (!findPop) return;
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); return; }
    if (e.key !== 'Enter') return;
    const t = e.target;
    const inFind = !!(t && t.closest && t.closest('.' + NS + '-find'));
    if (!inFind && t !== textarea) return;
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  }, true);

  // ============================ 5.2 站点原生能力复用 ============================

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
    video: ['插入视频', '哔哩哔哩视频', '哔哩哔哩', 'B站视频'],
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

  /** 富文本光标映射用的临时标记：只含字母数字，不会被 Markdown 转义成别的字符 */
  const CARET_MARK = 'PcrCaretMarker9Qz';

  /** 记住最近一次落在编辑区内的选区（焦点离开编辑区后，仍可用它映射源码光标） */
  function rememberRichRange() {
    if (!editor) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return;
    lastRichRange = r.cloneRange();
  }

  /**
   * 把富文本区当前光标映射成 Markdown 源码里的字符偏移。
   * 做法：在光标处插入一个唯一标记 → 整篇转成 Markdown → 查到标记的位置 → 移除标记。
   * 这样不用自己推算「##」「**」「![]()」这些语法字符占了多少位，行内样式 / 链接 / 图片都能对上。
   * 光标不在编辑区（或标记被转换逻辑吞掉）时返回 null，由调用方决定回退位置。
   */
  function richCaretMarkdownOffset() {
    if (!editor) return null;
    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
    } else if (lastRichRange && editor.contains(lastRichRange.startContainer)) {
      range = lastRichRange;
    }
    if (!range) return null;

    // 有选中文字时映射到选区起点，与「插入」的落点保持一致
    const caret = range.cloneRange();
    caret.collapse(true);
    const mark = document.createTextNode(CARET_MARK);
    let parent = null;
    try {
      caret.insertNode(mark);
      parent = mark.parentNode;
      const idx = htmlToMd(editor).indexOf(CARET_MARK);
      return idx >= 0 ? idx : null;
    } catch (e) {
      return null;
    } finally {
      // 移除临时标记，把被拆开的文本节点合回去，编辑区内容保持原样
      if (parent && mark.parentNode === parent) parent.removeChild(mark);
      if (parent && parent.normalize) parent.normalize();
    }
  }

  /**
   * 把给定偏移写进原生 textarea 的光标位置。
   * 站点原生弹窗会把 Markdown 插入到 textarea 光标处，所以切到源码视图前要先把光标
   * 放到「富文本里用户正在写的位置」，而不是文末。offset 为 null 时才回退到文末。
   */
  function syncCaretToTextarea(offset) {
    if (!textarea) return;
    try {
      let pos = (offset == null || offset < 0) ? textarea.value.length : offset;
      pos = Math.min(pos, textarea.value.length);
      textarea.setSelectionRange(pos, pos);
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
   * 让原生编辑器完整显示、弹窗定位正确；插入完成后自动切回可视化并回到插入位置。
   *
   * 两个关键点（之前「跳过去不弹窗 / 回来后再点没反应」就是这里出的问题）：
   *  1. 切换视图会让 Vue 重渲染原生工具栏，之前抓到的按钮节点已失效 —— 所以必须
   *     在切换之后「重新查找」按钮再点击，不能复用旧引用。
   *  2. setMode 内部会异步 focus 原生输入框，会打断刚打开的弹窗 —— 所以点击要
   *     延后到 focus 执行完之后。
   */
  function delegateSiteAction(labels, friendlyName) {
    const clickNative = (caret) => {
      const btn = findSiteButton(labels);   // 每次重新查找，避免用到已被重渲染替换的旧节点
      if (!btn) {
        console.warn('[Pickcat 富文本编辑器] 未找到站点原生按钮：' + friendlyName,
          '\n候选标签=', labels, '\n页面可用按钮文案=', listSiteButtonLabels());
        toast('未找到站点的「' + friendlyName + '」按钮，请改用站点原生工具栏');
        return;
      }
      if (caret != null) syncCaretToTextarea(caret);   // 让站点把内容插入到用户光标处
      btn.click();
    };

    // 已经是源码 / 分屏视图时，原生编辑器可见，直接点击即可：
    // 源码侧编辑保留 textarea 原光标；分屏里光标仍在富文本侧时，同样映射过去
    if (mode !== 'rich') {
      const caret = (mode === 'split' && document.activeElement !== textarea) ? richCaretMarkdownOffset() : null;
      clickNative(caret);
      return;
    }

    // setMode 会把富文本选区映射成源码偏移，这里复用它，避免切换后选区失效导致映射不准
    const caret = setMode('source');
    toast('已切到源码视图以显示「' + friendlyName + '」窗口，选择完成后会自动返回可视化');
    // 等 setMode 的异步 focus 执行完再点击，避免弹窗刚打开就被焦点变化打断
    setTimeout(() => clickNative(caret), 80);
    // 站点把图片 / 表情写回 textarea 时不一定派发 input（多数是直接改写 value），
    // 只监听 input 会一直停在源码视图，要再手动敲一下才会切回 —— 这里改为轮询值变化。
    watchSiteInsert(caret);
  }

  // —— 站点弹窗插入完成的检测与回位 ——
  let siteWatchTimer = 0;    // 轮询 textarea 值变化的定时器
  let siteWatchSettle = 0;   // 「值已变化、等待稳定」的防抖定时器

  /** 停止站点弹窗的插入监听（幂等） */
  function stopSiteInsertWatch() {
    clearInterval(siteWatchTimer);
    clearTimeout(siteWatchSettle);
    siteWatchTimer = 0;
    siteWatchSettle = 0;
  }

  /**
   * 监听站点弹窗把内容写回 textarea。
   * 站点是直接改写 textarea.value，可能不派发 input，所以以「值变化后稳定」为准：
   * 一次插入可能分多次写入（先占位、再换成真实图片 ID），稳定后才切回可视化。
   * caret 是点击弹窗按钮前的富文本光标在 Markdown 里的偏移，作为兜底定位点。
   */
  function watchSiteInsert(caret) {
    if (!textarea) return;
    stopSiteInsertWatch();
    const base = textarea.value;
    const startedAt = Date.now();
    let last = base;
    const commit = () => {
      stopSiteInsertWatch();
      if (!textarea || mode !== 'source') return;
      const diff = insertedMarkdownRange(base, textarea.value);
      setMode('rich');
      revealRichMarkdownOffset(diff ? diff.start : caret, diff ? diff.text : '');
    };
    siteWatchTimer = setInterval(() => {
      if (!textarea || !document.body.contains(textarea) || mode !== 'source') {
        stopSiteInsertWatch();
        return;
      }
      if (textarea.value !== last) {
        last = textarea.value;
        // 站点重写 value 后浏览器常把源码区滚到最底；先把视口拉回插入位置附近，
        // 让「切回可视化」之前的短暂停留也不跳到底部（不动选区，避免干扰站点后续写入）
        const at = insertedMarkdownRange(base, last);
        const pos = at ? at.start : caret;
        if (pos != null && pos >= 0) {
          const line = last.slice(0, pos).split('\n').length - 1;
          const lh = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
          textarea.scrollTop = Math.max(0, line * lh - textarea.clientHeight / 2);
        }
        clearTimeout(siteWatchSettle);
        siteWatchSettle = setTimeout(commit, 350);
      } else if (Date.now() - startedAt > 5 * 60 * 1000) {
        stopSiteInsertWatch();   // 长时间没有写入（用户取消弹窗），停止监听
      }
    }, 200);
    pendingBack = stopSiteInsertWatch;
  }

  /** 对比插入前后的 Markdown，返回新增片段（start / end / text）；无变化返回 null */
  function insertedMarkdownRange(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
    const max = Math.min(before.length, after.length);
    let s = 0;
    while (s < max && before.charCodeAt(s) === after.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && before.charCodeAt(before.length - 1 - e) === after.charCodeAt(after.length - 1 - e)) e++;
    return { start: s, end: after.length - e, text: after.slice(s, after.length - e) };
  }

  /**
   * 把视口和光标定位到 Markdown 偏移处（站点插入完成后回到可视化时用）。
   * 先尝试精确命中刚插入的图片 / 视频占位块；命中不了就按「块」累加偏移定位，
   * 只滚动到对应段落，不改动正文内容。
   */
  function revealRichMarkdownOffset(offset, insertedSnippet) {
    if (!editor || offset == null || offset < 0) return;
    const snippet = String(insertedSnippet || '');
    let host = null;

    // 1) 站点自定义图片引用 ![<id>]：富文本里渲染成 .pcr-img-ref[data-ref]
    const ref = (snippet.match(/!\[([0-9A-Za-z_-]{8,})\]/) || [])[1];
    if (ref) {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(ref) : ref.replace(/"/g, '\\"');
      const el = editor.querySelector('.' + NS + '-img-ref[data-ref="' + esc + '"]');
      if (el) host = el;
    }
    // 2) 标准图片 ![说明](网址)
    if (!host) {
      const src = (snippet.match(/!\[[^\]]*\]\(\s*([^)\s]+)/) || [])[1];
      if (src) {
        for (const img of editor.querySelectorAll('img')) {
          if (img.getAttribute('src') === src) { host = img; break; }
        }
      }
    }
    // 3) 哔哩哔哩视频占位块
    if (!host) {
      const url = (snippet.match(/https?:\/\/player\.bilibili\.com\/[^\s)]*/i) || [])[0];
      if (url) {
        for (const el of editor.querySelectorAll('.' + NS + '-video-ref')) {
          if (el.dataset.url === url) { host = el; break; }
        }
      }
    }
    // 4) 兜底：按块的 Markdown 长度累加，找到偏移所在段落
    if (!host) {
      let consumed = 0;
      const kids = Array.from(editor.childNodes);
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.nodeType === 3 && !node.nodeValue.trim()) continue;
        const md = (node.nodeType === 1 && isBlockNode(node) ? blockToMd(node) : inlineToMd(node)) || '';
        const len = md.trim().length;
        if (consumed + len >= offset || i === kids.length - 1) {
          host = node.nodeType === 1 ? node : node.parentElement;
          break;
        }
        consumed += len + 2;
      }
    }
    if (!host) return;

    // 光标落在占位块之后（占位块不可编辑），其它情况落在块首
    try {
      const range = document.createRange();
      const isRef = host.nodeType === 1 && (host.tagName === 'IMG' ||
        host.classList.contains(NS + '-img-ref') || host.classList.contains(NS + '-video-ref'));
      if (isRef) range.setStartAfter(host);
      else { range.selectNodeContents(host); range.collapse(true); }
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      lastRichRange = range.cloneRange();
    } catch (e) { /* noop */ }

    try { host.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* noop */ }
    try { editor.focus({ preventScroll: true }); } catch (e) { /* noop */ }
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

  // ============================ 5.3 斜杠命令与模板库 ============================

  const TPL_KEY = 'pcr_templates';        // 模板库存储键（chrome.storage.local，失效时降级 localStorage）
  const TPL_MAX = 30;                     // 模板数量上限，避免无限增长
  const SLASH_GROUP_TAG = { heading: '标题', list: '列表', code: '代码', insert: '插入', tpl: '模板', ai: 'AI' };
  // 触发字符：英文斜杠 + 中文输入法下同一按键打出的顿号 + 全角斜杠
  const SLASH_TRIGGERS = ['/', '、', '／'];

  let slashEl = null;                     // 斜杠面板节点（挂在 body 上、按光标 fixed 定位）
  let slashState = { open: false, items: [], index: 0, query: '' };
  let slashTemplates = [];                // 当前缓存的模板列表（面板与「管理模板」共用）
  let tplMask = null;                     // 模板库弹窗的遮罩根节点
  let tplEscHandler = null;               // 弹窗的 Esc 监听（关闭时移除，避免残留）

  /** 取光标所在块级元素中、光标之前的文本（斜杠判定与过滤词都基于它） */
  function blockTextBeforeCaret() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !editor) return null;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.startContainer)) return null;
      let block = range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
      while (block && block !== editor && !/^(p|div|h[1-6]|li|blockquote|pre|td|th)$/i.test(block.tagName)) {
        block = block.parentElement;
      }
      if (!block || block === editor) block = editor;
      // 从块起点量到光标，得到「光标之前的文本」
      const r = document.createRange();
      r.selectNodeContents(block);
      try { r.setEnd(range.startContainer, range.startOffset); } catch (e) { return null; }
      return { text: r.toString(), block };
    } catch (e) {
      return null;
    }
  }

  /** 光标（折叠选区）在视口中的矩形，空段落时退回所在块的矩形 */
  function caretClientRect() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(true);
      const rects = range.getClientRects();
      let r = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) {
        const info = blockTextBeforeCaret();
        if (info && info.block && info.block !== editor) r = info.block.getBoundingClientRect();
      }
      return r || null;
    } catch (e) {
      return null;
    }
  }

  /** 直接把当前块设为指定级别标题（与工具栏「切换」不同，这里不做还原） */
  function setHeading(level) {
    editor.focus();
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('formatBlock', false, 'H' + level);
    } catch (e) { /* 个别浏览器差异，忽略 */ }
    refreshToolbarState();
    richToSource();
  }

  /** 斜杠面板的命令表；模板组按当前缓存动态拼接 */
  function slashCommands() {
    const list = [
      { id: 'h1', group: 'heading', label: '一级标题', keywords: 'h1 title biaoti 标题', icon: ICONS.text('H1'), run: () => setHeading(1) },
      { id: 'h2', group: 'heading', label: '二级标题', keywords: 'h2 title biaoti 标题', icon: ICONS.text('H2'), run: () => setHeading(2) },
      { id: 'h3', group: 'heading', label: '三级标题', keywords: 'h3 title biaoti 标题', icon: ICONS.text('H3'), run: () => setHeading(3) },
      { id: 'h4', group: 'heading', label: '四级标题', keywords: 'h4 title biaoti 标题', icon: ICONS.text('H4'), run: () => setHeading(4) },
      { id: 'ul', group: 'list', label: '无序列表', keywords: 'ul bullet list 列表', icon: ICONS.ul, run: () => exec('insertUnorderedList') },
      { id: 'ol', group: 'list', label: '有序列表', keywords: 'ol number list 列表', icon: ICONS.ol, run: () => exec('insertOrderedList') },
      { id: 'task', group: 'list', label: '任务列表', keywords: 'task todo check 待办 任务', icon: ICONS.ul, run: () => insertTaskList() },
      { id: 'quote', group: 'code', label: '引用块', keywords: 'quote yinyong 引用', icon: ICONS.quote, run: () => exec('formatBlock', 'blockquote') },
      { id: 'inlinecode', group: 'code', label: '行内代码', keywords: 'code inline 代码', icon: ICONS.code, run: () => insertInlineCode() },
      { id: 'codeblock', group: 'code', label: '代码块', keywords: 'code block pre 代码', icon: ICONS.code, run: () => {
        insertHtml('<pre><code>' + escapeHtml(getSelectedText()) + '</code></pre><p><br></p>');
        richToSource();
      } },
      { id: 'table', group: 'insert', label: '插入表格', keywords: 'table biaoge 表格', icon: ICONS.table, run: () => insertTable() },
      { id: 'hr', group: 'insert', label: '分割线', keywords: 'hr line 分割线', icon: ICONS.hr, run: () => { insertHtml('<hr><p><br></p>'); richToSource(); } },
      { id: 'mathinline', group: 'insert', label: '行内公式', keywords: 'math inline formula 公式', icon: ICONS.mathInline, run: () => insertInlineMath() },
      { id: 'mathblock', group: 'insert', label: '块级公式', keywords: 'math block formula 公式', icon: ICONS.mathBlock, run: () => insertBlockMath() }
    ];
    // 模板组：最多直接列 8 条，超出时给一条「查看全部模板」的入口
    slashTemplates.slice(0, 8).forEach((tpl) => {
      list.push({
        id: 'tpl:' + tpl.id, group: 'tpl', label: tpl.name || '未命名模板',
        keywords: 'template tpl muban 模板 ' + String(tpl.content || '').slice(0, 40),
        icon: ICONS.text('T'),
        run: () => {
          insertHtml(mdToHtml(tpl.content || ''));
          richToSource();
          toast('已插入模板「' + (tpl.name || '未命名模板') + '」');
        }
      });
    });
    if (slashTemplates.length > 8) {
      list.push({
        id: 'tpl-more', group: 'tpl', label: '查看全部模板', keywords: 'template 模板 全部',
        icon: ICONS.text('…'), run: () => openTemplateManager()
      });
    }
    list.push(
      { id: 'ai-polish', group: 'ai', label: 'AI 润色', keywords: 'ai polish 润色', icon: aiIcon(), run: () => runAISlash('请润色下面的文字，保持原意与语气，只输出修改后的内容。') },
      { id: 'ai-continue', group: 'ai', label: 'AI 续写', keywords: 'ai continue 续写', icon: aiIcon(), run: () => runAISlash('请顺着正文继续往下写一段，保持原有语气与节奏。') },
      { id: 'ai-translate', group: 'ai', label: 'AI 翻译', keywords: 'ai translate 翻译', icon: aiIcon(), run: () => runAISlash('请把下面的文字翻译成英文，只输出译文。') }
    );
    return list;
  }

  /** 打开写作助手并预填指令（沿用既有 prefill 通道） */
  function runAISlash(prompt) {
    if (!aiOn('aiWriter')) { toast('AI 写作助手已在设置中关闭'); return; }
    openAIWriter(true);
    if (aiRefs && aiRefs.input) {
      aiRefs.input.value = prompt;
      aiRefs.input.dispatchEvent(new Event('input', { bubbles: true }));
      aiRefs.input.focus();
    }
  }

  /** 按查询词过滤后的命令列表 */
  function slashFiltered() {
    const q = (slashState.query || '').toLowerCase();
    const all = slashCommands();
    if (!q) return all;
    return all.filter((it) => (it.label + ' ' + (it.keywords || '')).toLowerCase().indexOf(q) !== -1);
  }

  /** 创建并打开面板（模板异步加载后重绘一次） */
  function openSlashPanel() {
    closeSlash();
    const el = document.createElement('div');
    el.className = NS + '-pop ' + NS + '-slash';
    el.dataset.pcrOwn = '1';
    el.innerHTML = '<div class="' + NS + '-slash-list" role="listbox" aria-label="斜杠命令"></div>' +
      '<div class="' + NS + '-slash-foot">' +
        '<button type="button" class="' + NS + '-slash-foot-btn" data-slash-act="save">保存为模板</button>' +
        '<button type="button" class="' + NS + '-slash-foot-btn" data-slash-act="manage">管理模板</button>' +
      '</div>';
    const saveBtn = el.querySelector('[data-slash-act="save"]');
    const manageBtn = el.querySelector('[data-slash-act="manage"]');
    // 保住编辑区焦点与选区：否则点击底部按钮时斜杠文本已随失焦提交/丢失
    [saveBtn, manageBtn].forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
    saveBtn.addEventListener('click', () => {
      // 先把输入框里的「/查询词」清掉，避免把斜杠文本一起存进模板
      const len = (slashState.query || '').length + 1;
      closeSlash();
      removeSlashText(len);
      saveCurrentAsTemplate();
    });
    manageBtn.addEventListener('click', () => {
      const len = (slashState.query || '').length + 1;
      closeSlash();
      removeSlashText(len);
      openTemplateManager();
    });
    document.body.appendChild(el);
    slashEl = el;
    slashState.open = true;
    slashState.index = 0;
    slashState.query = '';
    renderSlash();
    positionSlash();
    loadTemplates().then((list) => {
      slashTemplates = list;
      if (slashState.open) { renderSlash(); positionSlash(); }
    });
  }

  /** 重绘列表（沿用同一个面板节点，避免过滤时反复建 DOM 抖动） */
  function renderSlash() {
    if (!slashEl) return;
    const box = slashEl.querySelector('.' + NS + '-slash-list');
    if (!box) return;
    const items = slashFiltered();
    slashState.items = items;
    if (slashState.index >= items.length) slashState.index = 0;
    box.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = NS + '-slash-empty';
      empty.textContent = '没有匹配的命令';
      box.appendChild(empty);
      return;
    }
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = NS + '-slash-item' + (i === slashState.index ? ' is-on' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', i === slashState.index ? 'true' : 'false');
      b.innerHTML = '<span class="' + NS + '-slash-ico">' + (it.icon || '') + '</span>' +
        '<span class="' + NS + '-slash-label">' + escapeHtml(it.label) + '</span>' +
        '<span class="' + NS + '-slash-tag">' + (SLASH_GROUP_TAG[it.group] || '') + '</span>';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('mouseenter', () => { slashState.index = i; paintSlashActive(); });
      b.addEventListener('click', (e) => { e.preventDefault(); runSlashItem(it); });
      box.appendChild(b);
    });
    paintSlashActive();
  }

  /** 同步高亮项与滚动位置 */
  function paintSlashActive() {
    if (!slashEl) return;
    slashEl.querySelectorAll('.' + NS + '-slash-item').forEach((el, i) => {
      const on = i === slashState.index;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* noop */ } }
    });
  }

  /** 面板贴着光标定位；下方空间不足时上翻，左右夹取 8px 边距 */
  function positionSlash() {
    if (!slashEl) return;
    const r = caretClientRect();
    const w = slashEl.offsetWidth || 320;
    const h = slashEl.offsetHeight || 320;
    let left = r ? r.left : 24;
    let top = r ? r.bottom + 6 : 120;
    if (top + h > window.innerHeight - 8) top = (r ? r.top : 120) - h - 6;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, top);
    slashEl.style.left = left + 'px';
    slashEl.style.top = top + 'px';
  }

  function closeSlash() {
    if (slashEl && slashEl.parentElement) slashEl.parentElement.removeChild(slashEl);
    slashEl = null;
    slashState.open = false;
    slashState.items = [];
    slashState.index = 0;
    slashState.query = '';
  }

  /** 删除光标前的「/ + 查询词」，并把焦点还给编辑区 */
  function removeSlashText(len) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== 3) return;   // 只处理最普通的文本节点情况
    const end = range.startOffset;
    const start = Math.max(0, end - len);
    const r = document.createRange();
    r.setStart(range.startContainer, start);
    r.setEnd(range.startContainer, end);
    sel.removeAllRanges();
    sel.addRange(r);
    try { document.execCommand('delete', false); } catch (e) { /* noop */ }
  }

  /** 执行选中的命令：先清掉输入的 /查询词，再执行命令本身 */
  function runSlashItem(item) {
    if (!item) return;
    const len = (slashState.query || '').length + 1;
    closeSlash();
    removeSlashText(len);
    try { editor.focus(); } catch (e) { /* noop */ }
    try { item.run(); } catch (e) { /* 单条命令失败不影响编辑器 */ }
  }

  /** 斜杠面板的键盘操作；返回 true 表示已消费本次按键 */
  function onSlashKeydown(e) {
    if (!slashState.open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = slashState.items.length;
      if (!n) return true;
      slashState.index = (slashState.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintSlashActive();
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runSlashItem(slashState.items[slashState.index]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
      return true;
    }
    return false;
  }

  /** 输入时维护面板：未打开则判定是否要打开，已打开则更新过滤词 */
  function onEditorInputForSlash() {
    if (slashState.open) { updateSlashQuery(); return; }
    if (!editor || mode === 'source') return;
    const info = blockTextBeforeCaret();
    // 只认「光标所在块里仅有触发字符」这一种输入：行首或空段落输入斜杠 / 顿号
    if (!info) return;
    const t = info.text.trim();
    if (t.length !== 1 || SLASH_TRIGGERS.indexOf(t) === -1) return;
    openSlashPanel();
  }

  /** 面板打开后继续输入：块内以 / 开头才保留，查询词过长或光标离开即关闭 */
  function updateSlashQuery() {
    if (!slashState.open) return;
    const info = blockTextBeforeCaret();
    if (!info) { closeSlash(); return; }
    const head = info.text.replace(/^\s+/, '');
    if (SLASH_TRIGGERS.indexOf(head.charAt(0)) === -1) { closeSlash(); return; }
    const query = head.slice(1).trim();
    if (query.length > 20) { closeSlash(); return; }
    if (query === slashState.query) return;
    slashState.query = query;
    slashState.index = 0;
    renderSlash();
    positionSlash();
  }

  // —— 模板库存储 ——

  /** 扩展存储是否可用：扩展被重载后 chrome.runtime.id 会缺失 */
  function tplStorageOk() {
    try {
      return !!(window.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** 读取模板列表（按更新时间的倒序由 saveTemplates 保证） */
  function loadTemplates() {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const raw = localStorage.getItem(TPL_KEY);
          const list = raw ? JSON.parse(raw) : [];
          resolve(Array.isArray(list) ? list : []);
        } catch (e) { resolve([]); }
      };
      if (!tplStorageOk()) { fallback(); return; }
      try {
        chrome.storage.local.get({ [TPL_KEY]: [] }, (raw) => {
          if (chrome.runtime.lastError) { fallback(); return; }
          const list = raw && raw[TPL_KEY];
          resolve(Array.isArray(list) ? list : []);
        });
      } catch (e) { fallback(); }
    });
  }

  /** 写入模板列表（统一排序，保证「最近用过/保存过」的排在前面） */
  function saveTemplates(list) {
    const clean = (Array.isArray(list) ? list : [])
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return new Promise((resolve) => {
      const fallback = () => {
        try { localStorage.setItem(TPL_KEY, JSON.stringify(clean)); resolve(true); }
        catch (e) { resolve(false); }
      };
      if (!tplStorageOk()) { fallback(); return; }
      try {
        chrome.storage.local.set({ [TPL_KEY]: clean }, () => resolve(!chrome.runtime.lastError));
      } catch (e) { fallback(); }
    });
  }

  // —— 模板弹窗 ——

  /** 统一弹窗外壳；Esc 与点遮罩都会关闭 */
  function openTplShell(opts) {
    closeTplShell();
    const mask = document.createElement('div');
    mask.className = NS + '-tpl-mask';
    const modal = document.createElement('div');
    modal.className = NS + '-tpl-modal' + (opts && opts.extraClass ? ' ' + opts.extraClass : '');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const head = document.createElement('div');
    head.className = NS + '-tpl-head';
    const title = document.createElement('div');
    title.className = NS + '-tpl-title';
    title.textContent = (opts && opts.title) || '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = NS + '-tpl-close';
    close.innerHTML = '&times;';
    close.title = '关闭';
    close.addEventListener('click', closeTplShell);
    head.appendChild(title);
    head.appendChild(close);
    modal.appendChild(head);
    mask.appendChild(modal);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeTplShell(); });
    document.body.appendChild(mask);
    tplMask = mask;
    tplEscHandler = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeTplShell();
    };
    document.addEventListener('keydown', tplEscHandler, true);
    return { mask, modal };
  }

  function closeTplShell() {
    if (tplMask && tplMask.parentElement) tplMask.parentElement.removeChild(tplMask);
    tplMask = null;
    if (tplEscHandler) {
      document.removeEventListener('keydown', tplEscHandler, true);
      tplEscHandler = null;
    }
  }

  /** 轻量命名弹窗（不用 window.prompt，保证深色模式与视觉统一） */
  function openTemplateNameDialog(defaultName, onConfirm) {
    const shell = openTplShell({ title: '保存为模板', extraClass: NS + '-tpl-name-dialog' });
    const row = document.createElement('div');
    row.className = NS + '-tpl-name-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = NS + '-tpl-name-input';
    input.value = defaultName || '';
    input.placeholder = '模板名称';
    input.maxLength = 40;
    row.appendChild(input);
    shell.modal.appendChild(row);

    const foot = document.createElement('div');
    foot.className = NS + '-tpl-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = NS + '-tpl-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeTplShell);
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = NS + '-tpl-btn is-primary';
    ok.textContent = '保存';
    const submit = () => {
      const name = (input.value || '').trim();
      if (!name) { toast('请填写模板名称'); input.focus(); return; }
      closeTplShell();
      onConfirm(name);
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    foot.appendChild(cancel);
    foot.appendChild(ok);
    shell.modal.appendChild(foot);
    setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* noop */ } }, 30);
  }

  /** 把当前编辑区内容存为模板（内容为空时不写库） */
  async function saveCurrentAsTemplate() {
    if (!editor) return;
    const md = htmlToMd(editor);
    if (!md || !md.trim()) { toast('当前内容为空，无法保存为模板'); return; }
    const list = await loadTemplates();
    if (list.length >= TPL_MAX) { toast('模板过多，请先删除旧模板'); return; }
    openTemplateNameDialog('模板 ' + (list.length + 1), async (name) => {
      const now = Date.now();
      const item = {
        id: 'tpl_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        content: md,
        createdAt: now,
        updatedAt: now
      };
      const next = [item].concat(list);
      const ok = await saveTemplates(next);
      slashTemplates = next;
      if (!ok) { toast('模板保存失败'); return; }
      toast(list.some((t) => t.name === name) ? '已另存同名模板「' + name + '」' : '已保存模板「' + name + '」');
    });
  }

  /** 打开模板库：改名、插入、删除、新建 */
  async function openTemplateManager() {
    slashTemplates = await loadTemplates();
    renderTplManager(slashTemplates);
  }

  function renderTplManager(list) {
    const shell = openTplShell({ title: '模板库' });
    const body = document.createElement('div');
    body.className = NS + '-tpl-body';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = NS + '-tpl-empty';
      empty.textContent = '还没有模板。写好内容后点「保存为模板」，之后在空行输入 / 就能快速插入。';
      body.appendChild(empty);
    }
    list.forEach((tpl) => {
      const row = document.createElement('div');
      row.className = NS + '-tpl-row';
      const name = document.createElement('input');
      name.type = 'text';
      name.className = NS + '-tpl-name';
      name.value = tpl.name || '';
      name.title = '点击可重命名';
      name.maxLength = 40;
      name.addEventListener('change', async () => {
        const v = (name.value || '').trim();
        if (!v) { name.value = tpl.name || ''; toast('模板名称不能为空'); return; }
        if (v === tpl.name) return;
        tpl.name = v;
        tpl.updatedAt = Date.now();
        const ok = await saveTemplates(slashTemplates);
        toast(ok ? '已重命名' : '重命名失败');
      });
      const meta = document.createElement('span');
      meta.className = NS + '-tpl-meta';
      meta.textContent = (tpl.content || '').length + ' 字';
      const ins = document.createElement('button');
      ins.type = 'button';
      ins.className = NS + '-tpl-act';
      ins.textContent = '插入';
      ins.addEventListener('click', () => {
        closeTplShell();
        insertHtml(mdToHtml(tpl.content || ''));
        richToSource();
        toast('已插入模板「' + (tpl.name || '未命名模板') + '」');
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = NS + '-tpl-act is-danger';
      del.textContent = '删除';
      let armed = 0;   // 二次确认计时器：3 秒内再点一次才真正删除
      del.addEventListener('click', async () => {
        if (!armed) {
          del.textContent = '确认删除';
          armed = setTimeout(() => { armed = 0; del.textContent = '删除'; }, 3000);
          return;
        }
        clearTimeout(armed);
        armed = 0;
        const next = slashTemplates.filter((x) => x.id !== tpl.id);
        const ok = await saveTemplates(next);
        if (!ok) { toast('删除失败'); return; }
        slashTemplates = next;
        toast('已删除模板');
        renderTplManager(next);
      });
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(ins);
      row.appendChild(del);
      body.appendChild(row);
    });
    shell.modal.appendChild(body);

    const foot = document.createElement('div');
    foot.className = NS + '-tpl-foot';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = NS + '-tpl-btn';
    add.textContent = '新建模板';
    add.addEventListener('click', () => {
      closeTplShell();
      saveCurrentAsTemplate();
    });
    const done = document.createElement('button');
    done.type = 'button';
    done.className = NS + '-tpl-btn is-primary';
    done.textContent = '完成';
    done.addEventListener('click', closeTplShell);
    foot.appendChild(add);
    foot.appendChild(done);
    shell.modal.appendChild(foot);
  }

  let splitNativeRestore = null;  // 全屏左右对照时，站点源码区被临时移到面板内，这里记录它的原位

  /** 全屏 + 分屏对照：把站点源码区移到面板右侧，形成左右对照；退出时还原原位 */
  function layoutSplitFullscreen(on) {
    if (!root) return;
    const row = root.querySelector('.' + NS + '-row');
    if (!row) return;
    const want = !!on && mode === 'split';
    if (want && origWrapper && !splitNativeRestore && origWrapper.parentElement) {
      splitNativeRestore = { parent: origWrapper.parentElement, next: origWrapper.nextSibling };
      origWrapper.classList.add(NS + '-fs-native');
      row.appendChild(origWrapper);
    } else if (!want && splitNativeRestore) {
      const { parent, next } = splitNativeRestore;
      origWrapper.classList.remove(NS + '-fs-native');
      if (parent && parent.isConnected) {
        parent.insertBefore(origWrapper, next && next.parentElement === parent ? next : null);
      }
      splitNativeRestore = null;
    }
    root.classList.toggle(NS + '-fs-split', want);
  }

  /** 全屏模式（插件全屏或站点原生全屏）下隐藏视图切换滑块 */
  function syncTabsVisibility() {
    if (!root) return;
    root.classList.toggle(NS + '-no-tabs', root.classList.contains('is-fullscreen') || siteFullscreenOn());
  }

  // —— 全屏开合：FLIP 补间 ——
  // 首帧量卡片里的位置与尺寸，切到全屏后再量末帧（铺满视口），
  // 用 transform 把末帧反推回首帧再过渡回终态；全程只动 transform，不逐帧重排。
  let fsAnimating = false;   // 补间进行中：忽略连点，避免两段动画叠加
  let fsAnimTimer = 0;
  let fsSpeed = 1;           // 动画速度倍率（pco_config.animSpeed，与浮层同一口径）
  let fsScrollLock = null;   // 锁滚动前的 html 行内样式，退出时原样还原
  const FS_ENTER_MS = 520;   // 与 --pco-move 的 0.52s 对齐
  const FS_EXIT_MS = 540;    // 与 --pco-move-close 的 0.54s 对齐

  /** 把动画速度同步成 --pco-dur（= 1 / 速度），与 overlay.css 保持一致 */
  function applyFsTiming() {
    if (root) root.style.setProperty('--pco-dur', String(1 / fsSpeed));
  }

  /** 读取浮层设置里的动画速度；设置页改动后由 storage 监听再次同步 */
  function loadFsTiming() {
    try {
      chrome.storage.local.get('pco_config', (raw) => {
        if (chrome.runtime.lastError) return;
        const n = Number(raw && raw.pco_config && raw.pco_config.animSpeed);
        fsSpeed = Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
        applyFsTiming();
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  /** 全屏时锁住页面滚动，并补偿滚动条宽度，避免开合瞬间整页横向抖动 */
  function fsLockScroll(lock) {
    const html = document.documentElement;
    if (lock) {
      if (fsScrollLock) return;
      fsScrollLock = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
      const sbw = Math.max(0, window.innerWidth - html.clientWidth);
      html.style.overflow = 'hidden';
      if (sbw) html.style.paddingRight = sbw + 'px';
    } else if (fsScrollLock) {
      html.style.overflow = fsScrollLock.overflow;
      html.style.paddingRight = fsScrollLock.paddingRight;
      fsScrollLock = null;
    }
  }

  /** 计算「把 toRect 的布局反推回 fromRect 位置」的 transform（origin 必须是 0 0） */
  function fsFlipStyle(fromRect, toRect) {
    const sx = fromRect.width / Math.max(1, toRect.width);
    const sy = fromRect.height / Math.max(1, toRect.height);
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    return 'translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0) scale(' +
      sx.toFixed(5) + ',' + sy.toFixed(5) + ')';
  }

  function fsToggleBtn(on) {
    const b = root && root.querySelector('.' + NS + '-btn[data-key="fullscreen"]');
    if (b) b.classList.toggle('is-on', on);
  }

  /** 补间结束：清掉临时内联样式与合成层提示 */
  function fsEndAnim() {
    if (!fsAnimating) return;
    fsAnimating = false;
    clearTimeout(fsAnimTimer);
    fsAnimTimer = 0;
    if (!root) return;
    const leaving = root.classList.contains(NS + '-fs-out');
    root.classList.remove(NS + '-fs-anim', NS + '-fs-out');
    root.style.transition = '';
    root.style.transform = '';
    root.style.transformOrigin = '';
    if (leaving) {
      // 退出的补间末帧已经和原位置重合，这里同一帧摘类 + 清 transform，视觉不跳
      root.classList.remove('is-fullscreen');
      layoutSplitFullscreen(false);
      syncTabsVisibility();
      fsLockScroll(false);
      fitEditorViewport();
    }
  }

  /** 进入全屏：从卡片当前的位置尺寸连续放大到铺满视口 */
  function fsEnter(animate) {
    fsLockScroll(true);
    const first = root.getBoundingClientRect();
    root.classList.add('is-fullscreen');
    // 全屏由 flex 自适应高度，清掉普通视图下算出的内联 max-height，否则会压住 CSS 的 max-height:none
    if (editor) editor.style.maxHeight = '';
    layoutSplitFullscreen(true);
    syncTabsVisibility();
    fsToggleBtn(true);
    if (!animate || !first.width || !first.height) return;
    const last = root.getBoundingClientRect();
    if (!last.width || !last.height) return;
    fsAnimating = true;
    root.classList.add(NS + '-fs-anim');
    root.style.transition = 'none';
    root.style.transformOrigin = '0 0';
    root.style.transform = fsFlipStyle(first, last);   // 视觉先留在原位
    void root.offsetWidth;                             // 提交首帧，再放开过渡
    root.style.transition = '';
    root.style.transform = '';
    fsAnimTimer = setTimeout(fsEndAnim, Math.round(FS_ENTER_MS / fsSpeed) + 60);
  }

  /** 退出全屏：反向缩回原位置原尺寸 */
  function fsExit(animate) {
    const first = root.getBoundingClientRect();        // 全屏末帧
    // 临时摘掉全屏类量出原位置；整段同步执行，不会上屏
    root.classList.remove('is-fullscreen');
    layoutSplitFullscreen(false);
    syncTabsVisibility();
    fsToggleBtn(false);
    if (!animate) { fsLockScroll(false); fitEditorViewport(); return; }
    const last = root.getBoundingClientRect();
    if (!last.width || !last.height) { fsLockScroll(false); fitEditorViewport(); return; }
    // 先恢复全屏布局，让补间从当前画面出发，而不是先跳回原位
    root.classList.add('is-fullscreen');
    layoutSplitFullscreen(true);
    syncTabsVisibility();
    fsAnimating = true;
    root.classList.add(NS + '-fs-anim', NS + '-fs-out');
    root.style.transition = 'none';
    root.style.transformOrigin = '0 0';
    root.style.transform = 'none';
    void root.offsetWidth;
    root.style.transition = '';
    root.style.transform = fsFlipStyle(last, first);   // 全屏框 → 原位置原尺寸
    fsAnimTimer = setTimeout(fsEndAnim, Math.round(FS_EXIT_MS / fsSpeed) + 60);
  }

  /** 全屏编辑开关（再次点击退出） */
  function toggleFullscreen() {
    if (!root) return;
    // 补间未结束时忽略连点，避免叠加两段动画
    if (fsAnimating) return;
    const animate = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (root.classList.contains('is-fullscreen')) fsExit(animate);
    else fsEnter(animate);
  }

  /** 构建整个面板 DOM */
  // 三种工具栏布局的固定循环顺序：紧凑 → 分组线 → 功能组 → 紧凑
  const TB_MODES = ['compact', 'line', 'groups'];
  const TB_TIPS = {
    compact: '紧凑',
    line: '分组线（仅分割线）',
    groups: '功能组（仿 Word）'
  };

  /** 读取已保存的工具栏布局（默认紧凑） */
  function readToolbarStyle() {
    try {
      const v = localStorage.getItem(TOOLBAR_KEY);
      return TB_MODES.indexOf(v) > -1 ? v : 'compact';
    } catch (e) { return 'compact'; }
  }

  /** 应用工具栏布局：compact 紧凑单行（默认）/ line 只留组间分割线 / groups 仿 Word 功能组 */
  function setToolbarStyle(style, persist) {
    const s = TB_MODES.indexOf(style) > -1 ? style : 'compact';
    if (root) {
      root.classList.toggle(NS + '-tb-grouped', s !== 'compact');  // 分组线 / 功能组共用：组间细线 + 组高对齐
      root.classList.toggle(NS + '-tb-labels', s === 'groups');    // 仅功能组显示组名
    }
    if (persist) { try { localStorage.setItem(TOOLBAR_KEY, s); } catch (e) {} }
    syncLayoutBtn();
    return s;
  }

  /** 同步布局按钮的选中态与提示文案，让用户一眼看出当前用的是哪种布局 */
  function syncLayoutBtn() {
    const b = root && root.querySelector('.' + NS + '-btn[data-key="layout"]');
    if (!b) return;
    const s = readToolbarStyle();
    const next = TB_MODES[(TB_MODES.indexOf(s) + 1) % TB_MODES.length];
    b.classList.toggle('is-on', s !== 'compact');
    b.setAttribute('data-tip', '工具栏：' + TB_TIPS[s] + '（点击切换「' + TB_TIPS[next] + '」）');
    if (tipOwner === b) showTip(b);   // 提示正显示时文案变了，同步刷新
  }

  // —— 悬浮提示：挂在 body 上的单例浮层 ——
  // 按钮本身在站点卡片内，卡片带 overflow:hidden，提示若用 ::after 定位会被卡片右缘裁掉；
  // 因此改为独立浮层 + 视口定位，靠近屏幕边缘时自动水平回弹、下方放不下时翻到按钮上方。
  let tipEl = null;
  let tipOwner = null;

  function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = NS + '-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(btn) {
    const text = btn.getAttribute('data-tip');
    if (!text || !btn.isConnected) return;
    tipOwner = btn;
    const el = ensureTip();
    el.textContent = text;   // 文案长度会决定宽度，先写入再量尺寸
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 6, pad = 8;
    const left = Math.max(pad, Math.min(r.left + (r.width - w) / 2, window.innerWidth - w - pad));
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - gap - h);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.classList.add('is-on');
  }

  function hideTip() {
    tipOwner = null;
    if (tipEl) tipEl.classList.remove('is-on');
  }

  /** 全局委托：按钮是动态重建的，用事件委托就不必每次挂载后重新绑定 */
  function initTips() {
    if (initTips.done) return;
    initTips.done = true;
    const sel = '.' + NS + '-btn[data-tip]';
    document.addEventListener('pointerover', (e) => {
      const btn = e.target.closest && e.target.closest(sel);
      if (btn && btn !== tipOwner) showTip(btn);
    });
    document.addEventListener('pointerout', (e) => {
      const btn = e.target.closest && e.target.closest(sel);
      if (!btn || btn !== tipOwner) return;
      // 在按钮内部的图标之间移动不算离开
      if (e.relatedTarget && btn.contains(e.relatedTarget)) return;
      hideTip();
    });
    document.addEventListener('focusin', (e) => {
      const btn = e.target.closest && e.target.closest(sel);
      if (btn) showTip(btn);
    });
    document.addEventListener('focusout', (e) => {
      if (e.target.closest && e.target.closest(sel)) hideTip();
    });
    document.addEventListener('mousedown', hideTip, true);
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }


  /** 在「紧凑 → 分组线 → 功能组」三种工具栏布局之间循环切换，并记忆选择 */
  function toggleToolbarStyle() {
    const s = readToolbarStyle();
    const next = TB_MODES[(TB_MODES.indexOf(s) + 1) % TB_MODES.length];
    setToolbarStyle(next, true);
    const bar = root && root.querySelector('.' + NS + '-toolbar');
    if (bar) { bar.classList.remove(NS + '-tb-anim'); void bar.offsetWidth; bar.classList.add(NS + '-tb-anim'); }
    toast('工具栏已切换为「' + TB_TIPS[next] + '」');
  }

  function buildPanel() {
    root = document.createElement('div');
    root.className = NS + '-root';
    // 自家面板标记：同类扩展（PICKCAT Plus）用的是同一套 pcr-* 类名，只能靠这个标记区分彼此
    root.dataset.pcsRoot = '1';
    setToolbarStyle(readToolbarStyle(), false);   // 恢复上次选择的工具栏布局

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
      // 保住编辑区焦点与选区：切到源码时才能把光标映射到同一位置
      b.addEventListener('mousedown', (e) => e.preventDefault());
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
    const layoutBtn = makeBtn({ key: 'layout', html: ICONS.layout, tip: '工具栏布局', onClick: () => toggleToolbarStyle() });
    headRight.appendChild(layoutBtn);
    const helpBtn = makeBtn({ html: ICONS.help, tip: '新手帮助', onClick: (b) => openHelp(b) });
    headRight.appendChild(helpBtn);
    head.appendChild(headRight);
    root.appendChild(head);
    syncLayoutBtn();   // 布局按钮建好后，同步它的选中态与提示

    // —— 工具栏：按钮顺序沿用站点原有习惯；默认紧凑单行，可循环切成「分组线」「功能组」——
    const bar = document.createElement('div');
    bar.className = NS + '-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '富文本编辑工具');

    // groups: [{ label, items:[button] }]，渲染时组间画一条细线、组名以小字显示在按钮下方
    const groups = [];
    let cur = null;
    const group = (label) => { cur = { label, items: [] }; groups.push(cur); };
    const add = (b) => { cur.items.push(b); };
    const I = siteIcon; // 站点原生图标（运行时从站点工具栏读取，缺失时用内置图标兜底）

    // —— 历史 ——
    group('历史');
    add(makeBtn({ key: 'undo', html: ICONS.undo, tip: '撤销 (Ctrl+Z)', onClick: () => exec('undo') }));
    add(makeBtn({ key: 'redo', html: ICONS.redo, tip: '重做 (Ctrl+Y)', onClick: () => exec('redo') }));

    // —— 查找（紧跟撤销/重做，和 Word 的「编辑」区习惯一致）——
    group('查找');
    add(makeBtn({ key: 'find', html: ICONS.search, tip: '查找替换', onClick: (b) => openFind(b) }));

    // —— 字体：粗 / 斜 / 删 / 下划线，外加「标题级别」「对齐方式」两个下拉框，集中所有文字排版 ——
    group('字体');
    add(makeBtn({ key: 'bold', html: I(SITE_LABELS.bold, ICONS.text('B')), tip: '加粗 (Ctrl+B)', onClick: () => exec('bold') }));
    add(makeBtn({ key: 'italic', html: I(SITE_LABELS.italic, ICONS.text('I', 'font-style:italic')), tip: '斜体 (Ctrl+I)', onClick: () => exec('italic') }));
    add(makeBtn({ key: 'strike', html: I(SITE_LABELS.strike, ICONS.text('S', 'text-decoration:line-through')), tip: '删除线', onClick: () => exec('strikeThrough') }));
    add(makeBtn({ key: 'underline', html: I(SITE_LABELS.underline, ICONS.text('U', 'text-decoration:underline;text-underline-offset:2px')), tip: '下划线 (Ctrl+U)', onClick: () => exec('underline') }));
    add(makeDropdown({
      key: 'heading', tip: '标题级别（H1~H4）',
      triggerHtml: ICONS.text('H'),
      items: [
        { label: '一级标题', html: ICONS.text('H1'), isActive: () => currentBlockTag() === 'h1', onSelect: () => toggleHeading(1) },
        { label: '二级标题', html: ICONS.text('H2'), isActive: () => currentBlockTag() === 'h2', onSelect: () => toggleHeading(2) },
        { label: '三级标题', html: ICONS.text('H3'), isActive: () => currentBlockTag() === 'h3', onSelect: () => toggleHeading(3) },
        { label: '四级标题', html: ICONS.text('H4'), isActive: () => currentBlockTag() === 'h4', onSelect: () => toggleHeading(4) }
      ]
    }));
    add(makeDropdown({
      key: 'align', tip: '对齐方式',
      triggerHtml: ICONS.alignLeft,
      items: [
        { label: '左对齐', html: ICONS.alignLeft, isActive: () => alignState() === 'left', onSelect: () => exec('justifyLeft') },
        { label: '居中对齐', html: ICONS.alignCenter, isActive: () => alignState() === 'center', onSelect: () => exec('justifyCenter') },
        { label: '右对齐', html: ICONS.alignRight, isActive: () => alignState() === 'right', onSelect: () => exec('justifyRight') }
      ]
    }));

    // —— 颜色 ——
    group('颜色');
    add(makeBtn({ key: 'color', html: ICONS.color, tip: '文字颜色', onClick: (b) => openPalette(b, 'color') }));
    add(makeBtn({ key: 'highlight', html: ICONS.highlight, tip: '文字背景高亮', onClick: (b) => openPalette(b, 'bg') }));

    // —— 列表 ——
    group('列表');
    add(makeBtn({ key: 'ul', html: I(SITE_LABELS.ul, ICONS.ul), tip: '无序列表', onClick: () => exec('insertUnorderedList') }));
    add(makeBtn({ key: 'ol', html: I(SITE_LABELS.ol, ICONS.ol), tip: '有序列表', onClick: () => exec('insertOrderedList') }));
    add(makeBtn({ key: 'task', html: I(SITE_LABELS.task, ICONS.ul), tip: '任务列表', onClick: insertTaskList }));

    // —— 代码（引用 / 行内代码 / 代码块）——
    group('代码');
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

    // —— 插入（作品 / 表情 / 图片 / 视频 / 链接 / 表格 / 公式 / 分割线）：媒体项复用站点原生选择器，保证上传与图盘逻辑一致 ——
    group('插入');
    // 图标固定用内置的作品图标：不能跟着站点按钮图标走，否则容易和「插入图片」撞脸
    add(makeBtn({ key: 'work', html: ICONS.work, tip: '插入作品（Kitten 作品分享）', onClick: () => delegateSiteAction(SITE_LABELS.work, '插入作品') }));
    add(makeBtn({ key: 'emoji', html: I(SITE_LABELS.emoji, ICONS.text('☺')), tip: '添加表情', onClick: () => delegateSiteAction(SITE_LABELS.emoji, '添加表情') }));
    add(makeBtn({ key: 'image', html: I(SITE_LABELS.image, ICONS.image), tip: '插入图片', onClick: () => delegateSiteAction(SITE_LABELS.image, '插入图片') }));
    add(makeBtn({ key: 'video', html: I(SITE_LABELS.video, ICONS.video), tip: '插入哔哩哔哩视频', onClick: () => delegateSiteAction(SITE_LABELS.video, '插入哔哩哔哩视频') }));
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
    // 模板库：与编辑区输入「/」或「、」唤起的斜杠面板共用同一份模板数据
    add(makeBtn({ key: 'tpl', html: ICONS.text('T'), tip: '模板库（保存并复用常用内容）', onClick: () => openTemplateManager() }));

    // —— 视图 ——
    group('视图');
    add(makeBtn({ key: 'clear', html: ICONS.clear, tip: '清除格式', onClick: () => exec('removeFormat') }));

    // —— AI（彩色图标，一眼区分于工具栏其余单色 stroke 图标）——
    group('AI');
    add(makeBtn({ key: 'aiformat', html: aiFormatIcon(), tip: 'AI 排版（整理整篇 Markdown）', onClick: () => openAIFormatter() }));
    add(makeBtn({ key: 'ai', html: aiIcon(), tip: 'AI 写作助手', onClick: () => openAIWriter() }));

    // 渲染功能组：组名放在按钮下方，和 Word 功能区的分组标注一致
    groups.forEach((g) => {
      const box = document.createElement('div');
      box.className = NS + '-group';
      const row = document.createElement('div');
      row.className = NS + '-group-row';
      g.items.forEach((b) => row.appendChild(b));
      const label = document.createElement('span');
      label.className = NS + '-group-label';
      label.textContent = g.label;
      box.appendChild(row);
      box.appendChild(label);
      bar.appendChild(box);
    });

    // 全屏按钮固定在工具栏最右侧，与常规格式按钮拉开距离
    const fsBtn = makeBtn({ key: 'fullscreen', html: I(SITE_LABELS.fullscreen, ICONS.fullscreen), tip: '全屏编辑', onClick: toggleFullscreen });
    fsBtn.classList.add(NS + '-btn-end');
    bar.appendChild(fsBtn);

    root.appendChild(bar);
    syncAiToolbar();

    // —— 编辑区 ——
    const wrap = document.createElement('div');
    wrap.className = NS + '-editor-wrap';
    editor = document.createElement('div');
    editor.className = NS + '-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('spellcheck', 'false');
    editor.setAttribute('data-placeholder', '在这里开始写你的帖子…支持加粗、标题、列表、图片等，排版所见即所得');
    wrap.appendChild(editor);
    const row = document.createElement('div');
    row.className = NS + '-row';
    row.appendChild(wrap);
    root.appendChild(row);

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
    // 全屏补间沿用浮层的动画速度（--pco-dur）：先用当前值，再异步刷新设置
    applyFsTiming();
    loadFsTiming();
    return root;
  }

  // ============================ 6. 事件绑定 ============================

  function bindEditorEvents() {
    // 输入 → 同步到 Markdown 源码
    editor.addEventListener('input', () => { richToSource(); updateFloatMenu(); refreshFindSoon(); });
    // 输入 → 维护斜杠命令面板（开面板 / 过滤 / 关闭）
    editor.addEventListener('input', onEditorInputForSlash);
    editor.addEventListener('blur', () => { setTimeout(closeFloatMenu, 180); closeSlash(); });

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
      // 斜杠面板打开时优先接管 ↑↓ / Enter / Esc
      if (onSlashKeydown(e)) return;
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
        rememberRichRange();   // 记下光标，切到源码时用它映射位置
      }
    });
    editor.addEventListener('mouseup', () => setTimeout(updateFloatMenu, 0));
    // 在编辑区内重新落点时收起斜杠面板：面板只在刚刚输入 / 的位置有意义
    editor.addEventListener('mouseup', () => closeSlash());
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

  /**
   * 切换视图模式。
   * 返回值：切到源码视图时本次使用的 Markdown 光标偏移（供调用方复用，如 site 弹窗插入），
   * 其它情况返回 null。
   */
  function setMode(next) {
    // 切视图前收起斜杠面板，避免源码视图上残留一个定位在旧光标处的浮层
    closeSlash();
    // 任何视图切换都先清掉上一轮遗留的「插入完成自动返回」监听，避免之后被意外触发
    if (pendingBack) {
      pendingBack();
      pendingBack = null;
    }
    const prevMode = mode;
    mode = next;
    let caretOut = null;
    if (!root) return;
    root.querySelectorAll('.' + NS + '-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.mode === next));
    // 分屏对照时，在富文本区与站点源码区之间画一条横向分割线
    root.classList.toggle(NS + '-is-split', next === 'split');
    // 全屏 + 分屏：源码区挪到右侧做左右对照；离开分屏 / 退出全屏时归位
    layoutSplitFullscreen(root.classList.contains('is-fullscreen'));
    syncTabsVisibility();
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
    // 原生工具栏单独处理：它常常不在 origWrapper 里，站点还会重渲染它
    // 分屏对照也只保留插件工具栏，站点原生工具栏仅在源码视图显示
    syncNativeToolbar(next === 'source');

    if (next === 'source') {
      // 用户本来就在源码侧编辑（分屏）：保留它在 textarea 里的光标，不要重新映射
      const editingSource = textarea && document.activeElement === textarea;
      caretOut = editingSource ? null : richCaretMarkdownOffset();
      const prevSel = textarea ? { s: textarea.selectionStart, e: textarea.selectionEnd } : null;
      // 以富文本为准，刷新源码
      richToSource();
      closeFloatMenu();
      setTimeout(() => {
        if (!textarea || mode !== 'source') return;
        textarea.focus();
        if (caretOut != null) syncCaretToTextarea(caretOut);
        else if (editingSource && prevSel && prevSel.s != null) {
          // 分屏切过来：光标停在原来源码里的位置，不要跳到文末
          try { textarea.setSelectionRange(prevSel.s, prevSel.e); } catch (e) { /* noop */ }
        }
      }, 0);
    } else if (next === 'split') {
      // 分屏：以富文本为准刷新源码，并把光标映射到源码侧，两边看到同一个位置。
      // 必须等 richToSource 写完 textarea 再设光标（重写 value 会把选区重置到文末）
      const editingSource = textarea && document.activeElement === textarea;
      const caret = editingSource ? null : richCaretMarkdownOffset();
      richToSource();
      if (caret != null) syncCaretToTextarea(caret);
    } else {
      // 回到可视化：以源码为准刷新富文本（用户可能刚在源码里改过）
      sourceToRich();
    }
    // 查找浮层开着时，视图切换会改变查找目标（富文本 ↔ 原生输入框），重新扫描一次
    if (findPop) runFind(false, { quiet: true });
    fitEditorViewport();
    return caretOut;
  }

  // ============================ 8. 挂载与 SPA 监听 ============================

  function findTextarea() {
    return document.querySelector('textarea#post-content') ||
      document.querySelector('textarea[name="content"]') ||
      document.querySelector('form textarea') ||
      document.querySelector('textarea');
  }

  /** 节点是否属于脚本自己注入的面板 */
  function isOwnNode(el) {
    return !!(el && ((root && root.contains(el)) || (el.closest && el.closest('.' + NS + '-root'))));
  }

  /** 找站点原生工具栏：优先 role=toolbar，其次「输入框上方、同一列的纯图标行」 */
  function findNativeToolbar() {
    if (!textarea) return null;
    let node = textarea.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const bars = Array.from(node.querySelectorAll('[role="toolbar"]')).filter((el) => !isOwnNode(el));
      if (bars.length) return bars[0];
    }

    const taRect = textarea.getBoundingClientRect();
    const hasGeom = taRect.width > 0 && taRect.height > 0;
    const isIconBtn = (b) => {
      if (isOwnNode(b) || (b.textContent || '').trim() || !b.querySelector('svg')) return false;
      if (!hasGeom) return true;   // 原生输入框已隐藏时只做结构判断
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width <= 48 && r.height <= 48;
    };
    node = textarea.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      let hit = null;
      node.querySelectorAll('div, nav, ul').forEach((el) => {
        if (hit || isOwnNode(el)) return;
        if (el.querySelector('textarea, input, [contenteditable="true"]')) return;
        if (Array.from(el.children).filter(isIconBtn).length < 3) return;
        if (!hasGeom) { hit = el; return; }
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.height > 64) return;
        if (r.top >= taRect.top) return;                             // 必须在输入框上方
        if (r.left > taRect.right || r.right < taRect.left) return;  // 与输入框同一列
        hit = el;
      });
      if (hit) return hit;
    }
    return null;
  }

  /** 站点原生编辑器容器：优先「含有工具栏的最近祖先」，否则退回直接父级 */
  function locateOrigWrapper(ta) {
    const t = ta || textarea;
    if (!t) return null;
    const parent = t.parentElement;
    const guess = parent && parent.parentElement ? parent.parentElement : parent;
    if (guess && !isOwnNode(guess) && guess.querySelector('[role="toolbar"]')) return guess;
    return parent;
  }

  /** 从原生工具栏向上找到「整条工具行」容器（含右侧的全屏 / 预览等操作），遇到输入框就停 */
  function findNativeBarScope(el) {
    const card = (origWrapper && origWrapper.parentElement) || null;
    if (!el || !card) return el;
    let node = el;
    while (node.parentElement && node.parentElement !== card) {
      const p = node.parentElement;
      if (isOwnNode(p)) break;
      if (origWrapper && p === origWrapper) break;
      // 再往上会连标题输入框 / 正文输入框一起藏掉，必须停
      if (p.querySelector('textarea, [contenteditable="true"], input[type="text"], input:not([type])')) break;
      node = p;
    }
    return node;
  }

  /** 可视化模式隐藏站点原生工具栏；源码 / 分屏模式恢复（站点弹窗要按它定位） */
  function syncNativeToolbar(show) {
    // 卡片级标记：站点把工具行重渲染成新节点后，元素级 class 会丢，这一层仍然生效
    const card = (origWrapper && origWrapper.parentElement) || null;
    if (card) card.classList.toggle(NS + '-native-off', !show);

    if (show) {
      // 恢复：把上一轮标记过的节点依次还原
      nativeHiddenEls.forEach((el) => { if (el && el.isConnected) el.classList.remove(NS + '-native-collapsed'); });
      nativeHiddenEls = [];
      return;
    }

    if (!nativeToolbar || !nativeToolbar.isConnected) nativeToolbar = findNativeToolbar();

    const targets = [];
    if (nativeToolbar) {
      targets.push(nativeToolbar);
      // 站点的「全屏 / 预览」操作常常在工具行外侧的同一行里，需要整条行一起隐藏
      const bar = findNativeBarScope(nativeToolbar);
      if (bar && bar !== nativeToolbar) targets.push(bar);
    }
    // 兜底：按无障碍标签把全屏 / 预览按钮单独藏掉（工具行被拆成多块时也能覆盖）
    if (card) {
      card.querySelectorAll('button, [role="button"], a').forEach((b) => {
        if (isOwnNode(b)) return;
        const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim();
        if (/(全屏|预览|最大化|fullscreen|preview)/i.test(label)) targets.push(b);
      });
    }

    nativeHiddenEls = Array.from(new Set(targets));
    nativeHiddenEls.forEach((el) => {
      el.dataset.pcrNativeBar = '1';
      el.classList.add(NS + '-native-collapsed');
    });
  }

  /** 站点原生工具栏里的「全屏 / 最大化」按钮（可见状态下才返回） */
  function findNativeFullscreenBtn() {
    const scope = (origWrapper && origWrapper.parentElement) || document;
    const nodes = scope.querySelectorAll('button, [role="button"], a');
    for (const b of nodes) {
      if (isOwnNode(b)) continue;
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim();
      if (!/(全屏|最大化|fullscreen)/i.test(label)) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return b;
    }
    return null;
  }

  /** 站点原生编辑器是否正处于全屏（浏览器全屏 / 按钮已变「退出」/ 祖先铺满视口的固定浮层） */
  function siteFullscreenOn() {
    if (document.fullscreenElement) return true;
    const btn = findNativeFullscreenBtn();
    if (btn && /退出|exit/i.test((btn.getAttribute('aria-label') || '') + (btn.getAttribute('title') || '') + (btn.textContent || ''))) return true;
    let p = textarea && textarea.parentElement;
    while (p && p !== document.body) {
      if (getComputedStyle(p).position === 'fixed') {
        const r = p.getBoundingClientRect();
        if (r.width >= innerWidth * .9 && r.height >= innerHeight * .9) return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  /** 可视化模式下的兜底：站点重渲染原生容器 / 工具行后，重新定位并隐藏 */
  function keepNativeHidden() {
    if (!textarea || !textarea.isConnected) { mount(); return; }
    if (!origWrapper || !origWrapper.isConnected) origWrapper = locateOrigWrapper(textarea);
    if (origWrapper) origWrapper.classList.add(NS + '-native-collapsed');
    syncNativeToolbar(false);
  }

  let yieldedOnce = false;

  /** 页面上是否已有「别的扩展」挂载的同款富文本面板（PICKCAT Plus 等）。
      两边类名 / 结构 / 样式 id 都相同，只能靠自家面板上的 data-pcs-root 标记区分。 */
  function foreignEditorRoot() {
    const list = document.querySelectorAll('.' + NS + '-root');
    for (const el of list) {
      if (el === root || el.dataset.pcsRoot === '1') continue;
      return el;
    }
    return null;
  }

  /** 让位：拆掉自己的面板，把同一个 textarea 交给对方的编辑器，避免两套编辑器互相抢写。
      只清理自己创建的节点与动画状态；站点元素上的隐藏类保持原样（对方可视化模式同样需要），
      反正对方会按自己的视图状态持续维护它们。 */
  function yieldToForeignEditor() {
    if (root) {
      closeFind();
      if (root.parentElement) root.parentElement.removeChild(root);
    }
    // AI 模块的变量声明在文件更靠后的位置，首次挂载即让位时会命中暂时性死区，这里兜一下
    try { closeAIWriter(); } catch (e) { /* AI 模块尚未初始化 */ }
    try { closeAIFormatter(); } catch (e) { /* 同上 */ }
    root = null;
    editor = null;
    nativeHiddenEls = [];
    nativeToolbar = null;
    origWrapper = null;
    fsAnimating = false;
    clearTimeout(fsAnimTimer);
    fsAnimTimer = 0;
    fsLockScroll(false);
    if (!yieldedOnce) {
      yieldedOnce = true;
      try { console.info('[PickScribe] 检测到另一套富文本编辑器（如 PICKCAT Plus），编辑页已交由对方接管'); } catch (e) { /* noop */ }
    }
  }

  /** 普通视图下把编辑区高度收进视口：切换条 / 工具栏固定，只让正文区滚动，
      避免「页面滚动 + 编辑区滚动」两条滚动条同时出现。全屏由 flex 布局自适应。
      让位后页面上是对方的同款面板（类名一致），这里按 DOM 统一处理，不再依赖自己的 editor 引用。 */
  function fitEditorViewport() {
    const own = root && editor && document.body.contains(root);
    const panel = own ? root : document.querySelector('.' + NS + '-root');
    if (!panel) return;
    const body = own ? editor : panel.querySelector('.' + NS + '-editor');
    if (!body) return;
    const wrap = body.closest('.' + NS + '-editor-wrap');
    // 全屏走 flex 自适应；源码视图没有正文滚动区；分屏要留出下半屏的原生源码区
    const skip = panel.classList.contains('is-fullscreen') ||
      panel.classList.contains(NS + '-is-split') ||
      !!(wrap && wrap.classList.contains(NS + '-hidden'));
    if (skip) {
      if (body.style.maxHeight) body.style.maxHeight = '';
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      if (body.style.maxHeight) body.style.maxHeight = '';
      return;
    }
    // 面板里除编辑区以外的固定高度（切换条 + 工具栏 + 内边距），编辑区要扣掉这部分才算得准
    const chrome = Math.max(0, rect.height - body.offsetHeight);
    // 面板顶部到视口底部的剩余高度（扣掉固定高度与底部留白）；窗口太矮时保留最小可用高度
    const avail = Math.max(320, window.innerHeight - rect.top - chrome - 24);
    const next = Math.round(avail) + 'px';
    if (body.style.maxHeight !== next) body.style.maxHeight = next;
  }

  function mount() {
    if (!isEditorPage()) return;
    const ta = findTextarea();
    if (!ta) return;
    // 节点还没进文档说明尚未渲染；已经进文档的即使暂时不可见也照常挂载，
    // 避免站点容器折叠 / 隐藏时偶发「不注入」。
    if (!document.body.contains(ta)) return;

    // 页面上已有别人的同款富文本面板：直接让位，不再注入第二套
    if (foreignEditorRoot()) {
      // 记下站点输入框，让开放接口的 editor.read 仍能读到对方编辑器写回的内容
      textarea = ta;
      lastTaValue = ta.value;
      yieldToForeignEditor();
      fitEditorViewport();
      return;
    }

    const wired = ta.dataset[MOUNT_FLAG] === '1';
    const panelAlive = root && document.body.contains(root);
    if (wired && panelAlive) return;   // 已挂载且面板健在，无需处理

    // 面板要重建：先收起查找浮层，它的高亮 Range 指向的是即将被丢弃的旧编辑区
    closeFind();

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
      ta.addEventListener('input', () => { lastTaValue = ta.value; sourceToRich(); refreshFindSoon(); });

      // 提交前兜底：确保 Markdown 已写入 textarea
      const form = ta.closest('form');
      if (form) form.addEventListener('submit', () => { richToSource(); }, true);
    } else {
      // 已挂载过，但面板被站点重渲染移除了（编辑帖子页加载内容后很常见）——
      // 清掉旧节点，下面重建一个新的，否则会表现为「脚本完全不生效」。
      if (root && root.parentElement) root.parentElement.removeChild(root);
      root = null;
      // 面板被移除时顺带解除全屏留下的滚动锁与补间状态，避免页面卡在不可滚动
      fsAnimating = false;
      clearTimeout(fsAnimTimer);
      fsAnimTimer = 0;
      fsLockScroll(false);
    }

    // 定位站点原生编辑器容器（工具栏 + 输入框 的公共父级）
    origWrapper = locateOrigWrapper(ta);
    nativeToolbar = findNativeToolbar();

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
    editorBaselineMd = ta.value;

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

  // 常驻看护 1：面板被站点重渲染移除时自动重建，并在站内路由切换时立即挂载。
  // 编辑帖子页会先加载帖子数据再渲染编辑器，Vue 重渲染容易把注入的节点冲掉；
  // 另外站点是 SPA，站内跳转不刷新页面，必须靠这里兜底（否则会出现「有时注入、有时不注入」）。
  // 字体与编辑页无关（整站生效），因此放在编辑页判断之前：样式节点被重渲染丢掉时也要恢复。
  let lastHref = location.href;
  setInterval(() => {
    if (!document.getElementById(FONT_STYLE_ID)) injectFontStyle(customFaces.length > 0);
    // 离开编辑页：把独立窗口一并收起，避免它跟着 SPA 路由飘到别的页面上
    if (!isEditorPage()) { if (aiPop) closeAIWriter(); return; }
    // 对方的富文本编辑器可能比我们晚注入：一旦出现，立刻拆掉自己的面板让位
    if (foreignEditorRoot()) {
      if (root) yieldToForeignEditor();
      if (!textarea) textarea = findTextarea();   // 让 open API 的 editor.read 仍可读到正文
      fitEditorViewport();   // 对方的编辑器同样收进视口，保证整页只剩编辑区一条滚动条
      return;
    }
    const routeChanged = location.href !== lastHref;
    lastHref = location.href;
    if (routeChanged) closeAIWriter();   // 编辑页内切换路由（如 新建 / 编辑）时，同样收起
    if (routeChanged || !root || !document.body.contains(root)) mount();
    // 站点会重渲染原生工具栏（尤其是选中 / 失焦时），这里持续把可视化模式下的原生工具栏藏好
    else if (mode === 'rich') keepNativeHidden();
    // 站点原生全屏（源码视图）时隐藏视图切换滑块，退出后恢复
    syncTabsVisibility();
  }, 600);

  // 常驻看护 2：框架（Vue v-model）可能直接改写 textarea.value 且不派发 input，
  // 这里做兜底同步；脚本自己写入的值记录在 lastTaValue，不会被误判为外部变化。
  setInterval(() => {
    if (!textarea || !editor) return;
    if (textarea.value !== lastTaValue) {
      lastTaValue = textarea.value;
      if (mode !== 'source') sourceToRich();
    }
  }, 700);

  // 字体：与编辑页无关，整站生效，脚本启动即注入；具体来源（鸿蒙 / 自定义）随后由设置决定
  injectFontStyle(false);
  loadFontSetting();

  // G2 圆角：同样整站生效，先按默认开启注入，再按存储里的开关校正
  injectRadiusStyle();
  loadRadiusSetting();

  // 悬浮提示用全局事件委托，启动时绑定一次即可（面板会被站点重渲染重建，不需要重复绑定）
  initTips();

  // 视口变化后重新把编辑区收进视口（只影响可视化模式，源码 / 分屏走默认高度）
  let fitTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitEditorViewport, 120);
  });

  // ============================ 9. AI 写作助手 ============================

  /* 在可视化编辑器工具栏里加一个彩色图标的「AI 写作助手」浮层：
     快捷指令 / 自定义指令 → 结合当前正文交给后台大模型流式生成 → 插入 / 替换 / 复制。
     复用通用浮层 .pcr-pop（同一套定位、关闭、层级与样式变量），并复用后台 Port：
     port 名字 'pcai'、消息 {type:'start', id, messages, cacheKey, bypass}，与 ai/content.js 完全一致；
     后台 handleStart 本就「直接透传 messages、cacheKey 可为 null」，所以后台无需任何改动。 */

  const AI_CONFIG_KEY = 'pcai_config';   // 配置键，与 shared/constants.js / ai/content.js 保持一致
  const AI_MAX_BODY = 6000;              // 正文上下文截断上限（字符），避免超上下文
  const AI_DOCK_KEY = 'pcrAiDock';       // 侧边栏模式开关（记忆到 localStorage）
  const AI_POS_KEY = 'pcrAiPos';         // 浮动模式的窗口坐标（拖动后记忆）

  // 兜底默认值（字段与 shared/constants.js 的 DEFAULT_CONFIG 一致，这里只取本功能用得到的几项）
  const AI_DEFAULTS = {
    aiEnabled: true, aiFormat: true, aiWriter: true,
    provider: 'deepseek', apiKey: '', model: 'deepseek-chat', stream: true
  };

  // 快捷指令按用途分组：左列固定标签、右侧胶囊，多行时也能整齐对齐（原先把 8 个按钮挤成一片）
  const AI_QUICK_GROUPS = [
    {
      label: '改表达',
      items: [
        { label: '润色', prompt: '请润色下面这段正文，保持原意与事实不变，让表达更通顺、更专业。' },
        { label: '更自然', prompt: '请把下面这段正文改写得更自然通顺、易读，保持原意。' },
        { label: '缩短', prompt: '请把下面这段正文压缩得更精炼，保留核心信息。' },
        { label: '扩写', prompt: '请把下面这段正文扩写得更充实，补充合理细节，但不要编造关键事实。' }
      ]
    },
    {
      label: '理结构',
      items: [
        { label: '整理成大纲', prompt: '请把下面这段正文整理成结构化大纲，用 Markdown 多级列表输出。' },
        { label: '起标题', prompt: '请为下面这段正文起 5 个吸引人的标题，用 Markdown 无序列表输出。' }
      ]
    },
    {
      label: '换语言',
      items: [
        { label: '译成英文', prompt: '请把下面这段正文翻译成地道、自然的英文。' }
      ]
    },
    {
      label: '接着写',
      items: [
        { label: '续写', prompt: '请顺着下面这段正文的思路继续往下写一小段，风格保持一致。' }
      ]
    }
  ];

  // 扁平化索引：与 data-ai-chip 的下标一一对应
  const AI_QUICK = AI_QUICK_GROUPS.reduce((all, g) => all.concat(g.items), []);

  // 系统提示词：只输出结果本身 + 用 Markdown 排版（本功能为写作场景，与详情页总结的默认提示词区分开）
  const AI_SYSTEM_PROMPT = '你是一个专业、克制的中文写作助手。用户会提供一段「当前正文」作为参考并给出写作指令，'
    + '请严格按指令处理，并且只输出结果本身：不要任何开场白、解释、总结或「以下是……」之类的话；'
    + '结果必须使用 Markdown 排版（可用小标题、列表、加粗等），不要输出 HTML，也不要把整段结果包进代码围栏；'
    + '除非指令明确要求，否则不要整段复述原文。';

  // —— 状态 ——
  let aiConfig = { ...AI_DEFAULTS };                                 // 从 chrome.storage.local 读取的配置
  let aiPop = null;                                                  // 面板根节点（.pcr-pop.pcr-ai）
  let aiRefs = null;                                                 // 面板内部节点引用
  let aiBusy = false;                                                // 是否正在生成
  let aiStreamText = '';                                             // 流式累积的结果文本
  let aiLastInstruction = '';                                        // 上次指令（「再次生成」用）
  let aiReqId = null;                                                // 当前进行中的请求 id
  // 打开面板时捕获的上下文：选中文本 / 富文本选区 / 源码光标偏移，供插入 / 替换使用
  let aiCtx = { selectedText: '', range: null, taStart: null, taEnd: null, mode: 'rich' };
  let aiDock = false;                                                // 是否贴靠为右侧边栏
  let aiDrag = null;                                                 // 拖动状态 { dx, dy }，null 表示未在拖动

  // 与后台 Service Worker 的长连接（名字 'pcai'，协议与 ai/content.js 一致，断线自动重连）
  let aiPort = null;
  const aiPending = new Map();
  let aiSeq = 0;

  /** 某项 AI 能力是否开启（总开关优先） */
  function aiOn(name) {
    if (aiConfig.aiEnabled === false) return false;
    return aiConfig[name] !== false;
  }

  /** 按设置显示 / 隐藏工具栏里的 AI 排版与写作助手；整组都关掉时连组标题一起隐藏 */
  function syncAiToolbar() {
    const host = root || document;
    const f = host.querySelector('.' + NS + '-btn[data-key="aiformat"]');
    const w = host.querySelector('.' + NS + '-btn[data-key="ai"]');
    if (f) f.style.display = aiOn('aiFormat') ? '' : 'none';
    if (w) w.style.display = aiOn('aiWriter') ? '' : 'none';
    const box = f && f.closest('.' + NS + '-group');
    if (box) box.style.display = aiOn('aiFormat') || aiOn('aiWriter') ? '' : 'none';
  }

  /** AI 图标：与站点一致的单色图标，继承当前文字颜色 */
  function aiIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">' +
      '<path d="M10 2.5 11.7 8.3 17.5 10 11.7 11.7 10 17.5 8.3 11.7 2.5 10 8.3 8.3Z"/>' +
      '<path d="M17.8 3 18.5 5.5 21 6.2 18.5 6.9 17.8 9.4 17.1 6.9 14.6 6.2 17.1 5.5Z" opacity=".55"/>' +
      '<path d="M18.4 14.6 19 16.4 20.8 17 19 17.6 18.4 19.4 17.8 17.6 16 17 17.8 16.4Z" opacity=".35"/>' +
      '</svg>';
  }

  // ---------------------------- 9.1 配置读取 ----------------------------

  /** 读取 AI 配置（与 ai/content.js 一样从 chrome.storage.local 的 pcai_config 取） */
  function aiLoadConfig() {
    try {
      chrome.storage.local.get([AI_CONFIG_KEY], (raw) => {
        aiConfig = { ...AI_DEFAULTS, ...((raw && raw[AI_CONFIG_KEY]) || {}) };
        syncAiToolbar();
        if (aiRefs) syncAIBtns();
      });
    } catch (e) { /* 非扩展环境忽略 */ }
  }

  // ---------------------------- 9.2 后台 Port（复用 'pcai' 协议） ----------------------------

  /** 扩展上下文是否仍然有效（扩展被重载/停用后，旧内容脚本的 chrome.runtime 会失效） */
  function aiExtAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function aiEnsurePort() {
    if (aiPort) return aiPort;
    if (!aiExtAlive()) return null;   // 上下文已失效，无法再与后台通信
    try {
      aiPort = chrome.runtime.connect({ name: 'pcai' });
    } catch (e) {
      aiPort = null;
      return null;
    }
    aiPort.onMessage.addListener((msg) => {
      const cb = aiPending.get(msg && msg.id);
      if (!cb) return;
      if (msg.type === 'chunk') { if (cb.onChunk) cb.onChunk(msg.delta); }
      else if (msg.type === 'done') { aiPending.delete(msg.id); if (cb.onDone) cb.onDone(msg); }
      else if (msg.type === 'error') { aiPending.delete(msg.id); if (cb.onError) cb.onError(msg); }
    });
    aiPort.onDisconnect.addListener(() => {
      // 页面进入往返缓存（bfcache）时浏览器会强制关闭端口，
      // 这里主动读取 lastError，避免 Chrome 把它记成「未处理错误」
      void chrome.runtime.lastError;
      aiPort = null;
      // 请求途中被断开：把未完成的回调统一转成错误，避免面板卡在「正在生成」
      aiPending.forEach((cb) => {
        if (cb.onError) cb.onError({ code: 'disconnect', message: '后台连接已断开，请重试' });
      });
      aiPending.clear();
      aiReqId = null;
    });
    return aiPort;
  }

  /** 发起一次生成请求：cacheKey 传 null（写作助手每次都是新请求，不写缓存）
      maxTokens 可选：单次请求覆盖设置里的输出上限（AI 排版按正文长度动态放宽） */
  function aiRequest({ messages, maxTokens, onChunk, onDone, onError }) {
    const id = 'a' + (++aiSeq);
    const p = aiEnsurePort();
    if (!p) {
      onError({ code: 'context', message: '扩展已更新或已停用，请刷新页面后再试' });
      return id;
    }
    aiPending.set(id, { onChunk, onDone, onError });
    try {
      p.postMessage({ type: 'start', id, messages, cacheKey: null, bypass: true, maxTokens: maxTokens });
    } catch (e) {
      aiPending.delete(id);
      onError({ code: 'port', message: '后台连接失败，请重新加载页面后再试' });
    }
    return id;
  }

  function aiAbort() {
    if (aiReqId && aiPort) {
      try { aiPort.postMessage({ type: 'abort', id: aiReqId }); } catch (e) { /* 忽略 */ }
    }
    if (aiReqId) aiPending.delete(aiReqId);
    aiReqId = null;
  }

  // ---------------------------- 9.3 提示词组装 ----------------------------

  /** 取当前编辑器正文（Markdown）；过长按 AI_MAX_BODY 截断 */
  function aiCurrentBody() {
    let md = '';
    if (mode === 'source' && textarea) md = textarea.value;
    else if (editor) md = htmlToMd(editor);       // 可视化 / 分屏：以富文本为准
    else if (textarea) md = textarea.value;
    md = String(md || '').trim();
    if (md.length > AI_MAX_BODY) md = md.slice(0, AI_MAX_BODY) + '\n……（正文过长，已截断）';
    return md;
  }

  /** 组装发给模型的消息：system 约束「只输出结果 + Markdown」，user 为「指令 + 当前正文」 */
  function aiBuildMessages(instruction, body) {
    const ref = body
      ? '参考正文（当前编辑器内容，供你理解上下文）：\n\n' + body
      : '（当前编辑器里还没有正文，请直接依据指令进行写作。）';
    return [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: '写作指令：' + instruction + '\n\n' + ref }
    ];
  }

  // ---------------------------- 9.4 上下文捕获 / 插入与替换 ----------------------------

  /** 打开面板时捕获选区 / 光标：富文本取选区 Range，源码取 textarea 光标偏移 */
  function captureAIContext() {
    aiCtx = { selectedText: '', range: null, taStart: null, taEnd: null, mode: mode };
    if (mode === 'source' && textarea) {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      if (s != null && e != null) {
        aiCtx.taStart = s;
        aiCtx.taEnd = e;
        if (e > s) aiCtx.selectedText = textarea.value.slice(s, e);
      }
      return;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && editor && editor.contains(sel.anchorNode)) {
      aiCtx.selectedText = sel.toString();
      try { aiCtx.range = sel.getRangeAt(0).cloneRange(); } catch (e) { aiCtx.range = null; }
    }
  }

  /** 富文本区里当前是否存在有效选区（用于「替换选中内容」） */
  function aiLiveEditorRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && editor &&
        editor.contains(sel.anchorNode) && editor.contains(sel.focusNode)) {
      return sel.getRangeAt(0);
    }
    return null;
  }

  /** 插入到富文本光标处（先把选区折叠到末尾，避免误删选中文字） */
  function aiInsertToEditor(html) {
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && editor.contains(sel.anchorNode)) sel.collapseToEnd();
    insertHtml(html);     // insertHtml 内部在无选区时会定位到文末
    richToSource();
  }

  /** 用富文本替换选中内容：优先用实时选区，其次用打开面板时保存的 Range */
  function aiReplaceInEditor(html) {
    if (!editor) return;
    const range = aiLiveEditorRange() || aiCtx.range;
    editor.focus();
    if (!range) { aiInsertToEditor(html); return; }
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('insertHTML', false, html);
    } catch (e) {
      aiInsertToEditor(html);
      return;
    }
    richToSource();
  }

  /** 源码视图下的 textarea 光标：优先用实时位置，否则回退到打开面板时捕获的偏移 */
  function aiTextareaSel() {
    if (!textarea) return { s: 0, e: 0 };
    if (document.activeElement === textarea) {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      if (s != null && e != null) return { s: s, e: e };
    }
    const fallback = textarea.value.length;
    return { s: aiCtx.taStart != null ? aiCtx.taStart : fallback, e: aiCtx.taEnd != null ? aiCtx.taEnd : fallback };
  }

  /** 插入到源码 textarea 光标处（setTextareaValue 会派发 input，触发富文本同步） */
  function aiInsertToTextarea(text) {
    if (!textarea) return;
    const sel = aiTextareaSel();
    const at = sel.e > sel.s ? sel.e : sel.s;     // 插入：选区折叠到末尾，不删选中文字
    const v = textarea.value;
    setTextareaValue(v.slice(0, at) + text + v.slice(at));
    try { textarea.selectionStart = textarea.selectionEnd = at + text.length; } catch (e) { /* noop */ }
    if (mode === 'source') textarea.focus();
  }

  /** 用结果替换源码 textarea 里的选中内容；没有选中则返回 false */
  function aiReplaceInTextarea(text) {
    if (!textarea) return false;
    const sel = aiTextareaSel();
    if (sel.e <= sel.s) return false;
    const v = textarea.value;
    setTextareaValue(v.slice(0, sel.s) + text + v.slice(sel.e));
    try { textarea.selectionStart = textarea.selectionEnd = sel.s + text.length; } catch (e) { /* noop */ }
    if (mode === 'source') textarea.focus();
    return true;
  }

  // ---------------------------- 9.5 面板 UI ----------------------------

  function aiRenderPlaceholder() {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-ph">选一个快捷指令，或在下方输入自定义要求；'
      + '生成时会把当前正文一起发给模型。结果可一键插入正文或替换选中内容。</div>';
  }

  function aiRenderLoading() {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-loading"><span class="' + NS + '-ai-spin"></span>'
      + '<span>正在生成…</span></div>';
    aiClearUsage();
  }

  /** 流式渲染：走 sanitizeHtml 兜底，防止模型输出里混入危险 HTML */
  function aiRenderStream() {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-out">' + sanitizeHtml(mdToHtml(aiStreamText)) +
      '<span class="' + NS + '-ai-caret"></span></div>';
  }

  function aiRenderDone() {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-out">' + sanitizeHtml(mdToHtml(aiStreamText)) + '</div>';
  }

  function aiRenderError(msg) {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-note">' + escapeHtml(msg) +
      '<div class="' + NS + '-ai-tip">可检查扩展设置里的模型 / 密钥，或稍后重试。</div>' +
      '<div class="' + NS + '-ai-note-act">' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="again">重试</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="settings">打开设置</button>' +
      '</div></div>';
  }

  /** 未配置 API Key 时的友好提示 + 打开设置入口 */
  function aiRenderNoKey() {
    if (!aiRefs) return;
    aiRefs.result.innerHTML = '<div class="' + NS + '-ai-note">还没有配置 API Key，AI 写作助手暂时用不了。' +
      '<div class="' + NS + '-ai-tip">请先在扩展设置里选择服务商并填写密钥（本地 Ollama 无需 Key）。</div>' +
      '<div class="' + NS + '-ai-note-act">' +
        '<button type="button" class="' + NS + '-ai-act is-primary" data-ai="settings">打开设置</button>' +
      '</div></div>';
  }

  function aiOpenOptions() {
    // 回调形式：不返回 Promise，扩展刚被重载时也不会产生未处理的 rejection
    try { chrome.runtime.sendMessage({ type: 'open-options' }, () => { void chrome.runtime.lastError; }); }
    catch (e) { toast('请在浏览器扩展栏打开「扩展选项」设置页'); }
  }

  /** Token 缩写：1234 → 1.2k（窄胶囊里只做概览，详情进 title） */
  function aiFmtToken(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  /** refs 参数可选：写作助手与 AI 排版两个窗口共用同一套用量展示逻辑 */
  function aiSetUsage(u, refs) {
    const box = refs || aiRefs;
    if (!box || !box.usage) return;
    if (!u || !u.total) { aiClearUsage(refs); return; }
    const est = !!u.estimated;
    box.usage.textContent = (est ? '≈' : '') + '↑' + aiFmtToken(u.prompt) + ' ↓' + aiFmtToken(u.completion) +
      ' · ' + aiFmtToken(u.total);
    box.usage.classList.toggle('is-est', est);
    box.usage.title = [
      est ? '服务商未返回 usage，以下为本地估算值' : '本次用量（服务商返回）',
      '输入 ' + u.prompt + ' Tokens',
      '输出 ' + u.completion + ' Tokens',
      '合计 ' + u.total + ' Tokens'
    ].join('\n');
  }

  function aiClearUsage(refs) {
    const box = refs || aiRefs;
    if (!box || !box.usage) return;
    box.usage.textContent = '';
    box.usage.classList.remove('is-est');
    box.usage.title = '';
  }

  /** 停止当前生成：保留已输出片段，不再继续追加 */
  function aiStop() {
    if (!aiBusy) return;
    aiAbort();
    aiBusy = false;
    aiClearUsage();
    if (aiStreamText.trim()) aiRenderDone();
    else aiRefs && (aiRefs.result.innerHTML = '<div class="' + NS + '-ai-ph">已停止生成。</div>');
    toast('已停止生成');
    syncAIBtns();
  }

  /** 同步面板里各按钮的可用状态 */
  function syncAIBtns() {
    if (!aiRefs) return;
    const hasText = !!aiStreamText.trim();
    aiRefs.gen.disabled = aiBusy;
    aiRefs.el.querySelectorAll('.' + NS + '-ai-chip').forEach((b) => { b.disabled = aiBusy; });
    aiRefs.btnInsert.disabled = aiBusy || !hasText;
    aiRefs.btnReplace.disabled = aiBusy || !hasText || !aiCtx.selectedText;   // 无选中则禁用「替换」
    aiRefs.btnCopy.disabled = !hasText;
    aiRefs.btnAgain.disabled = aiBusy || !aiLastInstruction;
    if (aiRefs.btnStop) aiRefs.btnStop.classList.toggle(NS + '-ai-hide', !aiBusy);
    aiRefs.sub.textContent = aiConfig.model || '';
  }

  // ---------------------------- 9.6 生成与结果操作 ----------------------------

  const aiScheduleStream = debounce(() => { aiRenderStream(); }, 80);

  /** 点击自定义「生成」 */
  function aiGenerateCustom() {
    if (!aiRefs) return;
    const v = (aiRefs.input.value || '').trim();
    if (!v) { toast('请输入写作指令'); aiRefs.input.focus(); return; }
    aiRun(v);
  }

  /** 跑一次生成：组装 messages → 经 Port 流式回传 → 渲染 */
  function aiRun(instruction) {
    if (!aiPop || !aiRefs) return;
    if (aiBusy) { toast('正在生成中，请稍候…'); return; }
    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama') { aiRenderNoKey(); syncAIBtns(); return; }

    aiLastInstruction = instruction;
    const messages = aiBuildMessages(instruction, aiCurrentBody());

    aiAbort();
    aiStreamText = '';
    aiBusy = true;
    aiRenderLoading();
    syncAIBtns();

    aiReqId = aiRequest({
      messages,
      onChunk(delta) {
        aiStreamText += delta;
        aiScheduleStream();
      },
      onDone(msg) {
        aiReqId = null;
        aiBusy = false;
        aiStreamText = msg.text || aiStreamText;
        if (!aiStreamText.trim()) { aiRenderError('模型没有返回内容，请更换指令或模型后重试。'); aiClearUsage(); }
        else { aiRenderDone(); aiSetUsage(msg.usage); }
        syncAIBtns();
      },
      onError(err) {
        aiReqId = null;
        aiBusy = false;
        aiRenderError((err && err.message) || '生成失败，请稍后重试');
        aiClearUsage();
        syncAIBtns();
      }
    });
  }

  /** 「插入到正文」：源码模式插入 textarea 光标处，其余模式插入富文本光标处 */
  function aiDoInsert() {
    if (!aiStreamText || aiBusy) return;
    if (mode === 'source' && textarea) { aiInsertToTextarea(aiStreamText); toast('已插入到源码光标处'); return; }
    if (!editor) { toast('没有可插入的编辑区'); return; }
    aiInsertToEditor(sanitizeHtml(mdToHtml(aiStreamText)));
    toast('已插入到光标处');
  }

  /** 「替换选中内容」：有选中则替换，否则退化为插入并提示 */
  function aiDoReplace() {
    if (!aiStreamText || aiBusy) return;
    if (mode === 'source' && textarea) {
      if (aiReplaceInTextarea(aiStreamText)) toast('已替换选中内容');
      else { toast('没有选中内容，已改为插入'); aiInsertToTextarea(aiStreamText); }
      return;
    }
    if (!editor) return;
    if (aiLiveEditorRange() || aiCtx.range) {
      aiReplaceInEditor(sanitizeHtml(mdToHtml(aiStreamText)));
      toast('已替换选中内容');
    } else {
      toast('没有选中内容，已改为插入');
      aiInsertToEditor(sanitizeHtml(mdToHtml(aiStreamText)));
    }
  }

  function aiDoCopy() {
    if (!aiStreamText) return;
    navigator.clipboard.writeText(aiStreamText)
      .then(() => toast('已复制到剪贴板'))
      .catch(() => toast('复制失败，请手动选择文本'));
  }

  /** 构建面板 DOM（事件统一在根节点委托） */
  function buildAIWriter() {
    const el = document.createElement('div');
    el.className = NS + '-pop ' + NS + '-ai';
    el.setAttribute('role', 'dialog');

    let chipIndex = 0;
    const groups = AI_QUICK_GROUPS.map((g) =>
      '<div class="' + NS + '-ai-group">' +
        '<span class="' + NS + '-ai-glabel">' + escapeHtml(g.label) + '</span>' +
        '<div class="' + NS + '-ai-gchips">' +
          g.items.map((q) =>
            '<button type="button" class="' + NS + '-ai-chip" data-ai-chip="' + (chipIndex++) + '">' +
              escapeHtml(q.label) + '</button>'
          ).join('') +
        '</div>' +
      '</div>'
    ).join('');

    el.innerHTML =
      '<div class="' + NS + '-ai-head">' +
        '<span class="' + NS + '-ai-title">' + aiIcon() + '<span>AI 写作助手</span></span>' +
        '<span class="' + NS + '-ai-sub"></span>' +
        '<button type="button" class="' + NS + '-ai-x ' + NS + '-ai-stop ' + NS + '-ai-hide" data-ai="stop" title="停止生成">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
            '<rect x="7" y="7" width="10" height="10" rx="2"/></svg>' +
        '</button>' +
        '<button type="button" class="' + NS + '-ai-x" data-ai="dock" title="浮动 / 侧边栏">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
            '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>' +
        '</button>' +
        '<button type="button" class="' + NS + '-ai-x" data-ai="close" title="关闭（Esc）">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="' + NS + '-ai-groups">' + groups + '</div>' +
      '<div class="' + NS + '-ai-custom">' +
        '<textarea class="' + NS + '-ai-input" rows="1" spellcheck="false" ' +
          'placeholder="输入自定义写作要求，如：改写成小红书风格，Ctrl+回车生成"></textarea>' +
        '<button type="button" class="' + NS + '-ai-gen" data-ai="gen">生成</button>' +
      '</div>' +
      '<div class="' + NS + '-ai-result"></div>' +
      '<div class="' + NS + '-ai-actions">' +
        '<span class="' + NS + '-ai-usage"></span>' +
        '<button type="button" class="' + NS + '-ai-act is-primary" data-ai="insert">插入到正文</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="replace">替换选中内容</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="copy">复制</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="again">再次生成</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-ai="close">关闭</button>' +
      '</div>';

    aiRefs = {
      el: el,
      sub: el.querySelector('.' + NS + '-ai-sub'),
      input: el.querySelector('.' + NS + '-ai-input'),
      gen: el.querySelector('[data-ai="gen"]'),
      result: el.querySelector('.' + NS + '-ai-result'),
      btnInsert: el.querySelector('[data-ai="insert"]'),
      btnReplace: el.querySelector('[data-ai="replace"]'),
      btnCopy: el.querySelector('[data-ai="copy"]'),
      btnAgain: el.querySelector('[data-ai="again"]'),
      btnStop: el.querySelector('[data-ai="stop"]'),
      usage: el.querySelector('.' + NS + '-ai-usage')
    };

    // 按钮按下时阻止默认，保住编辑器光标 / 选区；输入框保持原生焦点行为
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.target.closest('button')) e.preventDefault();
    });

    // 点击统一委托：快捷指令 / 生成 / 插入 / 替换 / 复制 / 再次生成 / 关闭 / 打开设置
    el.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ai-chip]');
      if (chip) {
        const idx = parseInt(chip.getAttribute('data-ai-chip'), 10);
        if (AI_QUICK[idx]) aiRun(AI_QUICK[idx].prompt);
        return;
      }
      const node = e.target.closest('[data-ai]');
      if (!node) return;
      const act = node.getAttribute('data-ai');
      if (act === 'gen') aiGenerateCustom();
      else if (act === 'insert') aiDoInsert();
      else if (act === 'replace') aiDoReplace();
      else if (act === 'copy') aiDoCopy();
      else if (act === 'again') { if (aiLastInstruction) aiRun(aiLastInstruction); }
      else if (act === 'stop') aiStop();
      else if (act === 'settings') aiOpenOptions();
      else if (act === 'dock') toggleAIDock();
      else if (act === 'close') closeAIWriter();
    });

    // 拖动标题栏：用 pointer 事件 + setPointerCapture，拖出窗口范围也不会丢事件
    const headEl = el.querySelector('.' + NS + '-ai-head');
    headEl.addEventListener('pointerdown', startAIDrag);
    headEl.addEventListener('pointermove', moveAIDrag);
    headEl.addEventListener('pointerup', endAIDrag);
    headEl.addEventListener('pointercancel', endAIDrag);

    const ta = aiRefs.input;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiGenerateCustom(); }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(96, ta.scrollHeight) + 'px';
    });

    aiRenderPlaceholder();
    return el;
  }

  // ---------------------------- 9.6 窗口定位 / 拖动 / 侧边栏 ----------------------------

  /** 读取上次拖动保存的窗口坐标（固定定位，用的是视口坐标） */
  function aiSavedPos() {
    try {
      const raw = JSON.parse(localStorage.getItem(AI_POS_KEY) || 'null');
      if (raw && typeof raw.left === 'number' && typeof raw.top === 'number') return raw;
    } catch (e) { /* 忽略损坏的本地数据 */ }
    return null;
  }

  /** 记住当前窗口坐标 */
  function saveAIPos() {
    if (!aiPop) return;
    try {
      const r = aiPop.getBoundingClientRect();
      localStorage.setItem(AI_POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    } catch (e) { /* 忽略写入失败 */ }
  }

  /**
   * 窗口定位：固定在视口内（不随页面滚动移动）。
   * 侧边栏模式交给 CSS 贴右边；浮动模式优先沿用上次拖动的位置，否则默认靠右垂直居中。
   */
  function positionAIPop() {
    if (!aiPop) return;
    aiPop.classList.toggle('is-dock', aiDock);
    if (aiDock) {
      aiPop.style.left = '';    // 侧边栏由 CSS 定位，清掉内联坐标避免打架
      aiPop.style.top = '';
      return;
    }
    const w = aiPop.offsetWidth;
    const h = aiPop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 24;
    const saved = aiSavedPos();
    let left = saved ? saved.left : Math.max(gap, vw - w - gap);
    let top = saved ? saved.top : Math.round((vh - h) / 2);
    left = Math.max(gap, Math.min(left, vw - w - gap));
    top = Math.max(gap, Math.min(top, vh - h - gap));
    aiPop.style.left = left + 'px';
    aiPop.style.top = top + 'px';
  }

  /** 在浮动 / 侧边栏两种形态间切换，并记住选择 */
  function toggleAIDock() {
    aiDock = !aiDock;
    try { localStorage.setItem(AI_DOCK_KEY, aiDock ? '1' : '0'); } catch (e) { /* 忽略 */ }
    positionAIPop();
    toast(aiDock ? '已贴靠为右侧边栏' : '已切回浮动窗口');
  }

  /** 开始拖动：按住标题栏空白处（按钮 / 输入框上不触发） */
  function startAIDrag(e) {
    if (!aiPop || aiDock) return;
    if (e.target.closest('button, input, textarea')) return;
    const r = aiPop.getBoundingClientRect();
    aiDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    document.body.classList.add(NS + '-dragging');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    e.preventDefault();
  }

  /** 拖动中：坐标始终夹在视口内，避免窗口被拖出屏幕 */
  function moveAIDrag(e) {
    if (!aiDrag || !aiPop) return;
    const w = aiPop.offsetWidth;
    const h = aiPop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 8;
    const left = Math.max(gap, Math.min(e.clientX - aiDrag.dx, vw - w - gap));
    const top = Math.max(gap, Math.min(e.clientY - aiDrag.dy, vh - h - gap));
    aiPop.style.left = left + 'px';
    aiPop.style.top = top + 'px';
  }

  /** 结束拖动并记住位置 */
  function endAIDrag() {
    if (!aiDrag) return;
    aiDrag = null;
    document.body.classList.remove(NS + '-dragging');
    saveAIPos();
  }

  /** 打开写作助手窗口；已打开时再点一次即收起（独立窗口不受空白点击影响）。
      keepOpen 为真时只保证「打开」，已打开则不收起（供跨扩展联动调用）。 */
  function openAIWriter(keepOpen) {
    if (!aiOn('aiWriter')) return;
    if (aiPop) { if (!keepOpen) closeAIWriter(); return; }
    if (afPop) closeAIFormatter();   // 两个 AI 窗口同一时间只保留一个
    closePopups();          // 先收起其它浮层（AI 窗口自身已被 closePopups 排除在外）
    captureAIContext();     // 先捕获选区 / 光标，再把焦点交给窗口输入框
    try { aiDock = localStorage.getItem(AI_DOCK_KEY) === '1'; } catch (e) { aiDock = false; }
    aiPop = buildAIWriter();
    document.body.appendChild(aiPop);
    positionAIPop();
    if (aiRefs && aiRefs.input) aiRefs.input.focus();
    syncAIBtns();
  }

  /** 关闭面板并中断进行中的生成 */
  function closeAIWriter() {
    aiAbort();
    aiBusy = false;
    if (aiPop && aiPop.parentElement) aiPop.parentElement.removeChild(aiPop);
    aiPop = null;
    aiRefs = null;
  }

  // ============================ 9.6.1 与 PICKCAT Plus 联动 ============================

  /* 两个扩展的 content script 各自运行在隔离世界，彼此看不见变量、函数与 storage，
     唯一零权限的通道是页面 window 的 postMessage。协议 v1 采用「广播 + 自报家门」：
     用 source 字段辨认来源，谁先加载都能发现对方。详见 INTEGRATION.md。 */
  (function linkPickcatPlus() {
    /* 键 pcr_plus_link：与 options/options.js 的 PLUS_LINK_KEY 保持一致；
       设置里关掉后仍应答心跳，但不再响应唤起写作助手的指令 */
    const PLUS_LINK_KEY = 'pcr_plus_link';
    const send = (o) => { try { window.postMessage(o, '*'); } catch (e) { /* 忽略 */ } };
    const version = (() => {
      try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
    })();

    window.addEventListener('message', (ev) => {
      if (ev.origin !== location.origin) return;   // 只认本页同源消息
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== 'pickcat-plus') return;

      // 对方在找我们：回一句「我在」，带上版本与能力
      if (d.type === 'pickcat:link-ping') {
        send({ source: 'pickscribe', type: 'pickscribe:hello', version, features: ['ai', 'editor'] });
        return;
      }

      // 对方请我们打开 AI 助手：写作助手只在编辑页可用，其它页面直接忽略；
      // 编辑页已被对方编辑器接管时也没有可插入的富文本区，同样忽略，避免打开一个无法回填的面板
      if (d.type === 'pickcat:open-ai' && isEditorPage() && root && editor) {
        try {
          chrome.storage.local.get({ [PLUS_LINK_KEY]: true }, (raw) => {
            if (raw[PLUS_LINK_KEY] !== false) openAIWriter(true);
          });
        } catch (e) { /* 扩展上下文失效时忽略 */ }
      }
    });

    // 我们先喊一声（对方可能比我们晚加载）
    [0, 1500, 4000].forEach((ms) => setTimeout(() => send({ source: 'pickscribe', type: 'pickscribe:link-ping' }), ms));
  })();

  // ============================ 9.6.2 开放接口 v1.0 ============================

  /* 统一信封：{ source, v, id, action, payload, ts }，所有动作都回一条 ack。
     v1.0 只做 L1：这里校验 origin / ev.source / source / 时间戳，
     真正的鉴权、限流、requestId 去重放在 background 的 broker 里。
     v1.1 的 runtime 配对 + HMAC 会在 background 的 apiAuthorize 接入，本文件协议不变。 */
  (function openApiV1() {
    const API_VERSION = 1;
    const API_SOURCES = { 'pickcat-client': true, 'pickcat-plus': true };
    const API_ACTIONS = ['ai.open', 'post.open', 'post.context', 'editor.read', 'editor.write', 'post.summarize'];
    // 需要用户首次确认的数据动作：等待确认期间 ACK 不能提前超时
    const API_CONSENT_ACTIONS = {
      'post.context': true,
      'editor.read': true,
      'editor.write': true,
      'post.summarize': true
    };
    const API_TS_WINDOW = 60 * 1000;
    const API_ACK_TIMEOUT = 2500;
    const API_CONSENT_WAIT = 65 * 1000;
    // post.summarize：确认等待 + 模型生成（后台按 90 秒长耗时处理），
    // 页面侧必须比后台更宽松，否则会把已受理的请求提前判成 TIMEOUT。
    const API_LONG_ACTION_WAIT = 160 * 1000;
    const API_PERMS_KEY = 'pcr_api_perms';
    const API_PERMS_DEFAULT = Object.freeze({ readPost: true, readEditor: true, writeEditor: false, aiQuota: false });

    const version = (() => {
      try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
    })();

    const send = (o) => { try { window.postMessage(o, location.origin); } catch (e) { /* 忽略 */ } };

    // 发现类请求本地限速，避免页面脚本高频 ping 拖慢主线程
    const localRate = { start: 0, count: 0 };
    function locallyLimited() {
      const now = Date.now();
      if (now - localRate.start >= 1000) {
        localRate.start = now;
        localRate.count = 0;
      }
      localRate.count += 1;
      return localRate.count > 40;
    }

    function postIdFromPath() {
      const m = location.pathname.match(/\/forum\/post\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }

    function pageType() {
      if (isEditorPage()) return 'editor';
      if (postIdFromPath()) return 'post';
      // 与浮层脚本的 FEED_PATH 对齐，但搜索页不纳入 post.open 的信息流范围
      const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
      if (/^\/$|^\/forum(?:\/category\/[^/?#]+)?$/.test(path)) return 'feed';
      return 'other';
    }

    function loadPerms(cb) {
      try {
        chrome.storage.local.get({ [API_PERMS_KEY]: API_PERMS_DEFAULT }, (raw) => {
          if (chrome.runtime.lastError) { cb(Object.assign({}, API_PERMS_DEFAULT)); return; }
          const saved = raw && raw[API_PERMS_KEY];
          cb(Object.assign({}, API_PERMS_DEFAULT, saved && typeof saved === 'object' ? saved : {}));
        });
      } catch (e) {
        cb(Object.assign({}, API_PERMS_DEFAULT));
      }
    }

    function loadOverlayEnabled(cb) {
      try {
        chrome.storage.local.get('pco_config', (raw) => {
          if (chrome.runtime.lastError) { cb(true); return; }
          const cfg = raw && raw.pco_config;
          cb(!(cfg && cfg.enabled === false));
        });
      } catch (e) { cb(true); }
    }

    /** 能力 + 页面状态：ping / state / hello 共用 */
    function buildStatus(cb) {
      loadPerms((perms) => {
        loadOverlayEnabled((overlayEnabled) => {
          cb({
            version,
            protocol: { v: API_VERSION, min: API_VERSION, max: API_VERSION },
            auth: { mode: 'l1', pairing: false },
            page: { type: pageType(), href: location.href, postId: postIdFromPath() },
            actions: API_ACTIONS.slice(),
            perms,
            features: ['ai', 'editor', 'overlay'],
            limits: { actionsPerMinute: 30 },
            editor: { available: isEditorPage(), mode: isEditorPage() ? mode : null },
            overlay: { open: !!document.getElementById('pco-root'), enabled: overlayEnabled }
          });
        });
      });
    }

    function sendAck(req, res) {
      const r = res && typeof res === 'object' ? res : {};
      const payload = {
        replyTo: req.id,
        ok: !!r.ok,
        code: r.code || (r.ok ? 'OK' : 'INTERNAL'),
        message: r.message || '',
        data: r.data === undefined ? null : r.data,
        duplicate: !!r.duplicate
      };
      if (typeof r.retryAfter === 'number') payload.retryAfter = r.retryAfter;
      // 仅本次允许：让调用方知道这一次是单次放行，而不是长期授权
      if (r.once === true) payload.once = true;
      send({
        source: 'pickscribe',
        v: API_VERSION,
        id: 'ack-' + req.id,
        action: 'ack',
        payload,
        ts: Date.now()
      });
    }

    function broadcastHello() {
      buildStatus((status) => {
        send({
          source: 'pickscribe',
          v: API_VERSION,
          id: 'hello-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          action: 'hello',
          payload: status,
          ts: Date.now()
        });
      });
    }

    // ---- 数据动作：editor.read ----

    const API_EDITOR_MAX = 100000;   // 单次返回的正文上限（字符），超出截断并标记

    /** 当前编辑器 Markdown：按视图模式取，插件尚未挂载时降级读站点 textarea */
    function apiCurrentMarkdown() {
      if (mode === 'source' && textarea) return String(textarea.value || '');
      if (editor) return String(htmlToMd(editor) || '');
      return textarea ? String(textarea.value || '') : null;
    }

    /** 正文 revision：优先 SHA-256（取前 16 位十六进制），不可用时降级 FNV-1a */
    async function apiRevision(text) {
      const s = String(text || '');
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return Array.from(new Uint8Array(buf)).slice(0, 8)
          .map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      }
    }

    /** Markdown → 纯文本：复用富文本渲染后取 textContent，作为 text 格式的降级 */
    function apiMarkdownToText(md) {
      try {
        const div = document.createElement('div');
        div.innerHTML = mdToHtml(String(md || ''));
        return String(div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      } catch (e) {
        return String(md || '');
      }
    }

    async function apiReadEditor(payload) {
      if (!isEditorPage()) {
        return { ok: false, code: 'UNSUPPORTED_CONTEXT', message: '仅编辑页可用' };
      }
      const full = apiCurrentMarkdown();
      if (full === null) {
        return { ok: false, code: 'NOT_READY', message: '编辑器尚未就绪' };
      }
      const p = payload && typeof payload === 'object' ? payload : {};
      const format = p.format === 'text' ? 'text' : 'markdown';
      const truncated = full.length > API_EDITOR_MAX;
      const sliced = truncated ? full.slice(0, API_EDITOR_MAX) : full;
      return {
        ok: true,
        code: 'OK',
        data: {
          format,
          mode: editor ? mode : 'source',
          content: format === 'text' ? apiMarkdownToText(sliced) : sliced,
          revision: await apiRevision(full),
          length: full.length,
          truncated,
          isEmpty: !full.trim(),
          // 与编辑器挂载时的正文快照比较；站点在本插件之前改写的内容也算已修改
          dirty: editorBaselineMd === null ? false : full !== editorBaselineMd
        }
      };
    }

    // ---- 数据动作：editor.write ----

    const API_EDITOR_WRITE_MAX = 100000;      // 单次写入的 Markdown 上限（字符）
    const API_WRITE_DEDUPE_TTL = 120 * 1000;
    // 同一个 requestId 的重放直接复用结果，避免后台重试导致重复写入；
    // 去重只看 requestId，绝不按正文内容或长度推断「重复」。
    let apiLastWriteId = '';
    let apiLastWriteAt = 0;
    let apiLastWriteRes = null;

    /** 编辑器可写性：区分「非编辑页 / 未挂载 / 只读」三种失败 */
    function apiEditorState() {
      if (!isEditorPage()) {
        return { ok: false, code: 'UNSUPPORTED_CONTEXT', message: '仅编辑页可用' };
      }
      if (!root || !editor || !textarea) {
        return { ok: false, code: 'NOT_READY', message: '编辑器尚未就绪' };
      }
      if (textarea.readOnly || textarea.disabled ||
          editor.getAttribute('contenteditable') === 'false') {
        return { ok: false, code: 'EDITOR_READONLY', message: '编辑器当前为只读状态' };
      }
      return { ok: true };
    }

    /** 确认弹窗用的只读探测：返回当前正文长度与视图模式，不修改任何内容 */
    function apiEditorProbe() {
      const st = apiEditorState();
      if (!st.ok) {
        return { ok: false, code: st.code, message: st.message, available: false, length: null, mode: null };
      }
      const md = apiCurrentMarkdown();
      return {
        ok: true,
        code: 'OK',
        message: '',
        available: true,
        length: md === null ? null : String(md).length,
        mode: mode || 'source'
      };
    }

    /** 写入编辑器：insert 在光标处插入，replace 整体替换；返回可校验的写入结果 */
    async function apiWriteEditor(payload) {
      const st = apiEditorState();
      if (!st.ok) return st;

      const p = payload && typeof payload === 'object' ? payload : {};
      if (typeof p.text !== 'string') {
        return { ok: false, code: 'BAD_REQUEST', message: 'text 必须是 Markdown 字符串' };
      }
      const writeMode = p.mode == null || p.mode === '' ? 'insert' : p.mode;
      if (writeMode !== 'insert' && writeMode !== 'replace') {
        return { ok: false, code: 'BAD_REQUEST', message: 'mode 只能是 insert 或 replace' };
      }
      if (p.text.length > API_EDITOR_WRITE_MAX) {
        return { ok: false, code: 'BAD_REQUEST', message: 'text 超过 ' + API_EDITOR_WRITE_MAX + ' 字符上限' };
      }
      if (writeMode === 'insert' && !p.text) {
        return { ok: false, code: 'BAD_REQUEST', message: 'insert 模式下 text 不能为空' };
      }

      const before = apiCurrentMarkdown();
      if (before === null) {
        return { ok: false, code: 'NOT_READY', message: '编辑器尚未就绪' };
      }

      try {
        if (writeMode === 'replace') {
          // setTextareaValue 会派发 input，挂载时注册的监听会把内容同步回富文本；
          // 这里再显式 sourceToRich 一次，保证富文本区与源码一致。
          setTextareaValue(p.text);
          sourceToRich();
        } else if (mode === 'source' && textarea) {
          // 源码模式：聚焦时插到真实光标处，未聚焦时追加到末尾；
          // 不复用 AI 面板的 aiCtx（可能是上一次打开面板时的旧位置）。
          const at = document.activeElement === textarea && textarea.selectionStart != null
            ? textarea.selectionStart
            : String(textarea.value || '').length;
          const v = String(textarea.value || '');
          setTextareaValue(v.slice(0, at) + p.text + v.slice(at));
          try { textarea.selectionStart = textarea.selectionEnd = at + p.text.length; } catch (e) { /* noop */ }
        } else {
          insertHtml(mdToHtml(p.text));
          richToSource();
        }
      } catch (e) {
        return { ok: false, code: 'INTERNAL', message: String((e && e.message) || e) };
      }

      const after = apiCurrentMarkdown();
      const finalMd = after === null ? '' : String(after);
      return {
        ok: true,
        code: 'OK',
        data: {
          mode: writeMode,
          editorMode: mode,
          length: finalMd.length,
          insertedLength: p.text.length,
          replacedLength: writeMode === 'replace' ? String(before).length : 0,
          revision: await apiRevision(finalMd),
          dirty: editorBaselineMd === null ? false : finalMd !== editorBaselineMd
        }
      };
    }

    // 接收第三方扩展（或 PICKCAT Plus）的 v1 信封
    window.addEventListener('message', (ev) => {
      if (ev.origin !== location.origin) return;
      if (ev.source !== window) return;              // 过滤同源 iframe 转发
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.v !== API_VERSION || typeof d.action !== 'string') return;
      if (!API_SOURCES[d.source]) return;
      if (typeof d.id !== 'string' || !d.id || d.id.length > 128) return;
      if (typeof d.ts !== 'number' || Math.abs(Date.now() - d.ts) > API_TS_WINDOW) return;
      if (locallyLimited()) return;                  // 静默丢弃，避免放大攻击

      // 发现 / 状态查询：不经过后台，返回当前页面能力
      if (d.action === 'ping' || d.action === 'state') {
        buildStatus((status) => sendAck(d, { ok: true, code: 'OK', data: status }));
        return;
      }

      if (API_ACTIONS.indexOf(d.action) < 0) {
        sendAck(d, { ok: false, code: 'UNSUPPORTED', message: '动作未实现' });
        return;
      }

      // 动作交给 background broker：鉴权、限流、去重、转发给目标脚本
      let settled = false;
      const waitMs = d.action === 'post.summarize'
        ? API_LONG_ACTION_WAIT
        : (API_CONSENT_ACTIONS[d.action] ? API_CONSENT_WAIT : API_ACK_TIMEOUT);
      let timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', message: '后台未响应' }), waitMs);
      function finish(res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sendAck(d, res);
      }

      try {
        chrome.runtime.sendMessage({ __pcr_api: true, req: d, page: pageType() }, (res) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({ ok: false, code: 'NOT_READY', message: lastError.message || '后台未就绪' });
            return;
          }
          finish(res);
        });
      } catch (e) {
        finish({ ok: false, code: 'NOT_READY', message: String((e && e.message) || e) });
      }
    });

    // background broker 转发过来的动作：编辑页的 ai.open / editor.read / editor.write
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.__pcr_api_dispatch !== true) return;
        if (msg.action === 'editor.read') {
          apiReadEditor(msg.payload).then(sendResponse);
          return true;
        }
        if (msg.action === 'editor.write') {
          const rid = typeof msg.requestId === 'string' ? msg.requestId : '';
          // 同一 requestId 的重复投递复用上一次结果，避免重复写入；不同 requestId 一律照写。
          if (rid && rid === apiLastWriteId && apiLastWriteRes &&
              Date.now() - apiLastWriteAt < API_WRITE_DEDUPE_TTL) {
            sendResponse(Object.assign({}, apiLastWriteRes, { duplicate: true }));
            return;
          }
          apiWriteEditor(msg.payload).then((res) => {
            if (rid && res && res.ok) {
              apiLastWriteId = rid;
              apiLastWriteAt = Date.now();
              apiLastWriteRes = res;
            }
            sendResponse(res);
          });
          return true;
        }
        if (msg.action !== 'ai.open') return;
        if (!isEditorPage()) {
          sendResponse({ ok: false, code: 'UNSUPPORTED_CONTEXT', message: '仅编辑页可用' });
          return;
        }
        // 编辑页被其它扩展的编辑器接管（已让位）时没有可回填的富文本区，AI 面板不可用
        if (!root || !editor) {
          sendResponse({ ok: false, code: 'NOT_READY', message: '编辑器未就绪' });
          return;
        }
        const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
        const target = p.mode === 'format' ? 'format' : 'writer';
        if (!aiOn(target === 'format' ? 'aiFormat' : 'aiWriter')) {
          sendResponse({ ok: false, code: 'AI_DISABLED', message: '该 AI 功能已在设置中关闭' });
          return;
        }
        try {
          if (target === 'format') openAIFormatter();
          else openAIWriter(true);
          // 写作助手支持预填指令；排版窗口只接收正文，不预填 prompt
          const prompt = typeof p.prompt === 'string' ? p.prompt.trim().slice(0, 4000) : '';
          if (prompt && target === 'writer' && aiRefs && aiRefs.input) {
            aiRefs.input.value = prompt;
            aiRefs.input.dispatchEvent(new Event('input', { bubbles: true }));
            aiRefs.input.focus();
          }
          sendResponse({ ok: true, code: 'OK', data: { opened: true, mode: target } });
        } catch (e) {
          sendResponse({ ok: false, code: 'INTERNAL', message: String((e && e.message) || e) });
        }
      });
    } catch (e) { /* 扩展上下文失效时忽略 */ }

    // 后台在弹确认窗前探测编辑器状态（只读，不产生任何写入）
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.__pcr_editor_probe !== true) return;
        sendResponse(apiEditorProbe());
      });
    } catch (e) { /* 忽略 */ }

    // 设置页「联动状态」：直接向内容脚本要一份只读状态，不产生任何副作用
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.__pcr_api_status !== true) return;
        buildStatus((status) => {
          sendResponse(Object.assign({ ok: true, reachable: true }, status));
        });
        return true;
      });
    } catch (e) { /* 忽略 */ }

    // 设置变更 / SPA 路由切换后重新声明能力
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[API_PERMS_KEY] || changes.pco_config) broadcastHello();
      });
    } catch (e) { /* 忽略 */ }

    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      broadcastHello();
    }, 1000);

    // 对方可能比我们晚加载：沿用旧协议的节奏主动喊三次
    [0, 1500, 4000].forEach((ms) => setTimeout(broadcastHello, ms));
  })();

  // ============================ 9.7 AI 排版 ============================

  /* AI 排版：把整篇正文交给模型重新整理成规范的 Markdown（标题层级 / 空行 / 列表 / 表格）。
     只调整格式、不改内容，结果以「整篇替换」的方式写回编辑器。
     复用写作助手的后台 Port（协议同为 'pcai'）与结果渲染，窗口独立、互不干扰。 */

  const AF_MAX_BODY = 8000;    // 单次排版正文上限（字符），超过则提示分段，避免截断丢内容

  // 排版风格：不同场景用不同的整理侧重
  const AF_STYLES = [
    {
      id: 'general',
      name: '通用规范',
      hint: '统一标题层级、段落空行、列表符号与标点，让文档结构清晰、直接可读。'
    },
    {
      id: 'structure',
      name: '结构清晰',
      hint: '按内容逻辑分节，补上合适的小标题，把长段叙述拆成段落或要点列表。'
    },
    {
      id: 'tech',
      name: '技术文档',
      hint: '步骤改用有序列表，参数与字段用列表或表格呈现，代码块保留语言标注，术语统一。'
    },
    {
      id: 'outline',
      name: '精简大纲',
      hint: '用多级标题与列表提炼文档结构，合并重复表达，但不要改变原意或删减信息。'
    }
  ];

  // 系统提示词：只做排版，不改内容；只输出 Markdown 正文
  const AF_SYSTEM_PROMPT = '你是一个严谨的 Markdown 排版员。用户会给你一篇 Markdown 或纯文本文档，'
    + '你要在不改变原意、事实与信息量的前提下，把它整理成结构清晰、格式规范的 Markdown。必须遵守：'
    + '1. 只输出排版后的完整文档，不要任何解释、开场白或总结，也不要把整篇结果包进代码围栏；'
    + '2. 标题层级要合理且不跳级：文档标题用 #，一级小节用 ##，更细的用 ###，最多到 ####；'
    + '3. 段落之间留一个空行，列表前后也留空行；同类列表统一符号，不要混用 - 和 *；'
    + '4. 只使用标准 Markdown 语法，不要输出 HTML，也不要把普通段落改成大段表格；'
    + '5. 原样保留站点图片 / 视频引用标记（如单独一行的 ![...]，不要改动其中的 ID）、普通链接、'
    + '行内代码、代码块、公式与表格，不要改写或删除；'
    + '6. 不新增原文没有的内容，也不删除实质性内容；只调整空格、标点、换行与标题结构。';

  // —— 状态 ——
  let afPop = null;            // 排版窗口根节点
  let afRefs = null;           // 窗口内部节点引用
  let afBusy = false;          // 是否正在排版
  let afReqId = null;          // 当前进行中的请求 id
  let afStreamText = '';       // 流式累积的排版结果
  let afComplete = false;      // 本轮是否完整结束（未完成的结果不允许整篇应用）
  let afStyleId = AF_STYLES[0].id;   // 当前选中的排版风格
  let afLast = null;           // 上一轮参数 { styleId, extra }，「再次排版」用

  /** 排版图标：行首对齐 + 分节线，和写作助手的星芒图标区分开 */
  function aiFormatIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">' +
      '<path d="M4 5h16v2H4z"/>' +
      '<path d="M4 10.5h10v2H4z" opacity=".72"/>' +
      '<path d="M4 16h16v2H4z" opacity=".72"/>' +
      '<path d="M17.2 9.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>' +
      '</svg>';
  }

  /** 读取编辑器完整正文（不截断，排版结果要整篇写回） */
  function afReadBody() {
    if (mode === 'source' && textarea) return String(textarea.value || '').trim();
    if (editor) return String(htmlToMd(editor) || '').trim();
    return textarea ? String(textarea.value || '').trim() : '';
  }

  /** 组装消息：排版风格 + 可选补充要求 + 待排版文档 */
  function afBuildMessages(body, styleId, extra) {
    const st = AF_STYLES.find((s) => s.id === styleId) || AF_STYLES[0];
    const user = '排版风格：' + st.name + '\n具体要求：' + st.hint +
      (extra ? '\n补充要求：' + extra : '') +
      '\n\n待排版的文档：\n\n' + body;
    return [
      { role: 'system', content: AF_SYSTEM_PROMPT },
      { role: 'user', content: user }
    ];
  }

  /** 模型偶尔会把整篇结果包进 ```markdown 围栏：仅在明确标注 markdown 时移除外层围栏 */
  function afNormalizeResult(text) {
    return String(text || '').trim()
      .replace(/^```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```$/i, (m, inner) => inner.trim());
  }

  // ---------------------------- 9.7.1 结果写回 ----------------------------

  /** 把排版结果整篇写回编辑器（源码 / 可视化 / 分屏都同步） */
  function afWriteToEditor(md) {
    if (!editor && !textarea) return false;
    if (mode === 'source' && textarea) {
      // 源码视图：textarea 就是唯一数据源，恢复可视化时由 sourceToRich 自动同步
      setTextareaValue(md);
      return true;
    }
    if (editor) {
      lock = true;
      try {
        editor.innerHTML = sanitizeHtml(mdToHtml(md));
      } finally {
        lock = false;
      }
    }
    if (textarea) richToSource();
    return true;
  }

  // ---------------------------- 9.7.2 面板渲染 ----------------------------

  function afRenderPlaceholder() {
    if (!afRefs) return;
    afRefs.result.innerHTML = '<div class="' + NS + '-ai-ph">选择排版风格后点「开始排版」，'
      + 'AI 会把当前正文整理成规范的 Markdown；结果可预览，确认后再整篇应用到正文。</div>';
  }

  function afRenderLoading() {
    if (!afRefs) return;
    afRefs.result.innerHTML = '<div class="' + NS + '-ai-loading"><span class="' + NS + '-ai-spin"></span>'
      + '<span>正在整理排版…</span></div>';
    aiClearUsage(afRefs);
  }

  function afRenderStream() {
    if (!afRefs) return;
    afRefs.result.innerHTML = '<div class="' + NS + '-ai-out">' + sanitizeHtml(mdToHtml(afStreamText)) +
      '<span class="' + NS + '-ai-caret"></span></div>';
  }

  function afRenderDone() {
    if (!afRefs) return;
    afRefs.result.innerHTML = '<div class="' + NS + '-ai-out">' + sanitizeHtml(mdToHtml(afStreamText)) + '</div>';
  }

  /** 通用提示块：可附带操作按钮（重试 / 打开设置） */
  function afRenderNote(msg, actions) {
    if (!afRefs) return;
    afRefs.result.innerHTML = '<div class="' + NS + '-ai-note">' + escapeHtml(msg).replace(/\n/g, '<br>') +
      (actions || '') + '</div>';
  }

  function afRenderError(msg) {
    afRenderNote(msg + '\n可检查扩展设置里的模型 / 密钥，或稍后重试。',
      '<div class="' + NS + '-ai-note-act">' +
        '<button type="button" class="' + NS + '-ai-act" data-af="run">重试</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-af="settings">打开设置</button>' +
      '</div>');
  }

  function afRenderNoKey() {
    afRenderNote('还没有配置 API Key，AI 排版暂时用不了。\n'
      + '请先在扩展设置里选择服务商并填写密钥（本地 Ollama 无需 Key）。',
      '<div class="' + NS + '-ai-note-act">' +
        '<button type="button" class="' + NS + '-ai-act is-primary" data-af="settings">打开设置</button>' +
      '</div>');
  }

  /** 同步窗口内按钮与风格胶囊的可用状态 */
  function afSyncBtns() {
    if (!afRefs) return;
    const hasText = !!afStreamText.trim();
    afRefs.run.disabled = afBusy;
    afRefs.el.querySelectorAll('.' + NS + '-af-chip').forEach((b) => { b.disabled = afBusy; });
    // 只有完整生成的结果才允许整篇替换，避免用半截内容覆盖原文
    afRefs.btnApply.disabled = afBusy || !afComplete || !hasText;
    afRefs.btnCopy.disabled = !hasText;
    afRefs.btnAgain.disabled = afBusy || !afLast;
    if (afRefs.btnStop) afRefs.btnStop.classList.toggle(NS + '-ai-hide', !afBusy);
    afRefs.sub.textContent = aiConfig.model || '';
  }

  /** 切换风格胶囊的选中态 */
  function afSetStyle(styleId) {
    afStyleId = styleId;
    if (!afRefs) return;
    afRefs.el.querySelectorAll('.' + NS + '-af-chip').forEach((b) => {
      b.classList.toggle('is-on', b.getAttribute('data-af-style') === styleId);
    });
  }

  // ---------------------------- 9.7.3 生成与结果操作 ----------------------------

  const afScheduleStream = debounce(() => { afRenderStream(); }, 80);

  /** 开始排版：读取整篇正文 → 流式生成 → 预览 */
  function afRun() {
    if (!afPop || !afRefs) return;
    if (afBusy) { toast('正在排版中，请稍候…'); return; }
    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama') { afRenderNoKey(); afSyncBtns(); return; }

    const body = afReadBody();
    if (!body) {
      afRenderNote('编辑器里还没有正文，先写一点内容再来排版。');
      afSyncBtns();
      return;
    }
    if (body.length > AF_MAX_BODY) {
      afRenderNote('正文约 ' + body.length + ' 字，超过单次排版上限（' + AF_MAX_BODY + ' 字）。'
        + '\n请分段排版，或先精简内容后再试。');
      afSyncBtns();
      return;
    }

    const extra = (afRefs.input.value || '').trim();
    afLast = { styleId: afStyleId, extra: extra };
    const messages = afBuildMessages(body, afStyleId, extra);

    afAbortFormatter();
    afStreamText = '';
    afComplete = false;
    afBusy = true;
    afRenderLoading();
    afSyncBtns();

    afReqId = aiRequest({
      messages,
      // 排版结果的长度与原文接近：按正文长度估算输出上限，避免被设置里的较小值截断
      maxTokens: Math.min(8192, Math.max(aiConfig.maxTokens || 1200, Math.ceil(body.length * 0.9) + 400)),
      onChunk(delta) {
        afStreamText += delta;
        afScheduleStream();
      },
      onDone(msg) {
        afReqId = null;
        afBusy = false;
        afStreamText = afNormalizeResult(msg.text || afStreamText);
        if (!afStreamText.trim()) {
          afComplete = false;
          afRenderError('模型没有返回内容，请换个风格或模型后重试。');
          aiClearUsage(afRefs);
        } else {
          afComplete = true;
          afRenderDone();
          aiSetUsage(msg.usage, afRefs);
        }
        afSyncBtns();
      },
      onError(err) {
        afReqId = null;
        afBusy = false;
        afComplete = false;
        afRenderError((err && err.message) || '排版失败，请稍后重试');
        aiClearUsage(afRefs);
        afSyncBtns();
      }
    });
  }

  function afAbortFormatter() {
    if (afReqId && aiPort) {
      try { aiPort.postMessage({ type: 'abort', id: afReqId }); } catch (e) { /* 忽略 */ }
    }
    if (afReqId) aiPending.delete(afReqId);
    afReqId = null;
  }

  /** 停止生成：保留已经输出的片段供参考，但标记为未完成（不可应用） */
  function afStop() {
    if (!afBusy) return;
    afAbortFormatter();
    afBusy = false;
    afComplete = false;
    if (afStreamText.trim()) afRenderDone();
    else if (afRefs) afRefs.result.innerHTML = '<div class="' + NS + '-ai-ph">已停止排版。</div>';
    if (afStreamText.trim()) toast('已停止生成：结果不完整，仅可复制，不能应用');
    else toast('已停止生成');
    afSyncBtns();
  }

  /** 整篇应用到正文：写回前二次确认，避免误覆盖原文 */
  function afApplyResult() {
    if (!afComplete || !afStreamText.trim() || afBusy) return;
    if (!editor && !textarea) { toast('没有可写入的编辑区'); return; }
    if (!window.confirm('将用排版结果替换整篇正文，确定继续吗？\n如需保留原文，请先点「复制 Markdown」备份。')) return;
    if (!afWriteToEditor(afStreamText)) { toast('写入失败，请重试'); return; }
    toast('已应用到正文');
    closeAIFormatter();
  }

  function afDoCopy() {
    if (!afStreamText.trim()) return;
    navigator.clipboard.writeText(afStreamText)
      .then(() => toast('已复制到剪贴板'))
      .catch(() => toast('复制失败，请手动选择文本'));
  }

  function openAIFormatter() {
    if (!aiOn('aiFormat')) return;
    if (afPop) { closeAIFormatter(); return; }
    if (aiPop) closeAIWriter();     // 两个窗口同一时间只保留一个
    closePopups();
    afPop = buildAIFormatter();
    document.body.appendChild(afPop);
    afSyncBtns();
    afRenderPlaceholder();
    if (afRefs && afRefs.input) afRefs.input.focus();
  }

  function closeAIFormatter() {
    afAbortFormatter();
    afBusy = false;
    afStreamText = '';
    afComplete = false;
    afLast = null;
    if (afPop && afPop.parentElement) afPop.parentElement.removeChild(afPop);
    afPop = null;
    afRefs = null;
  }

  // ---------------------------- 9.7.4 窗口 DOM ----------------------------

  function buildAIFormatter() {
    const el = document.createElement('div');
    el.className = NS + '-pop ' + NS + '-ai ' + NS + '-af';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'AI 排版');

    const chips = AF_STYLES.map((s) =>
      '<button type="button" class="' + NS + '-ai-chip ' + NS + '-af-chip' +
        (s.id === afStyleId ? ' is-on' : '') + '" data-af-style="' + s.id + '">' +
        escapeHtml(s.name) + '</button>'
    ).join('');

    el.innerHTML =
      '<div class="' + NS + '-ai-head">' +
        '<span class="' + NS + '-ai-title">' + aiFormatIcon() + '<span>AI 排版</span></span>' +
        '<span class="' + NS + '-ai-sub"></span>' +
        '<button type="button" class="' + NS + '-ai-x ' + NS + '-ai-stop ' + NS + '-ai-hide" data-af="stop" title="停止生成">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
            '<rect x="7" y="7" width="10" height="10" rx="2"/></svg>' +
        '</button>' +
        '<button type="button" class="' + NS + '-ai-x" data-af="close" title="关闭（Esc）">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="' + NS + '-af-body">' +
        '<div class="' + NS + '-af-desc">把当前正文重新整理成规范的 Markdown：补齐标题层级、统一空行与列表，'
          + '保留图片、链接、公式与代码块。只调整格式，不改内容。</div>' +
        '<div class="' + NS + '-af-row">' +
          '<span class="' + NS + '-af-label">排版风格</span>' +
          '<div class="' + NS + '-af-chips">' + chips + '</div>' +
        '</div>' +
        '<div class="' + NS + '-ai-custom">' +
          '<textarea class="' + NS + '-ai-input" rows="1" spellcheck="false" ' +
            'placeholder="补充要求（可选），如：标题只保留两级、把步骤改成有序列表，Ctrl+回车开始"></textarea>' +
          '<button type="button" class="' + NS + '-ai-gen" data-af="run">开始排版</button>' +
        '</div>' +
        '<div class="' + NS + '-ai-result"></div>' +
      '</div>' +
      '<div class="' + NS + '-ai-actions">' +
        '<span class="' + NS + '-ai-usage"></span>' +
        '<button type="button" class="' + NS + '-ai-act is-primary" data-af="apply">应用到正文</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-af="copy">复制 Markdown</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-af="again">再次排版</button>' +
        '<button type="button" class="' + NS + '-ai-act" data-af="close">关闭</button>' +
      '</div>';

    afRefs = {
      el: el,
      sub: el.querySelector('.' + NS + '-ai-sub'),
      input: el.querySelector('.' + NS + '-ai-input'),
      run: el.querySelector('[data-af="run"]'),
      result: el.querySelector('.' + NS + '-ai-result'),
      btnApply: el.querySelector('[data-af="apply"]'),
      btnCopy: el.querySelector('[data-af="copy"]'),
      btnAgain: el.querySelector('[data-af="again"]'),
      btnStop: el.querySelector('[data-af="stop"]'),
      usage: el.querySelector('.' + NS + '-ai-usage')
    };

    // 按钮按下时保住编辑区焦点 / 选区；输入框保留原生焦点行为
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.target.closest('button')) e.preventDefault();
    });

    el.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-af-style]');
      if (chip) { afSetStyle(chip.getAttribute('data-af-style')); return; }

      const node = e.target.closest('[data-af]');
      if (!node) return;
      const act = node.getAttribute('data-af');
      if (act === 'run') afRun();
      else if (act === 'apply') afApplyResult();
      else if (act === 'copy') afDoCopy();
      else if (act === 'again') {
        if (afLast) {
          // 复现上一轮的风格与补充要求，避免用户改过输入框后结果不一致
          afSetStyle(afLast.styleId);
          if (afRefs.input) afRefs.input.value = afLast.extra || '';
          afRun();
        }
      }
      else if (act === 'stop') afStop();
      else if (act === 'settings') aiOpenOptions();
      else if (act === 'close') closeAIFormatter();
    });

    const ta = afRefs.input;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); afRun(); }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(96, ta.scrollHeight) + 'px';
    });

    return el;
  }

  // 初始化：读取配置，并在设置页改动后即时生效
  aiLoadConfig();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[AI_CONFIG_KEY]) return;
      aiConfig = { ...AI_DEFAULTS, ...(changes[AI_CONFIG_KEY].newValue || {}) };
      syncAiToolbar();
      // 关闭某项时立刻收起对应窗口，并中断进行中的生成
      if (aiPop && !aiOn('aiWriter')) closeAIWriter();
      if (afPop && !aiOn('aiFormat')) closeAIFormatter();
      if (aiRefs) syncAIBtns();
      if (afRefs) afSyncBtns();
    });
  } catch (e) { /* 非扩展环境忽略 */ }

  // 浮层动画速度是全局设置：编辑页的全屏开合同样按它缩放时长（--pco-dur）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.pco_config) return;
      const n = Number(changes.pco_config.newValue && changes.pco_config.newValue.animSpeed);
      fsSpeed = Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
      applyFsTiming();
    });
  } catch (e) { /* 非扩展环境忽略 */ }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (aiPop) closeAIWriter();
    if (afPop) closeAIFormatter();
  });

  // 视口尺寸变化时重新夹取位置，避免窗口被挤出可视区域
  window.addEventListener('resize', () => { if (aiPop) positionAIPop(); });

  // 暴露一个调试句柄，便于排查（不影响站点）
  window.__pickcatRichEditor = {
    mount,
    mdToHtml,
    htmlToMd,
    sanitizeHtml,
    get editor() { return editor; },
    get textarea() { return textarea; }
  };

  // 初始挂载放在文件末尾：mount() 会构建工具栏并触达 AI 模块状态，
  // 必须等所有模块级声明（aiConfig 等）初始化完成，否则会命中暂时性死区
  mount();
})();
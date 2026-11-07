/**
 * 自定义字体字节中转页（扩展域）
 *
 * 背景：用户上传的字体存在扩展域的 IndexedDB 里，而内容脚本运行在网页域，
 * 读不到扩展域的库；字体二进制又无法走 chrome.runtime 消息（JSON 序列化会丢掉 ArrayBuffer）。
 * 所以由本页（chrome-extension 源）读取 IndexedDB，再把 ArrayBuffer 交给父页面里的内容脚本。
 *
 * 通道：内容脚本创建一个 MessageChannel，把 port2 通过 postMessage 转移进来，
 * 双方只用这条私有端口通信——网页主世界的脚本既拿不到端口，也读不到字体数据。
 */
(() => {
  'use strict';

  const DB_NAME = 'pcr_fonts';
  const DB_VERSION = 1;
  const STORE = 'files';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function readOne(db, id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(id);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    });
  }

  async function collect(ids) {
    const db = await openDb();
    const out = [];
    for (const id of ids) {
      const rec = await readOne(db, id);
      if (!rec || !rec.blob) continue;
      try {
        out.push({ id, buffer: await rec.blob.arrayBuffer() });
      } catch (e) { /* 单个文件损坏时跳过 */ }
    }
    return out;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.__pcrFontInit !== true) return;
    const port = e.ports && e.ports[0];
    if (!port) return;

    port.onmessage = async (ev) => {
      const req = ev.data || {};
      if (!Array.isArray(req.ids)) return;
      let faces = [];
      try {
        faces = await collect(req.ids);
      } catch (err) {
        faces = [];
      }
      // 转移 ArrayBuffer，避免大字体在端口上再复制一份
      port.postMessage({ faces }, faces.map((f) => f.buffer));
    };

    port.postMessage({ ready: true });
  });
})();

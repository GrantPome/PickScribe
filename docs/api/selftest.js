/**
 * PickScribe 开放接口 v1.0 控制台自检
 * 用法：在 Pickcat 站点页面（pickcat.dao3.fun / cdsq.dao3.fun）打开 DevTools Console，
 *      粘贴本文件全部内容并回车。
 *
 * 说明：已实现 ai.open / post.open / post.context / editor.read / editor.write / post.summarize。
 *      数据动作首次调用会弹确认窗，pcrTest 里的读 / 写接口已把超时放宽到 65 秒；
 *      post.summarize 未命中缓存时要调用模型，超时放宽到 160 秒。
 *      有副作用的 writeEditor / summarize 只暴露为手动方法，不自动执行。
 */
(() => {
  const SOURCE = 'pickcat-client';
  const VERSION = 1;
  const ORIGIN = location.origin;
  const TIMEOUT = 3000;
  const CONSENT_TIMEOUT = 65000;
  const SUMMARY_TIMEOUT = 160000;

  const send = (action, payload = {}, wait) => new Promise((resolve, reject) => {
    const id = 'st-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => reject(new Error(action + ' 超时：没有收到 PickScribe 的 ACK')), wait || TIMEOUT);
    const onMsg = (ev) => {
      if (ev.origin !== ORIGIN || ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'pickscribe' || !d.payload || d.payload.replyTo !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve(d.payload);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: SOURCE, v: VERSION, id, action, payload, ts: Date.now() }, ORIGIN);
  });

  // 暴露给控制台手动调用，避免自动执行有副作用的动作
  window.pcrTest = {
    send,
    ping: () => send('ping'),
    state: () => send('state'),
    aiOpen: (prompt) => send('ai.open', { mode: 'writer', prompt: prompt || '' }),
    aiFormat: () => send('ai.open', { mode: 'format' }),
    postOpen: (postId) => send('post.open', { postId }),
    // 数据读取：首次调用会触发确认弹窗
    readPost: (postId, fields) => send('post.context',
      Object.assign({}, postId ? { postId } : {}, Array.isArray(fields) ? { fields } : {}), CONSENT_TIMEOUT),
    readEditor: (format) => send('editor.read',
      { format: format === 'text' ? 'text' : 'markdown' }, CONSENT_TIMEOUT),
    // 写编辑器：默认 insert，传 replace 时整体替换；首次调用会弹确认窗
    writeEditor: (markdown, mode) => send('editor.write', {
      text: typeof markdown === 'string' ? markdown : '',
      mode: mode === 'replace' ? 'replace' : 'insert'
    }, CONSENT_TIMEOUT),
    // AI 总结：命中缓存直接返回 cached: true，未命中才调用模型
    summarize: (postId) => send('post.summarize',
      postId ? { postId } : {}, SUMMARY_TIMEOUT)
  };

  const line = (label) => console.log('%c' + label, 'font-weight:bold;color:#fa322d');
  line('PickScribe 开放接口 v1 自检');

  Promise.all([pcrTest.ping(), pcrTest.state()]).then(([ping, state]) => {
    if (!ping.ok) {
      console.error('ping 失败', ping);
      return;
    }
    console.log('版本', ping.data.version, '协议', ping.data.protocol);
    console.log('页面', state.data.page);
    console.log('可用动作', (ping.data.actions || []).join(', ') || '无');
    console.table(ping.data.perms);
    const enabled = Object.keys(ping.data.perms || {}).filter((k) => ping.data.perms[k]);
    console.log('已开启能力', enabled.join(', ') || '无');
    console.log('手动测试：');
    console.log('  编辑页  await pcrTest.aiOpen("整理成大纲")');
    console.log('  信息流  await pcrTest.postOpen("帖子ID")');
    console.log('  数据读取 await pcrTest.readPost() / await pcrTest.readEditor()（首次会弹确认窗）');
    console.log('  写入正文 await pcrTest.writeEditor("**测试**", "insert")（首次会弹确认窗）');
    console.log('  AI 总结  await pcrTest.summarize()（首次会弹「消耗 AI 额度」；未命中缓存最长 160 秒）');
  }).catch((err) => {
    console.error('自检失败：', err);
    console.error('请确认：1) 当前在 Pickcat 站点；2) 扩展已加载；3) 页面刷新后重试。');
  });
})();

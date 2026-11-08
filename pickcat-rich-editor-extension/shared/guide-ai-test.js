/**
 * 新手引导里的「测试连接」按钮。
 *
 * 为什么单独放一个扩展页面：
 * - chrome.permissions.request 必须在扩展页面的用户点击同步栈里调用，
 *   内容脚本没有 permissions API，后台 service worker 里又会丢掉手势；
 * - 这里点按钮 → 当场申请接口域名 → 再让后台用同一份 pcai_config 发一次最小请求。
 *
 * 与父页面只通过 postMessage 交换三样东西：当前接口地址、主题、测试结果。
 */

const btn = document.getElementById('test');
let baseUrl = '';
let busy = false;

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.source !== 'pcs-guide-ai-test-config') return;
  baseUrl = String(data.baseUrl || '');
  document.body.classList.toggle('dark', data.theme === 'dark');
  if (data.primary) document.documentElement.style.setProperty('--accent', String(data.primary));
});

// 告诉父页面可以下发当前配置了
window.parent.postMessage({ source: 'pcs-guide-ai-test-ready' }, '*');

function finish(result) {
  busy = false;
  btn.disabled = false;
  btn.textContent = '测试连接';
  window.parent.postMessage({
    source: 'pcs-guide-ai-test-result',
    ok: !!(result && result.ok),
    needPermission: !!(result && result.needPermission),
    message: (result && result.message) || ''
  }, '*');
}

btn.addEventListener('click', () => {
  if (busy) return;

  let origin = '';
  try {
    origin = baseUrl.trim() ? new URL(baseUrl.trim()).origin : '';
  } catch (e) {
    origin = '';
  }

  // 授权必须发生在点击的同步栈里：await 之前不能插入异步操作
  let request;
  try {
    request = origin
      ? chrome.permissions.request({ origins: [origin + '/*'] })
      : Promise.resolve(true);
  } catch (e) {
    request = Promise.resolve(true);
  }

  busy = true;
  btn.disabled = true;
  btn.textContent = '测试中…';

  request.then((granted) => {
    if (!granted) {
      finish({ ok: false, needPermission: true, message: '未获得该接口域名的访问权限' });
      return;
    }
    // 给父页面留一点时间把刚输入的内容写入 storage，再让后台读取同一份配置
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'ai-test' }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            finish({ ok: false, message: err.message || '后台没有响应' });
            return;
          }
          finish(res || { ok: false, message: '后台没有响应' });
        });
      } catch (e) {
        finish({ ok: false, message: e && e.message ? e.message : String(e) });
      }
    }, 160);
  }).catch((err) => {
    finish({ ok: false, message: err && err.message ? err.message : String(err) });
  });
});

/**
 * 工牌甩动音效（独立文件，默认关闭）。
 *
 * 开关：chrome.storage.local 的 pcr_badge_swing_sound（设置页「账号菜单」分区）。
 * 声音：WebAudio 现场合成的短促风声，不打包任何音频资源，音量克制（峰值增益 0.05~0.1）。
 * 触发：由 api/badge.js 在摆动到达一次峰值时调用 PCRSwingSound.play(强度)。
 *
 * 说明：AudioContext 只在真正要发声时创建，且首次发声紧随用户的拖拽手势，
 * 不会在页面加载时就占用音频设备；同一时刻的重复调用会被节流。
 */

(() => {
  'use strict';

  if (window.PCRSwingSound) return;

  const KEY = 'pcr_badge_swing_sound';
  const MIN_GAP = 220;   // 两次音效的最小间隔（毫秒），避免连续摆动时叠成噪音
  const MIN_PEAK = 0.16; // 强度低于这个值不发声，轻碰一下就响会很烦

  let enabled = false;
  let ctx = null;
  let noiseBuffer = null;
  let lastAt = 0;

  // ============================ 开关 ============================

  function readSwitch() {
    try {
      chrome.storage.local.get(KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        enabled = !!raw && raw[KEY] === true;
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        enabled = changes[KEY].newValue === true;
      });
    } catch (e) { /* 非扩展环境：保持关闭 */ }
  }

  // ============================ 音频 ============================

  function ensureContext() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      ctx = new Ctx();
    } catch (e) {
      return null;
    }
    return ctx;
  }

  /** 0.3 秒白噪声：只用一次，之后复用，避免每次发声都重新生成缓冲区 */
  function getNoise(context) {
    if (noiseBuffer) return noiseBuffer;
    const len = Math.floor(context.sampleRate * 0.3);
    const buffer = context.createBuffer(1, len, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      // 淡入淡出包络，避免首尾爆音
      const edge = Math.min(1, i / 240, (len - i) / 240);
      data[i] = (Math.random() * 2 - 1) * edge;
    }
    noiseBuffer = buffer;
    return buffer;
  }

  /**
   * 发一声「呼」：带通滤波从高往低扫，模拟挂绳划过空气。
   * strength 0~1，越大越响、越闷。
   */
  function play(strength) {
    if (!enabled) return;
    const peak = Math.max(0, Math.min(1, Number(strength) || 0));
    if (peak < MIN_PEAK) return;
    const now = performance.now();
    if (now - lastAt < MIN_GAP) return;

    const context = ensureContext();
    if (!context) return;
    if (context.state === 'suspended') context.resume().catch(() => {});
    lastAt = now;

    const t0 = context.currentTime;
    const dur = 0.2 + 0.1 * peak;

    const src = context.createBufferSource();
    src.buffer = getNoise(context);

    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    band.frequency.setValueAtTime(760 + 980 * peak, t0);
    band.frequency.exponentialRampToValueAtTime(240, t0 + dur);

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05 + 0.05 * peak, t0 + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(band);
    band.connect(gain);
    gain.connect(context.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  readSwitch();

  window.PCRSwingSound = { play, isOn: () => enabled };
})();

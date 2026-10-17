// ==UserScript==
// @name         2048
// @namespace    https://fby.hfz300.com/
// @version      4.3
// @description  2048：去广告（推荐块/导航条/影片横幅/打赏卡）；隐藏详情页侧栏；去懒加载——列表原生 lazy 与详情页占位图（data-original）一律立即加载，防抖观察者兜底站点改图；图片加载队列（10 张/秒、在途≤10、首屏突发 10），列表页"搜索"右边有队列模式开关（关闭即一次性全量加载，状态存本地）；右下角加载进度胶囊。
// @author       Chevy Yang
// @match        https://bbs.hdaksog.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================ 可调参数 ============================

  // 广告与无用块，命中即整块移除（含打赏推广卡）
  const REMOVE_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill', '.nav-container', '.movie-banner', '.reward-card'];

  // 观察者防抖间隔（毫秒）
  const OBSERVE_DEBOUNCE = 80;

  // 进度胶囊全部结算后延迟多久淡出
  const PILL_HIDE_DELAY = 2500;

  // 图片加载节奏：2048 图床无实测限流，取"温和节流"而非色花堂的保守值——
  // 每秒最多发起 10 张、同时在途 ≤10、首屏允许 10 张突发（52 张约 5 秒派完）
  const IMG_INFLIGHT_MAX = 10;
  const IMG_START_PER_SEC = 10;
  const IMG_TOKEN_CAP = 10;
  const IMG_HOLD_TIMEOUT = 10000;

  // 队列模式开关状态的 localStorage 键名（'0'=关闭，恢复旧的一次性全量加载）
  const QUEUE_KEY = 't2048QueueMode';

  // ============================ 哨兵 ============================

  // 防双注入：同版本已占位则退出；旧版本占位（值不同）不退出，改写哨兵接管
  if (document.documentElement.getAttribute('data-t2048') === '4.3') return;
  document.documentElement.setAttribute('data-t2048', '4.3');

  // ============================ 样式 ============================

  // 侧栏隐藏 + 站点占位 gif 背景清除 + 进度胶囊（沿用旧版式）
  document.head.insertAdjacentHTML('beforeend', `<style>
    .r_two { display: none !important; }
    [style*="thumb-ing"] { background-image: none !important; }
    #thumb-progress { position: fixed; right: 14px; bottom: 14px; z-index: 2147483646; padding: 7px 14px; border-radius: 999px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 12px; line-height: 1.4; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: opacity 0.3s ease; pointer-events: none; }
    #thumb-progress.thumb-progress-done { background: rgba(35, 120, 60, 0.85); }
    #thumb-progress.thumb-progress-partial { background: rgba(150, 70, 20, 0.88); }
  </style>`);

  // ============================ 去广告 ============================

  function removeMatching(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(REMOVE_SELECTORS.join(',')).forEach(el => el.remove());
  }

  // ============================ 图片加载队列 ============================
  // 同色花堂：令牌桶控节奏（4 张/秒、在途≤6、首屏突发 6、单张 15s 兜底）
  // 队列模式开关关闭时每张图立即加载（旧行为）

  const imgLoader = (() => {
    let tokens = IMG_TOKEN_CAP, inflight = 0, queue = [], timer = null;
    const pump = () => {
      while (queue.length && tokens > 0 && inflight < IMG_INFLIGHT_MAX) {
        tokens--; inflight++;
        queue.shift()(() => { inflight--; pump(); });
      }
      if (queue.length && !timer) timer = setInterval(() => { tokens = Math.min(IMG_TOKEN_CAP, tokens + 1); pump(); }, 1000 / IMG_START_PER_SEC);
      if (!queue.length && timer) { clearInterval(timer); timer = null; }
    };
    const load = task => { queue.push(task); pump(); };
    const flushAll = () => {
      if (timer) { clearInterval(timer); timer = null; }
      queue.splice(0).forEach(task => task(() => {}));
    };
    return { load, flushAll };
  })();

  let queueEnabled = true;

  function setQueueMode(on) {
    queueEnabled = on;
    if (!on) imgLoader.flushAll();
  }

  // 队列模式开关：插在列表页顶部"搜索"导航项右边。
  // queueEnabled 初始化在启动处无条件做，不能依赖本函数
  function injectQueueSwitch() {
    if (document.getElementById('t2048-queue-switch')) return;
    const link = [...document.querySelectorAll('a')].find(a => (a.textContent || '').trim() === '搜索' && a.getBoundingClientRect().width > 0);
    const li = link && link.closest('li');
    if (!li) return;
    let on = true;
    try { on = localStorage.getItem(QUEUE_KEY) !== '0'; } catch (e) {}
    const box = document.createElement('li');
    box.id = 't2048-queue-switch';
    box.innerHTML = '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none;color:#fff;font-size:14px;font-weight:700;padding:0 10px;white-space:nowrap;"><input type="checkbox"' + (on ? ' checked' : '') + '>队列模式</label>';
    li.insertAdjacentElement('afterend', box);
    box.querySelector('input').addEventListener('change', e => {
      try { localStorage.setItem(QUEUE_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
      setQueueMode(e.target.checked);
    });
  }

  // 让一张图计入胶囊并按队列模式开始加载；action=实际触发加载的动作（设 src / 改 loading）
  function trackImage(img, action) {
    if (img.dataset.watched) return;   // 同一节点只计一次
    img.dataset.watched = '1';
    pill.add(1);
    let settledHere = false;
    const settle = failed => { if (!settledHere) { settledHere = true; pill.settle(failed); } };
    const start = poolDone => {
      let released = false;
      const release = () => { if (released) return; released = true; clearTimeout(to); if (poolDone) poolDone(); };
      const to = setTimeout(() => { settle(true); release(); }, IMG_HOLD_TIMEOUT);
      img.addEventListener('load', () => { settle(false); release(); }, { once: true });
      img.addEventListener('error', () => { settle(true); release(); }, { once: true });
      action();
      // 触发后若图已完成（缓存命中/原本就加载完了），load 事件不会再触发，需同步结算
      if (img.complete) { if (img.naturalWidth > 0) settle(false); else settle(true); release(); }
    };
    if (queueEnabled) imgLoader.load(start); else start(null);
  }

  // ============================ 去懒加载 ============================

  // 站内占位图特征
  const PLACEHOLDER_NAME_RE = /thumb-ing|thumbing|none\.gif|spacer\.gif|loading\.gif|blank\.gif|grey\.gif/i;

  // 当前 src 是否占位：空 / data: 内联 / 相对路径 / 占位特征名
  function isPlaceholderSrc(src) {
    if (!src || src.indexOf('data:') === 0) return true;
    if (/^(https?:)?\/\//i.test(src)) return PLACEHOLDER_NAME_RE.test(src);
    return true;   // 相对路径一律当占位：真图床不会用相对地址
  }

  // 绝对化图片地址；https 页面里的 http 图升级成 https。
  // val 为 null 时 new URL 会把它串成 "null" 并返回合法假地址，必须先挡
  const absUrl = val => {
    if (!val) return null;
    try {
      const u = new URL(val, location.href);
      if (!u.protocol.startsWith('http')) return null;
      if (location.protocol === 'https:' && u.protocol === 'http:') u.protocol = 'https:';
      return u.href;
    } catch (e) { return null; }
  };

  // 处理单张图：占位图换 data 属性里的真址，原生懒图改立即加载；返回是否动了这张图。
  // 触发加载的动作交给 trackImage（计入胶囊 + 按队列模式节流）
  function deLazyImg(img) {
    if (img.closest('picture') || img.getAttribute('srcset')) return false;   // 响应式图不碰
    const real = absUrl(img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src'));
    let touched = false;
    if (real && isPlaceholderSrc(img.getAttribute('src'))) {
      trackImage(img, () => { img.loading = 'eager'; img.src = real; });
      touched = true;
    } else if (img.getAttribute('loading') === 'lazy') {
      trackImage(img, () => { img.loading = 'eager'; });   // 原生懒图（src 已真）改立即加载
      touched = true;
    }
    if (touched) {
      img.decoding = 'async';
      if (location.pathname.indexOf('thread.php') !== -1) {   // 列表页缩略图点开新标签
        const a = img.closest('a');
        if (a && !a.getAttribute('target')) { a.target = '_blank'; a.rel = 'noopener'; }
      }
    }
    return touched;
  }

  // 批量处理容器内所有图
  function sweep(root) {
    root.querySelectorAll('img[data-original], img[data-src], img[data-lazy-src], img[loading=lazy]').forEach(deLazyImg);
  }

  // ============================ 加载进度胶囊 ============================
  // 只统计脚本触发加载的图，原生 load/error 即结算，全部完成后延迟淡出

  const pill = {
    total: 0, settled: 0, failed: 0, el: null, timer: null,

    add(n) {
      this.total += n;
      clearTimeout(this.timer); this.timer = null;   // 新图入账，撤销淡出计时
      if (this.el) this.el.style.opacity = '';
      this.render();
    },

    settle(failed) { this.settled++; if (failed) this.failed++; this.render(); },

    render() {
      if (!this.total) return;
      const el = this.mount(); if (!el) return;
      const done = this.settled >= this.total;
      el.classList.toggle('thumb-progress-done', done && !this.failed);
      el.classList.toggle('thumb-progress-partial', done && this.failed > 0);
      el.textContent = done
        ? (this.failed ? `缩略图 ${this.total - this.failed}/${this.total}（${this.failed} 张失败）` : `缩略图 ${this.total} 张已加载`)
        : `缩略图已完成 ${this.settled}/${this.total}${this.failed ? `（其中 ${this.failed} 张失败）` : ''}`;
      if (done && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.hide(); }, PILL_HIDE_DELAY);
    },

    mount() {
      if (this.el && this.el.isConnected) return this.el;
      const parent = document.body || document.documentElement; if (!parent) return null;
      this.el = Object.assign(document.createElement('div'), { id: 'thumb-progress' });
      parent.appendChild(this.el);
      return this.el;
    },

    hide() {
      const el = this.el; if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => { el.remove(); this.el = null; }, 400);   // 只摘节点不清计数：后续再插入图胶囊能重建
    }
  };

  // ============================ 启动 ============================
  function processRoot(root) {
    removeMatching(root);                              // 先清广告再扫图：广告块里的图不处理
    sweep(root);                                       // 计数与节流由 trackImage 接管
  }

  let debounceTimer = null;
  function scheduleProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processRoot(document), OBSERVE_DEBOUNCE);
  }

  // 站点 AJAX 插入新帖子行时扫描新图；src 已在初始全扫时设好，不监听属性变化
  new MutationObserver(scheduleProcess).observe(document.documentElement, { childList: true, subtree: true });

  // 队列模式初始化（无条件，不能依赖开关是否渲染出来）+ 注入开关
  try { queueEnabled = localStorage.getItem(QUEUE_KEY) !== '0'; } catch (e) {}
  injectQueueSwitch();
  processRoot(document);
})();

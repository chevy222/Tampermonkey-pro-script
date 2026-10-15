// ==UserScript==
// @name         2048
// @namespace    https://fby.hfz300.com/
// @version      4.0.0
// @description  2048：去广告（推荐块/导航条/影片横幅/打赏卡）；隐藏详情页侧栏；去懒加载——列表原生 lazy 与详情页占位图（data-original）一律立即加载，防抖观察者兜底站点改图；右下角加载进度胶囊。无加载引擎。
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

  // ============================ 哨兵 ============================

  // 防双注入：同版本已占位则退出；旧版本占位（值不同）不退出，改写哨兵接管
  if (document.documentElement.getAttribute('data-t2048') === '4.0.0') return;
  document.documentElement.setAttribute('data-t2048', '4.0.0');

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

  // 处理单张图：占位图换 data 属性里的真址，原生懒图改立即加载；返回是否动了这张图
  function deLazyImg(img) {
    if (img.closest('picture') || img.getAttribute('srcset')) return false;   // 响应式图不碰
    const real = absUrl(img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src'));
    let touched = false;
    if (real && isPlaceholderSrc(img.getAttribute('src'))) {
      img.loading = 'eager';                  // eager 先于 src：赋值的瞬间就必须是立即加载
      img.src = real;
      touched = true;
    } else if (img.getAttribute('loading') === 'lazy') {
      img.loading = 'eager';                  // 原生懒图（src 已真）直接改立即加载
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

  // 批量处理容器内所有图，返回本轮触发加载的图
  function sweep(root) {
    const touched = [];
    root.querySelectorAll('img[data-original], img[data-src], img[data-lazy-src], img[loading=lazy]').forEach(img => {
      if (deLazyImg(img)) touched.push(img);
    });
    return touched;
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
        : `缩略图已完成 ${this.settled}/${this.total}${this.failed ? `（${this.failed} 张失败）` : ''}`;
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

  // 监听一组图的加载结果；调用时机 = 赋真址/插入 DOM 之后
  function watchImgs(imgs) {
    imgs.forEach(img => {
      if (img.dataset.watched) return;               // 同一节点只计一次
      img.dataset.watched = '1';
      pill.add(1);
      const done = failed => pill.settle(failed);
      if (img.complete) done(img.naturalWidth === 0);            // 缓存命中：同步结算
      else {
        img.addEventListener('load', () => done(false), { once: true });
        img.addEventListener('error', () => done(true), { once: true });
      }
    });
  }

  // ============================ 启动 ============================

  function processRoot(root) {
    removeMatching(root);                              // 先清广告再扫图：广告块里的图不处理
    watchImgs(sweep(root));
  }

  let debounceTimer = null;
  function scheduleProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processRoot(document), OBSERVE_DEBOUNCE);
  }

  // 站点滚动加载器会改写 src、后续可能插入新图：防抖后幂等重处理
  new MutationObserver(scheduleProcess).observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ['src'] });

  processRoot(document);
})();

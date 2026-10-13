// ==UserScript==
// @name         色花堂缩略图
// @namespace    http://98tang.com/
// @version      3.10
// @description  PC列表页从移动版触屏模板取缩略图，页面打开时一次性全部加载（无懒加载、无滚动触发、无按需加载），宽屏单列布局 + 加载进度提示 + 失败自动重试；搜索页栏目过滤与详情图加载；详情页宽屏去广告；搜索繁忙自动刷新；失败图压暗留位 + 角标 ↻ 手动重试；双注入防护；迟到 load 回收。
// 失败记忆分三层，互相独立：sehuaBadImages（硬失败单图，TTL 5min）、sehuaSlowImages（超时单图，TTL 60s）、sehuaDeadHosts（图床，仅本次页面加载内作为熔断闸门，跨刷新不拦）。要恢复尝试：清掉 sehuaBadImages + sehuaSlowImages 后刷新即可。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  // ============================ 可调参数 ============================

  // 版本号，document-start 阶段写到 <html data-sehua="..."> 上（兼作双注入哨兵）
  // 必须与文件头 @version 保持一致，否则哨兵值与声明版本对不上，排障时会误判
  const VERSION = '3.10';

  // 防双注入（Tampermonkey 装重 / 多渠道注入）：先占位，后到的实例原路退出
  if (document.documentElement.getAttribute('data-sehua')) return;
  document.documentElement.setAttribute('data-sehua', VERSION);

  // 移动版 User-Agent，服务端据此分发触屏模板
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

  // GM 请求超时（毫秒）
  const REQUEST_TIMEOUT = 15000;

  // 详情页取图的并发上限
  const MAX_CONCURRENT = 5;

  // 搜索繁忙自动刷新的次数上限
  const MAX_BUSY_RETRY = 5;

  // 从详情页回捞时单帖最多取几张图
  const MAX_DETAIL_IMGS = 5;

  // 每个帖子最多注入几张缩略图
  const MAX_THUMBS_PER_POST = 5;

  // 移动版映射请求失败后的重试次数与退避间隔
  const MOBILE_RETRY_TIMES = 2;
  const MOBILE_RETRY_DELAY = 1500;

  // 是否预取下一页的移动版映射（翻页时省去等待）
  const PREFETCH_NEXT_PAGE = true;

  // 预取延后多久发出（等当前页图片请求铺开后再发）
  const PREFETCH_DELAY_MS = 3000;

  // 详情页请求被反爬拦截后的退避重试
  const DETAIL_RETRY_TIMES = 3;
  const DETAIL_RETRY_BASE_MS = 2000;

  // 单张缩略图加载失败后的重试次数与退避基数
  const IMG_RETRY_TIMES = 2;
  const IMG_RETRY_BASE_MS = 800;

  // 单张图片的总等待上限，跨所有重试共享
  const IMG_TOTAL_WAIT_MS = 45000;

  // 同一图床连续硬失败这么多次即判不可达；任一成功即清零
  const HOST_FAIL_THRESHOLD = 3;

  // 同一图床连续「超时」这么多次同样判不可达：挂住不回 = 不可用，只是证据弱，故阈值放宽。
  // 不加这条的话，一个整体挂住的图床永远不会触发熔断，每轮刷新都全量重试。
  const HOST_TIMEOUT_THRESHOLD = 8;

  // ============ 失败记忆 ============
  // 记住加载失败的图和死图床，刷新页面后直接跳过
  const BAD_IMAGE_KEY = 'sehuaBadImages';
  const BAD_IMAGE_TTL = 5 * 60 * 1000;     // 硬失败单图的记忆时长
  const BAD_IMAGE_MAX = 300;
  const SLOW_IMAGE_KEY = 'sehuaSlowImages';
  const SLOW_IMAGE_TTL = 60 * 1000;        // 超时（弱证据）的记忆时长
  const SLOW_IMAGE_MAX = 300;
  const DEAD_HOST_KEY = 'sehuaDeadHosts';
  const DEAD_HOST_TTL = 10 * 60 * 1000;    // 判死图床的记忆时长
  const DEAD_HOST_MAX = 16;

  // 同时在途的缩略图请求数上限（0 = 不限制）——这是全局总闸
  const MAX_IMG_IN_FLIGHT = 16;

  // 单域名在途上限。Chrome 对同一 origin 的 HTTP/1.1 只给约 6 条连接，
  // 全局 16 会让多余的请求滞留在浏览器 socket 队列里空等，而脚本的等待计时照跑，
  // 于是未真正发出的请求被误判超时 → 重试 → 更堵。按域名分池才是真实可控的并发。
  const PER_HOST_IN_FLIGHT = 6;

  // 首屏判定余量
  const FOLD_SLACK_PX = 120;

  // 非首屏缩略图的加载优先级
  const BELOW_FOLD_PRIORITY = 'auto';

  // 缩略图之间的间距
  const THUMB_GAP_PX = 8;

  // 进度提示在全部图片结算后延迟多久消失
  const PROGRESS_HIDE_DELAY = 2500;

  // 搜索页要过滤（默认隐藏）的栏目
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];

  // 过滤开关状态的 localStorage 键名
  const FILTER_STORAGE_KEY = 'sehuaFilterState';

  // 搜索繁忙重试计数的 sessionStorage 键名
  const BUSY_RETRY_KEY = 'sehuaBusyRetry';

  // 解析 HTML 取图片真实地址时依次探测的属性
  const IMG_SRC_ATTRS = ['file', 'zoomfile', 'data-original'];

  // 站内装饰图特征串：静态图标、用户头像、占位图
  const PLACEHOLDER_MARKERS = ['static/image', 'uc_server', 'none.gif', 'thumb-ing'];

  // 运行日志开关（排查时改成 true）
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[色花堂缩略图]', ...args); };

  // ============================ 工具函数 ============================

  function isPlaceholder(url) {
    return PLACEHOLDER_MARKERS.some(marker => url.indexOf(marker) !== -1);
  }

  // 归一化成 http(s) 绝对地址
  function normalizeHttpUrl(val, base) {
    if (!val) return null;
    try {
      const u = new URL(val, base || location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // 从一张 img 上取真实图片地址（依次探测 IMG_SRC_ATTRS，最后退回 src）
  function getRealSrc(img) {
    for (const attr of IMG_SRC_ATTRS) {
      const url = normalizeHttpUrl(img.getAttribute(attr));
      if (url && !isPlaceholder(url)) return url;
    }
    const url = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    if (url && !isPlaceholder(url)) return url;
    return null;
  }

  // 当前页面的论坛 ID 与页码
  function getPageInfo() {
    const m1 = location.href.match(/forum-(\d+)-(\d+)\.html/);
    if (m1) return { fid: m1[1], page: parseInt(m1[2], 10) };
    const params = new URLSearchParams(location.search);
    return { fid: params.get('fid'), page: parseInt(params.get('page') || '1', 10) };
  }

  // 并发控制器
  class ConcurrencyPool {
    constructor(max) { this.max = max; this.running = 0; this.queue = []; }
    async add(fn) {
      while (this.running >= this.max) {
        await new Promise(resolve => this.queue.push(resolve));
      }
      this.running++;
      try {
        return await fn();
      } finally {
        this.running--;
        if (this.queue.length > 0) this.queue.shift()();
      }
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============ 移动版缩略图映射 ============

  // 带移动 UA 请求触屏模板，解析出 帖子tid -> 缩略图地址列表 的映射
  function fetchMobileThumbs(fid, page) {
    return new Promise((resolve) => {
      const sp = new URLSearchParams(location.search);
      const pairs = ['mobile=2'];
      ['filter', 'orderby', 'typeid', 'specialtype'].forEach(k => {
        if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k)));
      });
      const url = `https://${location.hostname}/forum-${fid}-${page}.html?${pairs.join('&')}`;
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': MOBILE_UA,
          'Cookie': 'mobile=2'
        },
        onload: function(resp) {
          try {
            const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
            const cards = doc.querySelectorAll('.n5_htmk');
            if (cards.length === 0) {
              if (isSafePage(resp.responseText)) {
                console.warn('[色花堂缩略图] 移动版请求被 safe 挑战页挡下:', url);
              } else {
                console.warn('[色花堂缩略图] 未找到移动版结构(.n5_htmk)');
              }
            }
            const mapping = {};
            const fallbackTids = [];
            cards.forEach(el => {
              const link = el.querySelector('a[href*=viewthread]');
              if (!link) return;
              const tid = link.href.match(/tid=(\d+)/)?.[1];
              if (!tid) return;
              const urls = [];
              el.querySelectorAll('img').forEach(img => {
                const src = getRealSrc(img);
                if (src && !urls.includes(src)) urls.push(src);
              });
              if (urls.length > 0) mapping[tid] = urls;
              else fallbackTids.push(tid);
            });
            resolve({ mapping, fallbackTids });
          } catch (e) {
            console.error('[色花堂缩略图] 解析失败:', e);
            resolve({ mapping: {}, fallbackTids: [] });
          }
        },
        ontimeout: function() {
          console.error('[色花堂缩略图] 请求超时:', url);
          resolve({ mapping: {}, fallbackTids: [] });
        },
        onerror: function() {
          console.error('[色花堂缩略图] 请求失败');
          resolve({ mapping: {}, fallbackTids: [] });
        }
      });
    });
  }

  // 判断一次移动版请求是否解出有效内容
  function mobileResultOk(result) {
    if (!result) return false;
    return Object.keys(result.mapping || {}).length > 0 || (result.fallbackTids || []).length > 0;
  }

  // 带自动重试的获取
  function fetchMobileThumbsWithRetry(fid, page, left = MOBILE_RETRY_TIMES) {
    return fetchMobileThumbs(fid, page).then(result => {
      if (mobileResultOk(result) || left <= 0) return result;
      return new Promise(resolve => setTimeout(() => {
        fetchMobileThumbsWithRetry(fid, page, left - 1).then(resolve);
      }, MOBILE_RETRY_DELAY));
    });
  }

  // ============ 移动版映射缓存 ============

  const thumbCache = {};
  const pendingPages = {};
  const PAGE_CACHE_KEY = 'sehuaPageCache';
  const PAGE_CACHE_TTL = 5 * 60 * 1000;
  const PAGE_CACHE_MAX = 10;

  function readPageCache(key) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(PAGE_CACHE_KEY) || '{}')[key];
      if (hit && Date.now() - hit.t < PAGE_CACHE_TTL && mobileResultOk(hit.v)) return hit.v;
    } catch (e) {}
    return null;
  }

  function writePageCache(key, value) {
    try {
      const all = JSON.parse(sessionStorage.getItem(PAGE_CACHE_KEY) || '{}');
      all[key] = { t: Date.now(), v: value };
      const keys = Object.keys(all);
      if (keys.length > PAGE_CACHE_MAX) {
        keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0))
          .slice(0, keys.length - PAGE_CACHE_MAX)
          .forEach(k => { delete all[k]; });
      }
      sessionStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // 取某一页的移动版缩略图映射
  function fetchMobileThumbsByPage(fid, page, allowRetry = true) {
    const key = fid + '_' + page;
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    const persisted = readPageCache(key);
    if (persisted) { thumbCache[key] = persisted; return Promise.resolve(persisted); }
    if (pendingPages[key]) return pendingPages[key];
    const fetchPromise = (allowRetry ? fetchMobileThumbsWithRetry(fid, page) : fetchMobileThumbs(fid, page))
      .then(result => {
        if (mobileResultOk(result)) {
          thumbCache[key] = result;
          writePageCache(key, result);
        }
        return result;
      })
      .finally(() => { delete pendingPages[key]; });
    pendingPages[key] = fetchPromise;
    return fetchPromise;
  }

  // 预取下一页的映射
  function prefetchNextPageMapping(fid, page) {
    if (!PREFETCH_NEXT_PAGE) return;
    setTimeout(() => {
      fetchMobileThumbsByPage(fid, page + 1, false).catch(() => {});
    }, PREFETCH_DELAY_MS);
  }

  // ============ 缩略图图床的预连接 ============

  const IMG_HOST_KEY = 'sehuaImgHosts';
  const IMG_HOST_MAX = 4;

  // 挂一条 preconnect
  function preconnectHost(origin, tries = 0) {
    if (!origin || origin === location.origin) return;
    if (deadHosts.has(origin)) return;
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (tries < 10) setTimeout(() => preconnectHost(origin, tries + 1), 20);
      else console.warn('[色花堂缩略图] preconnect 放弃:', origin);
      return;
    }
    if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    parent.appendChild(link);
  }

  // 收集图床域名：立即预连接，同时记入 localStorage 供下次提前连
  function preconnectUrlList(urls) {
    const hosts = new Set();
    urls.forEach(u => {
      try {
        const origin = new URL(u, location.origin).origin;
        if (origin !== location.origin) hosts.add(origin);
      } catch (e) {}
    });
    if (hosts.size === 0) return;
    hosts.forEach(h => preconnectHost(h));
    try {
      const prev = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]');
      const merged = [...new Set([...hosts, ...prev])].filter(h => !deadHosts.has(h));
      localStorage.setItem(IMG_HOST_KEY, JSON.stringify(merged.slice(0, IMG_HOST_MAX)));
    } catch (e) {}
  }

  // document-start 调用：用上次学到的图床域名抢先握手
  function preconnectLearnedHosts() {
    try {
      JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]').forEach(h => preconnectHost(h));
    } catch (e) {}
  }

  // 移动版映射到手后调用（列表页）
  function preconnectImageHosts(mapping) {
    const urls = [];
    Object.values(mapping).forEach(list => urls.push(...list));
    preconnectUrlList(urls);
  }

  // ============ 详情页取图（移动版没给出缩略图时的回捞） ============

  // 站点反爬拦截页（safeid 挑战页）
  function isSafePage(text) {
    return typeof text === 'string' && text.indexOf('safeid') !== -1;
  }

  // 从详情页取图片；被拦截或重试耗尽返回 null
  function fetchDetailImages(tid) {
    const url = `https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`;
    function requestOnce() {
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: REQUEST_TIMEOUT,
          onload: function(resp) {
            if (isSafePage(resp.responseText)) { resolve('blocked'); return; }
            try {
              const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
              const urls = [];
              doc.querySelectorAll('.t_f img, .pcb img, .message img').forEach(img => {
                const u = getRealSrc(img);
                if (u && urls.indexOf(u) === -1 && urls.length < MAX_DETAIL_IMGS) urls.push(u);
              });
              resolve(urls);
            } catch (e) {
              console.error('[色花堂缩略图] 详情页解析失败:', e);
              resolve(null);
            }
          },
          ontimeout: function() { resolve('blocked'); },
          onerror: function() { resolve('blocked'); }
        });
      });
    }
    return (async () => {
      for (let attempt = 0; attempt < DETAIL_RETRY_TIMES; attempt++) {
        const result = await requestOnce();
        if (result !== 'blocked') return result;
        await sleep(DETAIL_RETRY_BASE_MS + attempt * DETAIL_RETRY_BASE_MS);
      }
      console.error('[色花堂缩略图] 详情页请求被反爬拦截:', tid);
      return null;
    })();
  }

  // ============================ 样式 ============================

  // 宽屏样式：三层容器全部撑满
  const WIDE_CSS = `
    .wp { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #nv { width: 100% !important; left: 0 !important; right: 0 !important; }
    #diy_chart { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #diy_chart .slideshow li { width: 100% !important; }
    #diy_chart .slideshow li img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
  `;

  const PAGE_CSS = `
    ${WIDE_CSS}
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
  `;

  // 缩略图版式
  const THUMB_CSS = `
    .sehua-thumb { --img-width: 50%; display: flex; flex-wrap: wrap; justify-content: center; gap: ${THUMB_GAP_PX}px; margin-top: 8px; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; transition: border-color 0.2s ease; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; text-decoration: none; width: var(--img-width) !important; position: relative; }
    .sehua-thumb a.sehua-failed { opacity: 0.4; filter: grayscale(1); }
    .sehua-retry { position: absolute; top: 4px; right: 4px; z-index: 2; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(0, 0, 0, 0.65); color: #fff; font-size: 13px; line-height: 1; cursor: pointer; }
    .sehua-retry:hover { background: rgba(0, 0, 0, 0.85); }
    .sehua-thumb img:hover { border-color: #4a90d9; }
    .sehua-date { display: inline-block; margin-top: 4px; font-size: 12px; color: #999; }
  `;

  const PROGRESS_CSS = `
    #sehua-progress { position: fixed; right: 14px; bottom: 14px; z-index: 99999; padding: 7px 14px; border-radius: 999px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 12px; line-height: 1.4; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: opacity 0.3s ease; pointer-events: none; }
    #sehua-progress.sehua-done { background: rgba(35, 120, 60, 0.85); }
    #sehua-progress.sehua-partial { background: rgba(150, 70, 20, 0.88); }
  `;

  // 需要缩略图的页面共用的样式前缀
  const THUMB_PAGE_CSS = `${PAGE_CSS}${THUMB_CSS}${PROGRESS_CSS}`;

  function addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 删除无用元素与站内广告
  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    // 表格里不属于帖子的行整块移除：公告行、空表头行、广告行
    document.querySelectorAll('#threadlisttableid tbody').forEach(tb => {
      if (/^(normalthread_|stickthread_)/.test(tb.id)) return;
      if (tb.querySelector('.pg')) return;
      tb.remove();
    });
  }

  // 列表页样式
  function injectListStyles() {
    addStyle(`
      ${THUMB_PAGE_CSS}
      #threadlisttableid { table-layout: fixed !important; width: 100% !important; }
      #threadlisttableid th { width: 100% !important; padding-right: 0 !important; }
    `);
  }

  // ============================ 加载进度提示 ============================

  const thumbProgress = {
    total: 0, settled: 0, failed: 0, el: null, timer: null, removeTimer: null,

    add(count) {
      this.total += count;
      clearTimeout(this.timer);
      clearTimeout(this.removeTimer);
      this.removeTimer = null;
      if (this.el) this.el.style.opacity = '';
      this.render();
    },

    settle(failed) {
      this.settled++;
      if (failed) this.failed++;
      this.render();
      if (this.settled >= this.total) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.hide(), PROGRESS_HIDE_DELAY);
      }
    },

    // 手动重试成功：把已计入的失败数撤回一次，total/settled 都不动（分母不能被顶大）
    revive() {
      if (this.failed > 0) this.failed--;
      this.render();
    },

    render() {
      if (this.total === 0) return;
      const el = this.mount();
      const done = this.settled >= this.total;
      el.classList.toggle('sehua-done', done && this.failed === 0);
      el.classList.toggle('sehua-partial', done && this.failed > 0);
      if (!done) el.textContent = `缩略图加载中 ${this.settled}/${this.total}`;
      else if (this.failed > 0) el.textContent = `缩略图 ${this.total - this.failed}/${this.total}（${this.failed} 张失败）`;
      else el.textContent = `缩略图 ${this.total} 张已加载`;
    },

    mount() {
      if (this.el && this.el.isConnected) return this.el;
      this.el = document.createElement('div');
      this.el.id = 'sehua-progress';
      (document.body || document.documentElement).appendChild(this.el);
      return this.el;
    },

    hide() {
      const el = this.el;
      if (!el) return;
      el.style.opacity = '0';
      this.removeTimer = setTimeout(() => { el.remove(); this.removeTimer = null; }, 400);
    }
  };

  // ============================ 缩略图注入（全量加载） ============================

  const imgQueue = [];
  let imgInFlight = 0;

  // 图床健康度
  const hostFailStreak = new Map();
  const hostTimeoutStreak = new Map();
  const deadHosts = new Set();

  // 每个域名的在途计数，配合 PER_HOST_IN_FLIGHT 做分池限流
  const inFlightByHost = new Map();

  // 失败记忆
  const badImages = new Set();
  const badImageStamps = {};
  const slowImages = new Set();
  const slowImageStamps = {};
  const deadHostStamps = {};

  // 读一张"名称 -> 时间戳"表，顺手清掉过期项
  function readStampTable(key, ttl) {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
    const now = Date.now();
    const out = {};
    let pruned = false;
    for (const k of Object.keys(raw)) {
      const t = raw[k];
      if (!k || typeof t !== 'number' || now - t > ttl) { pruned = true; continue; }
      out[k] = t;
    }
    if (pruned) writeStampTable(key, out);
    return out;
  }

  function writeStampTable(key, table) {
    try { localStorage.setItem(key, JSON.stringify(table)); } catch (e) {}
  }

  // 超过上限时丢掉最早的一条
  function trimStamps(stamps, set, max, key) {
    const keys = Object.keys(stamps);
    if (keys.length > max) {
      keys.sort((a, b) => stamps[a] - stamps[b])
        .slice(0, keys.length - max)
        .forEach(k => { delete stamps[k]; set.delete(k); });
    }
    writeStampTable(key, stamps);
  }

  // soft=true 表示只是超时/慢，用短 TTL 的表；否则按硬失败记 5 分钟
  function rememberBadImage(url, soft) {
    if (soft) {
      slowImageStamps[url] = Date.now();
      slowImages.add(url);
      trimStamps(slowImageStamps, slowImages, SLOW_IMAGE_MAX, SLOW_IMAGE_KEY);
      return;
    }
    badImageStamps[url] = Date.now();
    badImages.add(url);
    trimStamps(badImageStamps, badImages, BAD_IMAGE_MAX, BAD_IMAGE_KEY);
  }

  // 手动重试前的"赦免"：把某张图从硬失败/超时两张表里除名并落盘，
  // 否则重试一进门就会被 loadThumb 行内的记忆检查自己挡回来
  function forgetImage(url) {
    let dirty = false;
    if (badImages.delete(url)) { delete badImageStamps[url]; dirty = true; }
    if (slowImages.delete(url)) { delete slowImageStamps[url]; dirty = true; }
    if (dirty) {
      writeStampTable(BAD_IMAGE_KEY, badImageStamps);
      writeStampTable(SLOW_IMAGE_KEY, slowImageStamps);
    }
  }

  // 图床恢复可用时立刻忘掉它
  function forgetHost(origin) {
    if (!deadHosts.has(origin)) return;
    deadHosts.delete(origin);
    delete deadHostStamps[origin];
    writeStampTable(DEAD_HOST_KEY, deadHostStamps);
  }

  function rememberDeadHost(origin) {
    deadHostStamps[origin] = Date.now();
    deadHosts.add(origin);
    trimStamps(deadHostStamps, deadHosts, DEAD_HOST_MAX, DEAD_HOST_KEY);
    dropPreconnectHost(origin);
  }

  // 把某个域名从预连接名单里剔除
  function dropPreconnectHost(origin) {
    try {
      const prev = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]');
      const next = prev.filter(h => h !== origin);
      if (next.length !== prev.length) localStorage.setItem(IMG_HOST_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  // 启动时把 TTL 内的失败记录读回来。
  // 图床记忆（sehuaDeadHosts）只做 TTL 清理与落盘，**不恢复成内存闸门**：
  // 跨刷新一律靠图级表（badImages/slowImages）拦，保证用户清掉图级表后一定能恢复尝试，
  // 不会出现「清了 sehuaBadImages 却还被 sehuaDeadHosts 挡住」的困惑；
  // 同一次页面加载内的熔断仍由内存态 deadHosts 负责（trackHostResult 写入）。
  function loadFailureMemory() {
    const bad = readStampTable(BAD_IMAGE_KEY, BAD_IMAGE_TTL);
    Object.assign(badImageStamps, bad);
    Object.keys(bad).forEach(k => badImages.add(k));

    readStampTable(DEAD_HOST_KEY, DEAD_HOST_TTL);

    const slow = readStampTable(SLOW_IMAGE_KEY, SLOW_IMAGE_TTL);
    Object.assign(slowImageStamps, slow);
    Object.keys(slow).forEach(k => slowImages.add(k));
  }

  function imageOrigin(url) {
    try { return new URL(url, location.origin).origin; } catch (e) { return null; }
  }

  // 图床健康度记账：ok = 成功清零；hard = 硬失败累加；timeout = 弱证据、单独更宽的阈值累加
  function trackHostResult(origin, outcome) {
    if (!origin) return;
    if (outcome === 'ok') {
      hostFailStreak.delete(origin);
      hostTimeoutStreak.delete(origin);
      forgetHost(origin);
      return;
    }
    // 整体挂住不回的图床同样不可用，必须能走到熔断，
    // 否则超时类失败永远熔断不了，每轮刷新都全量重试
    if (outcome === 'timeout') {
      const n = (hostTimeoutStreak.get(origin) || 0) + 1;
      hostTimeoutStreak.set(origin, n);
      if (n >= HOST_TIMEOUT_THRESHOLD) rememberDeadHost(origin);
      return;
    }
    const streak = (hostFailStreak.get(origin) || 0) + 1;
    hostFailStreak.set(origin, streak);
    if (streak >= HOST_FAIL_THRESHOLD) rememberDeadHost(origin);
  }

  function pumpImgQueue() {
    for (let i = 0; i < imgQueue.length; ) {
      if (MAX_IMG_IN_FLIGHT > 0 && imgInFlight >= MAX_IMG_IN_FLIGHT) break;
      const task = imgQueue[i];
      // 只做准入判断；真正的计数在 task 内部（已结算的任务会提前返回，
      // 若在这里先加计数就会漏还一个配额，把该域名永久卡死）
      if ((inFlightByHost.get(task._host) || 0) >= PER_HOST_IN_FLIGHT) { i++; continue; }
      imgQueue.splice(i, 1);
      task();
    }
  }

  // 该帖张数决定的单张宽度
  function thumbWidthRule(count) {
    if (count <= 1) return '50%';
    if (count === 2) return '40%';
    return `calc((100% - ${(count - 1) * THUMB_GAP_PX}px) / ${count})`;
  }

  // refetch 为真（硬错误重试）时才加参数破缓存；超时重试沿用原地址
  function attemptUrl(url, attempt, refetch) {
    if (!refetch) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '_r=' + Date.now() + attempt;
  }

  // 记录脚本自己写进去的 src。本站 img 由脚本自建自管，站点不会改写，
  // 所以不需要 2048 那边的 _selfSrc 比对（那边要防 MutationObserver 误判节点复用）
  function setImgSrc(img, url) {
    img.src = url;
  }

  // 加载一张缩略图。窗口位按次持有，重试排到队尾。
  // manual=true 为角标手动重试专用：不 add/settle（不动进度分母），强行绕过失败记忆发请求
  function loadThumb(img, url, anchor, wrap, manual = false) {
    const origin = imageOrigin(url);
    let startedAt = 0;
    let attempt = 0;
    let settled = false;
    let failedFlag = false;
    let holding = false;
    let heldHost = null;   // 本闭包当前占用的域名配额，释放时归还
    let refetch = false;   // 下次派发是否必须换新地址（仅硬错误重试时置真）
    let timer = null;

    const releaseSlot = () => {
      if (!holding) return;
      holding = false;
      imgInFlight--;
      const used = inFlightByHost.get(heldHost) || 0;
      inFlightByHost.set(heldHost, Math.max(0, used - 1));
      pumpImgQueue();
    };

    const done = (failed, outcome) => {
      if (settled) return;
      settled = true;
      failedFlag = failed;
      clearTimeout(timer);
      releaseSlot();

      if (!failed) trackHostResult(origin, 'ok');
      else if (outcome === 'hard') { rememberBadImage(url); trackHostResult(origin, 'hard'); }
      else if (outcome === 'timeout') { rememberBadImage(url, true); trackHostResult(origin, 'timeout'); }
      else if (outcome === 'cached-hard') rememberBadImage(url);
      // 被图床熔断跳过的图也要进图级表：否则图级记忆与图床记忆脱节，
      // 用户清 sehuaBadImages 时这些图根本没有条目，清了也看不出变化
      else if (outcome === 'skip') rememberBadImage(url);

      if (manual) {
        if (!failed) {
          // 手动重试成功：失败计数减回去，顺手清掉暗态和角标
          thumbProgress.revive();
          anchor.classList.remove('sehua-failed');
          const btn = anchor.querySelector('.sehua-retry');
          if (btn) btn.remove();
        } else {
          // 手动重试又挂了：恢复暗态 + 角标，还能再按
          markFailedAnchor(anchor, url, wrap);
        }
      } else {
        thumbProgress.settle(failed);
        if (failed) markFailedAnchor(anchor, url, wrap);
      }
    };

    // 把下一次尝试排进队列（队尾）
    const queueAttempt = () => {
      if (settled) return;
      const task = () => {
        if (settled) return;
        imgInFlight++;
        holding = true;
        heldHost = origin;
        inFlightByHost.set(origin, (inFlightByHost.get(origin) || 0) + 1);
        if (attempt === 0) startedAt = performance.now();
        if (!manual && deadHosts.has(origin)) { done(true, 'skip'); return; }
        const nextUrl = attemptUrl(url, attempt, refetch);
        // 只有地址真的变了才赋值：对同一 URL 重新赋值会取消浏览器在途/排队的请求
        if (img.getAttribute('src') !== nextUrl) setImgSrc(img, nextUrl);
        // 命中缓存时直接结算
        if (img.complete) {
          const ok = img.naturalWidth > 0;
          done(!ok, ok ? 'ok' : 'cached-hard');
          return;
        }
        armWait();
      };
      task._host = origin;   // pumpImgQueue 据此做域名分池
      imgQueue.push(task);
      pumpImgQueue();
    };

    const armWait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!settled) onTimeout(); },
        Math.max(0, IMG_TOTAL_WAIT_MS - (performance.now() - startedAt)));
    };

    function retryLater(hard) {
      attempt++;
      refetch = hard;   // 只有「请求已经结束」的硬错误才换地址重发
      releaseSlot();
      const delay = IMG_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 400);
      timer = setTimeout(queueAttempt, delay);
    }

    function onTimeout() {
      if (settled) return;
      clearTimeout(timer);
      // 超时一律结算为失败，不再重发：那次请求可能还卡在浏览器的连接队列里，
      // 重发只会取消它并把它重新排到队尾。真慢的图由「迟到 load 回收」兜底。
      done(true, 'timeout');
    }

    function onError() {
      if (settled) return;
      clearTimeout(timer);
      if (attempt >= IMG_RETRY_TIMES) { done(true, 'hard'); return; }
      retryLater(true);
    }

    img.addEventListener('load', () => {
      if (img.naturalWidth > 0) {
        if (settled && failedFlag) {
          // 迟到 load：已按失败结算后请求才完成，撤回失败记账与暗态
          failedFlag = false;
          thumbProgress.revive();
          anchor.classList.remove('sehua-failed');
          const btn = anchor.querySelector('.sehua-retry');
          if (btn) btn.remove();
          return;
        }
        done(false, 'ok');
      } else {
        onError();   // load 了但宽度为 0 = 坏图，按错误走重试链
      }
    });
    img.addEventListener('error', onError);

    if (!manual) thumbProgress.add(1);
    // 命中图级失败记忆：直接跳过（manual 模式已在 manualRetry 里赦免，强行放行）
    // 这里不查 deadHosts：图床闸门只负责「本次页面加载内」不再重复试探，跨刷新一律靠图级表，
    // 这样用户清掉 sehuaBadImages 就一定能恢复尝试。
    if (!manual && (badImages.has(url) || slowImages.has(url))) { done(true, 'skip'); return; }
    queueAttempt();
  }

  // 失败兜底：暗色占位 + 角标重试按钮（不再删锚点——图格宽度不变，列表不跳布局）
  function markFailedAnchor(anchor, url, wrap) {
    anchor.classList.add('sehua-failed');
    const img = anchor.querySelector('img');
    if (img) img.removeAttribute('src');   // 去裂图图标，留一块干净的灰
    if (anchor.querySelector('.sehua-retry')) return;
    const btn = document.createElement('span');
    btn.className = 'sehua-retry';
    btn.textContent = '↻';
    btn.title = '重试这张图';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // 否则会顺着 anchor 跳详情页
      const cur = anchor.querySelector('img');
      if (!cur) return;
      manualRetry(cur, url, anchor, wrap);
    });
    anchor.appendChild(btn);
  }

  // 手动重试：先赦免失败记忆（不清就会被记忆检查自己挡回来），换一张干净 img 重发。
  // 换节点是因为失败态 img 是 complete=true/naturalWidth=0，且旧监听还挂在上面
  function manualRetry(img, url, anchor, wrap) {
    const origin = imageOrigin(url);
    forgetImage(url);
    forgetHost(origin);
    hostFailStreak.delete(origin);   // 只解封不清 streak 的话，残留 ≥3 会让紧接着一次真失败又秒判死
    anchor.classList.remove('sehua-failed');
    const oldBtn = anchor.querySelector('.sehua-retry');
    if (oldBtn) oldBtn.remove();

    const fresh = document.createElement('img');
    fresh.decoding = 'async';
    fresh.loading = 'eager';
    anchor.replaceChild(fresh, img);

    loadThumb(fresh, url, anchor, wrap, true);
  }

  // 建缩略图容器并同步开始加载全部图片
  function createThumbWrap(tid, urls, highPriority) {
    const wrap = document.createElement('div');
    wrap.className = 'sehua-thumb';
    const shown = urls.slice(0, MAX_THUMBS_PER_POST);
    wrap.style.setProperty('--img-width', thumbWidthRule(shown.length));
    const href = `https://${location.hostname}/thread-${tid}-1-1.html`;

    shown.forEach((url, idx) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';

      const img = document.createElement('img');
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = (highPriority && idx === 0) ? 'high' : BELOW_FOLD_PRIORITY;

      anchor.appendChild(img);
      wrap.appendChild(anchor);

      loadThumb(img, url, anchor, wrap);
    });

    return wrap;
  }

  // 行顶距视口底部在 FOLD_SLACK_PX 内即视为首屏
  function isAboveFold(tbody) {
    return !!tbody && tbody.getBoundingClientRect().top < window.innerHeight + FOLD_SLACK_PX;
  }

  // 往一个帖子行注入缩略图
  function injectThumb(tr, thumbMap, highPriority) {
    const th = tr.querySelector('th');
    const tbody = tr.closest('tbody');
    const tid = tbody && tbody.id ? (tbody.id.match(/\d+/) || [])[0] : null;
    if (tid && thumbMap[tid] && th && !th.querySelector('.sehua-thumb')) {
      th.appendChild(createThumbWrap(tid, thumbMap[tid], highPriority));
    }
  }

  // 处理单个帖子行：搬日期 + 注入缩略图 + 单列化
  function processRow(tr, thumbMap) {
    if (!tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]')) return;
    const th = tr.querySelector('th');
    const tbody = tr.closest('tbody');
    const firstBy = tr.querySelector('td.by');

    // 把发帖时间从 td.by 挪到标题下方
    if (th && firstBy) {
      const em = firstBy.querySelector('em');
      if (em) {
        let target = th.querySelector('.tps');
        if (!target) {
          target = document.createElement('span');
          target.className = 'sehua-date';
          th.appendChild(target);
        }
        em.style.marginLeft = '8px';
        target.appendChild(em);
      }
    }

    injectThumb(tr, thumbMap, isAboveFold(tbody));
    tr.querySelectorAll('td').forEach(td => td.remove());
  }

  function processTable(thumbMap) {
    let injected = 0, moved = 0, high = 0;
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const th = tr.querySelector('th');
      const hadThumb = !!(th && th.querySelector('.sehua-thumb'));
      const hadDate = !!(th && th.querySelector('.tps em, .sehua-date em'));

      processRow(tr, thumbMap);

      if (!hadThumb && th && th.querySelector('.sehua-thumb')) {
        injected++;
        high += th.querySelectorAll('.sehua-thumb img[fetchpriority="high"]').length;
      }
      if (!hadDate && th && th.querySelector('.tps em, .sehua-date em')) moved++;
    });
    log(`注入 ${injected} 个帖子的缩略图（${high} 张首屏图用 high 优先级），搬移 ${moved} 个日期`);
  }

  // 把分页按钮还原成普通链接（点击即整页跳转）
  function restoreRealPagination() {
    const btn = document.getElementById('autopbn');
    if (!btn) return;
    const next = btn.getAttribute('rel');
    if (!next) return;
    btn.onclick = null;
    btn.setAttribute('href', next);
  }

  // 详情图到手后的统一收尾：预连接图床 + 注入缩略图
  function attachDetailThumbs(container, foldEl, tid, urls) {
    preconnectUrlList(urls);
    if (urls.length === 0 || container.querySelector('.sehua-thumb')) return;
    container.appendChild(createThumbWrap(tid, urls, isAboveFold(foldEl)));
  }

  // 移动版没给出缩略图的帖子，逐个回详情页取
  async function loadFallbackThumbs(tbodies) {
    const pool = new ConcurrencyPool(MAX_CONCURRENT);
    const tasks = tbodies.map(tb => pool.add(async () => {
      const th = tb.querySelector('th');
      const tid = tb.id?.match(/\d+/)?.[0];
      if (!tid || !th || th.querySelector('.sehua-thumb')) return;
      const urls = await fetchDetailImages(tid);
      if (urls === null) return;
      attachDetailThumbs(th, tb, tid, urls);
    }));
    await Promise.all(tasks);
  }

  // ============================ 搜索页 ============================

  function loadFilterState() {
    try {
      return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveFilterState() {
    const state = {};
    document.querySelectorAll('.sehua-forum-switch input[type=checkbox]').forEach(cb => {
      state[cb.dataset.forum] = cb.checked;
    });
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('[色花堂缩略图] 保存过滤状态失败:', e);
    }
  }

  // 添加栏目过滤开关
  function addForumSwitches() {
    const sttl = document.querySelector('.sttl.mbn');
    if (!sttl) return null;
    sttl.style.display = 'flex';
    sttl.style.alignItems = 'center';
    sttl.style.justifyContent = 'space-between';
    sttl.style.flexWrap = 'wrap';
    sttl.style.gap = '8px';

    const switchWrap = document.createElement('div');
    switchWrap.style.cssText = 'display:flex; gap:12px; align-items:center; font-size:12px;';
    const savedState = loadFilterState();
    BLOCK_FORUMS.forEach(name => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:4px; cursor:pointer; user-select:none;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = savedState[name] ?? true;
      cb.dataset.forum = name;
      const span = document.createElement('span');
      span.textContent = '隐藏' + name;
      label.appendChild(cb);
      label.appendChild(span);
      switchWrap.appendChild(label);
    });
    sttl.appendChild(switchWrap);
    return switchWrap;
  }

  function applyFilter() {
    const hidden = {};
    document.querySelectorAll('.sehua-forum-switch input[type=checkbox]').forEach(cb => {
      if (cb.checked) hidden[cb.dataset.forum] = true;
    });
    document.querySelectorAll('#threadlist li.pbw').forEach(li => {
      const fl = li.querySelector('a[href*=forum-]');
      const forumName = fl ? fl.textContent.trim() : '';
      li.style.display = hidden[forumName] ? 'none' : '';
    });
  }

  let loadingThumbs = false;
  let pendingReload = false;

  // 只对可见（未被栏目过滤掉）的结果取详情图
  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }
    loadingThumbs = true;
    try {
      const targets = Array.from(document.querySelectorAll('#threadlist li.pbw'))
        .filter(li => li.style.display !== 'none'
          && !li.querySelector('.sehua-thumb')
          && !li.dataset.sehuaChecked);
      log(`搜索页加载 ${targets.length} 个可见帖子的详情图（并发${MAX_CONCURRENT}）`);

      const pool = new ConcurrencyPool(MAX_CONCURRENT);
      const tasks = targets.map(li => pool.add(async () => {
        const tid = (li.id || '').match(/\d+/)?.[0];
        if (!tid) return;
        const loading = document.createElement('div');
        loading.className = 'sehua-loading';
        loading.textContent = '加载中...';
        li.appendChild(loading);
        try {
          const urls = await fetchDetailImages(tid);
          loading.remove();
          if (urls === null) return;
          li.dataset.sehuaChecked = '1';
          attachDetailThumbs(li, li, tid, urls);
        } catch (e) {
          loading.remove();
        }
      }));
      await Promise.all(tasks);
    } finally {
      loadingThumbs = false;
      if (pendingReload) {
        pendingReload = false;
        loadDetailThumbs();
      }
    }
  }

  async function searchPageMain() {
    addStyle(`
      ${THUMB_PAGE_CSS}
      div.sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }
      .slst.mtw { width: 100% !important; }
    `);

    removeUnused();

    // 空结果页（没有结果项）直接退出
    if (!document.querySelector('#threadlist li.pbw')) {
      log('搜索页没有结果项，跳过开关与取图');
      return;
    }

    const switchWrap = addForumSwitches();
    if (!switchWrap) {
      log('未找到 .sttl.mbn，跳过搜索页处理');
      return;
    }
    switchWrap.classList.add('sehua-forum-switch');

    switchWrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        applyFilter();
        saveFilterState();
        loadDetailThumbs();
      });
    });

    applyFilter();
    await loadDetailThumbs();
  }

  // 检测"搜索繁忙"并自动刷新
  function autoReloadOnSearchBusy() {
    if (location.pathname.indexOf('/search.php') === -1) {
      sessionStorage.removeItem(BUSY_RETRY_KEY);
      return false;
    }
    const box = document.getElementById('messagetext') || document.querySelector('.alert_error, .alert_info');
    const text = box ? box.textContent : '';
    if (!text || text.indexOf('搜索繁忙') === -1) {
      sessionStorage.removeItem(BUSY_RETRY_KEY);
      return false;
    }

    const retryCount = parseInt(sessionStorage.getItem(BUSY_RETRY_KEY) || '0', 10);
    if (retryCount >= MAX_BUSY_RETRY) {
      console.warn(`[色花堂缩略图] 搜索繁忙已重试 ${retryCount} 次，停止自动刷新`);
      sessionStorage.removeItem(BUSY_RETRY_KEY);
      return false;
    }
    sessionStorage.setItem(BUSY_RETRY_KEY, String(retryCount + 1));
    log(`检测到"搜索繁忙"（第${retryCount + 1}次），4 秒后自动刷新`);

    addStyle(PAGE_CSS);

    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.8); color:#fff; padding:16px 24px; border-radius:8px; font-size:14px; z-index:99999; text-align:center; box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    let count = 4;
    tip.textContent = `检测到"搜索繁忙"（第${retryCount + 1}/${MAX_BUSY_RETRY}次），${count} 秒后自动刷新...`;
    document.body.appendChild(tip);
    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        tip.textContent = `检测到"搜索繁忙"（第${retryCount + 1}/${MAX_BUSY_RETRY}次），${count} 秒后自动刷新...`;
      } else {
        clearInterval(timer);
        tip.textContent = '正在刷新...';
        location.reload();
      }
    }, 1000);
    return true;
  }

  // ============================ 详情页 / 首页 ============================

  // 单张正文图：占位符换成真地址，打上 lazyloaded 标记；有改动返回 true
  function fixLazyImg(img) {
    let touched = false;
    const real = img.getAttribute('file');
    const cur = img.getAttribute('src');
    if (real && (!cur || isPlaceholder(cur))) { img.setAttribute('src', real); touched = true; }
    if (!img.getAttribute('lazyloaded')) { img.setAttribute('lazyloaded', 'true'); touched = true; }
    return touched;
  }

  // 详情页：掐掉站点自己的滚动补图。折叠楼层是滚动/交互时才插图，补个观察者兜底
  function disableSiteLazyLoad() {
    let fixed = 0;
    document.querySelectorAll('#postlist img[file]').forEach(img => {
      if (fixLazyImg(img)) fixed++;
    });
    if (fixed) log(`正文图：${fixed} 张从占位符换成真地址/打上 lazyloaded`);

    const postlist = document.getElementById('postlist');
    if (!postlist || postlist.__sehuaImgObserver) return;
    const observer = new MutationObserver(mutations => {
      let added = 0;
      mutations.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('img[file]') && fixLazyImg(node)) added++;
        if (node.querySelectorAll) {
          node.querySelectorAll('img[file]').forEach(img => {
            if (fixLazyImg(img)) added++;
          });
        }
      }));
      if (added) log(`正文图（新增节点）：${added} 张补齐`);
    });
    observer.observe(postlist, { childList: true, subtree: true });
    postlist.__sehuaImgObserver = observer;
  }

  function detailPageMain() {
    log('详情页模式');
    if (!document.getElementById('postlist')) {
      log('页面无帖子正文，跳过详情页处理');
      return;
    }
    addStyle(`
      ${PAGE_CSS}
      #postlist { width: 100% !important; }
      #postlist ignore_js_op { text-align: center; }
      #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; }
    `);
    removeUnused();
    disableSiteLazyLoad();
  }

  function homePageMain() {
    log('首页模式');
    addStyle(PAGE_CSS);
    removeUnused();
  }

  // ============================ 列表页 ============================

  async function listPageMain() {
    const { fid, page } = getPageInfo();
    if (!fid) {
      log('非列表页，跳过');
      return;
    }

    // 年龄门页面（无帖子表格）直接退出
    if (!document.getElementById('threadlisttableid')) {
      log('页面无帖子表格，跳过列表页处理');
      return;
    }

    injectListStyles();
    removeUnused();
    restoreRealPagination();
    window.addEventListener('load', restoreRealPagination, { once: true });

    log(`请求移动版: forum-${fid}-${page}.html?mobile=2`);
    let result = earlyListFetch ? await earlyListFetch : null;
    if (!mobileResultOk(result)) {
      log('抢跑请求无效，改为带重试获取');
      result = await fetchMobileThumbsByPage(fid, page, true);
    }
    const mapping = (result && result.mapping) || {};
    const fallbackTids = (result && result.fallbackTids) || [];
    log(`获取到 ${Object.keys(mapping).length} 个帖子的缩略图，${fallbackTids.length} 个需从详情页加载`);

    preconnectImageHosts(mapping);
    processTable(mapping);
    prefetchNextPageMapping(fid, page);

    if (fallbackTids.length > 0) {
      const fallbackBatch = Array.from(document.querySelectorAll('#threadlisttableid tbody[id^=normalthread_], #threadlisttableid tbody[id^=stickthread_]'))
        .filter(tb => {
          const tid = tb.id?.match(/\d+/)?.[0];
          return tid && fallbackTids.includes(tid);
        });
      if (fallbackBatch.length > 0) {
        loadFallbackThumbs(fallbackBatch).catch(e => log('回捞详情图异常', e));
      }
    }
  }

  // ============================ 入口 ============================

  const earlyPageInfo = getPageInfo();
  let earlyListFetch = null;

  loadFailureMemory();
  preconnectLearnedHosts();

  // document-start 阶段：先发出移动版请求抢跑
  if (earlyPageInfo.fid) {
    earlyListFetch = fetchMobileThumbsByPage(earlyPageInfo.fid, earlyPageInfo.page, false);
    earlyListFetch.then(result => {
      if (mobileResultOk(result)) preconnectImageHosts(result.mapping);
    }).catch(err => {
      console.warn('[色花堂缩略图] 抢跑请求异常，忽略:', err);
    });
  }

  async function onDomReady() {
    try {
      if (autoReloadOnSearchBusy()) return;

      if (location.pathname.indexOf('/search.php') !== -1) {
        log('搜索页模式');
        await searchPageMain();
        return;
      }

      if (location.pathname.indexOf('/thread-') !== -1 || location.search.indexOf('mod=viewthread') !== -1) {
        detailPageMain();
        return;
      }

      if (location.pathname.indexOf('/forum.php') !== -1 && !location.search) {
        homePageMain();
        return;
      }

      await listPageMain();
    } catch (e) {
      console.error('[色花堂缩略图] 初始化失败:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  } else {
    onDomReady();
  }
})();

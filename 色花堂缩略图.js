// ==UserScript==
// @name         色花堂缩略图
// @namespace    http://98tang.com/
// @version      3.3
// @description  PC列表页从移动版触屏模板取缩略图，页面打开时一次性全部加载（无懒加载、无滚动触发、无按需加载），宽屏单列布局 + 加载进度提示 + 失败自动重试；搜索页栏目过滤与详情图加载；详情页宽屏去广告；搜索繁忙自动刷新。
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

  // 版本号，与头部 @version 保持一致。运行时写到 <html data-sehua="..."> 上，
  // 用于随时确认浏览器里实际加载的是哪一版（改了文件但没重新导入时一眼可见）
  const VERSION = '3.3';

  // 服务端只凭请求头 User-Agent 分发模板，这是整个缩略图方案成立的唯一开关。
  // 不能用"浏览器伪装 UA 直接访问"代替：触屏模板自带的 JS 会用 "ontouchend" in document 判定后
  // 跳回 forum.php?mobile=1，桌面浏览器拿不到触屏模板。只有不执行 JS 的 XHR 才稳定。
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

  // GM 请求超时（毫秒）
  const REQUEST_TIMEOUT = 15000;

  // 详情页取图的并发上限
  const MAX_CONCURRENT = 5;

  // 搜索繁忙自动刷新的次数上限（超过则停止刷新，避免无限循环）
  const MAX_BUSY_RETRY = 5;

  // 从详情页回捞时单帖最多取几张图
  const MAX_DETAIL_IMGS = 5;

  // 每个帖子最多注入几张缩略图。触屏模板每卡给 2~3 张，5 只是防御性封顶；
  // 版式由 createThumbWrap 按实际张数计算，改这个值不需要同步改样式。
  // ⚠️ 必须 ≥ 1：设为 0 会让每行都插入一个没有图片的空容器，白留一段 margin
  const MAX_THUMBS_PER_POST = 5;

  // 移动版映射请求失败后的重试次数与退避间隔
  const MOBILE_RETRY_TIMES = 2;
  const MOBILE_RETRY_DELAY = 1500;

  // 预取下一页的移动版映射。
  // 映射请求（约 184KB）是每页唯一的大块固定等待：它到达之前，一张缩略图都不能开始请求。
  // "下一页"已被还原成整页跳转，所以完全可以在用户读当前页时把下一页的映射先准备好，
  // 翻过去时缩略图在 DOM 就绪那一刻就能开始请求。代价是每页多约 184KB（约为整页图片量的 1.4%）。
  // 预取用 allowRetry=false：失败不缓存也不重试，真正翻到那一页时自会走带重试的正常流程。
  const PREFETCH_NEXT_PAGE = true;

  // 预取延后多久发出：等当前页的图片请求已经铺开后再发，避免与首波图片抢站点连接
  const PREFETCH_DELAY_MS = 3000;

  // 详情页请求被反爬拦截后的退避重试：间隔 = 基数 + 第几次 x 基数（2s / 4s）
  const DETAIL_RETRY_TIMES = 3;
  const DETAIL_RETRY_BASE_MS = 2000;

  // 单张缩略图加载失败后的重试次数与退避基数（间隔 = 基数 x 第几次，另加随机抖动）
  const IMG_RETRY_TIMES = 2;
  const IMG_RETRY_BASE_MS = 800;

  // 单张图片的总等待上限，跨所有重试共享这一个预算。
  // 快失败（DNS 失败、连接被拒、404）几乎不占预算，重试照常生效；
  // 而图床无响应时最多耗掉这一个预算就放弃，不会因为重试次数把一张死图拖成好几份超时。
  // 值不能太小：实测（2026-10-08）浏览器**首次**连该图床要 25 秒以上 —— 图床宣告
  // alt-svc: h3，Chrome 先试 QUIC，被代理挡住后要等握手超时才回落 TCP，而 curl 同一
  // 时刻只要 0.86s。连接一旦建立，32 并发整批只要 799ms。预算若压在这个冷连接时间附近，
  // 一次慢启动就会把整页图判成超时（实测 60 张里 29 张被这样丢掉）。
  const IMG_TOTAL_WAIT_MS = 45000;

  // 同一图床的**硬失败**（浏览器派发了 error 事件：DNS 失败、连接被拒、HTTP 错误）连续达到此次数，
  // 即判定该域名不可达，此后该域名尚未开始的图片直接判失败。
  // 只统计硬失败，**超时不算**——超时是"慢"，把它算进来会把一次冷启动抖动放大成整个域名被判死。
  // 任意一次成功都会清零计数。
  const HOST_FAIL_THRESHOLD = 3;

  // ============ 失败记忆 ============
  // 成功图片不需要脚本操心：图床自带 Cache-Control: max-age=2592000（30 天），
  // 刷新或重开页面都直接命中浏览器 HTTP 缓存，不会重新下载。
  // 需要记住的是**失败**：站点里确实存在已失效的图床（qpic.ws、imgpile.com）和已删除的附件，
  // 它们每次都要把"重试 + 等待预算"走满才被移除，刷新一次就重来一次。
  // 下面两项把失败结论存进 localStorage，TTL 之内直接跳过：不再发请求，也不再占用发送窗口。
  // 图床文件名带内容哈希，图片被替换后地址也会变，所以"跳过旧地址"不会误伤修复后的图。
  // TTL 取得保守：超时只是"慢"的弱证据，记住太久会让一次网络抖动变成长时间的缺图。
  // 5 分钟的取舍：短时间内反复刷新不会把已知失败的图重试一遍；链路恢复 5 分钟后自动重试。
  // 图床级记录另有自愈——该域名只要有一张图加载成功，失效记录立刻被清掉。
  const BAD_IMAGE_KEY = 'sehuaBadImages';
  const BAD_IMAGE_TTL = 5 * 60 * 1000;     // 单张失败图的记忆时长
  const BAD_IMAGE_MAX = 300;
  // 超时是"弱证据"，单独一张表 + 短 TTL。
  // 实测教训：浏览器首次连图床要 25 秒以上，预算没压住时整页图会被判成超时；若再用
  // 5 分钟去记这些超时，一次慢启动就会让整页图在接下来 5 分钟里被直接跳过 ——
  // 用户看到的是"图怎么没了"。60 秒只够挡住"刷新后立刻再试一遍"，不至于长时间缺图。
  const SLOW_IMAGE_KEY = 'sehuaSlowImages';
  const SLOW_IMAGE_TTL = 60 * 1000;
  const SLOW_IMAGE_MAX = 300;
  const DEAD_HOST_KEY = 'sehuaDeadHosts';
  const DEAD_HOST_TTL = 10 * 60 * 1000;    // 失效图床的记忆时长（判死影响面更大，所以更短）
  const DEAD_HOST_MAX = 16;

  // 同时在途的缩略图请求数上限（0 = 不限制）。
  // 一页 60 张全部压给同一个图床，会把浏览器与代理的连接池排成 60 层队列：任何一张卡住都会
  // 连带拖住后面所有图。这里按 DOM 顺序维护滑动窗口，在途数不超过此值、每张结算后立刻补下一张。
  // "打开即全部加载"不变，只是把发送节奏铺平，避免个别慢请求造成整页停摆。
  const MAX_IMG_IN_FLIGHT = 16;

  // 首屏判定余量：行顶距视口底部在此范围内的帖子，其首张缩略图用 high 优先级先取
  const FOLD_SLACK_PX = 120;

  // 非首屏缩略图的优先级。全量加载下这是唯一的排序手段：'auto' 交给浏览器排队，
  // 想让缩略图压过页面其余资源（广告图等）就改成 'high'
  const BELOW_FOLD_PRIORITY = 'auto';

  // 缩略图之间的间距（必须与 --img-width 的计算一致）
  const THUMB_GAP_PX = 8;

  // 进度提示在全部图片结算后延迟多久消失
  const PROGRESS_HIDE_DELAY = 2500;

  // 搜索页要过滤（默认隐藏）的栏目
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];

  // 过滤开关状态的 localStorage 键名
  const FILTER_STORAGE_KEY = 'sehuaFilterState';

  // 搜索繁忙重试计数的 sessionStorage 键名
  const BUSY_RETRY_KEY = 'sehuaBusyRetry';

  // 解析 HTML 取图片真实地址时依次探测的属性。顺序不可调换：详情页的 file 是小图、
  // zoomfile 是原图；触屏模板用 data-original。
  // 刻意不含 zsrc —— 触屏模板的 zsrc 存的是 1x1 占位图，排进来会取到空图。
  const IMG_SRC_ATTRS = ['file', 'zoomfile', 'data-original'];

  // 站内装饰图特征串：静态图标、用户头像、Discuz 空图占位。用于把它们排除在缩略图之外
  const PLACEHOLDER_MARKERS = ['static/image', 'uc_server', 'none.gif'];

  // 运行日志开关（排查时改成 true）
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[色花堂缩略图]', ...args); };

  // ============================ 工具函数 ============================

  function isPlaceholder(url) {
    return PLACEHOLDER_MARKERS.some(marker => url.indexOf(marker) !== -1);
  }

  // 归一化成 http(s) 绝对地址：协议相对（//host/a.jpg）与相对路径都还原。
  // 只判 startsWith('http') 会把这两类静默丢弃，表现为整页缩略图消失
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

  // 当前页面的论坛 ID 与页码，兼容 /forum-103-1.html 与 /forum.php?mod=forumdisplay&fid=103&page=1
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
      // 用 while 而非 if：被唤醒后需重新检查，避免并发数瞬间超限
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
  //
  // 站点是 Discuz! X3.4 + n5 触屏模板。带 Android UA 请求 forum-{fid}-{page}.html 时服务端返回触屏
  // 模板 HTML，每个帖子卡片是 <div class="n5_htmk">，缩略图真实地址在 <img data-original="...">。
  // 资源图（/uc_server/ 头像、static/image/ 图标）由 getRealSrc 的 PLACEHOLDER_MARKERS 过滤掉。
  //
  // 反爬依赖浏览器会话 Cookie（_safe）：不带它的请求只会收到 safeid JS 挑战页（isSafePage 可检测）。
  // Tampermonkey 发 GM 请求时会自动带上目标域名的浏览器 Cookie，headers 里显式写的
  // Cookie: mobile=2 会被 TM 合并到浏览器 Cookie 之后，不会覆盖掉 _safe。
  // document-start 抢跑时 _safe 可能尚未建立（首次访问、浏览器重启后），那一次必然拿到门页，
  // DOM 就绪后的带重试流程会补上。
  //
  // mobile=2 是 URL 与 Cookie 的双保险，强制 Discuz 走触屏版（=2）而不是纯文字的标准手机版（=1）。
  //
  // 置顶帖在移动版顶部是纯文字列表，其卡片没有 a[href*=viewthread]，会被解析逻辑跳过，
  // 因此 PC 列表的置顶行不会注入缩略图。这是预期行为。
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
          // UA 决定服务端返回哪套模板；Cookie 的 mobile=2 与 TM 自动附带的浏览器 Cookie 合并后发出
          'User-Agent': MOBILE_UA,
          'Cookie': 'mobile=2'
        },
        onload: function(resp) {
          try {
            const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
            const cards = doc.querySelectorAll('.n5_htmk');
            if (cards.length === 0) {
              // 空结果要区分根因：反爬拦截页 vs 自定义 UA 头未生效而拿到 PC 版
              if (isSafePage(resp.responseText)) {
                console.warn('[色花堂缩略图] 移动版请求被 safe 挑战页挡下（首访或浏览器重启后 _safe 尚未建立时属预期，DOM 就绪后会带重试重取）:', url);
              } else {
                console.warn('[色花堂缩略图] 未找到移动版结构(.n5_htmk)，可能自定义 User-Agent 头未生效而拿到了 PC 版页面');
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

  // 一次移动版请求是否解出有效内容（拦截页与空响应都算无效）
  function mobileResultOk(result) {
    if (!result) return false;
    return Object.keys(result.mapping || {}).length > 0 || (result.fallbackTids || []).length > 0;
  }

  // 带自动重试的获取：瞬时网络抖动或反爬拦截页不应导致整页无图
  function fetchMobileThumbsWithRetry(fid, page, left = MOBILE_RETRY_TIMES) {
    return fetchMobileThumbs(fid, page).then(result => {
      if (mobileResultOk(result) || left <= 0) return result;
      return new Promise(resolve => setTimeout(() => {
        fetchMobileThumbsWithRetry(fid, page, left - 1).then(resolve);
      }, MOBILE_RETRY_DELAY));
    });
  }

  // ============ 移动版映射缓存 ============
  // 页面 DOM 就绪早于映射到达，这段等待是首图关键路径上最大的一块。帖子列表变动不快，
  // 会话内复用同一页的映射足够安全。
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
      // 按时间戳淘汰最旧的一条。不能按对象键顺序淘汰：覆盖写入已存在的键不会改变它原来的位置，
      // 那样会把刚刚更新的条目当成最旧的删掉。
      const keys = Object.keys(all);
      if (keys.length > PAGE_CACHE_MAX) {
        keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0))
          .slice(0, keys.length - PAGE_CACHE_MAX)
          .forEach(k => { delete all[k]; });
      }
      sessionStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // 取某一页的移动版缩略图映射。
  // allowRetry=false 用于 document-start 的抢跑：只发一次，不与页面加载争资源，失败结果不写缓存
  function fetchMobileThumbsByPage(fid, page, allowRetry = true) {
    const key = fid + '_' + page;   // 缓存键带 fid，避免跨版块同页码串缓存
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    const persisted = readPageCache(key);
    if (persisted) { thumbCache[key] = persisted; return Promise.resolve(persisted); }
    if (pendingPages[key]) return pendingPages[key];
    const fetchPromise = (allowRetry ? fetchMobileThumbsWithRetry(fid, page) : fetchMobileThumbs(fid, page))
      .then(result => {
        // 只缓存有效结果：拦截页与空响应不缓存，下次还能重试
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

  // 预取下一页的映射（见 PREFETCH_NEXT_PAGE 处的说明）
  function prefetchNextPageMapping(fid, page) {
    if (!PREFETCH_NEXT_PAGE) return;
    setTimeout(() => {
      fetchMobileThumbsByPage(fid, page + 1, false).catch(() => {});
    }, PREFETCH_DELAY_MS);
  }

  // ============ 缩略图图床的预连接 ============
  // 图床与站点不同源，首个缩略图必须新开一次 DNS+TCP+TLS，而该域名一旦出现就长期稳定。
  // 把域名记在 localStorage 里，之后任何页面在 document-start 就能先建连，把握手挪进
  // "等待移动版映射"的那段窗口；等拿到映射再连等于与图片请求同时起跑，收益很小。
  // 不要加 crossorigin：缩略图是普通 <img>（非 CORS 请求），加了反而会多建一条连接。
  const IMG_HOST_KEY = 'sehuaImgHosts';
  const IMG_HOST_MAX = 4;

  // 挂一条 preconnect。document-start 时 <head>/<html> 可能都还没建立，短暂重试即可
  function preconnectHost(origin, tries = 0) {
    if (!origin || origin === location.origin) return;
    if (deadHosts.has(origin)) return;   // 失败记忆里已判定不可达，就别再白握手一次
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (tries < 10) setTimeout(() => preconnectHost(origin, tries + 1), 20);
      else console.warn('[色花堂缩略图] preconnect 放弃（DOM 尚未建立）:', origin);
      return;
    }
    if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    parent.appendChild(link);
  }

  // 收集一组图片地址里的图床域名（排除站点自身）：立即预连接，同时记入 localStorage 供下次提前连
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
      // 已判不可达的域名不写进名单：IMG_HOST_MAX 只有 4 条，实测搜索页会同时产出
      // qpic.ws / imgpile.com 两个死域名，它们一占位就会把健康域名挤出 document-start 预连接
      const merged = [...new Set([...hosts, ...prev])].filter(h => !deadHosts.has(h));
      localStorage.setItem(IMG_HOST_KEY, JSON.stringify(merged.slice(0, IMG_HOST_MAX)));
    } catch (e) {}
  }

  // document-start 调用：用上次学到的图床域名抢先握手（首次访问时列表为空，无副作用）
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

  // ============ 详情页取图（移动版没给出缩略图时的回捞，也是搜索页取图来源） ============

  // 站点反爬拦截页（safeid 挑战页，纯 XHR 无法通过）
  function isSafePage(text) {
    return typeof text === 'string' && text.indexOf('safeid') !== -1;
  }

  // 从详情页取图片；被拦截或重试耗尽返回 null（区别于"帖子确实无图"的 []）
  // 选择器只覆盖正文容器（.t_f / .pcb / .message），签名档与表情图会被 PLACEHOLDER_MARKERS 过滤
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
              // 返回 null 而不是 []：[] 的含义是"这帖确实没图"，会被上层标记为已处理、
              // 从此不再重试；解析异常属于偶发失败，必须走"可重试"的那条路
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

  const WIDE_CSS = `
    .wp { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #nv { width: 100% !important; left: 0 !important; right: 0 !important; }
  `;

  const PAGE_CSS = `
    ${WIDE_CSS}
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
  `;

  // 缩略图版式。--img-width 由 createThumbWrap 按该帖张数写入，CSS 只提供 1 张时的默认值，
  // 因此增删每帖张数不需要同步改样式表。
  const THUMB_CSS = `
    .sehua-thumb { --img-width: 50%; display: flex; flex-wrap: wrap; justify-content: center; gap: ${THUMB_GAP_PX}px; margin-top: 8px; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; transition: border-color 0.2s ease; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; text-decoration: none; width: var(--img-width) !important; }
    .sehua-thumb img:hover { border-color: #4a90d9; }
    .sehua-date { display: inline-block; margin-top: 4px; font-size: 12px; color: #999; }
  `;

  const PROGRESS_CSS = `
    #sehua-progress { position: fixed; right: 14px; bottom: 14px; z-index: 99999; padding: 7px 14px; border-radius: 999px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 12px; line-height: 1.4; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: opacity 0.3s ease; pointer-events: none; }
    #sehua-progress.sehua-done { background: rgba(35, 120, 60, 0.85); }
    #sehua-progress.sehua-partial { background: rgba(150, 70, 20, 0.88); }
  `;

  // 需要缩略图的页面（列表页 / 检索页）共用的样式前缀
  const THUMB_PAGE_CSS = `${PAGE_CSS}${THUMB_CSS}${PROGRESS_CSS}`;

  function addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 删除无用元素与站内广告
  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    // 表格里不属于帖子的行整块移除：公告行、空表头行（separatorline）、表格内的博彩广告行。
    // 只按 id 前缀判定，并给含分页的行留一条后路，避免模板改动时误删导航
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
  // 全量加载时用户需要知道"还剩多少没出来"。计数由 createThumbWrap 注册、每张图的
  // 结算（成功/最终失败）回报一次；全部结算后延迟消失，期间若又有新图注册则推迟。
  const thumbProgress = {
    total: 0, settled: 0, failed: 0, el: null, timer: null, removeTimer: null,

    add(count) {
      this.total += count;
      clearTimeout(this.timer);
      // 必须连同淡出后的移除定时器一起取消，并把透明度复位：
      // mount() 只要看到元素还 connected 就会复用它，若不移除那个 400ms 定时器，
      // 新注册的进度会写进一个全透明、且马上要被删掉的元素里 —— 用户什么都看不到
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

  // 图片发送窗口：见 MAX_IMG_IN_FLIGHT 的说明
  const imgQueue = [];
  let imgInFlight = 0;

  // 图床健康度：见 HOST_FAIL_THRESHOLD 的说明
  const hostFailStreak = new Map();
  const deadHosts = new Set();

  // 失败记忆：见 BAD_IMAGE_KEY 处的说明
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

  // 超过上限时丢掉最早的一条，并同步内存集合
  function trimStamps(stamps, set, max, key) {
    const keys = Object.keys(stamps);
    if (keys.length > max) {
      keys.sort((a, b) => stamps[a] - stamps[b])
        .slice(0, keys.length - max)
        .forEach(k => { delete stamps[k]; set.delete(k); });
    }
    writeStampTable(key, stamps);
  }

  // soft=true 表示只是"超时/慢"，用短 TTL 的表；否则按硬失败记 5 分钟
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

  // 图床恢复可用（该域名有图加载成功）时立刻忘掉它，别让失效记录一直生效
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

  // 把某个域名从预连接名单里剔除（判死时调用），腾出 IMG_HOST_MAX 的位子给健康域名
  function dropPreconnectHost(origin) {
    try {
      const prev = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]');
      const next = prev.filter(h => h !== origin);
      if (next.length !== prev.length) localStorage.setItem(IMG_HOST_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  // 启动时把 TTL 内的失败记录读回来
  function loadFailureMemory() {
    const bad = readStampTable(BAD_IMAGE_KEY, BAD_IMAGE_TTL);
    Object.assign(badImageStamps, bad);
    Object.keys(bad).forEach(k => badImages.add(k));

    const hosts = readStampTable(DEAD_HOST_KEY, DEAD_HOST_TTL);
    Object.assign(deadHostStamps, hosts);
    Object.keys(hosts).forEach(k => deadHosts.add(k));

    const slow = readStampTable(SLOW_IMAGE_KEY, SLOW_IMAGE_TTL);
    Object.assign(slowImageStamps, slow);
    Object.keys(slow).forEach(k => slowImages.add(k));
  }

  function imageOrigin(url) {
    try { return new URL(url, location.origin).origin; } catch (e) { return null; }
  }

  // 图床健康度记账：outcome 为 'ok'（成功，清零）或 'hard'（硬失败，累加）。
  // 超时不上报，见 HOST_FAIL_THRESHOLD 的说明
  function trackHostResult(origin, outcome) {
    if (!origin) return;
    if (outcome === 'ok') {
      hostFailStreak.delete(origin);
      forgetHost(origin);
      return;
    }
    const streak = (hostFailStreak.get(origin) || 0) + 1;
    hostFailStreak.set(origin, streak);
    if (streak >= HOST_FAIL_THRESHOLD) rememberDeadHost(origin);
  }

  function pumpImgQueue() {
    while (imgQueue.length > 0 && (MAX_IMG_IN_FLIGHT <= 0 || imgInFlight < MAX_IMG_IN_FLIGHT)) {
      imgQueue.shift()();
    }
  }

  // 该帖张数决定的单张宽度：1 张 50%、2 张 40%（与触屏模板的封面比例一致）、3 张以上等分整行
  function thumbWidthRule(count) {
    if (count <= 1) return '50%';
    if (count === 2) return '40%';
    return `calc((100% - ${(count - 1) * THUMB_GAP_PX}px) / ${count})`;
  }

  // 加载一张缩略图。
  // 窗口位是"按次"持有的：每次尝试结束后先让出窗口位，重试再重新排队到队尾。
  // 这样一张慢图的多次重试不会一直霸占窗口，后面的图能先走完；等连接变暖后慢图再回来重试，
  // 往往就能成功——这是把"冷启动拖慢"从"整页受损"降级成"个别图晚到"的关键。
  // 失败分两类：硬失败（浏览器派发 error）计入图床健康度；超时（预算耗尽）不计入。
  function loadThumb(img, url, anchor, wrap) {
    const origin = imageOrigin(url);
    let startedAt = 0;           // 等待预算的起点，见队列任务里的说明
    let attempt = 0;
    let settled = false;
    let holding = false;
    let timer = null;

    const releaseSlot = () => {
      if (!holding) return;
      holding = false;
      imgInFlight--;
      pumpImgQueue();
    };

    const done = (failed, outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseSlot();

      // 失败记忆与图床熔断是**两件事**，判据不同：
      //   · 硬失败与超时都写进失败记忆（TTL 内不再请求），这样刷新页面不会把已知失败的图重试一遍；
      //   · 只有硬失败才喂给图床熔断 —— 超时只是"慢"的弱证据，喂进去会重演
      //     "一次冷启动抖动把整个域名判死"的老问题。
      // outcome === 'skip'（命中失败记忆或图床已判死）已经记过了，不必再记。
      if (!failed) trackHostResult(origin, 'ok');
      else if (outcome === 'hard') { rememberBadImage(url); trackHostResult(origin, 'hard'); }
      else if (outcome === 'timeout') rememberBadImage(url, true);   // 超时只短暂记住
      else if (outcome === 'cached-hard') rememberBadImage(url);   // 只记图，不喂熔断

      thumbProgress.settle(failed);
      if (failed) {
        anchor.remove();
        if (!wrap.querySelector('img')) wrap.remove();
      }
    };

// 把下一次尝试排进队列（队尾），拿到窗口位后才真正发请求。
  // 注意：窗口位是在**任务内部**才递增的。若像以前那样在出队前先递增，
  // 一个"排队期间已经 settled"的任务会直接 return，那一次递增就永远还不回去，
  // 累积到 MAX_IMG_IN_FLIGHT 次之后整个窗口彻底卡死、再也没有图片能开始加载。
  const queueAttempt = () => {
    if (settled) return;
imgQueue.push(() => {
        if (settled) return;
        imgInFlight++;
        holding = true;
        // 等待预算从**真正发起第一次请求**时起算，而不是从"图片被创建"时起算。
        // 同一页几十张图是同一批注入的，只有 MAX_IMG_IN_FLIGHT 张能真正开始；后面那些要排队。
        // 若把排队时间算进预算，图床一慢，队尾的图拿到手的剩余预算就是 0，
        // 会在毫秒内被判超时、连一次完整尝试都没做完就被放弃（实测可让整页 56 张图丢在排队阶段）。
        if (attempt === 0) startedAt = performance.now();
        if (deadHosts.has(origin)) { done(true, 'skip'); return; }
      img.src = attempt === 0 ? url : url + (url.indexOf('?') === -1 ? '?' : '&') + '_r=' + attempt;
      // 命中缓存时不会再派发 load / error，必须自己结算一次。
      // 实测：只有"缓存里已有成功图"才会让新 src 同步 complete=true；把某个已经失败的地址
      // 再赋一次，complete 会被同步重置为 false —— 所以下面这条失败分支实际上极少走到。
      // 真走到时按 'cached-hard' 结算：写失败记忆，但不喂图床熔断
      // （熔断是给"域名级不可达"用的硬证据，一张缓存里的坏图不该有资格动它）。
      if (img.complete) {
        const ok = img.naturalWidth > 0;
        done(!ok, ok ? 'ok' : 'cached-hard');
        return;
      }
      armWait();
    });
    pumpImgQueue();
  };

    const armWait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!settled) onTimeout(); },
        Math.max(0, IMG_TOTAL_WAIT_MS - (performance.now() - startedAt)));
    };

    function retryLater() {
      attempt++;
      releaseSlot();
      const delay = IMG_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 400);
      timer = setTimeout(queueAttempt, delay);
    }

    function onTimeout() {
      if (settled) return;
      clearTimeout(timer);
      if (attempt >= IMG_RETRY_TIMES) { done(true, 'timeout'); return; }
      retryLater();
    }

    function onError() {
      if (settled) return;
      clearTimeout(timer);
      if (attempt >= IMG_RETRY_TIMES) { done(true, 'hard'); return; }
      retryLater();
    }

    img.addEventListener('load', () => done(false, 'ok'));
    img.addEventListener('error', onError);

    thumbProgress.add(1);
    // 失败记忆命中：TTL 内已知这张图/这个图床不行，直接跳过——不发请求，也不占用发送窗口
    if (badImages.has(url) || slowImages.has(url) || deadHosts.has(origin)) { done(true, 'skip'); return; }
    queueAttempt();
  }

  // 建缩略图容器并同步开始加载全部图片。
  // highPriority 只影响该帖第一张图的 fetchpriority，用于把首屏内容提前
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
      img.decoding = 'async';                                       // 异步解码，不阻塞主线程渲染
      img.loading = 'eager';                                        // 打开即全量加载，不使用任何按需加载
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

  // 处理单个帖子行：搬日期 + 注入缩略图 + 单列化。
  // 单列化会删掉除标题外的全部单元格（作者、回复/查看数等列）——这是刻意的，列表页只保留
  // 标题、发帖日期与缩略图三样。非帖子行（表头行、公告行、广告行）不参与。
  function processRow(tr, thumbMap) {
    if (!tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]')) return;
    const th = tr.querySelector('th');
    const tbody = tr.closest('tbody');
    const firstBy = tr.querySelector('td.by');

    // 把发帖时间从 td.by 挪到标题下方（随后整行 td 都会被删除，只保留单列标题）
    if (th && firstBy) {
      const em = firstBy.querySelector('em');
      if (em) {
        // 帖内分页链接容器（.tps）只有多页帖才有，单页帖现场补一个承载节点
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

  // 站点用 static/js/autoloadpage.js 接管 #autopbn 的点击，用 Ajax 往表格里追加下一页的 tbody。
  // 但本脚本的缩略图依赖移动版映射，而映射只取了当前页；被 Ajax 追加进来的行拿不到映射，
  // 只能是一整页没有缩略图的行。同时原站 autoloadpage.js 里 autopagenum 恒为 0，
  // 滚动到底本来也不会自动追加。所以这里把分页按钮还原成普通链接：点击即整页跳转，
  // 走与首页完全一致的缩略图流程。
  // 必须在站点脚本执行完之后改，否则 autoloadpage.js 会重新绑定 onclick —— 调用点在 DOMContentLoaded。
  function restoreRealPagination() {
    const btn = document.getElementById('autopbn');
    if (!btn) return;
    const next = btn.getAttribute('rel');
    if (!next) return;
    btn.onclick = null;
    btn.setAttribute('href', next);
  }

  // 详情图到手后的统一收尾：预连接图床 + 注入缩略图。
  // container 是缩略图的落点（列表页回捞用 <th>，检索页用 <li>），foldEl 用于首屏判定
  function attachDetailThumbs(container, foldEl, tid, urls) {
    preconnectUrlList(urls);
    if (urls.length === 0 || container.querySelector('.sehua-thumb')) return;
    container.appendChild(createThumbWrap(tid, urls, isAboveFold(foldEl)));
  }

  // 移动版没给出缩略图的帖子，逐个回详情页取（并发受 MAX_CONCURRENT 限制）
  async function loadFallbackThumbs(tbodies) {
    const pool = new ConcurrencyPool(MAX_CONCURRENT);
    const tasks = tbodies.map(tb => pool.add(async () => {
      const th = tb.querySelector('th');
      const tid = tb.id?.match(/\d+/)?.[0];
      if (!tid || !th || th.querySelector('.sehua-thumb')) return;
      const urls = await fetchDetailImages(tid);
      if (urls === null) return;   // 被反爬拦截：不标记，后续仍可重试
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
      cb.checked = savedState[name] ?? true;   // 默认勾选 = 默认隐藏这些栏目
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

  // 只对可见（未被栏目过滤掉）的结果取详情图，并发受 MAX_CONCURRENT 限制。
  // 取到的图同样一次性全部加载，不区分首屏
  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }   // 加载中再次触发则记录补跑
    loadingThumbs = true;
    try {
      const targets = Array.from(document.querySelectorAll('#threadlist li.pbw'))
        .filter(li => li.style.display !== 'none'          // 被栏目过滤隐藏的不请求
          && !li.querySelector('.sehua-thumb')             // 已有缩略图的不重复请求
          && !li.dataset.sehuaChecked);                    // 已确认无图的帖不重复请求
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
          if (urls === null) return;        // 被反爬拦截：不标记，下次筛选变化或重进页面还能重试
          li.dataset.sehuaChecked = '1';    // 标记已处理，避免对无图帖子反复请求
          attachDetailThumbs(li, li, tid, urls);
        } catch (e) {
          loading.remove();
        }
      }));
      await Promise.all(tasks);
    } finally {
      loadingThumbs = false;
      if (pendingReload) {                  // 加载期间若又有筛选变化，补跑一次
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

    const switchWrap = addForumSwitches();
    if (!switchWrap) {
      // 未登录时 search.php 只返回空壳，没有 .sttl.mbn
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

  // 检测"搜索繁忙"并自动刷新。只在站点的提示容器里找关键字，
  // 不做全文扫描——正文/标题里出现同样字样不应触发刷新
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

  // 详情页：站点对正文里少数图片只给 file 属性、不给 src（Discuz 的按需加载写法）。
  // 实测（thread-3820178）：刷新后不滚动时这 2 张是 1x1 空白、已加载 57/59；
  // 滚动进视口后站点自己的 JS 才把 file 拷成 src，变成 59/59。
  // "打开即全量加载"的前提下不能留这个尾巴，所以在 DOM 就绪时直接补齐。
  // 只补 src，保留 file —— 站点的灯箱（showImage）还要读 file 取大图。
  function materializeFileOnlyImages() {
    let n = 0;
    document.querySelectorAll('#postlist img[file]:not([src])').forEach(img => {
      const real = img.getAttribute('file');
      if (!real) return;
      img.setAttribute('src', real);
      n++;
    });
    if (n > 0) log(`补齐 ${n} 张只给 file、没给 src 的正文图`);
  }

  function detailPageMain() {
    log('详情页模式');
    // 与列表页同理：URL 是帖子页不代表正文就是帖子。年龄门中间页没有 #postlist，
    // 注入这几行样式纯属空转，直接退出
    if (!document.getElementById('postlist')) {
      log('页面无帖子正文（18+ 年龄门或异常页），跳过详情页处理');
      return;
    }
    addStyle(`
      ${PAGE_CSS}
      #postlist { width: 100% !important; }
      #postlist ignore_js_op { text-align: center; }
      #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; }
    `);
    removeUnused();
    materializeFileOnlyImages();
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

    // URL 是列表页不代表正文就是帖子表格：_safe 尚未建立时（首次访问、浏览器重启后）服务端先返回
    // 18+ 年龄门，URL 仍是 forum-103-1.html。此时既没有行可注入，移动版请求也必然被挡下，
    // 直接退出可省掉 3 次请求与随后的退避等待。
    if (!document.getElementById('threadlisttableid')) {
      log('页面无帖子表格（18+ 年龄门或异常页），跳过列表页处理');
      return;
    }

    injectListStyles();
    removeUnused();
    restoreRealPagination();
    // autoloadpage.js 若是以 async 方式加载，可能在 DOMContentLoaded 之后才绑定 onclick，这里补一次
    window.addEventListener('load', restoreRealPagination, { once: true });

    log(`请求移动版: forum-${fid}-${page}.html?mobile=2（移动 UA）`);
    // 直接消费 document-start 抢跑的那个 Promise：成功路径命中缓存/pending，
    // 失败路径也不必再补发一次"不带重试"的请求
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
      const fallbackBatch = Array.from(document.querySelectorAll('#threadlisttableid tbody[id^=normalthread_]'))
        .filter(tb => {
          const tid = tb.id?.match(/\d+/)?.[0];
          return tid && fallbackTids.includes(tid);
        });
      if (fallbackBatch.length > 0) {
        // 补 catch：内部取图自身是 catch 过的，但 attachDetailThumbs / DOM 操作万一抛错
        // 就会变成 unhandled rejection，污染控制台并掩盖真实原因
        loadFallbackThumbs(fallbackBatch).catch(e => log('回捞详情图异常', e));
      }
    }
  }

  // ============================ 入口 ============================
  // @run-at document-start：函数体在 <html> 解析前执行，此时只有 location 可用。把两件不依赖 DOM
  // 的事提前做掉：用上次学到的图床域名抢先握手、发出移动版请求。其余 DOM 处理等 DOMContentLoaded。

  const earlyPageInfo = getPageInfo();
  let earlyListFetch = null;

  loadFailureMemory();
  preconnectLearnedHosts();

  if (earlyPageInfo.fid) {
    earlyListFetch = fetchMobileThumbsByPage(earlyPageInfo.fid, earlyPageInfo.page, false);
    // catch 必须补：GM API 缺失或抛同步异常时这个 Promise 会 reject，没有 catch 就是
    // unhandled rejection（控制台噪音，且掩盖真实失败原因）。失败无需处理——DOM 就绪后会带重试重取
    earlyListFetch.then(result => {
      if (mobileResultOk(result)) preconnectImageHosts(result.mapping);
    }).catch(err => {
      console.warn('[色花堂缩略图] 抢跑请求异常，忽略（DOM 就绪后会带重试重取）:', err);
    });
  }

  async function onDomReady() {
    try {
      document.documentElement.dataset.sehua = VERSION;   // 版本标记，见 VERSION 处的说明

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

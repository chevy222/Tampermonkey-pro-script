// ==UserScript==
// @name         色花堂精简
// @namespace    http://98tang.com/
// @version      1.1
// @description  色花堂精简版：去广告；PC 列表页注入移动版缩略图（打开即全部加载）；详情页去懒加载/去滚动补图；检索页从详情页抽取缩略图 + 栏目过滤开关。无加载引擎、无进度条、无失败记忆——只做注入，加载交给浏览器。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================== 可调参数 ============================== */

  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[色花堂精简]', ...args); };

  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  const REQUEST_TIMEOUT = 15000;          // 单次请求超时
  const MAX_CONCURRENT = 5;               // 检索页详情抽取的并发
  const MAX_DETAIL_IMGS = 5;              // 单个详情最多取几张图
  const THUMB_GAP_PX = 8;                 // 缩略图间距
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];
  const FILTER_STORAGE_KEY = 'sehuaFilterStateLite';

  const IMG_SRC_ATTRS = ['file', 'zoomfile', 'data-original'];
  const PLACEHOLDER_MARKERS = ['static/image', 'uc_server', 'none.gif', 'thumb-ing'];

  /* ============================== 工具函数 ============================== */

  function isPlaceholder(url) {
    return PLACEHOLDER_MARKERS.some(m => url.indexOf(m) !== -1);
  }

  function normalizeHttpUrl(val, base) {
    if (!val) return null;
    try {
      const u = new URL(val, base || location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  }

  // 从 img 上取真实图片地址（依次探测 data 属性，最后退回 src）
  function getRealSrc(img) {
    for (const attr of IMG_SRC_ATTRS) {
      const url = normalizeHttpUrl(img.getAttribute(attr));
      if (url && !isPlaceholder(url)) return url;
    }
    const url = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    if (url && !isPlaceholder(url)) return url;
    return null;
  }

  // 当前页面的论坛 ID 与页码（forum-95-2.html 与 ?fid=95&page=2 两种形式）
  function getPageInfo() {
    const m1 = location.href.match(/forum-(\d+)-(\d+)\.html/);
    if (m1) return { fid: m1[1], page: parseInt(m1[2], 10) };
    const params = new URLSearchParams(location.search);
    return { fid: params.get('fid'), page: parseInt(params.get('page') || '1', 10) };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 迷你并发池：限制同时进行的任务数
  async function pool(items, limit, fn) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) await fn(items[idx++]);
    });
    await Promise.all(workers);
  }

  function addStyle(css) {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // 站点反爬拦截页（safeid 挑战页）
  function isSafePage(text) {
    return typeof text === 'string' && text.indexOf('safeid') !== -1;
  }

  /* ============================== 取图 ============================== */

  // 带移动 UA 请求触屏模板，解析出 帖子tid -> 缩略图地址列表；被拦/超时返回 null
  function fetchMobileThumbs(fid, page) {
    return new Promise(resolve => {
      const sp = new URLSearchParams(location.search);
      const pairs = ['mobile=2'];
      ['filter', 'orderby', 'typeid', 'specialtype'].forEach(k => {
        if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k)));
      });
      const url = `https://${location.hostname}/forum-${fid}-${page}.html?${pairs.join('&')}`;
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
        onload(resp) {
          if (isSafePage(resp.responseText)) { resolve(null); return; }
          try {
            const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
            const mapping = {};
            doc.querySelectorAll('.n5_htmk').forEach(el => {
              const link = el.querySelector('a[href*=viewthread]');
              if (!link) return;
              const tid = (link.href.match(/tid=(\d+)/) || [])[1];
              if (!tid) return;
              const urls = [];
              el.querySelectorAll('img').forEach(img => {
                const src = getRealSrc(img);
                if (src && urls.indexOf(src) === -1) urls.push(src);
              });
              if (urls.length > 0) mapping[tid] = urls;
            });
            resolve({ mapping });
          } catch (e) { resolve(null); }
        },
        ontimeout: () => resolve(null),
        onerror: () => resolve(null)
      });
    });
  }

  // 带两次重试的移动版映射获取
  async function fetchMobileMapping(fid, page) {
    for (let i = 0; i < 2; i++) {
      const r = await fetchMobileThumbs(fid, page);
      if (r && Object.keys(r.mapping).length > 0) return r;
      if (i === 0) await sleep(1500);
    }
    return { mapping: {} };
  }

  // 从详情页 HTML 抽图片地址；被拦截或重试耗尽返回 null
  function fetchDetailImages(tid) {
    const url = `https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`;
    const attempt = () => new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
        onload(resp) {
          if (isSafePage(resp.responseText)) { resolve('blocked'); return; }
          try {
            const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
            const urls = [];
            doc.querySelectorAll('.t_f img, .pcb img, .message img').forEach(img => {
              const u = getRealSrc(img);
              if (u && urls.indexOf(u) === -1 && urls.length < MAX_DETAIL_IMGS) urls.push(u);
            });
            resolve(urls);
          } catch (e) { resolve(null); }
        },
        ontimeout: () => resolve('blocked'),
        onerror: () => resolve('blocked')
      });
    });
    return (async () => {
      for (let i = 0; i < 2; i++) {
        const r = await attempt();
        if (r !== 'blocked') return r;
        if (i === 0) await sleep(2000);
      }
      return null;
    })();
  }

  /* ============================== 缩略图注入 ============================== */

  const THUMB_CSS = `
    .sehua-thumb { --img-width: 50%; display: flex; flex-wrap: wrap; justify-content: center; gap: ${THUMB_GAP_PX}px; margin-top: 8px; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; text-decoration: none; width: var(--img-width) !important; position: relative; }
  `;

  function createThumbWrap(tid, urls) {
    const wrap = document.createElement('div');
    wrap.className = 'sehua-thumb';
    wrap.style.setProperty('--img-width', urls.length <= 1 ? '50%' : `calc((100% - ${(urls.length - 1) * THUMB_GAP_PX}px) / ${urls.length})`);
    const href = `https://${location.hostname}/thread-${tid}-1-1.html`;
    urls.forEach(url => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = url;               // 直接加载：打开页面就开始下，不用懒加载
      img.decoding = 'async';
      img.onerror = () => { img.style.visibility = 'hidden'; };   // 裂图不露馅
      a.appendChild(img);
      wrap.appendChild(a);
    });
    return wrap;
  }

  function attachDetailThumbs(container, tid, urls) {
    if (urls.length === 0 || container.querySelector('.sehua-thumb')) return;
    container.appendChild(createThumbWrap(tid, urls));
  }

  /* ============================== 去广告 ============================== */

  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    // 表格里不属于帖子的行整块移除：公告行、空表头行、广告行
    document.querySelectorAll('#threadlisttableid tbody').forEach(tb => {
      if (/^(normalthread_|stickthread_)/.test(tb.id)) return;
      if (tb.querySelector('.pg')) return;
      tb.remove();
    });
  }

  // 把分页按钮还原成普通链接（点击即整页跳转，避免 AJAX 翻页漏注入）
  function restoreRealPagination() {
    const btn = document.getElementById('autopbn');
    if (!btn) return;
    const next = btn.getAttribute('rel');
    if (!next) return;
    btn.onclick = null;
    btn.setAttribute('href', next);
  }

  /* ============================== 列表页 ============================== */

  async function listPageMain() {
    const { fid, page } = getPageInfo();
    if (!fid) { log('非列表页，跳过'); return; }
    if (!document.getElementById('threadlisttableid')) { log('无帖子表格，跳过'); return; }

    addStyle(THUMB_CSS + `
      #threadlisttableid { table-layout: fixed !important; width: 100% !important; }
      #threadlisttableid th { width: 100% !important; padding-right: 12px; }
    `);
    removeUnused();
    restoreRealPagination();
    window.addEventListener('load', restoreRealPagination, { once: true });

    log(`请求移动版: forum-${fid}-${page}.html?mobile=2`);
    const { mapping } = await fetchMobileMapping(fid, page);
    log(`映射到手 ${Object.keys(mapping).length} 个帖子`);

    let injected = 0;
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      if (!tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]')) return;
      const th = tr.querySelector('th');
      const tbody = tr.closest('tbody');
      const tid = tbody && tbody.id ? (tbody.id.match(/\d+/) || [])[0] : null;
      if (tid && mapping[tid] && th && !th.querySelector('.sehua-thumb')) {
        th.appendChild(createThumbWrap(tid, mapping[tid]));
        injected++;
      }
    });
    log(`注入 ${injected} 个帖子的缩略图`);
  }

  /* ============================== 详情页 ============================== */

  // 单张正文图：占位符换成真地址，打上 lazyloaded 标记；有改动返回 true
  function fixLazyImg(img) {
    let touched = false;
    const real = img.getAttribute('file');
    const cur = img.getAttribute('src');
    if (real && (!cur || isPlaceholder(cur))) { img.setAttribute('src', real); touched = true; }
    if (!img.getAttribute('lazyloaded')) { img.setAttribute('lazyloaded', 'true'); touched = true; }
    return touched;
  }

  // 去懒加载 + 去滚动补图：全量把占位符换成真地址并打标记，站点自己的
  // 滚动加载器于是无事可做。实测 #postlist 不会动态插入图片（两页验证），
  // 不需要 MutationObserver
  function detailPageMain() {
    if (!document.getElementById('postlist')) { log('无帖子正文，跳过'); return; }
    removeUnused();

    let fixed = 0;
    document.querySelectorAll('#postlist img[file]').forEach(img => { if (fixLazyImg(img)) fixed++; });
    log(`正文图：${fixed} 张从占位符换成真地址/打上 lazyloaded`);
  }

  /* ============================== 检索页 ============================== */

  function loadFilterState() {
    try { return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }

  function saveFilterState() {
    const state = {};
    document.querySelectorAll('.sehua-forum-switch input[type=checkbox]').forEach(cb => {
      state[cb.dataset.forum] = cb.checked;
    });
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // 栏目过滤开关：勾选的栏目隐藏对应结果
  function addForumSwitches() {
    const sttl = document.querySelector('.sttl.mbn');
    if (!sttl) return null;
    sttl.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:8px;';

    const switchWrap = document.createElement('div');
    switchWrap.className = 'sehua-forum-switch';
    switchWrap.style.cssText = 'display:flex; gap:12px; align-items:center; font-size:12px;';
    const saved = loadFilterState();
    BLOCK_FORUMS.forEach(name => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:4px; cursor:pointer; user-select:none;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = saved[name] ?? true;   // 默认勾选 = 默认隐藏这些栏目
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

  // 只对可见（未被栏目过滤掉）的结果取详情图
  let loadingThumbs = false;
  let pendingReload = false;

  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }
    loadingThumbs = true;
    try {
      const targets = Array.from(document.querySelectorAll('#threadlist li.pbw'))
        .filter(li => li.style.display !== 'none'
          && !li.querySelector('.sehua-thumb')
          && !li.dataset.sehuaChecked);
      log(`检索页加载 ${targets.length} 个可见帖子的详情图（并发${MAX_CONCURRENT}）`);

      await pool(targets, MAX_CONCURRENT, async li => {
        const tid = (li.id || '').match(/\d+/)?.[0];
        if (!tid) return;
        const loading = document.createElement('div');
        loading.className = 'sehua-loading';
        loading.textContent = '加载中...';
        li.appendChild(loading);
        try {
          const urls = await fetchDetailImages(tid);
          if (urls === null) return;
          li.dataset.sehuaChecked = '1';
          attachDetailThumbs(li, tid, urls);
        } finally { loading.remove(); }
      });
    } finally {
      loadingThumbs = false;
      if (pendingReload) { pendingReload = false; loadDetailThumbs(); }
    }
  }

  async function searchPageMain() {
    addStyle(THUMB_CSS + `
      #threadlist .slst.mtw { width: 100% !important; }
      div.sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }
    `);
    removeUnused();

    if (!document.querySelector('#threadlist li.pbw')) { log('检索页无结果项，跳过'); return; }
    const switchWrap = addForumSwitches();
    if (!switchWrap) { log('未找到 .sttl.mbn，跳过检索页处理'); return; }

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

  /* ============================== 路由 ============================== */

  function onDomReady() {
    try {
      if (location.pathname.indexOf('/search.php') !== -1) {
        log('检索页模式');
        searchPageMain().catch(e => console.error('[色花堂精简] 检索页处理失败:', e));
      } else if (location.pathname.indexOf('/thread-') !== -1 || location.search.indexOf('mod=viewthread') !== -1) {
        log('详情页模式');
        detailPageMain();
      } else if (location.pathname.indexOf('/forum.php') !== -1 && !location.search) {
        log('首页模式');
        removeUnused();
      } else {
        log('列表页模式');
        listPageMain().catch(e => console.error('[色花堂精简] 列表页处理失败:', e));
      }
    } catch (e) {
      console.error('[色花堂精简] 初始化失败:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  } else {
    onDomReady();
  }
})();

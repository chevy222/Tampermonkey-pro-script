// ==UserScript==
// @name         色花堂精简
// @namespace    http://98tang.com/
// @version      1.3
// @description  色花堂精简版：去广告；PC 列表页注入移动版缩略图（打开即全部加载）；详情页去懒加载/去滚动补图；检索页从详情页抽取缩略图 + 栏目过滤开关 + 搜索频繁拦截自动刷新重试（5 次）。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================== 可调参数 ============================== */

  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  const REQUEST_TIMEOUT = 15000;          // 单次请求超时
  const MAX_CONCURRENT = 5;               // 检索页详情抽取并发
  const MAX_DETAIL_IMGS = 5;              // 单帖最多取几张图
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];
  const FILTER_STORAGE_KEY = 'sehuaFilterStateLite';
  const BUSY_KEY = 'sehuaBusyRetryLite';

  /* ============================== 工具函数 ============================== */

  function isPlaceholder(url) {
    return ['static/image', 'uc_server', 'none.gif', 'thumb-ing'].some(m => url.includes(m));
  }

  function normalizeHttpUrl(val) {
    try {
      const u = new URL(val, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  }

  // 从 img 上取真实图片地址（依次探测 data 属性，最后退回 src）
  function getRealSrc(img) {
    for (const attr of ['file', 'zoomfile', 'data-original']) {
      const url = normalizeHttpUrl(img.getAttribute(attr));
      if (url && !isPlaceholder(url)) return url;
    }
    const url = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    return (url && !isPlaceholder(url)) ? url : null;
  }

  // 当前页面的论坛 ID 与页码（forum-95-2.html 与 ?fid=95&page=2 两种形式）
  function getPageInfo() {
    const m = location.href.match(/forum-(\d+)-(\d+)\.html/);
    if (m) return { fid: m[1], page: +m[2] };
    const p = new URLSearchParams(location.search);
    return { fid: p.get('fid'), page: +p.get('page') || 1 };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 并发池：限制同时进行的任务数
  async function pool(items, limit, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  }

  function addStyle(css) {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============================== 取图 ============================== */

  // 带移动 UA 请求触屏模板，解析出 帖子tid -> 缩略图列表；被拦/超时返回 null
  function fetchMobileThumbs(fid, page) {
    return new Promise(resolve => {
      const sp = new URLSearchParams(location.search);
      const pairs = ['mobile=2'];
      ['filter', 'orderby', 'typeid', 'specialtype'].forEach(k => { if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k))); });
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://${location.hostname}/forum-${fid}-${page}.html?${pairs.join('&')}`,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
        onload(resp) {
          if (resp.responseText.includes('safeid')) return resolve(null);
          try {
            const mapping = {};
            new DOMParser().parseFromString(resp.responseText, 'text/html').querySelectorAll('.n5_htmk').forEach(el => {
              const tid = (el.querySelector('a[href*=viewthread]')?.href.match(/tid=(\d+)/) || [])[1];
              if (!tid) return;
              const urls = [];
              el.querySelectorAll('img').forEach(img => { const s = getRealSrc(img); if (s && !urls.includes(s)) urls.push(s); });
              if (urls.length) mapping[tid] = urls;
            });
            resolve({ mapping });
          } catch (e) { resolve(null); }
        },
        ontimeout: () => resolve(null),
        onerror: () => resolve(null)
      });
    });
  }

  // 移动版映射：最多试 2 次
  async function fetchMobileMapping(fid, page) {
    for (let i = 0; i < 2; i++) {
      const r = await fetchMobileThumbs(fid, page);
      if (r && Object.keys(r.mapping).length) return r;
      if (i < 1) await sleep(1500);
    }
    return { mapping: {} };
  }

  // 从详情页抽图片地址；被拦/超时/解析失败最多试 2 次，全挂返回 null
  function fetchDetailImages(tid) {
    const attempt = () => new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
        onload(resp) {
          if (resp.responseText.includes('safeid')) return resolve(null);
          try {
            const urls = [];
            new DOMParser().parseFromString(resp.responseText, 'text/html').querySelectorAll('.t_f img, .pcb img, .message img').forEach(img => {
              const u = getRealSrc(img);
              if (u && !urls.includes(u) && urls.length < MAX_DETAIL_IMGS) urls.push(u);
            });
            resolve(urls);
          } catch (e) { resolve(null); }
        },
        ontimeout: () => resolve(null),
        onerror: () => resolve(null)
      });
    });
    return (async () => {
      for (let i = 0; i < 2; i++) {
        const r = await attempt();
        if (r) return r;               // 拿到结果就走（空数组 = 帖子里没图）
        if (i < 1) await sleep(2000);  // 被拦/超时：隔 2 秒再来
      }
      return null;
    })();
  }

  /* ============================== 缩略图注入 ============================== */

  const THUMB_CSS = `
    .sehua-thumb { --img-width: 50%; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; text-decoration: none; width: var(--img-width) !important; position: relative; }
  `;

  function createThumbWrap(tid, urls) {
    const wrap = document.createElement('div');
    wrap.className = 'sehua-thumb';
    wrap.style.setProperty('--img-width', urls.length <= 1 ? '50%' : `calc((100% - ${(urls.length - 1) * 8}px) / ${urls.length})`);
    const href = `https://${location.hostname}/thread-${tid}-1-1.html`;
    urls.forEach(url => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = url;               // 直接加载：打开页面就开始下，不用懒加载
      a.appendChild(img);
      wrap.appendChild(a);
    });
    return wrap;
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

  /* ============================== 列表页 ============================== */

  async function listPageMain() {
    const { fid, page } = getPageInfo();
    if (!fid || !document.getElementById('threadlisttableid')) return;

    addStyle(THUMB_CSS + `
      #threadlisttableid { table-layout: fixed !important; width: 100% !important; }
      #threadlisttableid th { width: 100% !important; padding-right: 12px; }
    `);
    removeUnused();
    // 掐掉 autoloadpage.js 的 AJAX 翻页（它绑在 onclick 上），走 href 整页跳转
    const autopbn = document.getElementById('autopbn');
    if (autopbn) autopbn.onclick = null;

    const { mapping } = await fetchMobileMapping(fid, page);
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const tbody = tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]');
      const th = tr.querySelector('th');
      const tid = tbody && (tbody.id.match(/\d+/) || [])[0];
      if (tid && th && mapping[tid] && !th.querySelector('.sehua-thumb')) th.appendChild(createThumbWrap(tid, mapping[tid]));
    });
  }

  /* ============================== 详情页 ============================== */

  // 单张正文图：占位符换成真地址，打上 lazyloaded 标记（站点的滚动加载器跳过它）
  function fixLazyImg(img) {
    const real = img.getAttribute('file');
    const cur = img.getAttribute('src');
    if (real && (!cur || isPlaceholder(cur))) img.setAttribute('src', real);
    img.setAttribute('lazyloaded', 'true');
  }

  // 去懒加载 + 去滚动补图：加载后的占位图全部立即换真地址。
  // 实测 #postlist 不会动态插入图片，不需要 MutationObserver
  function detailPageMain() {
    if (!document.getElementById('postlist')) return;
    removeUnused();
    document.querySelectorAll('#postlist img[file]').forEach(fixLazyImg);
  }

  /* ============================== 检索页 ============================== */

  function loadFilterState() {
    try { return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }

  function saveFilterState() {
    const st = {};
    document.querySelectorAll('.sehua-forum-switch input').forEach(cb => { st[cb.dataset.forum] = cb.checked; });
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(st)); } catch (e) {}
  }

  // 栏目过滤开关：勾选的栏目隐藏对应结果，状态记在本地
  function addForumSwitches() {
    const sttl = document.querySelector('.sttl.mbn');
    if (!sttl) return null;
    sttl.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:8px;';
    const wrap = document.createElement('div');
    wrap.className = 'sehua-forum-switch';
    wrap.style.cssText = 'display:flex; gap:12px; align-items:center; font-size:12px;';
    const saved = loadFilterState();
    BLOCK_FORUMS.forEach(name => {
      wrap.insertAdjacentHTML('beforeend', `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;"><input type="checkbox" data-forum="${name}"${(saved[name] ?? true) ? ' checked' : ''}><span>隐藏${name}</span></label>`);
    });
    sttl.appendChild(wrap);
    return wrap;
  }

  function applyFilter() {
    const hidden = {};
    document.querySelectorAll('.sehua-forum-switch input:checked').forEach(cb => { hidden[cb.dataset.forum] = 1; });
    document.querySelectorAll('#threadlist li.pbw').forEach(li => {
      const fl = li.querySelector('a[href*=forum-]');
      li.style.display = hidden[fl ? fl.textContent.trim() : ''] ? 'none' : '';
    });
  }

  let loadingThumbs = false;
  let pendingReload = false;

  // 只对可见（未被过滤）的结果取详情图；运行中再触发会补跑一轮
  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }
    loadingThumbs = true;
    try {
      const targets = [...document.querySelectorAll('#threadlist li.pbw')]
        .filter(li => li.style.display !== 'none' && !li.querySelector('.sehua-thumb') && !li.dataset.sehuaChecked);
      await pool(targets, MAX_CONCURRENT, async li => {
        const tid = (li.id.match(/\d+/) || [])[0];
        if (!tid) return;
        const tip = document.createElement('div');
        tip.className = 'sehua-loading';
        tip.textContent = '加载中...';
        li.appendChild(tip);
        try {
          const urls = await fetchDetailImages(tid);
          if (urls === null) return;
          li.dataset.sehuaChecked = '1';
          if (urls.length && !li.querySelector('.sehua-thumb')) li.appendChild(createThumbWrap(tid, urls));
        } finally { tip.remove(); }
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
    if (!document.querySelector('#threadlist li.pbw')) return;
    const bar = addForumSwitches();
    if (!bar) return;
    bar.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => { applyFilter(); saveFilterState(); loadDetailThumbs(); }));
    applyFilter();
    await loadDetailThumbs();
  }

  // 搜索频繁拦截页（"搜索过于频繁…"）：倒计时后自动刷新，最多 5 次（计数存
  // sessionStorage 跨刷新）；搜成功（无拦截文案）就清零，下一次重新计数
  function searchBusyRetry() {
    const mt = document.getElementById('messagetext');
    if (!mt || !/(频繁|繁忙)/.test(mt.textContent)) { sessionStorage.removeItem(BUSY_KEY); return false; }
    const n = (+sessionStorage.getItem(BUSY_KEY) || 0) + 1;
    if (n > 5) { sessionStorage.removeItem(BUSY_KEY); return false; }
    sessionStorage.setItem(BUSY_KEY, n);
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.8);color:#fff;padding:16px 24px;border-radius:8px;font-size:14px;z-index:99999;text-align:center;';
    let s = 4;
    tip.textContent = `搜索频繁，${s} 秒后自动刷新（第 ${n}/5 次）...`;
    document.body.appendChild(tip);
    const t = setInterval(() => {
      if (--s > 0) tip.textContent = `搜索频繁，${s} 秒后自动刷新（第 ${n}/5 次）...`;
      else { clearInterval(t); location.reload(); }
    }, 1000);
    return true;
  }

  /* ============================== 路由 ============================== */

  function onDomReady() {
    if (location.pathname.indexOf('/search.php') !== -1) {
      if (searchBusyRetry()) return;
      searchPageMain();
    } else if (location.pathname.indexOf('/thread-') !== -1 || location.search.indexOf('mod=viewthread') !== -1) detailPageMain();
    else if (location.pathname.indexOf('/forum.php') !== -1 && !location.search) removeUnused();
    else listPageMain();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  } else {
    onDomReady();
  }
})();

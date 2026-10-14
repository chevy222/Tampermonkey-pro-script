// ==UserScript==
// @name         色花堂精简
// @namespace    http://98tang.com/
// @version      1.7
// @description  色花堂精简版：去广告；PC 列表页注入移动版缩略图（打开即全部加载、宽屏单列、发帖日期搬到标题下）；详情页宽屏、正文撑满居中、去懒加载/去滚动补图；检索页宽屏、从详情页抽取缩略图 + 栏目过滤开关 + 搜索繁忙拦截自动刷新重试（5 次）。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

  // 站内装饰图特征：静态图标、用户头像、占位图
  const isPlaceholder = url => ['static/image', 'uc_server', 'none.gif', 'thumb-ing'].some(m => url.includes(m));

  const normalizeHttpUrl = val => {
    if (!val) return null;   // 属性缺失时 getAttribute 返回 null，别让 new URL 把它串成"null"
    try {
      const u = new URL(val, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  };

  // 从 img 上取真实图片地址（依次探测 data 属性，最后退回 src）
  function getRealSrc(img) {
    for (const attr of ['file', 'zoomfile', 'data-original']) {
      const url = normalizeHttpUrl(img.getAttribute(attr));
      if (url && !isPlaceholder(url)) return url;
    }
    const url = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    return (url && !isPlaceholder(url)) ? url : null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const addStyle = css => document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

  // 并发池：最多 5 个任务同时进行
  async function pool(items, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  }

  // 带移动 UA 的 GET；被 safeid 挑战页拦下或解析抛错都返回 null
  const gmGet = (url, parse) => new Promise(resolve => GM_xmlhttpRequest({
    method: 'GET',
    url,
    timeout: 15000,
    headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
    onload: resp => {
      try { resolve(resp.responseText.includes('safeid') ? null : parse(resp.responseText)); }
      catch (e) { resolve(null); }
    },
    ontimeout: () => resolve(null),
    onerror: () => resolve(null)
  }));

  // 移动版触屏模板 -> 帖子tid映射（筛选参数透传）；被拦/为空返回 null 由调用方重试
  const fetchMobileThumbs = (fid, page) => {
    const sp = new URLSearchParams(location.search);
    const pairs = ['mobile=2'];
    ['filter', 'orderby', 'typeid', 'specialtype'].forEach(k => { if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k))); });
    return gmGet(`https://${location.hostname}/forum-${fid}-${page}.html?${pairs.join('&')}`, text => {
      const mapping = {};
      new DOMParser().parseFromString(text, 'text/html').querySelectorAll('.n5_htmk').forEach(el => {
        const tid = (el.querySelector('a[href*=viewthread]')?.href.match(/tid=(\d+)/) || [])[1];
        if (!tid) return;
        const urls = [];
        el.querySelectorAll('img').forEach(img => { const s = getRealSrc(img); if (s && !urls.includes(s)) urls.push(s); });
        if (urls.length) mapping[tid] = urls;
      });
      return Object.keys(mapping).length ? mapping : null;
    });
  };

  // 详情页抽图；被拦/超时最多试 2 次
  const fetchDetailImages = tid => (async () => {
    for (let i = 0; i < 2; i++) {
      const r = await gmGet(`https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`, text => {
        const urls = [];
        new DOMParser().parseFromString(text, 'text/html').querySelectorAll('.t_f img, .pcb img, .message img').forEach(img => {
          const u = getRealSrc(img);
          if (u && !urls.includes(u) && urls.length < 5) urls.push(u);
        });
        return urls;
      });
      if (r) return r;               // 拿到结果就走（空数组 = 帖子里没图）
      if (i < 1) await sleep(2000);  // 被拦/超时：隔 2 秒再来
    }
    return null;
  })();

  const WIDE_CSS = `
    .wp { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #nv { width: 100% !important; left: 0 !important; right: 0 !important; }
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
  `;

  const THUMB_CSS = WIDE_CSS + `
    .sehua-thumb { --img-width: 50%; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; text-decoration: none; width: var(--img-width) !important; position: relative; }
    .sehua-date { display: inline-block; margin: 4px 0 0 8px; font-size: 12px; color: #999; }
  `;

  function createThumbWrap(tid, urls) {
    const wrap = document.createElement('div');
    wrap.className = 'sehua-thumb';
    wrap.style.setProperty('--img-width', urls.length <= 1 ? '50%' : `calc((100% - ${(urls.length - 1) * 8}px) / ${urls.length})`);
    wrap.innerHTML = urls.map(u => `<a href="https://${location.hostname}/thread-${tid}-1-1.html" target="_blank" rel="noopener"><img src="${u}"></a>`).join('');
    return wrap;
  }

  // 去广告：垃圾元素 + 表格里非帖子行（公告/空表头/广告行）
  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    document.querySelectorAll('#threadlisttableid tbody:not([id^=normalthread_]):not([id^=stickthread_])').forEach(tb => { if (!tb.querySelector('.pg')) tb.remove(); });
  }

  async function listPageMain() {
    const m = location.href.match(/forum-(\d+)-(\d+)\.html/);
    const p = new URLSearchParams(location.search);
    const fid = m ? m[1] : p.get('fid');
    if (!fid || !document.getElementById('threadlisttableid')) return;

    addStyle(THUMB_CSS + `
      #threadlisttableid { table-layout: fixed !important; width: 100% !important; }
      #threadlisttableid th { width: 100% !important; padding-right: 12px; }
    `);
    removeUnused();
    // 掐掉 autoloadpage.js 的 AJAX 翻页（绑在 onclick 上），走 href 整页跳转
    const autopbn = document.getElementById('autopbn');
    if (autopbn) autopbn.onclick = null;

    let map = {};
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(1500);
      map = await fetchMobileThumbs(fid, m ? +m[2] : (+p.get('page') || 1)) || {};
      if (Object.keys(map).length) break;
    }
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const tbody = tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]');
      const th = tr.querySelector('th');
      if (!tbody || !th) return;
      const em = tr.querySelector('td.by em');   // 发帖时间搬到标题下
      if (em) { em.className = 'sehua-date'; th.appendChild(em); }
      tr.querySelectorAll('td').forEach(td => td.remove());   // 单列化：删掉作者/回复等列
      const tid = (tbody.id.match(/\d+/) || [])[0];
      if (tid && map[tid] && !th.querySelector('.sehua-thumb')) th.appendChild(createThumbWrap(tid, map[tid]));
    });
  }

  // 详情页去懒加载 + 去滚动补图：占位图立即换真地址并打 lazyloaded 标记（站点滚动加载器跳过它）；宽屏 + 正文撑满 + 图居中
  function detailPageMain() {
    if (!document.getElementById('postlist')) return;
    addStyle(WIDE_CSS + `
      #postlist { width: 100% !important; }
      #postlist ignore_js_op { text-align: center; }
      #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; }
    `);
    removeUnused();
    document.querySelectorAll('#postlist img[file]').forEach(img => {
      const cur = img.getAttribute('src');
      if (!cur || isPlaceholder(cur)) img.setAttribute('src', img.getAttribute('file'));
      img.setAttribute('lazyloaded', 'true');
    });
  }

  // 栏目过滤开关：勾选的栏目隐藏对应结果，状态记在本地
  function addForumSwitches() {
    const sttl = document.querySelector('.sttl.mbn');
    if (!sttl) return null;
    sttl.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:8px;';
    const wrap = document.createElement('div');
    wrap.className = 'sehua-forum-switch';
    wrap.style.cssText = 'display:flex; gap:12px; align-items:center; font-size:12px;';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sehuaFilterStateLite') || '{}'); } catch (e) {}
    ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'].forEach(name => {
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
      await pool(targets, async li => {
        const tid = (li.id.match(/\d+/) || [])[0];
        if (!tid) return;
        const tip = li.appendChild(document.createElement('div'));
        tip.className = 'sehua-loading';
        tip.textContent = '加载中...';
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
      .slst.mtw { width: 100% !important; }
      div.sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }
    `);
    removeUnused();
    if (!document.querySelector('#threadlist li.pbw')) return;
    const bar = addForumSwitches();
    if (!bar) return;
    bar.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
      applyFilter();
      const st = {};
      document.querySelectorAll('.sehua-forum-switch input').forEach(c => { st[c.dataset.forum] = c.checked; });
      try { localStorage.setItem('sehuaFilterStateLite', JSON.stringify(st)); } catch (e) {}
      loadDetailThumbs();
    }));
    applyFilter();
    await loadDetailThumbs();
  }

  // 搜索繁忙拦截页：倒计时后自动刷新，最多 5 次（计数存 sessionStorage 跨刷新）。
  // 只认"搜索繁忙"（瞬时繁忙，重试有意义）；"搜索过于频繁…120秒"是冷却，不碰
  function searchBusyRetry() {
    const box = document.getElementById('messagetext') || document.querySelector('.alert_error, .alert_info');
    if (!box || !box.textContent.includes('搜索繁忙')) { sessionStorage.removeItem('sehuaBusyRetryLite'); return false; }
    const n = (+sessionStorage.getItem('sehuaBusyRetryLite') || 0) + 1;
    if (n > 5) { sessionStorage.removeItem('sehuaBusyRetryLite'); return false; }
    sessionStorage.setItem('sehuaBusyRetryLite', n);
    const tip = document.body.appendChild(document.createElement('div'));
    tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.8);color:#fff;padding:16px 24px;border-radius:8px;font-size:14px;z-index:99999;text-align:center;';
    let s = 4;
    tip.textContent = `搜索繁忙，${s} 秒后自动刷新（第 ${n}/5 次）...`;
    const t = setInterval(() => {
      if (--s > 0) tip.textContent = `搜索繁忙，${s} 秒后自动刷新（第 ${n}/5 次）...`;
      else { clearInterval(t); location.reload(); }
    }, 1000);
    return true;
  }

  function onDomReady() {
    if (location.pathname.includes('/search.php')) {
      if (searchBusyRetry()) return;
      searchPageMain();
    } else if (location.pathname.includes('/thread-') || location.search.includes('mod=viewthread')) detailPageMain();
    else if (location.pathname.includes('/forum.php') && !location.search) removeUnused();
    else listPageMain();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  else onDomReady();
})();

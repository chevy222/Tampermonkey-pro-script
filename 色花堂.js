// ==UserScript==
// @name         色花堂
// @namespace    http://98tang.com/
// @version      5.7
// @description  色花堂：去广告；PC 列表页注入移动版缩略图（横竖版按原比例、竖图最高 4:3 垂直居中裁切、每行最多 5 张、右上角图片总数角标；打开即全部加载，宽屏单列，日期搬到标题下；移动版无图的帖子从详情页补图）；图片加载队列对齐移动端节奏（4 张/秒、在途≤6、首屏突发 6），"新帖瀑布流"右边有队列模式开关（关闭即一次性全量加载，状态存本地）；详情页宽屏、正文图去懒加载；检索页宽屏单列 + 栏目过滤 + 搜索繁忙自动重试；右下角加载进度胶囊。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================ 哨兵 ============================

  // 防双注入：同版本已占位则退出；旧版本占位（值不同）不退出，改写哨兵接管
  if (document.documentElement.getAttribute('data-sehua') === '5.7') return;
  document.documentElement.setAttribute('data-sehua', '5.7');

  // ============================ 可调参数 ============================

  // 移动版 User-Agent，服务端据此分发触屏模板
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

  // GM 请求超时（毫秒）
  const REQUEST_TIMEOUT = 15000;

  // 取图池并发上限（检索页逐帖取图、列表页回捞共用）
  const MAX_CONCURRENT = 5;

  // 搜索繁忙自动刷新的次数上限
  const MAX_BUSY_RETRY = 5;

  // 从详情页取图时单帖最多取几张
  const MAX_DETAIL_IMGS = 5;

  // 移动版映射被拦后的重试次数与退避间隔
  const MOBILE_RETRY_TIMES = 2;
  const MOBILE_RETRY_DELAY = 1500;

  // 详情页请求被拦后的退避重试
  const DETAIL_RETRY_TIMES = 2;
  const DETAIL_RETRY_DELAY = 2000;

  // 缩略图之间的间距
  const THUMB_GAP = 8;

  // 进度胶囊全部结算后延迟多久淡出
  const PILL_HIDE_DELAY = 2500;

  // 检索页默认隐藏的栏目（同时是过滤开关的栏目清单）
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];

  // 过滤开关状态的 localStorage 键名
  const FILTER_KEY = 'sehuaFilterState';

  // 搜索繁忙重试计数的 sessionStorage 键名
  const BUSY_KEY = 'sehuaBusyRetry';

  // 图片加载节奏（对齐移动版实测：最大在途 6 路，滚动浏览约 3-6 张/秒）。
  // 与固定批间隔不同：令牌桶滚动发放、完成即抢下一张，不人为等整批
  const IMG_INFLIGHT_MAX = 6;
  const IMG_START_PER_SEC = 4;
  const IMG_TOKEN_CAP = 6;

  // 单张图最多占用配额多久再兜底释放（旧图床 wkt41.app 会黑洞挂起；限流时挂起的图也靠它快速判定失败，避免 6 个并发槽被死图吃满）
  const IMG_HOLD_TIMEOUT = 10000;

  // 队列模式开关状态的 localStorage 键名（'0'=关闭，恢复旧的一次性全量加载）
  const QUEUE_KEY = 'sehuaQueueMode';

  // ============================ 工具函数 ============================

  // 站内装饰图特征：静态图标、用户头像、占位图
  const isPlaceholder = url => ['static/image', 'uc_server', 'none.gif', 'thumb-ing'].some(m => url.includes(m));

  // val 为 null 时 new URL 会把它串成 "null" 并返回合法假地址，必须先挡
  const normalizeHttpUrl = val => { if (!val) return null; try { const u = new URL(val, location.href); return u.protocol.startsWith('http') ? u.href : null; } catch (e) { return null; } };

  // 从 img 上取真实图片地址（依次探测 data 属性，最后退回 src）
  function getRealSrc(img) {
    for (const a of ['file', 'zoomfile', 'data-original']) { const u = normalizeHttpUrl(img.getAttribute(a)); if (u && !isPlaceholder(u)) return u; }
    const u = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    return u && !isPlaceholder(u) ? u : null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const addStyle = css => document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

  // ============================ 网络请求 ============================

  // 带移动 UA 的 GET；被 safeid 挑战页拦下或解析抛错都返回 null
  const gmGet = (url, parse) => new Promise(resolve => GM_xmlhttpRequest({
    url, timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
    onload: resp => { try { resolve(resp.responseText.includes('safeid') ? null : parse(resp.responseText)); } catch (e) { resolve(null); } },
    ontimeout: () => resolve(null), onerror: () => resolve(null)
  }));

  // 移动版触屏模板取图（筛选参数透传）。
  // 返回 {map, fallback, totals}：map=tid->图址列表；fallback=有卡无图的 tid；
  // totals=tid->该帖图片总数（卡片右上角 .zttpsz，用于列表角标）。
  // null=被拦/失败由调用方重试；空页返回空对象，不重试
  const fetchMobileThumbs = (fid, page) => {
    const pairs = ['mobile=2'], sp = new URLSearchParams(location.search);
    ['filter', 'orderby', 'typeid', 'specialtype'].forEach(k => { if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k))); });
    return gmGet(`https://${location.hostname}/forum-${fid}-${page}.html?${pairs.join('&')}`, text => {
      const map = {}, fallback = [], totals = {};
      new DOMParser().parseFromString(text, 'text/html').querySelectorAll('.n5_htmk').forEach(el => {
        const tid = (el.querySelector('a[href*=viewthread]')?.href.match(/tid=(\d+)/) || [])[1];
        if (!tid) return;
        const urls = [];
        el.querySelectorAll('img').forEach(img => { const s = getRealSrc(img); if (s && !urls.includes(s)) urls.push(s); });
        const total = +(el.querySelector('.zttpsz')?.textContent || '').trim() || 0;
        if (urls.length) { map[tid] = urls; if (total) totals[tid] = total; } else fallback.push(tid);
      });
      return { map, fallback, totals };
    });
  };

  // 详情页抽图；null=被拦/超时（可重试），[]=帖子里没图（终态）
  const fetchDetailImages = tid => (async () => {
    for (let i = 0; i < DETAIL_RETRY_TIMES; i++) {
      const r = await gmGet(`https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`, text => {
        const urls = [];
        new DOMParser().parseFromString(text, 'text/html').querySelectorAll('.t_f img, .pcb img, .message img').forEach(img => {
          const u = getRealSrc(img);
          if (u && !urls.includes(u) && urls.length < MAX_DETAIL_IMGS) urls.push(u);
        });
        return urls;
      });
      if (r) return r;
      if (i < DETAIL_RETRY_TIMES - 1) await sleep(DETAIL_RETRY_DELAY);
    }
    return null;
  })();

  // ============================ 图片加载池 ============================
  // 对齐移动版图片加载节奏：同时在途 ≤6（其视口并发实测值）、每秒最多发起 4 张
  // （其滚动浏览实测节奏），首屏允许 6 张突发。完成/失败/超时立即释放配额抢下一张——
  // 与已否决的"固定批间隔"不同，不会因为等整批而人为拖慢

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
    // 关闭队列时把剩余任务立即放行（不占池配额，等价旧的一次性全量加载）
    const flushAll = () => {
      if (timer) { clearInterval(timer); timer = null; }
      queue.splice(0).forEach(task => task(() => {}));
    };
    return { load, flushAll };
  })();

  // 列队模式：开=走加载池（对齐移动端节奏）；关=每张图立即发请求（旧行为）
  let queueEnabled = true;

  function setQueueMode(on) {
    queueEnabled = on;
    if (!on) imgLoader.flushAll();
  }

  // 列队模式开关：插在"新帖瀑布流"导航项（#mn_portal）右边。
  // queueEnabled 的初始化在 onDomReady 里无条件做——不能依赖本函数，否则没有导航项的页面上开关状态会失效
  function injectQueueSwitch() {
    const li = document.getElementById('mn_portal');
    if (!li || document.getElementById('sehua-queue-switch')) return;
    let on = true;
    try { on = localStorage.getItem(QUEUE_KEY) !== '0'; } catch (e) {}
    const box = document.createElement('li');
    box.id = 'sehua-queue-switch';
    box.innerHTML = '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none;color:#fff;font-size:14px;font-weight:700;padding:0 10px;white-space:nowrap;"><input type="checkbox"' + (on ? ' checked' : '') + '>队列模式</label>';
    li.insertAdjacentElement('afterend', box);
    box.querySelector('input').addEventListener('change', e => {
      try { localStorage.setItem(QUEUE_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
      setQueueMode(e.target.checked);
    });
  }

  // 让一张图计入胶囊并开始加载：建节点时立即计数（分母一次定型），
  // 队列模式走加载池（对齐移动端节奏），关闭队列则立即发请求（旧行为）；
  // url 为 null 表示图已由站点直出真址、脚本只接管计数与结算（不改 src，避免重发请求）
  // load/error/超时各结算一次（超时兜底，防黑洞图卡住分母）
  function trackImage(img, url) {
    if (img.dataset.watched) return;   // 同一节点只计一次
    img.dataset.watched = '1';
    pill.add(1);
    let settledHere = false, timedOut = false;
    const settle = failed => { if (!settledHere) { settledHere = true; pill.settle(failed); } };
    // 默认框即 4:3 横框（横图/方图加载前后不跳框）；只有竖图在加载完成后切 3:4 竖框（裁上下）
    const markOrientation = () => {
      const a = img.closest('a');
      if (a && img.naturalWidth && img.naturalWidth < img.naturalHeight) a.classList.add('sehua-port');
    };
    const start = poolDone => {
      let released = false;
      const release = () => { if (released) return; released = true; clearTimeout(to); if (poolDone) poolDone(); };
      const to = setTimeout(() => { timedOut = true; settle(true); release(); }, IMG_HOLD_TIMEOUT);
      img.addEventListener('load', () => {
        markOrientation();
        if (timedOut) pill.correctFailed(); else settle(false);   // 迟到成功：回退失败计数
        release();
      }, { once: true });
      img.addEventListener('error', () => { settle(true); release(); }, { once: true });
      if (url) img.setAttribute('src', url);
      // 设 src（或接管直出图）后若图已完成（缓存命中），load 事件不会再触发，需同步结算
      if (img.complete) { if (img.naturalWidth > 0) { markOrientation(); settle(false); } else settle(true); release(); }
    };
    if (!url) start(null);
    else if (queueEnabled) imgLoader.load(start); else start(null);
  }

  // ============================ 缩略图 ============================

  // 宽度规则：1-2 张均分半行，3 张及以上每行最多 5 张换行
  const thumbWidthRule = n => {
    const cols = Math.min(Math.max(n, 1), 5);
    return n <= 1 ? '50%' : `calc((100% - ${(cols - 1) * THUMB_GAP}px) / ${cols})`;
  };

  // DOM-API 构造缩略图容器——不能 innerHTML 拼 URL，图址含引号会破坏结构。
  // total=该帖图片总数（移动版角标值），有则右上角显示角标（对齐移动端语义）。
  // img 保留移动端的 data-original / class 结构（站点 .lazy 无隐藏样式，实测安全）
  function createThumbWrap(tid, urls, total) {
    const wrap = document.createElement('div');
    wrap.className = 'sehua-thumb';
    wrap.style.setProperty('--img-width', thumbWidthRule(urls.length));
    urls.forEach(u => {
      const a = document.createElement('a');
      a.href = `https://${location.hostname}/thread-${tid}-1-1.html`;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'lazy imagelist';
      img.setAttribute('data-original', u);
      // 站点详情页的 lazyload 用该标记跳过已处理的图；列表页当前没有 lazyload，
      // 但若站点将来加上，这个标记能防止注入图被提前设 src、绕过加载池节流
      img.setAttribute('lazyloaded', 'true');
      img.decoding = 'async';
      a.appendChild(img);
      wrap.appendChild(a);
      trackImage(img, u);   // 计数立即定型 + src 由加载池按移动端节奏设置
    });
    if (total > urls.length) {
      wrap.appendChild(Object.assign(document.createElement('span'), { className: 'sehua-num', textContent: total }));
    }
    return wrap;
  }

  // ============================ 样式 ============================

  // 宽屏：三层容器撑满 + 首页轮播撑满
  const WIDE_CSS = `
    .wp { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #nv { width: 100% !important; left: 0 !important; right: 0 !important; }
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
    #diy_chart { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #diy_chart .slideshow li { width: 100% !important; }
    #diy_chart .slideshow li img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
  `;

  // 缩略图版式（含宽屏底）
  const THUMB_CSS = WIDE_CSS + `
    .sehua-thumb { --img-width: 50%; position: relative; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: ${THUMB_GAP}px; margin-top: 8px; }
    .sehua-thumb > a { display: flex; align-items: center; justify-content: center; overflow: hidden; width: var(--img-width) !important; aspect-ratio: 4 / 3; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box; text-decoration: none; }
    .sehua-thumb img { width: 100% !important; height: 100% !important; object-fit: cover; object-position: center; display: block; }
    .sehua-thumb > a.sehua-port { aspect-ratio: 3 / 4; }
    .sehua-thumb > a.sehua-port img { height: auto !important; object-fit: fill; }
    .sehua-num { position: absolute; right: 8px; top: 8px; z-index: 1; padding: 0 6px; height: 18px; line-height: 18px; font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.55); border-radius: 3px; pointer-events: none; }
    .sehua-date { display: inline-block; margin: 4px 0 0 8px; font-size: 12px; color: #999; }
  `;

  // 检索页宽屏单列：结果列表整列撑满
  const SEARCH_CSS = `
    .slst.mtw { width: 100% !important; box-sizing: border-box !important; }
    #threadlist { width: 100% !important; }
    #threadlist li.pbw { width: 100% !important; box-sizing: border-box !important; }
  `;

  // 进度胶囊样式（沿用旧版式）
  const PILL_CSS = `
    #sehua-progress { position: fixed; right: 14px; bottom: 14px; z-index: 99999; padding: 7px 14px; border-radius: 999px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 12px; line-height: 1.4; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: opacity 0.3s ease; pointer-events: none; }
    #sehua-progress.sehua-done { background: rgba(35, 120, 60, 0.85); }
    #sehua-progress.sehua-partial { background: rgba(150, 70, 20, 0.88); }
  `;

  // ============================ 加载进度胶囊 ============================
  // 只统计脚本触发加载的图，原生 load/error 即结算，全部完成后延迟淡出。
  // 不感知图床、不做请求调度：浏览器挂起的请求就如实显示 x/y

  const pill = {
    total: 0, settled: 0, failed: 0, el: null, timer: null,

    add(n) {
      this.total += n;
      clearTimeout(this.timer); this.timer = null;   // 新图入账，撤销淡出计时
      if (this.el) this.el.style.opacity = '';
      this.render();
    },

    settle(failed) { this.settled++; if (failed) this.failed++; this.render(); },

    // 超时判失败后图又延迟加载成功：回退失败计数。
    // 计数与可见性解耦：即使胶囊已移除也必须扣，否则陈旧失败值会在下一批 add() 重建时被重新显示；
    // 只有"重渲染"受可见性限制（render 会 mount 重建节点，已淡出的胶囊不能被复活）
    correctFailed() {
      if (this.failed > 0) this.failed--;
      if (this.el && this.el.isConnected) this.render();
    },

    render() {
      if (!this.total) return;
      const el = this.mount(); if (!el) return;
      const done = this.settled >= this.total;
      el.classList.toggle('sehua-done', done && !this.failed);
      el.classList.toggle('sehua-partial', done && this.failed > 0);
      el.textContent = done
        ? (this.failed ? `缩略图 ${this.total - this.failed}/${this.total}（${this.failed} 张失败）` : `缩略图 ${this.total} 张已加载`)
        // 分子统一用"成功数"（settled - failed），与终态语义一致：中间态不会有"分子+失败>分母"，终态切换时分子只增不减
        : `缩略图已成功 ${this.settled - this.failed}/${this.total}${this.failed ? `（${this.failed} 张失败）` : ''}`;
      if (done && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.hide(); }, PILL_HIDE_DELAY);
    },

    mount() {
      if (this.el && this.el.isConnected) return this.el;
      const parent = document.body || document.documentElement; if (!parent) return null;
      this.el = Object.assign(document.createElement('div'), { id: 'sehua-progress' });
      parent.appendChild(this.el);
      return this.el;
    },

    hide() {
      const el = this.el; if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => { el.remove(); this.el = null; }, 400);   // 只摘节点不清计数：后续再注入图胶囊能重建
    }
  };

  // ============================ 去广告 ============================

  // 垃圾元素 + 表格里非帖子行（公告/空表头/广告行）。
  // #autopbn 是 autoloadpage 插件的 AJAX 翻页浮动按钮：很少点、且和宽屏单列版式冲突，
  // 随广告一并清掉；翻页用页面里的标准分页链接（.pg 内的页码/下一页，整页跳转脚本会正常处理）
  function removeUnused() {
    // 注意：不清 .show-text2——它是列表页"查看今日新帖"入口行，删了站点功能就断了
    document.querySelectorAll('#autopbn, .show-text.cl, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    document.querySelectorAll('#threadlisttableid tbody:not([id^=normalthread_]):not([id^=stickthread_])').forEach(tb => {
      // 保留：分页行、"今日新帖"分隔行（站点 forumchecknew 依赖 #separatorline，删了 console 报 parentNode 错误）、"查看新帖"入口行
      if (tb.querySelector('.pg') || tb.id === 'separatorline' || tb.querySelector('.show-text2')) return;
      tb.remove();
    });
    // 表头/分隔空行都是多列（5 列：图标 30px/标题/作者/回复/最后发表），而站点给表格设了
    // table-layout: fixed——列宽由这些行决定，单列化后的数据行标题 th 就被压进 30px 图标列（竖排）。
    // 非帖子行里的多列行全部删掉（#separatorline 的 tbody 本身保留——站点 forumchecknew 依赖它；
    // 单列行如"查看新帖"入口不动）
    document.querySelectorAll('#threadlisttableid > tbody > tr').forEach(tr => {
      if (tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]')) return;   // 帖子行不动
      if (tr.children.length > 1) tr.remove();
    });
  }

  // ============================ 列表页 ============================

  // 发帖日期搬到标题下：外层 span 担纲样式，em 原类名保留
  function relocateDate(tr, th) {
    const em = tr.querySelector('td.by em');
    if (!em) return;
    const box = document.createElement('span');
    box.className = 'sehua-date';
    th.appendChild(box).appendChild(em);
  }

  async function listPageMain() {
    const m = location.href.match(/forum-(\d+)-(\d+)\.html/), p = new URLSearchParams(location.search);
    const fid = m ? m[1] : p.get('fid');
    if (!fid || !document.getElementById('threadlisttableid')) return;

    addStyle(THUMB_CSS + PILL_CSS + ' #threadlisttableid { table-layout: fixed !important; width: 100% !important; } #threadlisttableid th { width: 100% !important; padding-right: 12px; }');
    removeUnused();   // 顺带清掉 #autopbn 浮动翻页按钮（见函数注释）

    // 移动版映射：仅被拦（null）才重试，空页不重试
    let r = null;
    for (let i = 0; i < MOBILE_RETRY_TIMES && !r; i++) { if (i) await sleep(MOBILE_RETRY_DELAY); r = await fetchMobileThumbs(fid, m ? +m[2] : (+p.get('page') || 1)); }
    const map = r ? r.map : {}, fallback = r ? r.fallback : [], totals = r ? (r.totals || {}) : {};

    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const tbody = tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]'), th = tr.querySelector('th');
      if (!tbody || !th) return;
      relocateDate(tr, th);
      tr.querySelectorAll('td').forEach(td => td.remove());   // 单列化：删掉作者/回复等列
      const tid = (tbody.id.match(/\d+/) || [])[0];
      if (map[tid] && !th.querySelector('.sehua-thumb')) th.appendChild(createThumbWrap(tid, map[tid], totals[tid]));
    });

    // 回捞：移动版有卡无图的帖子，从详情页补图（与检索页共用取图池）
    if (fallback.length) await loadFallbackThumbs(fallback);
  }

  // ============================ 详情页 ============================

  // 详情页去懒加载（占位图立即换真址 + lazyloaded 标记，站点滚动加载器跳过）+ 宽屏、正文撑满、图居中
  function detailPageMain() {
    if (!document.getElementById('postlist')) return;
    addStyle(WIDE_CSS + PILL_CSS + ' #postlist { width: 100% !important; } #postlist ignore_js_op { text-align: center; } #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; } #postlist div[style*="loading.gif"] { margin: 0 auto; }');
    removeUnused();
    document.querySelectorAll('#postlist img[file]').forEach(img => {
      const file = img.getAttribute('file'), cur = img.getAttribute('src');
      if (!file) return;
      // 占位图换址走加载池；站点已直出真址的图只计入胶囊（不重设 src，避免重发请求）
      trackImage(img, (!cur || isPlaceholder(cur)) ? file : null);
      img.setAttribute('lazyloaded', 'true');
    });
  }

  // ============================ 检索页 ============================

  // 栏目过滤开关：勾选的栏目隐藏对应结果，状态记在本地
  function addForumSwitches() {
    const sttl = document.querySelector('.sttl.mbn');
    if (!sttl) return null;
    sttl.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:8px;';
    const wrap = Object.assign(document.createElement('div'), { className: 'sehua-forum-switch', style: 'display:flex; gap:12px; align-items:center; font-size:12px;' });
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'); } catch (e) {}
    BLOCK_FORUMS.forEach(name => {
      wrap.insertAdjacentHTML('beforeend', `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;"><input type="checkbox" data-forum="${name}"${(saved[name] ?? true) ? ' checked' : ''}><span>隐藏${name}</span></label>`);
    });
    sttl.appendChild(wrap);
    return wrap;
  }

  function applyFilter() {
    const hidden = {};
    document.querySelectorAll('.sehua-forum-switch input:checked').forEach(cb => hidden[cb.dataset.forum] = 1);
    document.querySelectorAll('#threadlist li.pbw').forEach(li => {
      const fl = li.querySelector('a[href*=forum-]'); li.style.display = hidden[fl ? fl.textContent.trim() : ''] ? 'none' : '';
    });
  }

  // 取图池核心：并发逐帖取详情图，注入 target 并计入胶囊
  async function runThumbPool(tasks) {
    let i = 0;
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, async () => {
      while (i < tasks.length) {
        const task = tasks[i++];
        const tip = task.target.appendChild(Object.assign(document.createElement('div'), { className: 'sehua-loading', textContent: '加载中...' }));
        try {
          const urls = await fetchDetailImages(task.tid);
          if (urls === null) continue;                  // 被拦：不标记，下次刷新再试
          task.target.dataset.sehuaChecked = '1';
          if (urls.length && !task.target.querySelector('.sehua-thumb')) {
            task.target.appendChild(createThumbWrap(task.tid, urls));
          }
        } finally { tip.remove(); }
      }
    }));
  }

  let loadingThumbs = false, pendingReload = false;

  // 检索页：只对可见（未被过滤）的结果取详情图；运行中再触发会补跑一轮
  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }
    loadingThumbs = true;
    try {
      const tasks = [...document.querySelectorAll('#threadlist li.pbw')]
        .filter(li => li.style.display !== 'none' && !li.querySelector('.sehua-thumb') && !li.dataset.sehuaChecked)
        .map(li => ({ tid: (li.id.match(/\d+/) || [])[0], target: li }))
        .filter(t => t.tid);
      await runThumbPool(tasks);
    } finally {
      loadingThumbs = false;
      if (pendingReload) { pendingReload = false; loadDetailThumbs(); }
    }
  }

  // 列表页回捞：移动版映射里没给出图的帖子，从详情页补图
  async function loadFallbackThumbs(tids) {
    const tasks = [...document.querySelectorAll('#threadlisttableid tbody[id^=normalthread_], #threadlisttableid tbody[id^=stickthread_]')]
      .map(tb => ({ tid: (tb.id.match(/\d+/) || [])[0], target: tb.querySelector('th') }))
      .filter(t => tids.includes(t.tid) && t.target && !t.target.querySelector('.sehua-thumb') && !t.target.dataset.sehuaChecked);
    if (tasks.length) await runThumbPool(tasks);
  }

  async function searchPageMain() {
    addStyle(THUMB_CSS + SEARCH_CSS + PILL_CSS + ' div.sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }');
    removeUnused();
    if (!document.querySelector('#threadlist li.pbw')) return;   // 空结果页直接退出
    const bar = addForumSwitches();
    if (!bar) return;
    bar.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
      applyFilter();
      const st = {}; document.querySelectorAll('.sehua-forum-switch input').forEach(c => st[c.dataset.forum] = c.checked);
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(st)); } catch (e) {}
      loadDetailThumbs();
    }));
    applyFilter();
    await loadDetailThumbs();
  }

  // ============================ 搜索繁忙 ============================

  // 拦截页倒计时后自动刷新，最多 5 次（计数存 sessionStorage 跨刷新）。
  // 只认"搜索繁忙"（瞬时繁忙，重试有意义）；"搜索过于频繁…120秒"是冷却，不碰。
  // 任何页面都先清零计数，避免旧计数跨页面叠加
  function searchBusyRetry() {
    if (location.pathname.indexOf('/search.php') === -1) { sessionStorage.removeItem(BUSY_KEY); return false; }
    const box = document.getElementById('messagetext') || document.querySelector('.alert_error, .alert_info');
    if (!box || box.textContent.indexOf('搜索繁忙') === -1) { sessionStorage.removeItem(BUSY_KEY); return false; }
    const n = (+sessionStorage.getItem(BUSY_KEY) || 0) + 1;
    if (n > MAX_BUSY_RETRY) { sessionStorage.removeItem(BUSY_KEY); return false; }
    sessionStorage.setItem(BUSY_KEY, n);
    const tip = document.body.appendChild(document.createElement('div'));
    tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.8);color:#fff;padding:16px 24px;border-radius:8px;font-size:14px;z-index:99999;text-align:center;';
    let s = 4;
    tip.textContent = `搜索繁忙，${s} 秒后自动刷新（第 ${n}/${MAX_BUSY_RETRY} 次）...`;
    const t = setInterval(() => { if (--s > 0) tip.textContent = `搜索繁忙，${s} 秒后自动刷新（第 ${n}/${MAX_BUSY_RETRY} 次）...`; else { clearInterval(t); location.reload(); } }, 1000);
    return true;
  }

  // ============================ 路由 ============================

  function onDomReady() {
    // 队列模式初始化无条件做：没有"新帖瀑布流"导航项的页面也要同步 localStorage 状态
    try { queueEnabled = localStorage.getItem(QUEUE_KEY) !== '0'; } catch (e) {}
    injectQueueSwitch();   // 有"新帖瀑布流"导航项的页面才可见
    if (searchBusyRetry()) return;   // 任何页面都先过一遍：非搜索页清零计数，繁忙页进入倒计时
    if (location.pathname.includes('/search.php')) searchPageMain();
    else if (location.pathname.includes('/thread-') || location.search.includes('mod=viewthread')) detailPageMain();
    else if (location.pathname.includes('/forum.php') && !location.search) { addStyle(WIDE_CSS); removeUnused(); }
    else listPageMain();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  else onDomReady();
})();

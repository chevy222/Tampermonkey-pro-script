// ==UserScript==
// @name         色花堂
// @namespace    http://98tang.com/
// @version      5.27
// @description  色花堂：去广告；PC 列表页注入移动版缩略图（默认 4:3 横框，竖图加载完成后切 3:4 竖框，均居中裁切不拉伸；每行最多 5 张；右上角图片总数角标；宽屏单列，日期搬到标题下；移动版无图的帖子从详情页补图）；图片按队列节奏加载（默认 4 张/秒、在途≤6、首屏突发 6），"新帖瀑布流"右边有队列模式开关（关闭即一次性全量加载，状态存本地）；详情页宽屏、正文图去懒加载；检索页宽屏单列 + 栏目过滤 + 按筛选结果自动翻页补齐（凑不满一页就往后抓原站，最多 12 页）+ 拦截原因分类重试（验证码/未登录不重试，限频按原站给的等待秒数）；右下角加载进度胶囊（翻页重算，继续补齐累加）。
// @author       Chevy Yang
// @match        https://xtsa.wqfj3.com/*
// @connect      xtsa.wqfj3.com
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================ 哨兵 ============================

  // 防双注入：同版本已占位则退出；旧版本占位（值不同）不退出，改写哨兵接管
  if (document.documentElement.getAttribute('data-sehua') === '5.27') return;
  document.documentElement.setAttribute('data-sehua', '5.27');

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

  // 移动版映射的请求次数上限（含首次，不是"重试几次"）与退避间隔
  const MOBILE_MAX_TRIES = 2;
  const MOBILE_RETRY_DELAY = 1500;

  // 详情页取图的请求次数上限（含首次）与退避间隔
  const DETAIL_MAX_TRIES = 2;
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

  // 搜索页每页条数（原站一页 30 条，合并分页按它算"补满一页"的目标）
  const SEARCH_PER_PAGE = 30;

  // 合并分页：两次抓页的最小间隔，以及单轮最多自动补抓几页。
  // 12 页是实测定出来的：搜"探花"时 60 条原始结果只有 7 条能过默认过滤（命中率约 12%），
  // 想补满一页 30 条得往上翻 9 页左右。间隔不能小于 5 秒 —— 实测 2 秒时抓 3 页就被原站限频
  const SEARCH_FILL_GAP = 5000;
  const SEARCH_FILL_MAX = 12;

  // 图片加载节奏（对齐移动版实测：最大在途 6 路，滚动浏览约 3-6 张/秒）。
  // 与固定批间隔不同：令牌桶滚动发放、完成即抢下一张，不人为等整批
  const IMG_INFLIGHT_MAX = 6;
  const IMG_START_PER_SEC = 4;
  const IMG_TOKEN_CAP = 6;

  // 单张图最多占用池内并发/令牌配额多久就释放（防图床黑洞挂起占满并发槽，挡住后面的图）。
  // 只释放配额，不判定成败：之后图迟到落地照常补结算，永不落地则一直显示"等待中"等用户介入
  const IMG_HOLD_TIMEOUT = 10000;

  // 队列模式开关状态的 localStorage 键名（'0'=关闭，恢复旧的一次性全量加载）
  const QUEUE_KEY = 'sehuaQueueMode';

  // ============================ 工具函数 ============================

  // 判"这个地址不可能是图"，只认**明确的坏特征**，不做"没有扩展名就拒绝"。
  // 两个来源：
  //   1. 站内装饰图：静态图标、用户头像、占位图
  //   2. 站内被截断的附件路径：/data/attachment/h 这种末段只有 1-2 个字符、没有文件名的残址
  //      （真实附件名都是 forum/202610/17/172401p60httd033udmrqx.png 这种长串）
  // 为什么不用扩展名白名单：白名单意味着"不认识的格式一律当坏图"，图床每出一个新格式
  // （avif/jfif/heic/…）就得补一次，漏一个就把真图误判成占位、白跑一次详情页回捞；
  // 而 query 里带扩展名的（/resize?url=/photo/x.jpg）和无扩展名的 CDN（/i/8899）永远补不进来
  const isPlaceholder = url => {
    if (['static/image', 'uc_server', 'none.gif', 'thumb-ing'].some(m => url.includes(m))) return true;
    try { return /\/data\/attachment\/[^/.]{0,2}$/.test(new URL(url, location.href).pathname); } catch (e) { return true; }
  };

  // val 为 null 时 new URL 会把它串成 "null" 并返回合法假地址，必须先挡
  const normalizeHttpUrl = val => { if (!val) return null; try { const u = new URL(val, location.href); return u.protocol.startsWith('http') ? u.href : null; } catch (e) { return null; } };

  // 从 img 上取真实图片地址（依次探测 data 属性，最后退回 src）
  function getRealSrc(img) {
    for (const a of ['file', 'zoomfile', 'data-original']) { const u = normalizeHttpUrl(img.getAttribute(a)); if (u && !isPlaceholder(u)) return u; }
    const u = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    return u && !isPlaceholder(u) ? u : null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 同一段 CSS 只注入一次：拦截重试成功后会再调一次 searchPageMain()，
  // 不判重的话每次重试都往 head 里堆一份完整的样式表
  const injectedCss = new Set();
  const addStyle = css => {
    if (injectedCss.has(css)) return;
    injectedCss.add(css);
    document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  };

  // sessionStorage 在"禁用站点数据"、隐私模式等情况下，连 getItem 都会抛 SecurityError。
  // searchBusyRetry 是 onDomReady 的前置步骤，那里抛一次错就足以让缩略图、去广告、详情页全部停摆，
  // 所以本脚本所有 sessionStorage 访问都走这里，不再直接碰原生对象
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) {} }
  };

  // ============================ 网络请求 ============================

  // 带移动 UA 的 GET；被 safeid 挑战页拦下或解析抛错都返回 null
  const gmGet = (url, parse) => new Promise(resolve => GM_xmlhttpRequest({
    url, timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': MOBILE_UA, 'Cookie': 'mobile=2' },
    onload: resp => { try { resolve(resp.responseText.includes('safeid') ? null : parse(resp.responseText)); } catch (e) { resolve(null); } },
    ontimeout: () => resolve(null), onerror: () => resolve(null)
  }));

  // 搜索页专用 GET：保留状态码与响应头（gmGet 把失败原因吞成 null，分类重试需要它们）。
  // 刻意不带移动 UA —— 触屏模板里没有 #threadlist，合并分页只认 PC 模板
  const gmFetchRaw = url => new Promise(resolve => {
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        url, timeout: REQUEST_TIMEOUT,
        onload: resp => resolve({ status: resp.status, headers: resp.responseHeaders || '', text: resp.responseText || '' }),
        ontimeout: () => resolve({ status: 0, headers: '', text: '' }),
        onerror: () => resolve({ status: 0, headers: '', text: '' })
      });
      return;
    }
    // 没有 GM（脚本被以页面上下文注入时）退回同源 fetch，同样带超时
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
    fetch(url, { credentials: 'same-origin', signal: ctl.signal })
      .then(r => r.text().then(t => ({ status: r.status, headers: '', text: t })))
      .catch(() => ({ status: 0, headers: '', text: '' }))
      .then(v => { clearTimeout(timer); resolve(v); });
  });

  // 把一次失败的搜索响应归类：能不能重试、要等多久、给人看什么话。
  // 调用方必须先确认"页面里没有结果条目"再调它 —— 成功页正文里也可能出现"等待 N 秒"字样
  function classifySearchFailure(res) {
    const text = res.text || '', headers = res.headers || '';
    // status 0 = 请求根本没打通（超时 / 连接被拒 / DNS 失败）。这是网络问题，值得重试；
    // 之前落到最后的兜底分支会被判成"不可重试"，一次抖动就让合并分页永久放弃
    if (!res.status) return { retry: true, waitMs: 3000, msg: '请求原站失败（超时或连接中断）' };
    if (res.status === 429 || res.status === 408 || res.status >= 500) {
      const ra = (headers.match(/^retry-after:\s*(.+)$/im) || [])[1];
      let wait = 5000;
      if (ra) {
        const v = ra.trim();
        wait = /^\d+$/.test(v) ? (+v) * 1000 : Date.parse(v) - Date.now();
      }
      return { retry: true, waitMs: Math.min(Math.max(wait, 1000), 60000), msg: '原站返回 HTTP ' + res.status };
    }
    if (/验证码|安全验证|人机验证|checking your browser|just a moment|captcha/i.test(text))
      return { retry: false, msg: '原站要求验证，请手动打开搜索结果页处理' };
    if (/请先登录|尚未登录|需要登录|您需要登录/.test(text))
      return { retry: false, msg: '原站要求登录，请重新登录后再搜' };
    // 冷却类提示按原站给的秒数等。原站实际文案是"搜索过于频繁，请30秒后再试"——
    // "请"后面直接跟数字，所以不能只认"等待/请等/间隔"开头
    const sm = text.match(/(\d+)\s*秒(?:后|内|之后)/) || text.match(/(?:等待|请等|间隔)\s*(\d+)\s*秒/);
    if (sm) return { retry: true, waitMs: Math.max(1000, (+sm[1]) * 1000), msg: `原站要求等待 ${sm[1]} 秒` };
    if (/搜索繁忙/.test(text)) return { retry: true, waitMs: 4000, msg: '搜索繁忙' };
    if (/过于频繁|频率|稍后再|too many|rate.?limit/i.test(text))
      return { retry: true, waitMs: 10000, msg: '原站限制访问频率' };
    return { retry: false, msg: '搜索结果页没有结果条目' };
  }

  // 下一页地址：只认原站自己的 nxt 链接，别自己拼参数（searchid / searchmd5 会变）
  const searchNextUrl = doc => {
    const a = doc.querySelector('.pg a.nxt, .pages a.next, a.nxt');
    if (!a) return null;
    try { return new URL(a.getAttribute('href'), location.href).href; } catch (e) { return null; }
  };

  // 原站总页数：分页条只列当前页附近的几个页码 + 末尾页，取其中最大的 page 值即可。
  // 页面没有"共 N 页"文案，只能这么算
  const searchTotalPages = doc => {
    const pg = doc.querySelector('.pg, .pages');
    if (!pg) return 0;
    let max = 0;
    pg.querySelectorAll('a').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) max = Math.max(max, +m[1]);
    });
    return max;
  };

  // 把「下次该从原站第几页开始读」写进 URL 的 page 参数。
  // 刷新时服务端直接返回那一页，脚本接着往后补，不用从第 1 页重来。
  // 注意：这个 page 是原站页码，不是脚本自己的筛选结果页码，两者不是一个维度。
  // 用 replaceState 而不是 pushState——翻页不该在浏览器历史里堆一堆记录
  function syncUrlPage() {
    try {
      const url = new URL(location.href);
      url.searchParams.set('page', String(searchState.readPages + 1));
      history.replaceState(null, '', url);
    } catch (e) {}
  }

  // 抓一页搜索结果。成功判据是「解析出结果条目」而不是文案，避免被正文里的"等待/频繁"字样误杀
  async function fetchSearchPage(url) {
    const res = await gmFetchRaw(url);
    let doc = null, items = [];
    try {
      doc = new DOMParser().parseFromString(res.text || '', 'text/html');
      items = [...doc.querySelectorAll('#threadlist li.pbw')];
    } catch (e) { doc = null; }
    if (items.length) return { ok: true, doc, items, next: searchNextUrl(doc) };
    const info = classifySearchFailure(res);
    // 连 #threadlist 容器都没有、也没有任何提示文案 —— 这是 Discuz 搜索快照过期后的静默空壳页。
    // 这种情况重试没用（同一个 searchmd5 已经作废），只能重新搜索；要单独标出来给用户一条出路
    if (doc && !doc.getElementById('threadlist') && info.msg === '搜索结果页没有结果条目') {
      return { ok: false, retry: false, expired: true, msg: '搜索快照已失效（原站时效限制，隔太久不翻页就会过期）' };
    }
    return Object.assign({ ok: false, doc: null, items: [], next: null }, info);
  }

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
    for (let i = 0; i < DETAIL_MAX_TRIES; i++) {
      // 详情页抽图；null=被拦/超时（可重试），[]=帖子里没图（终态）。
      // gmGet 带的是移动 UA，站点会返回**触屏模板**——它没有 .t_f / .pcb（PC 版容器），
      // 正文图挂在 .plc（楼层）里，实测 3805180 上旧选择器只能命中 0 张、加 .plc 后能取到正文图。
      // 真机验证：6 个帖子里 5 个确实无图（新旧选择器都返回 0，头像被 getRealSrc 过滤掉），
      // 只有 3805180 有图但旧选择器漏了——所以这里必须同时覆盖两套模板
      const r = await gmGet(`https://${location.hostname}/forum.php?mod=viewthread&tid=${tid}`, text => {
        const urls = [];
        new DOMParser().parseFromString(text, 'text/html').querySelectorAll('.t_f img, .pcb img, .message img, .plc img').forEach(img => {
          const u = getRealSrc(img);
          if (u && !urls.includes(u) && urls.length < MAX_DETAIL_IMGS) urls.push(u);
        });
        return urls;
      });
      if (r) return r;
      if (i < DETAIL_MAX_TRIES - 1) await sleep(DETAIL_RETRY_DELAY);
    }
    return null;
  })();

  // ============================ 图片加载池 ============================
  // 图片加载池：同时在途 ≤6、每秒最多发起 4 张、首屏突发 6 张；完成即释放配额抢下一张

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
    const box = document.createElement('li');
    box.id = 'sehua-queue-switch';
    box.innerHTML = '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none;color:#fff;font-size:14px;font-weight:700;padding:0 10px;white-space:nowrap;"><input type="checkbox"' + (queueEnabled ? ' checked' : '') + '>队列模式</label>';
    li.insertAdjacentElement('afterend', box);
    box.querySelector('input').addEventListener('change', e => {
      try { localStorage.setItem(QUEUE_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
      setQueueMode(e.target.checked);
    });
  }

  // 让一张图计入胶囊并开始加载：建节点时立即计数（分母一次定型），
  // 队列模式走加载池（对齐移动端节奏），关闭队列则立即发请求（旧行为）；
  // url 为 null 表示图已由站点直出真址、脚本只接管计数与结算（不改 src，避免重发请求）
  // 结算路径：load/error 正常结算；超时只释放池配额并转入"等待中"，等图迟到落地再补结算——
  // 没有"超时两次判失败"的兜底，黑洞图会一直显示等待中，由用户刷新介入
  function trackImage(img, url) {
    if (img.dataset.watched) return;   // 同一节点只计一次
    img.dataset.watched = '1';
    const ep = pill.epoch;             // 绑定当前代际：翻页重置后这批图的迟到回调会被丢弃
    pill.add(1, ep);
    // settledHere = 这张图的最终状态已确定（成功或明确失败）。守卫放在分支之前，
    // 保证 load 和 error 各来一次也只结算一次（{once:true} 只管单个监听器自删，
    // 挡不住 load 成功后 src 又被改成坏址导致的第二次事件）。
    // 超时路径不置位——那时只是转入"等待中"，迟到落地还要靠 resolveUndecided 补结算
    let settledHere = false, timedOut = false;
    const settle = failed => { pill.settle(failed, ep); };
    // 默认框即 4:3 横框（横图/方图加载前后不跳框）；只有竖图在加载完成后切 3:4 竖框（裁上下）
    const markOrientation = () => {
      const a = img.closest('a');
      if (a && img.naturalWidth && img.naturalWidth < img.naturalHeight) a.classList.add('sehua-port');
    };
    const start = poolDone => {
      let released = false;
      const release = () => { if (released) return; released = true; clearTimeout(to); if (poolDone) poolDone(); };
      const to = setTimeout(() => { timedOut = true; pill.markUndecided(ep); release(); }, IMG_HOLD_TIMEOUT);
      img.addEventListener('load', () => {
        if (settledHere) { release(); return; }
        settledHere = true;
        markOrientation();
        if (timedOut) pill.resolveUndecided(true, ep); else settle(false);   // 迟到成功：补结算，不计失败
        release();
      }, { once: true });
      img.addEventListener('error', () => {
        if (settledHere) { release(); return; }
        settledHere = true;
        if (timedOut) pill.resolveUndecided(false, ep); else settle(true);   // 迟到明确失败：补结算 + 计失败
        release();
      }, { once: true });
      if (url) img.setAttribute('src', url);
      // 设 src（或接管直出图）后若图已完成（缓存命中），load 事件不会再触发，需同步结算
      if (img.complete) { settledHere = true; if (img.naturalWidth > 0) { markOrientation(); settle(false); } else settle(true); release(); }
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
    /* 比例用伪元素的百分比 padding 撑，不用 aspect-ratio。
       aspect-ratio 定容器高 + img height:100% 这条链在 Safari 上百分比高度可能解析失败，
       img 会退回自身比例渲染，object-fit 的裁切基准随之错位（表现为只裁某一边）。 */
    .sehua-thumb > a { display: block; position: relative; overflow: hidden; width: var(--img-width) !important; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box; text-decoration: none; }
    .sehua-thumb > a:before { content: ''; display: block; padding-top: 75%; }
    .sehua-thumb > a.sehua-port:before { padding-top: 133.3333%; }
    .sehua-thumb img { position: absolute; top: 0; left: 0; width: 100% !important; height: 100% !important; object-fit: cover; object-position: center; display: block; }
    .sehua-num { position: absolute; right: 8px; top: 8px; z-index: 1; padding: 0 6px; height: 18px; line-height: 18px; font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.55); border-radius: 3px; pointer-events: none; }
    .sehua-date { display: inline-block; margin: 4px 0 0 8px; font-size: 12px; color: #999; }
  `;

  // 检索页宽屏单列：结果列表整列撑满
  const SEARCH_CSS = `
    .slst.mtw { width: 100% !important; box-sizing: border-box !important; }
    #threadlist { width: 100% !important; }
    #threadlist li.pbw { width: 100% !important; box-sizing: border-box !important; }
    .sehua-pager { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 12px 0 4px; font-size: 12px; color: #666; }
    .sehua-pager button { padding: 3px 12px; border: 1px solid #ccc; background: #fff; border-radius: 3px; cursor: pointer; font-size: 12px; color: #333; }
    .sehua-pager button:disabled { opacity: .45; cursor: not-allowed; }
    .sehua-pager .sehua-pager-state { color: #888; }
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
    total: 0, settled: 0, failed: 0, undecided: 0, el: null, timer: null,
    // 代际号：翻页时 reset() 会 +1。上一页的图还在飞，load/error 照样会回调，
    // 靠它把这些迟到事件丢掉 —— 否则重置后 settled 会超过 total，显示"成功 5 · 共 0"
    epoch: 0,

    add(n, ep) {
      if (ep !== this.epoch) return;
      this.total += n;
      clearTimeout(this.timer); this.timer = null;   // 新图入账，撤销淡出计时
      if (this.el) this.el.style.opacity = '';
      this.render();
    },

    settle(failed, ep) {
      if (ep !== this.epoch) return;
      this.settled++; if (failed) this.failed++; this.render();
    },

    // 超时只释放池配额，图仍在等待响应——记为"未决"，不算失败（失败只认明确的 error：404/拒绝/解码失败）：
    // 胶囊不算完成、不淡出，文案显示"N 张等待中"，一直等到图真正落地或用户介入（刷新）。
    // 不做"超时两次就判失败"的兜底——那会制造 settled 越界、迟到误清计时器、宽限不顺延三类 bug，
    // 而且把"还在等"谎报成"失败了"。宁可让胶囊一直挂着等用户处理。
    markUndecided(ep) {
      if (ep !== this.epoch) return;
      this.undecided++;
      this.render();
    },

    // 未决图迟到落地：补结算。lateOk=true 迟到成功（不计失败），false 迟到明确失败。
    // 账上没有未决就直接返回：正常流程走不到这里，真走到了说明不变式已破（配对丢了），
    // 这时再多记一个 settled 会让"成功+失败+等待"超过"共"，宁可不记账也不谎报
    resolveUndecided(lateOk, ep) {
      if (ep !== this.epoch) return;
      if (!this.undecided) return;
      this.undecided--;
      this.settled++;
      if (!lateOk) this.failed++;
      this.render();
    },

    // 翻页（换成另一批内容）时清零重算，代际号 +1 让上一页的迟到回调失效。
    // 「继续补齐」是同一批继续往后加载，不调这里，计数继续累加
    reset() {
      this.epoch += 1;
      this.total = 0; this.settled = 0; this.failed = 0; this.undecided = 0;
      clearTimeout(this.timer); this.timer = null;
      if (this.el) { this.el.remove(); this.el = null; }
    },

    // 四段固定文案：成功/等待/失败语义不变，中间态与终态不再切换分子含义
    render() {
      if (!this.total) return;
      const el = this.mount(); if (!el) return;
      const done = this.settled >= this.total && this.undecided === 0;
      el.classList.toggle('sehua-done', done && !this.failed);
      el.classList.toggle('sehua-partial', done && this.failed > 0);
      const parts = [`成功 ${this.settled - this.failed}`];
      if (this.undecided) parts.push(`等待 ${this.undecided}`);
      if (this.failed) parts.push(`失败 ${this.failed}`);
      parts.push(`共 ${this.total}`);
      el.textContent = `缩略图：${parts.join(' · ')}`;
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
  // .show-text2 是列表/页脚里的赌博广告链（不是"查看新帖"入口——那由站点 AJAX 动态插入 #forumnewshow），随广告一并清
  function removeUnused() {
    document.querySelectorAll('#autopbn, .show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    document.querySelectorAll('#threadlisttableid tbody:not([id^=normalthread_]):not([id^=stickthread_])').forEach(tb => {
      // 保留：分页行、"今日新帖"分隔行（站点 forumchecknew 依赖 #separatorline，删了 console 报 parentNode 错）
      if (tb.querySelector('.pg') || tb.id === 'separatorline') return;
      tb.remove();
    });
    // 非帖子行里的多列行删掉，防止 table-layout:fixed 把标题列压窄
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
    for (let i = 0; i < MOBILE_MAX_TRIES && !r; i++) { if (i) await sleep(MOBILE_RETRY_DELAY); r = await fetchMobileThumbs(fid, m ? +m[2] : (+p.get('page') || 1)); }
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

  // 检索页状态：已抓到的全部条目（含自动补齐进来的）、脚本自己的页码、下一页地址。
  // 原站一页固定 30 条，过滤掉隐藏栏目后常只剩几条，所以不跟着原站翻页，
  // 而是自己维护页码，不够就往后抓页补满
  const searchState = {
    items: [],        // [{ el, forum, matches }]
    page: 1,          // 脚本自己的页码（筛选结果分页），和原站页码无关
    nextUrl: null,
    totalPages: 0,    // 原站一共多少页（从分页条最大页码推）
    readPages: 1,     // 已经读到原站第几页，刷新后从这页继续
    filling: false,
    paused: false,
    fetched: 0,       // 本轮已经补抓了几页（只管限流保护，点「继续补齐」会清零）
    error: '',
    expired: false    // 搜索快照失效：重试没意义，只能重新搜索
  };

  // 把 DOM 里所有结果条目收进 items（已在 items 里的跳过）
  function collectSearchItems() {
    const seen = new Set(searchState.items.map(it => it.el));
    document.querySelectorAll('#threadlist li.pbw').forEach(li => {
      if (seen.has(li)) return;
      const fl = li.querySelector('a[href*=forum-]');
      searchState.items.push({ el: li, forum: fl ? fl.textContent.trim() : '', matches: true });
    });
  }

  // 追加抓回来的条目，按 li 的 id（tid）去重，避免跨页重复
  function appendSearchItems(items) {
    const host = document.querySelector('#threadlist ul.ml') || document.querySelector('#threadlist ul') || document.getElementById('threadlist');
    if (!host) return 0;
    const seen = new Set(searchState.items.map(it => it.el.id));
    const frag = document.createDocumentFragment();
    let added = 0;
    items.forEach(li => {
      if (!li.id || seen.has(li.id)) return;
      seen.add(li.id);
      frag.appendChild(li);
      added += 1;
    });
    host.appendChild(frag);
    collectSearchItems();
    return added;
  }

  let searchPager = null;

  // 原站分页条隐藏（内容已跨页合并），换成脚本自己的分页条
  function mountSearchPager() {
    searchPager = document.querySelector('.sehua-pager');
    if (searchPager) return;
    const bar = document.createElement('div');
    bar.className = 'sehua-pager';
    const prev = Object.assign(document.createElement('button'), { type: 'button', textContent: '上一页' });
    const next = Object.assign(document.createElement('button'), { type: 'button', textContent: '下一页' });
    const more = Object.assign(document.createElement('button'), { type: 'button', textContent: '继续补齐' });
    const label = Object.assign(document.createElement('span'), { className: 'sehua-pager-state' });
    prev.addEventListener('click', () => gotoSearchPage(-1));
    next.addEventListener('click', () => gotoSearchPage(1));
    more.addEventListener('click', () => {
      // 快照失效后重试同一个 searchmd5 没用，只能拿同一个关键词重新发起一次搜索
      if (searchState.expired) { reSearchFromCurrent(); return; }
      searchState.paused = false; searchState.error = ''; searchState.fetched = 0;
      scheduleFill(); updateSearchPager();
    });
    bar.append(prev, next, more, label);
    const pg = document.querySelector('.pg');
    if (pg) { pg.style.display = 'none'; pg.insertAdjacentElement('beforebegin', bar); }
    else {
      const list = document.getElementById('threadlist');
      if (!list) return;
      list.insertAdjacentElement('afterend', bar);
    }
    searchPager = bar;
  }

  // 用当前关键词重新发起搜索（会拿到新的 searchid/searchmd5）。
  // 代价是从第 1 页重来，但搜索快照失效后这是唯一能继续读下去的路
  function reSearchFromCurrent() {
    const sp = new URLSearchParams(location.search);
    const kw = sp.get('kw') || sp.get('srchtxt');
    if (!kw) { location.reload(); return; }
    location.href = `search.php?mod=forum&srchtxt=${encodeURIComponent(kw)}&searchsubmit=yes`;
  }

  function gotoSearchPage(delta) {
    const st = searchState;
    if (st.filling) return;
    const before = st.page + delta;
    if (before < 1) return;
    // 本页还没补满时不许往后翻，先让补齐跑完
    if (delta > 0 && st.items.filter(it => it.matches).length < st.page * SEARCH_PER_PAGE) return;
    st.page = before;
    applyFilter();
    // 换页等于换一批内容：胶囊清零重算，只统计这一页的图。
    // 「继续补齐」是同一批继续往后加载，不重置 —— 那里保持累加
    pill.reset();
    // 新一页的帖子还没取过图，不在这里触发的话翻过去只有一排光标题
    loadDetailThumbs();
    const list = document.getElementById('threadlist');
    if (list && list.scrollIntoView) list.scrollIntoView({ block: 'start', behavior: 'smooth' });
    syncUrlPage();
    scheduleFill();
  }

  function updateSearchPager() {
    if (!searchPager) return;
    const st = searchState;
    const matched = st.items.filter(it => it.matches).length;
    const start = (st.page - 1) * SEARCH_PER_PAGE;
    const full = matched >= st.page * SEARCH_PER_PAGE;
    const [prev, next, more] = searchPager.querySelectorAll('button');
    const label = searchPager.querySelector('.sehua-pager-state');
    prev.disabled = st.page <= 1 || st.filling;
    // 下一页必须有东西才让点：matched 要超过当前页末尾。
    // 原来只判 full（当前页满没满），matched 恰好 = page×30 时仍可点，翻过去是空白页
    next.disabled = st.filling || matched <= st.page * SEARCH_PER_PAGE;
    // 只有正在请求时才禁用：之前 nextUrl 一被清空按钮就永久锁死，用户连重试都点不到
    more.disabled = st.filling;
    more.textContent = st.expired ? '重新搜索' : '继续补齐';
    const shown = Math.max(0, Math.min(SEARCH_PER_PAGE, matched - start));
    let tail;
    if (st.filling) tail = '正在读取原站下一页…';
    else if (st.expired) tail = st.error + '，点「重新搜索」用同一个关键词从头再搜';
    else if (st.error) tail = st.error + (st.nextUrl ? '（点「继续补齐」重试）' : '');
    else if (!st.nextUrl) tail = '已到底';
    else if (full) tail = '本页已满';
    // 补到单轮上限时 scheduleFill 已经不排定时器了，必须单独说明，
    // 否则会一直显示"正在补齐"却一个请求都不发
    else if (st.fetched >= SEARCH_FILL_MAX) tail = `本轮已补 ${SEARCH_FILL_MAX} 页，点「继续补齐」再抓`;
    else if (st.paused) tail = '已暂停补齐';
    else tail = '5 秒后继续补齐…';   // 这个状态只是在等定时器，并没有发请求
    const totalTxt = st.totalPages ? ` / ${st.totalPages}` : '';
    label.textContent = `第 ${st.page} 页 · 本页 ${shown} / ${SEARCH_PER_PAGE} 条 · 筛选后共 ${matched} 条 · 已读原站 ${st.readPages}${totalTxt} 页 · ${tail}`;
    // 「筛选后共」容易被读成"本次搜索命中"，这里补个悬浮说明
    label.title = '「筛选后共」= 已经抓下来的全部原始结果里，没被栏目过滤掉的总条数。'
      + '「已读原站」= 为了凑够这一页，一共往后翻了多少个原站页面（斜杠后面是原站总页数）。';
  }

  let fillTimer = null;

  function scheduleFill() {
    clearTimeout(fillTimer);
    const st = searchState;
    if (st.filling || st.paused || !st.nextUrl) return;
    if (st.fetched >= SEARCH_FILL_MAX) return;
    if (st.items.filter(it => it.matches).length >= st.page * SEARCH_PER_PAGE) return;
    fillTimer = setTimeout(fillNextPage, SEARCH_FILL_GAP);
  }

  async function fillNextPage() {
    const st = searchState;
    if (st.filling || st.paused || !st.nextUrl) return;
    st.filling = true;
    updateSearchPager();
    let r;
    try {
      r = await fetchSearchPage(st.nextUrl);
    } catch (e) {
      // 请求本身抛错也要把 filling 放开，否则补齐功能会永久卡在"正在读取"
      r = { ok: false, retry: true, msg: '抓取下一页失败：' + ((e && e.message) || e) };
    } finally {
      st.filling = false;
    }
    if (!r.ok) {
      st.error = r.msg || '抓取下一页失败';
      if (r.expired) st.expired = true;
      if (!r.retry) st.nextUrl = null;   // 验证码/未登录这类不可重试，别再自动试
      updateSearchPager();
      return;
    }
    appendSearchItems(r.items);
    st.nextUrl = r.next;
    st.fetched += 1;
    st.readPages += 1;
    st.error = '';
    applyFilter();
    loadDetailThumbs();
    syncUrlPage();   // 把"读到第几页"写进 URL，刷新后从这页接着读
    scheduleFill();
  }

  function applyFilter() {
    const hidden = {};
    document.querySelectorAll('.sehua-forum-switch input:checked').forEach(cb => hidden[cb.dataset.forum] = 1);
    const matched = [];
    searchState.items.forEach(it => {
      it.matches = !hidden[it.forum];
      if (it.matches) matched.push(it);
    });
    const start = (searchState.page - 1) * SEARCH_PER_PAGE;
    searchState.items.forEach(it => { it.el.style.display = 'none'; });
    matched.slice(start, start + SEARCH_PER_PAGE).forEach(it => { it.el.style.display = ''; });
    updateSearchPager();
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

    // 拦截重试换过 DOM 后会再进来一次：旧开关、旧分页条、旧状态都要重置
    document.querySelectorAll('.sehua-forum-switch, .sehua-pager').forEach(el => el.remove());
    searchPager = null;
    // URL 带 page 就说明上次读到这儿了，从这页接着读；fetched 单独归零，只用于限流保护
    const urlPage = Math.max(1, +(new URLSearchParams(location.search).get('page') || 1));
    Object.assign(searchState, { items: [], page: 1, totalPages: 0, readPages: urlPage, filling: false, paused: false, fetched: 0, error: '' });
    collectSearchItems();
    searchState.nextUrl = searchNextUrl(document);
    searchState.totalPages = searchTotalPages(document);

    // 过滤开关找不到容器（.sttl 结构变了）不该拖累分页条和补齐 —— 两件事互不依赖，
    // 之前这里 return 会让整套合并分页静默失效
    const bar = addForumSwitches();
    if (bar) bar.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
      searchState.page = 1;   // 换过滤条件回到第一页
      applyFilter();
      const st = {}; document.querySelectorAll('.sehua-forum-switch input').forEach(c => st[c.dataset.forum] = c.checked);
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(st)); } catch (e) {}
      loadDetailThumbs();
      scheduleFill();
    }));
    mountSearchPager();
    applyFilter();
    scheduleFill();
    await loadDetailThumbs();
  }

  // ============================ 搜索拦截重试 ============================

  // 拦截页不再整页 reload（那是重新注入脚本、重跑缩略图队列），改成 fetch 当前 URL
  // 增量换掉结果区。失败原因走 classifySearchFailure：验证码/未登录直接提示不重试，
  // "等待 N 秒"按原站说的等，HTTP 5xx 看 Retry-After。计数存 sessionStorage 跨刷新累计
  const showBusyTip = text => {
    const tip = document.body.appendChild(document.createElement('div'));
    tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.8);color:#fff;padding:16px 24px;border-radius:8px;font-size:14px;z-index:99999;text-align:center;max-width:80vw;line-height:1.6;';
    tip.textContent = text;
    return tip;
  };

  const countdown = (tip, ms, msg, n) => new Promise(done => {
    let left = Math.max(1, Math.ceil(ms / 1000));
    const paint = () => { tip.textContent = `${msg}，${left} 秒后重试（第 ${n}/${MAX_BUSY_RETRY} 次）…`; };
    paint();
    const t = setInterval(() => { left -= 1; if (left <= 0) { clearInterval(t); done(); } else paint(); }, 1000);
  });

  // 彻底失败（或本来就不该重试）时的提示：必须能关掉。
  // 之前只改文字不移除，一个 fixed + z-index:99999 的黑框会一直盖在页面正中央
  const dismissTip = (tip, text) => {
    tip.textContent = text + '（点击关闭）';
    tip.style.cursor = 'pointer';
    tip.addEventListener('click', () => tip.remove(), { once: true });
    setTimeout(() => { if (tip.isConnected) tip.remove(); }, 12000);
  };

  // 只换 #threadlist 和分页条，页面其余部分与脚本闭包状态都保留
  function replaceSearchResults(doc) {
    const fresh = doc && doc.getElementById('threadlist');
    const old = document.getElementById('threadlist');
    if (!fresh || !old) return false;
    old.replaceWith(fresh);
    const freshPg = doc.querySelector('.pg'), oldPg = document.querySelector('.pg');
    if (freshPg && oldPg) oldPg.replaceWith(freshPg);
    return true;
  }

  function searchBusyRetry() {
    if (location.pathname.indexOf('/search.php') === -1) { ss.del(BUSY_KEY); return false; }
    if (document.querySelector('#threadlist li.pbw')) { ss.del(BUSY_KEY); return false; }   // 有结果就不是拦截页
    const box = document.getElementById('messagetext') || document.querySelector('.alert_error, .alert_info');
    if (!box) { ss.del(BUSY_KEY); return false; }

    const info = classifySearchFailure({ status: 200, headers: '', text: document.body.textContent || '' });
    if (!info.retry) {
      ss.del(BUSY_KEY);
      // 没命中任何拦截特征（正常无结果页）就直接放行，别弹框拦路
      if (!info.msg || info.msg === '搜索结果页没有结果条目') return false;
      dismissTip(showBusyTip(''), info.msg);
      return true;
    }
    const n = (+ss.get(BUSY_KEY) || 0) + 1;
    if (n > MAX_BUSY_RETRY) { ss.del(BUSY_KEY); return false; }
    ss.set(BUSY_KEY, n);

    const tip = showBusyTip('');
    (async () => {
      let at = n, cur = info;
      for (;;) {
        await countdown(tip, cur.waitMs || 4000, cur.msg || '搜索繁忙', at);
        tip.textContent = '正在重新请求搜索结果…';
        const r = await fetchSearchPage(location.href);
        if (r.ok && replaceSearchResults(r.doc)) {
          ss.del(BUSY_KEY);
          tip.remove();
          searchPageMain();
          return;
        }
        cur = r;
        at += 1;
        if (!r.retry) { ss.del(BUSY_KEY); dismissTip(tip, r.msg || '重试失败，请手动刷新'); return; }
        if (at > MAX_BUSY_RETRY) { ss.del(BUSY_KEY); dismissTip(tip, `${r.msg}，已重试 ${MAX_BUSY_RETRY} 次仍失败`); return; }
        ss.set(BUSY_KEY, at);
      }
    })();
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

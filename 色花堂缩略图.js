// ==UserScript==
// @name         色花堂缩略图
// @namespace    http://98tang.com/
// @version      2.6
// @description  PC版列表页加载移动版缩略图、宽屏布局、清理无用元素；搜索页栏目过滤与详情图加载；详情页宽屏去广告；搜索繁忙自动刷新并宽屏；列表页按真实视口几何判定首屏优先加载，非首屏按需加载以节省带宽。
// @author       Chevy Yang
// @match        https://bhagq.4yl7j.com/*
// @connect      bhagq.4yl7j.com
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  // ============================ 可调参数 ============================

  // 移动版 User-Agent（GM 请求头；实测仅 mobile=2 不够，必须换 UA 才返回移动版内容）
  // 服务端凭此 UA 返回触屏模板 HTML，是整个缩略图方案成立的唯一开关，详见 fetchMobileThumbs 头部说明
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';

  // 请求超时（毫秒）
  const REQUEST_TIMEOUT = 15000;

  // 并发限制：同时最多发多少个详情图请求
  const MAX_CONCURRENT = 5;

  // 搜索繁忙最大自动重试次数（超过则停止刷新，避免无限循环）
  const MAX_BUSY_RETRY = 5;

  // 详情页单帖最大加载图片数
  const MAX_DETAIL_IMGS = 5;

  // 列表页每个帖子最多展示多少张缩略图
  // 实测触屏模板每个卡片给 2~3 张（30 帖 ≈ 60~61 张图）。注意这是带宽大户：
  // 单页 60 张实测合计 8.0MB（均值 136KB/张），改成 1 可省掉约一半流量，
  // 但会改变版式，故默认保持跟随移动版给出的张数（上限 5 只是防御性封顶）。
  // ⚠️ THUMB_CSS 只定义了 n1~n5 的宽度规则；把本值调到 5 以上时必须同步补
  // n6~nN 的 --img-width 规则，否则多出的图会按 5 列宽排导致换行错位
  const MAX_THUMBS_PER_POST = 5;

  // 移动版请求失败后的重试次数与退避间隔
  const MOBILE_RETRY_TIMES = 2;
  const MOBILE_RETRY_DELAY = 1500;

  // 详情页（fallback/搜索页取图）被拦截后的重试次数与退避基数
  // 实际间隔 = 基数 + 第几次×基数：2s / 4s
  const DETAIL_RETRY_TIMES = 3;
  const DETAIL_RETRY_BASE_MS = 2000;

  // 搜索页要过滤的栏目
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];

  // 过滤开关状态的 localStorage 键名
  const FILTER_STORAGE_KEY = 'sehuaFilterState';

  // 搜索繁忙重试计数的 sessionStorage 键名
  const BUSY_RETRY_KEY = 'sehuaBusyRetry';

  // 所有可能的懒加载属性（按优先级排序）
  const LAZY_ATTRS = ['file', 'zoomfile', 'data-original', 'data-src', 'data-loadsrc', 'data-thumb', 'data-lazy-src', 'original', 'data-url'];

  // ============ 首屏判定 / 非首屏加载策略 ============
  //
  // 【判据】逐行按 getBoundingClientRect().top 判断，不用固定行数。注入按 DOM 顺序逐行进行，
  // 处理到第 k 行时上面 k-1 行已插入缩略图且高度已定型（CSS 给了 aspect-ratio，无需等图加载即有
  // 正确盒高），因此第 k 行的 top 是准确的，天然适配任意窗口尺寸与滚动位置。
  // 固定行数在两处都不准：行高随窗口宽度成比例变化（缩略图按百分比宽），也随每帖图片张数变化。
  // 实测（1440x708、每帖 2 张）：行高恒 409px，一屏只见 1.7 行，前 2 行共 4 张被判为首屏。
  const FOLD_SLACK_PX = 120;   // 首屏下方留一点余量，半露出的行也按首屏处理

  function isAboveFold(tb) {
    return tb.getBoundingClientRect().top < window.innerHeight + FOLD_SLACK_PX;
  }

  // 【为什么非首屏不"到点全量放行"】旧策略（注入后 3.5s 无条件把全部非首屏图改 eager）实测会在
  // +3.99s 一次性涌出 48 张 / 约 6.4MB，而对照实验证明它对首屏耗时毫无帮助（只请求首屏 12 张：
  // 中位 246ms；60 张同时请求：首屏那 12 张中位 241ms）。即"非首屏抢带宽拖慢首屏"在本站并不成立
  // （浏览器本来就按视口/优先级排队），全量放行只会凭空替用户预下载数 MB。故改为按需加载。
  //
  // 【但仍保留兜底】原生 loading=lazy 在「后台/隐藏标签页」「元素无布局尺寸」时不会发起请求。
  // 折中：
  //   · 隐藏页一律不主动放行——用户不在看的时候替他下载整页图片才是真的浪费；
  //     页面重新可见后交给原生 lazy 处理（浏览器会立刻加载视口附近的图）。
  //   · 前台可见页用长时定时器兜底，防御浏览器懒加载启发式漏掉个别图而永久停在占位态。
  // ⚠️ 已知代价（有意保留，未加几何闸门）：本兜底只看"页面可见 + 还有 lazy 图"，不看位置，
  // 因此前台不滚动地停留满 10s，剩余非首屏图会被一次性全部转 eager。实测：T+4.5s 时仅请求 8 张 /
  // 共 62 张，T+13s 变成 62/62，日志为「兜底放行 56~58 张」，约合 7MB。若要更省流，
  // 应给下面的选择器再加一层几何条件（仅放行视口下方 2 屏内）——这是刻意留的取舍点。
  const LAZY_SAFETY_MS = 10000;
  let lazySafetyTimer = null;

  // 兜底放行：只在页面可见时执行
  function releaseStaleLazy() {
    lazySafetyTimer = null;
    if (document.visibilityState !== 'visible') return;   // 隐藏页交还给原生 lazy
    const imgs = document.querySelectorAll('.sehua-thumb img[loading="lazy"]');
    if (imgs.length === 0) return;
    log(`兜底放行 ${imgs.length} 张原生懒加载未取走的缩略图`);
    imgs.forEach(img => { img.loading = 'eager'; });
  }

  // 排期兜底（已排则不重复排，避免持续新增导致永不触发）
  // visibilitychange 监听改为首次排期时才注册：详情页/首页这类不会创建 lazy 缩略图的页面
  // 不必常驻，否则每次切回前台都白排一个 10s 定时器
  let visibilityBound = false;
  function scheduleLazySafety() {
    if (lazySafetyTimer) return;
    lazySafetyTimer = setTimeout(releaseStaleLazy, LAZY_SAFETY_MS);
    if (!visibilityBound) {
      visibilityBound = true;
      // 页面重新可见时补排一次兜底（隐藏期间被跳过的批次靠这里接上）
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleLazySafety();
      });
    }
  }

  // ============================ 工具函数 ============================

  // 运行日志开关：DEBUG=false 时叙事型日志全部静默，只保留 error / warn
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[色花堂缩略图]', ...args); };

  // 站内占位图标 / 用户头像 / base64 占位图的特征串，用于把装饰图排除在缩略图之外
  const PLACEHOLDER_MARKERS = ['static/image', 'uc_server', 'none.gif'];

  function isPlaceholder(url) {
    if (url.indexOf('data:') === 0) return true;
    return PLACEHOLDER_MARKERS.some(marker => url.indexOf(marker) !== -1);
  }

  // 归一化成 http(s) 绝对地址：协议相对（//host/a.jpg）与相对路径都还原。
  // 只用 startsWith('http') 判会把这两类静默丢弃——表现是整页缩略图消失、日志却只报"未找到结构"，
  // 排查方向会被完全带偏，故统一在这里收口。
  function normalizeHttpUrl(val, base) {
    if (!val) return null;
    try {
      const u = new URL(val, base || location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // 获取图片真实URL（从各种懒加载属性中提取，统一归一化）
  function getRealSrc(img) {
    for (const attr of LAZY_ATTRS) {
      const url = normalizeHttpUrl(img.getAttribute(attr));
      if (url && !isPlaceholder(url)) return url;
    }
    const url = normalizeHttpUrl(img.getAttribute('src') || img.currentSrc);
    if (url && !isPlaceholder(url)) return url;
    return null;
  }

  // 获取当前页面的论坛 ID 和页码
  // 兼容两种 URL：/forum-103-1.html 与 /forum.php?mod=forumdisplay&fid=103&page=1
  function getPageInfo() {
    const url = location.href;
    let fid = null, page = 1;
    const m1 = url.match(/forum-(\d+)-(\d+)\.html/);
    if (m1) {
      fid = m1[1];
      page = m1[2];
    } else {
      const params = new URLSearchParams(location.search);
      fid = params.get('fid');
      page = params.get('page') || 1;
    }
    return { fid, page };
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
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          next();
        }
      }
    }
  }

  // ============ 移动版缩略图获取原理 ============
  // 1. 核心机制：本站是 Discuz! X3.4 + n5 触屏模板，服务端只看请求头 User-Agent 分发模板。
  //    带 Android 移动 UA 请求 forum-{fid}-{page}.html，服务端直接返回触屏模板 HTML，
  //    其中每个帖子卡片是 <div class="n5_htmk">，缩略图真实地址在 <img data-original="https://tu.xxx/....jpg">。
  //
  // 2. 为什么必须用 GM_xmlhttpRequest（XHR）而不是让浏览器伪装 UA 直接访问：
  //    触屏模板自带的 static/js/mobile/common.js 里有 JS 守门逻辑：
  //      var supporttouch = "ontouchend" in document;
  //      !supporttouch && (window.location.href = 'forum.php?mobile=1');
  //    PC 浏览器没有触摸事件，即使带移动 UA 打开页面也会被 JS 踢回标准手机版（无缩略图）。
  //    而 GM_xmlhttpRequest 只拿原始 HTML 不执行 JS，守门脚本完全不生效 → 稳定取到触屏模板。
  //    〔实测复现〕同一移动 UA 关掉触屏模拟后 ontouchend=false → 确实跳 forum.php?mobile=1、
  //    卡片数 0；开启触屏模拟则停在触屏模板。所以这不是保守，而是必需。
  //
  // 3. 反爬（WAF）依赖浏览器会话 Cookie：
  //    站点有 _safe cookie 校验——不带 _safe 的请求只会收到 safeid JS 挑战页（isSafePage 可检测）。
  //    Tampermonkey 发 GM 请求时默认自动附上目标域名的浏览器 Cookie（_safe 随请求带出），
  //    下面 headers 里显式写的 Cookie: mobile=2 会被 TM「合并」到浏览器 Cookie 之后
  //    （TM 官方文档 cookie 条目 / 5.6.6239 更新日志 "merge given cookies"，不会覆盖丢失 _safe）。
  //    ⚠️ 本请求在 document-start 发出，此时 _safe 可能尚未建立（首次访问、浏览器重启后即是如此），
  //       于是这次抢跑必然拿到门页并被判为"疑似被反爬拦截"——属预期，不是故障。
  //       DOM 就绪后的带重试流程会补一次；若那时仍频繁被拦，多为请求过快被限流，内建重试会兜底。
  //
  // 4. 解析映射：.n5_htmk = 帖子卡片；卡片内 a[href*=viewthread] 的 tid=N 即帖子 ID
  //    （DOMParser 会把相对 href 解析成绝对地址，tid=(\d+) 正则照常命中）；
  //    缩略图地址由 getRealSrc 按 LAZY_ATTRS 依次探测（触屏模板用 data-original）；
  //    用户头像(/uc_server/...)与站内占位图标已被 getRealSrc 的 uc_server / static_image 过滤排除。
  //    实测命中率：forum-103 第 10~20 页共 11 页，全部为「30 个帖子拿到映射，0 个需回详情页兜底」。
  //
  // 5. mobile=2 双保险：URL 参数 + Cookie 都写 mobile=2，强制 Discuz 走触屏版（=2）
  //    而非标准手机版（=1，纯文字无图）。实测仅移动 UA 不带参数时服务端也会返回触屏模板，
  //    保留 mobile=2 意图更明确且无害。
  //
  // 6. 已知边界：置顶帖在移动版顶部是纯文字列表（无缩略图），因此 PC 列表的置顶行不会注入缩略图，
  //    属预期行为（与移动版展示一致），非 bug。〔实测〕该卡片没有 a[href*=viewthread]，被解析逻辑跳过。
  //
  // 7. 缩略图图床特性（决定了只能"少请求/按需请求"，无法靠缩放省流量）：
  //    · 只有原图，没有小图变体。前端 Cloudflare、回源 Backblaze B2（纯对象存储，不做图片处理），
  //      ?w= / ?imageView2/ / ?x-oss-process= / ?imageMogr2/ 等缩放参数全部被忽略。
  //    · 附加查询串安全：实测带 ?bsk=xxx 的 URL 70~72ms 正常返回同一张图（据此做过缓存破坏实验）。
  //    · ⚠️ 图床要求 Referer 必须是本站（无 Referer 直接 403），所以缩略图 <img> 绝不能设
  //      referrerPolicy="no-referrer"。
  //    · 浏览器自动协商 WebP（Vary: accept），无需脚本干预，实际下载量小于 curl 测得的 JPEG 体积。
  //    · Cache-Control: max-age=2592000（30 天），"冷缓存"只影响某个帖子第一次被看到。
  function fetchMobileThumbs(fid, page) {
    return new Promise((resolve) => {
      const sp = new URLSearchParams(location.search);
      const keepKeys = ['filter', 'orderby', 'typeid', 'specialtype'];
      const pairs = ['mobile=2'];
      keepKeys.forEach(k => { if (sp.get(k)) pairs.push(k + '=' + encodeURIComponent(sp.get(k))); });
      const qs = '?' + pairs.join('&');
      const url = `https://${location.hostname}/forum-${fid}-${page}.html${qs}`;
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: REQUEST_TIMEOUT,
        headers: {
          // UA 是服务端分发触屏模板的开关；Cookie 的 mobile=2 与 TM 自动附带的浏览器
          // Cookie（含 WAF 所需的 _safe）合并后一起发出，二者缺一不可的只有 _safe
          'User-Agent': MOBILE_UA,
          'Cookie': 'mobile=2'
        },
        onload: function(resp) {
          try {
            const doc = new DOMParser().parseFromString(resp.responseText, 'text/html');
            const thumbs = doc.querySelectorAll('.n5_htmk');
            if (thumbs.length === 0) {
              // 空结果的两种根因要区分开：反爬拦截页 vs 自定义 UA 头未生效拿到 PC 版
              if (isSafePage(resp.responseText)) {
                console.warn('[色花堂缩略图] 移动版请求被 safe 挑战页挡下（document-start 抢跑时 _safe 尚未建立，首访/浏览器重启后属预期，DOM 就绪后会带重试重取）:', url);
              } else {
                console.warn('[色花堂缩略图] 未找到移动版结构(.n5_htmk)，可能自定义 User-Agent 头未生效而拿到了 PC 版页面');
              }
            }
            const mapping = {};
            const fallbackTids = [];
            thumbs.forEach(el => {
              const link = el.querySelector('a[href*=viewthread]');
              if (!link) return;
              const tid = link.href.match(/tid=(\d+)/)?.[1];
              if (!tid) return;
              const imgs = el.querySelectorAll('img');
              const urls = [];
              imgs.forEach(img => {
                const src = getRealSrc(img);   // 已归一化为 http(s) 绝对地址
                if (src && !urls.includes(src)) {
                  urls.push(src);
                }
              });
              if (urls.length > 0) {
                mapping[tid] = urls;
              } else {
                fallbackTids.push(tid);
              }
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

  // 判定一次移动版请求是否解析出有效内容（拦截页/空响应两者皆空）
  // 防御：调用点分布在入口抢跑、缓存写入、自动加载三处，上游理论上恒返回
  // { mapping, fallbackTids } 结构（fetchMobileThumbs 四个分支均 resolve、无 reject），
  // 但 GM API 缺失或异常时仍可能给出 null/undefined/部分字段，这里统一兜住，
  // 避免把「隐式依赖上游行为」变成整页崩溃（异常会冒泡到 onDomReady 的 try/catch，
  // 表现为整页缩略图静默消失，极难排查）
  function mobileResultOk(result) {
    if (!result) return false;
    return Object.keys(result.mapping || {}).length > 0 || (result.fallbackTids || []).length > 0;
  }

  // 带自动重试的获取：瞬时网络抖动或站点反爬拦截页不再导致整页无图
  function fetchMobileThumbsWithRetry(fid, page, left = MOBILE_RETRY_TIMES) {
    return fetchMobileThumbs(fid, page).then(result => {
      if (mobileResultOk(result) || left <= 0) return result;
      return new Promise(resolve => setTimeout(() => {
        fetchMobileThumbsWithRetry(fid, page, left - 1).then(resolve);
      }, MOBILE_RETRY_DELAY));
    });
  }

  // ============================ 样式 ============================

  // 全宽布局 CSS
  const WIDE_CSS = `
    .wp { width: 100% !important; margin: 0 !important; box-sizing: border-box !important; }
    #nv { width: 100% !important; left: 0 !important; right: 0 !important; }
  `;

  // 页面级布局修正
  const PAGE_CSS = `
    ${WIDE_CSS}
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
  `;

  // 缩略图相关 CSS
  // · n1~n5 的 --img-width 必须与 MAX_THUMBS_PER_POST 联动（见该常量处的约束说明）
  // · 书写顺序有讲究：通用 `img` 的 width:100% 必须放在 `> a / > img` 之前——两者特异性相同
  //   （都是 1 类 + 1 类型），靠源顺序决胜；反过来的话无 <a> 包裹的图片会被撑满整行宽
  // · 占位闪烁类名是 sehua-thumb-loading，与"加载中…"提示的 sehua-loading 刻意分开：
  //   搜索页给 sehua-loading 定义了 padding:8px，若共用类名会把在途缩略图内缩 8px（实测少 12.5%）
  const THUMB_CSS = `
    .sehua-thumb { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; --img-width: calc((100% - 32px) / 5); }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; transition: border-color 0.2s ease, transform 0.2s ease; }
    .sehua-thumb > a, .sehua-thumb > img { display: flex; align-items: center; justify-content: center; text-decoration: none; overflow: hidden; width: var(--img-width) !important; transition: width 0.2s ease; }
    .sehua-thumb img:hover { border-color: #4a90d9; transform: scale(1.03); }
    .sehua-thumb.n1 { --img-width: 50%; }
    .sehua-thumb.n2 { --img-width: 40%; }
    .sehua-thumb.n3 { --img-width: calc((100% - 16px) / 3); }
    .sehua-thumb.n4 { --img-width: calc((100% - 24px) / 4); }
    .sehua-thumb > a.portrait, .sehua-thumb > img.portrait { width: calc(var(--img-width) * 0.7) !important; }
    .sehua-thumb > a.portrait img, .sehua-thumb > img.portrait { aspect-ratio: 2/3; }
    .sehua-thumb img.sehua-thumb-loading { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: sehua-shimmer 1.5s infinite; }
    @keyframes sehua-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  `;

  // 统一注入 <style>
  function addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 强制容器内所有图片立即可见的页面级 CSS（搜索页传 #threadlist、详情页传 #postlist）
  function forceVisibleCSS(selector) {
    return `
      ${selector} img { opacity: 1 !important; visibility: visible !important; transition: none !important; }
      ${selector} img.lazy, ${selector} img.lazyload { opacity: 1 !important; visibility: visible !important; }
    `;
  }

  // 注入列表页 CSS
  function injectStyles() {
    addStyle(`
      ${PAGE_CSS}
      #threadlisttableid { table-layout: fixed !important; width: 100% !important; }
      #threadlisttableid th { width: 100% !important; padding-right: 0 !important; }
      ${THUMB_CSS}
    `);
  }

  // 删除无用元素 / 站内广告
  // 实测：两个 `*.pad-tb-10` 选择器在本站命中 0（模板已不带 pad-tb-10），真正要清的是 .show-text2
  // （表格内的博彩广告行）。那一行以前是被 processRow 的"删 td"顺手清掉的，属副作用，不能依赖，
  // 故这里给出显式规则。
  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text2, .show-text4, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
    // 表格内不属于帖子的行整块移除：`separatorline`（空表头行，高 0）与博彩广告行（58px）。
    // 实测该表每页恒定 32 个 tbody = 30 个 normalthread_ + 上述两个。
    // 只按 id 前缀判定，并给含分页的行留一条后路，避免模板改动时误删导航。
    document.querySelectorAll('#threadlisttableid tbody').forEach(tb => {
      if (/^(normalthread_|stickthread_)/.test(tb.id)) return;
      if (tb.querySelector('.pg')) return;
      tb.remove();
    });
  }

  // ============ 统一懒加载清除（列表/搜索/详情三页共用） ============

  // 强制单图立即加载：设真实 src、清除所有懒加载痕迹
  function forceEagerImg(img) {
    // 本站自绘的缩略图有自己的加载调度（见 createThumbWrap / scheduleLazySafety），
    // 必须排除，否则 MutationObserver 会把刚插入的非首屏图立刻改成 eager，
    // 按需加载策略当场失效
    if (img.closest && img.closest('.sehua-thumb')) return;

    const realSrc = getRealSrc(img);
    if (!realSrc) return;
    // 幂等保护：已处理的直接返回（也避免 observer 属性回环）
    if ((img.getAttribute('src') || '') === realSrc && img.getAttribute('lazyloaded')) return;
    img.src = realSrc;
    // Discuz 标记：防止论坛自身 showImage 滚动时重复处理（插占位、缩 1px、重设 src 中断重发）
    img.setAttribute('lazyloaded', 'true');
    img.removeAttribute('lazy');
    img.removeAttribute('loadsrc');
    img.removeAttribute('data-loadsrc');
    img.removeAttribute('data-lazy');
    img.classList.remove('lazy', 'lazyload', 'lazyloaded');
    img.loading = 'eager';   // 立即加载：不再用原生懒加载（后台标签页/无布局时 lazy 图不发起请求）
    img.decoding = 'async';  // 异步解码，不阻塞主线程渲染
  }

  // 当前页面的主内容容器（详情页 #postlist / 搜索页与列表页 #threadlist / 兜底 body）
  function mainContainer() {
    return document.getElementById('postlist')
      || document.getElementById('threadlist')
      || document.getElementById('threadlisttableid')
      || document.body;
  }

  // 全量立即加载
  function forceEagerAll() {
    mainContainer().querySelectorAll('img').forEach(forceEagerImg);
  }

  // 监听新增图片并立即修复（三页共用）
  function watchImages() {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(m => {
        if (m.type === 'childList') {
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.tagName === 'IMG') forceEagerImg(node);
            else node.querySelectorAll?.('img').forEach(forceEagerImg);
          });
        } else if (m.type === 'attributes' && m.target.tagName === 'IMG') {
          forceEagerImg(m.target);
        }
      });
    });
    // attributeFilter 刻意不含 'class'：每张缩略图加载完都会改 class，分页/筛选也会成片改，
    // 而 forceEagerImg 只依赖 src / 懒加载属性，监听 class 纯属噪音。
    // 地址属性清单由 LAZY_ATTRS 派生（与 getRealSrc 的探测表永不脱钩），另补 4 个状态属性：
    // src/lazy/loadsrc 是站点脚本会改写的，data-lazy 是 forceEagerImg 自己会 removeAttribute 的；
    // 是现清单的超集，只会多触发幂等回调，不会漏。
    observer.observe(mainContainer(), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: LAZY_ATTRS.concat(['src', 'lazy', 'loadsrc', 'data-lazy'])
    });
  }

  // 拦截 Discuz 懒加载（三页共用）
  // 【防御性保留，实测本站暂无对象】列表页 99 张 img 全是 static_image 占位/图标、img[data-original]
  // 命中 0；详情页 41 张里仅 2 张内容图，且 loading=lazy / class*=lazy / data-original 全为 0。
  // 即这两页本就没有懒加载可清，forceEagerImg 在此只是空转；保留是为了防未知模板变动，
  // 副作用可控——非 IMG 元素的 observe 仍走原生 IO（见下）。
  // ⚠️ 页面全局必须经 unsafeWindow 写入：脚本带 @grant 时脚本内的 window 是包装对象，
  //    读取会透传、但纯赋值只写进沙箱，页面侧看不到（这曾使下述覆盖长期静默失效）。
  const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function interceptLazyLoad() {
    // 若 Discuz 已初始化 lazyload（scroll 监听已通过闭包绑定到原始实例），
    // 清空其待加载队列 lazyload.imgs，避免滚动时 showImage 继续处理队列中的图片
    try {
      if (pageWindow.lazyload && pageWindow.lazyload.imgs) pageWindow.lazyload.imgs.length = 0;
    } catch (e) {}

    // 覆盖懒加载构造函数：后续任何 new lazyload() / LazyLoad() 都转为立即全量加载。
    // 必须是普通函数：箭头函数没有 [[Construct]]，页面脚本一旦 new 就直接抛 TypeError
    function fixAll() { forceEagerAll(); }
    pageWindow.LazyLoad = fixAll;
    pageWindow.lazyload = fixAll;

    // 拦截 IntersectionObserver：IMG observe 时立即修 + 手动以"已可见"状态触发回调
    const OriginalIO = pageWindow.IntersectionObserver;
    if (!OriginalIO) return;
    pageWindow.IntersectionObserver = function(callback, options) {
      const observer = new OriginalIO(callback, options);
      const originalObserve = observer.observe.bind(observer);
      observer.observe = function(target) {
        if (target.tagName === 'IMG') {
          forceEagerImg(target);
          const rect = target.getBoundingClientRect();
          try {
            callback([{
              isIntersecting: true,
              target: target,
              intersectionRatio: 1,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: performance.now()
            }], observer);
          } catch (e) {
            console.error('[色花堂缩略图] IO 回调异常:', e);
            originalObserve(target);
          }
        } else {
          originalObserve(target);
        }
      };
      return observer;
    };
    pageWindow.IntersectionObserver.prototype = OriginalIO.prototype;
  }

  // 三页通用的懒加载清理：立即清一遍 + 监听新增 + 覆盖构造函数
  // watch=false 仅首页使用：mainContainer() 在首页兜底到 document.body，挂 Observer 等于监听整个文档；
  // 实测首页 64 张图零懒加载、无动态新增场景，首轮 forceEagerAll 已全覆盖，无需监听
  function scrubPageLazyLoad(watch = true) {
    forceEagerAll();
    if (watch) watchImages();
    interceptLazyLoad();
  }

  // ============ 缩略图注入 ============

  // 创建缩略图容器
  //   urls  该帖的图片地址（本函数内部也会按 MAX_THUMBS_PER_POST 封顶）
  //   tid   帖子 ID，每张图包一层 <a target=_blank> 指向详情页（三个调用点都保证 tid 非空）
  //   eager true = 首屏（立即请求 + high 优先级）；false = 非首屏（原生懒加载，按需请求）
  function createThumbWrap(urls, tid, eager) {
    const wrap = document.createElement('div');
    // 封顶值必须与 MAX_THUMBS_PER_POST 联动：调大常量时若 class 仍是 n5，多出的图会按 5 列宽排版错位
    const n = Math.min(Math.max(urls.length, 1), MAX_THUMBS_PER_POST);
    wrap.className = 'sehua-thumb n' + n;
    const href = `https://${location.hostname}/thread-${tid}-1-1.html`;

    urls.forEach(url => {
      const img = document.createElement('img');
      img.decoding = 'async';   // 异步解码：解码不阻塞主线程渲染
      img.classList.add('sehua-thumb-loading');

      const container = document.createElement('a');
      container.href = href;
      container.target = '_blank';
      container.appendChild(img);
      wrap.appendChild(container);

      const onload = () => {
        img.classList.remove('sehua-thumb-loading');
        // 竖图（高>宽）单独缩小并改用 2/3 比例，避免被 3/2 的裁剪框切掉主体
        if (img.naturalHeight > img.naturalWidth) container.classList.add('portrait');
      };

      const onerror = () => {
        container.remove();
        // 整组全失败时连容器一起移除，避免在标题下留一段空白的 margin 间隙
        if (!wrap.querySelector('img')) wrap.remove();
      };

      img.addEventListener('load', onload, { once: true });
      img.addEventListener('error', onerror, { once: true });

      // 缓存兜底：complete 为 true 后不会再触发 load/error 事件——naturalWidth === 0 是被浏览器
      // 缓存住的失败结果，必须直接走 onerror，否则该图会带着 shimmer 占位永远卡住；
      // lazy 图在预取距离内也可能立即命中缓存完成，事件已派发完毕，监听器收不到回调。
      // 手动结算与后续事件重复触发均幂等（onload 移 class 可重复、onerror remove 可重复）
      const settleIfComplete = () => {
        if (img.complete) {
          img.naturalWidth > 0 ? onload() : onerror();
        }
      };

      if (eager) {
        // 首屏：立即发起请求；high 让首屏图优先于页面其余图片
        img.loading = 'eager';
        img.fetchPriority = 'high';
        img.src = url;
        settleIfComplete();
      } else {
        // 非首屏：交给浏览器原生懒加载（会提前约一屏开始加载），不再设 src 就抢带宽。
        // 隐藏标签页下浏览器不会请求，此时由 releaseStaleLazy 在页面可见后兜底。
        img.loading = 'lazy';
        img.fetchPriority = 'low';
        img.src = url;
        settleIfComplete();
        scheduleLazySafety();
      }
    });

    return wrap;
  }

  // 注入缩略图；是否按首屏处理由行所在 tbody 的真实几何位置决定
  function injectThumb(tr, thumbMap) {
    if (!thumbMap) return;
    const th = tr.querySelector('th');
    const tbody = tr.closest('tbody');
    const tid = tbody?.id?.match(/\d+/)?.[0];
    if (tid && thumbMap[tid] && th && !th.querySelector('.sehua-thumb')) {
      th.appendChild(createThumbWrap(
        thumbMap[tid].slice(0, MAX_THUMBS_PER_POST),
        tid,
        tbody ? isAboveFold(tbody) : true
      ));
    }
  }

  // 处理单个 tr
  // 只处理真正的帖子行：表头行（tbody#separatorline）与博彩广告行等非帖子行不参与单列化与删 td
  function processRow(tr, thumbMap) {
    if (!tr.closest('tbody[id^=normalthread_], tbody[id^=stickthread_]')) return;
    const th = tr.querySelector('th');
    const tps = th?.querySelector('.tps');
    const firstBy = tr.querySelector('td.by');

    // 把发帖时间/作者从 td.by 挪到标题下方（随后整行 td 都会被删除，只保留单列标题）
    if (firstBy && th) {
      const em = firstBy.querySelector('em');
      if (em) {
        let target = tps;
        if (!target) {
          target = document.createElement('span');
          target.className = 'tps';
          target.style.cssText = 'display:inline-block; margin-top:4px; font-size:12px; color:#999;';
          th.appendChild(target);
        }
        em.style.marginLeft = '8px';
        target.appendChild(em);
      }
    }

    injectThumb(tr, thumbMap);
    // 单列化：删掉除 th 之外的所有单元格，标题获得整行宽度
    tr.querySelectorAll('td').forEach(td => td.remove());
  }

  // 处理表格
  function processTable(thumbMap) {
    let injected = 0, moved = 0, eagerPosts = 0, eagerImgs = 0;
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const th = tr.querySelector('th');
      const hadThumb = th?.querySelector('.sehua-thumb');
      const hadEm = th?.querySelector('.tps em');

      processRow(tr, thumbMap);

      if (!hadThumb && th?.querySelector('.sehua-thumb')) {
        injected++;
        // 单位注意：这里计的是"帖"，实际张数要另算（实测每帖 2 张，故首屏 2 帖 = 4 张）
        const highImgs = th.querySelectorAll('.sehua-thumb img[fetchpriority="high"]').length;
        if (highImgs > 0) { eagerPosts++; eagerImgs += highImgs; }
      }
      if (!hadEm && th?.querySelector('.tps em')) moved++;
    });
    log(`注入 ${injected} 个缩略图（首屏 ${eagerPosts} 帖 / ${eagerImgs} 张立即加载，其余交给原生按需加载），移动 ${moved} 个日期`);
  }

  // ============ 移动版缩略图缓存与预连接 ============

  const thumbCache = {};
  const pendingPages = {};

  // 会话级持久缓存：移动版映射的 TTL 与条数上限
  // 【为什么值得缓存】实测页面 DOM 约 425ms 就绪，而映射到达约 1.4s —— 首图在映射到达前无法开始，
  // 这段等待是首图关键路径上最大的一块。帖子列表变动不快，5 分钟内的同页复用足够安全。
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
      if (keys.length > PAGE_CACHE_MAX) keys.slice(0, keys.length - PAGE_CACHE_MAX).forEach(k => { delete all[k]; });
      sessionStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // 取某一页的移动版缩略图映射
  //   allowRetry=false 用于「文档开始时抢跑」的那次：只发一次，不与页面加载争资源；
  //   失败结果不写入任何缓存，让 DOM 就绪后的带重试流程可以重新发起。
  function fetchMobileThumbsByPage(fid, page, allowRetry = true) {
    const key = fid + '_' + page;   // 缓存键带 fid，避免跨版块同页码串缓存
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    const persisted = readPageCache(key);            // 会话级缓存命中：直接省掉整次移动版请求
    if (persisted) { thumbCache[key] = persisted; return Promise.resolve(persisted); }
    if (pendingPages[key]) return pendingPages[key];
    const fetchPromise = (allowRetry ? fetchMobileThumbsWithRetry(fid, page) : fetchMobileThumbs(fid, page))
      .then(result => {
        // 只缓存有效结果：拦截页/空响应不缓存，下次还能重试
        if (mobileResultOk(result)) {
          thumbCache[key] = result;
          writePageCache(key, result);
        }
        return result;
      })
      .finally(() => { delete pendingPages[key]; });  // 异常路径同样清理，否则同键此后一直拿到 rejected Promise
    pendingPages[key] = fetchPromise;
    return fetchPromise;
  }

  // ============ 缩略图图床的预连接 ============
  // 【为什么要"学"域名】图床与站点不同源，首个缩略图必须新开一次 DNS+TCP+TLS；而该域名一旦出现就
  // 长期稳定（实测 forum-103 的 10/11/12/13 页恒为同一域名）。把域名记下来，下次进列表页就能在
  // document-start 就预连接，把握手挪进"等待移动版映射"那段窗口里。
  // 只在拿到映射后才连，等于与图片请求同时起跑，收益≈0。
  // 注意不要加 crossorigin：本站缩略图是普通 <img>（非 CORS 请求），加了反而会多建一条连接。
  const IMG_HOST_KEY = 'sehuaImgHosts';
  const IMG_HOST_MAX = 4;

  function collectImageHosts(mapping) {
    const hosts = new Set();
    Object.values(mapping).forEach(urls => urls.forEach(u => {
      try { hosts.add(new URL(u, location.origin).origin); } catch (e) {}
    }));
    hosts.delete(location.origin);
    return [...hosts];
  }

  // 挂一条 preconnect。document-start 时 <head>/<html> 可能都还没建立，短暂重试即可
  // （映射到达通常在 1s 之后，几次 20ms 的延迟不影响收益）
  function preconnectHost(origin, tries = 0) {
    if (!origin || origin === location.origin) return;
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (tries < 10) setTimeout(() => preconnectHost(origin, tries + 1), 20);
      return;
    }
    if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;   // 去重
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    parent.appendChild(link);
  }

  // document-start 调用：用上次学到的图床域名抢先握手（首次访问时列表为空，无副作用）
  function preconnectLearnedHosts() {
    try {
      JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]').forEach(h => preconnectHost(h));
    } catch (e) {}
  }

  // 映射到手后：立即连（兜底）+ 记住域名（供下次提前连）
  function preconnectImageHosts(mapping) {
    const hosts = collectImageHosts(mapping);
    hosts.forEach(h => preconnectHost(h));
    if (hosts.length === 0) return;
    try {
      const prev = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]');
      localStorage.setItem(IMG_HOST_KEY, JSON.stringify([...new Set([...hosts, ...prev])].slice(0, IMG_HOST_MAX)));
    } catch (e) {}
  }

  // ============ 详情页取图（fallback） ============

  // 检测站点反爬拦截页（safe 挑战页：含 safeid 脚本，纯 XHR 无法通过）
  function isSafePage(text) {
    return typeof text === 'string' && text.indexOf('safeid') !== -1;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 从详情页加载图片；被反爬拦截/重试耗尽返回 null（区别于"帖子确实无图"的 []）
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
              const imgs = doc.querySelectorAll('.t_f img, .pcb img, .message img');
              const urls = [];
              imgs.forEach(img => {
                const u = getRealSrc(img);   // 已归一化为 http(s) 绝对地址
                if (u && urls.indexOf(u) === -1 && urls.length < MAX_DETAIL_IMGS) urls.push(u);
              });
              resolve(urls);
            } catch (e) {
              console.error('[色花堂缩略图] 详情页解析失败:', e);
              resolve([]);
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
        await sleep(DETAIL_RETRY_BASE_MS + attempt * DETAIL_RETRY_BASE_MS); // 退避：2s / 4s
      }
      console.error('[色花堂缩略图] 详情页请求被反爬拦截:', tid);
      return null;
    })();
  }

  // 并发加载 fallback 缩略图（列表页上移动版没给出缩略图的帖子，逐个回详情页取）
  async function loadFallbackThumbs(fallbackBatch, concurrency = MAX_CONCURRENT) {
    const pool = new ConcurrencyPool(concurrency);
    const tasks = fallbackBatch.map(tb => pool.add(async () => {
      const th = tb.querySelector('th');
      const tid = tb.id?.match(/\d+/)?.[0];
      if (!tid || !th || th.querySelector('.sehua-thumb')) return;
      const urls = await fetchDetailImages(tid);
      if (urls === null) {
        // 被反爬拦截：回滚标记，后续可重试（与搜索页 sehuaChecked 语义对齐）
        delete tb.dataset.sehuaDone;
        return;
      }
      if (urls.length > 0 && !th.querySelector('.sehua-thumb')) {
        th.appendChild(createThumbWrap(urls, tid, isAboveFold(tb)));
      }
    }));
    await Promise.all(tasks);
  }

  // ============ 列表页自动加载监听 ============
  //
  // ⚠️ 至今未能实测复现：站点确实加载了 static/js/autoloadpage.js、#autopbn 也存在且可见
  //    （rel="forum.php?mod=forumdisplay&fid=103&page=21"），但两种环境下滚到页底都没触发：
  //    ① Agent Window 后台标签页（document.hidden === true）；② 窗口切到前台（visible）后
  //    从顶部逐段滚到页底并等待 4s —— tbody 仍是 32→32，站点没有追加任何行。
  //    该分支按 Discuz 原版行为保留（校验、回滚、去重逻辑本身自洽），但属"未经真实触发验证"；
  //    若后续确认站点不再追加 tbody，这整段可直接删除。

  function watchAutoLoad(fid, initialPage) {
    const table = document.getElementById('threadlisttableid');
    if (!table) return;
    let loadedPage = initialPage;
    let pendingTbodies = [];
    let debounceTimer = null;
    const DEBOUNCE_MS = 300;

    function flushQueue() {
      // 定时器已触发：立即清空引用，否则失败分支的 if (!debounceTimer) 永远为假，
      // 回滚批次的延迟自动重试永远不会被调度（只能靠下一次滚动被动补跑）
      debounceTimer = null;
      if (pendingTbodies.length === 0) return;
      const batch = pendingTbodies.splice(0);
      const targetPage = loadedPage + 1;
      log(`自动加载第 ${targetPage} 页内容，处理 ${batch.length} 个帖子`);
      // 先完成单列化与日期搬移（此时还没有缩略图映射，只做结构处理）
      batch.forEach(tb => {
        const tr = tb.querySelector('tr');
        if (tr) processRow(tr, null);
      });
      fetchMobileThumbsByPage(fid, targetPage).then(result => {
        if (!mobileResultOk(result)) {
          // 拦截页/空响应：不推进页码、回滚标记，批次塞回队头等下一次触发重试（有上限，防打转）
          const tries = (parseInt(batch[0]?.dataset?.sehuaRetry || '0', 10) || 0) + 1;
          if (tries <= 3) {
            batch.forEach(tb => {
              delete tb.dataset.sehuaDone;
              tb.dataset.sehuaRetry = String(tries);
            });
            pendingTbodies.unshift(...batch);
            console.warn(`[色花堂缩略图] 第 ${targetPage} 页移动版请求无效（第${tries}次），已回滚待重试`);
            if (!debounceTimer) debounceTimer = setTimeout(flushQueue, DEBOUNCE_MS * 6);
          } else {
            batch.forEach(tb => {
              delete tb.dataset.sehuaRetry;
              // 放弃本批：恢复已处理标记，避免这些行之后再次出现在 DOM 变更中
              // 时被 observer 重新入队、又空转 4 轮请求
              tb.dataset.sehuaDone = '1';
            });
            console.warn(`[色花堂缩略图] 第 ${targetPage} 页连续 ${tries} 次请求无效，放弃本批`);
          }
          return;
        }
        loadedPage = targetPage;
        batch.forEach(tb => {
          delete tb.dataset.sehuaRetry;
          const tr = tb.querySelector('tr');
          // 追加进来的帖子一定在当前视口下方（用户是滚到底部才触发的），
          // injectThumb 内部的几何判断会自然把它们判为非首屏 → 走原生按需加载
          if (tr) injectThumb(tr, result.mapping);
        });
        const fallbackBatch = batch.filter(tb => {
          const tid = tb.id?.match(/\d+/)?.[0];
          return tid && result.fallbackTids.includes(tid);
        });
        if (fallbackBatch.length > 0) {
          loadFallbackThumbs(fallbackBatch);
        }
        // 结果有效但本批 tid 全部未命中：大概率页码漂移（多页内容并入一次 flush 等），提示排查
        if (batch.length >= 3) {
          const hit = batch.some(tb => {
            const tid = tb.id?.match(/\d+/)?.[0];
            return tid && (result.mapping[tid] || result.fallbackTids.includes(tid));
          });
          if (!hit) console.warn('[色花堂缩略图] 本批 tid 未命中任何缩略图映射，可能存在页码漂移');
        }
      });
    }

    const observer = new MutationObserver(mutations => {
      let foundNew = false;
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          const tbodies = node.tagName === 'TBODY' ? [node] : node.querySelectorAll ? node.querySelectorAll('tbody') : [];
          tbodies.forEach(tb => {
            if (tb.id && tb.id.indexOf('normalthread_') !== -1 && !tb.dataset.sehuaDone) {
              tb.dataset.sehuaDone = '1';
              pendingTbodies.push(tb);
              foundNew = true;
            }
          });
        });
      });
      if (foundNew) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushQueue, DEBOUNCE_MS);
      }
    });
    observer.observe(table, { childList: true, subtree: true });
    log('已监听自动加载，起始页 ' + initialPage);
  }

  // ============ 搜索页逻辑 ============

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
      cb.checked = savedState[name] ?? true;   // 默认全部勾选（=隐藏这些栏目）
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

  // 搜索页加载详情图
  let loadingThumbs = false;
  let pendingReload = false;
  async function loadDetailThumbs() {
    if (loadingThumbs) { pendingReload = true; return; }   // 并发保护：加载中再次触发则记录补跑
    loadingThumbs = true;
    try {
      const allLis = Array.from(document.querySelectorAll('#threadlist li.pbw'))
        .filter(li => li.style.display !== 'none'          // 被栏目过滤隐藏的不请求
          && !li.querySelector('.sehua-thumb')
          && !li.querySelector('.sehua-loading')
          && !li.dataset.sehuaChecked);                    // 已确认无图的帖不重复请求
      log(`搜索页加载 ${allLis.length} 个可见帖子的详情图（并发${MAX_CONCURRENT}）`);

      const pool = new ConcurrencyPool(MAX_CONCURRENT);
      const tasks = allLis.map(li => pool.add(async () => {
        const tid = (li.id || '').match(/\d+/)?.[0];
        if (!tid) return;
        const loading = document.createElement('div');
        loading.className = 'sehua-loading';
        loading.textContent = '加载中...';
        li.appendChild(loading);
        try {
          const urls = await fetchDetailImages(tid);
          loading.remove();
          // 被反爬拦截（null）：不标记已处理，下次筛选变化/重进页面还能重试
          if (urls === null) return;
          // 标记已处理，避免对无图帖子反复请求
          li.dataset.sehuaChecked = '1';
          if (urls.length > 0 && !li.querySelector('.sehua-thumb')) {
            // 与列表页同一套判据：视口内的立即加载，视口外的交给原生懒加载，
            // 避免搜索结果较多时一次性把几十个帖子的详情图全部拉下来
            li.appendChild(createThumbWrap(urls, tid, isAboveFold(li)));
          }
        } catch (e) {
          loading.remove();
        }
      }));
      await Promise.all(tasks);
    } finally {
      loadingThumbs = false;
      // 加载期间若又有筛选变化，补跑一次
      if (pendingReload) {
        pendingReload = false;
        loadDetailThumbs();
      }
    }
  }

  // 搜索页主流程
  async function searchPageMain() {
    addStyle(`
      ${PAGE_CSS}
      ${THUMB_CSS}
      /* 限定到 div：缩略图的占位闪烁用 sehua-thumb-loading，两者不能混，否则在途缩略图会被这里的内边距挤小 */
      div.sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }
      .slst.mtw { width: 100% !important; }
      ${forceVisibleCSS('#threadlist')}
    `);

    removeUnused();
    scrubPageLazyLoad();

    const switchWrap = addForumSwitches();
    if (!switchWrap) {
      // 未登录时 search.php 只返回空壳，没有 .sttl.mbn，直接跳过
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

  // 检测"搜索繁忙"
  function autoReloadOnSearchBusy() {
    if (location.pathname.indexOf('/search.php') === -1) {
      sessionStorage.removeItem(BUSY_RETRY_KEY);
      return false;
    }
    const msg = document.getElementById('messagetext');
    const text = msg ? msg.textContent : document.body.textContent;
    if (!text || text.indexOf('搜索繁忙') === -1) {
      sessionStorage.removeItem(BUSY_RETRY_KEY);
      return false;
    }

    let retryCount = parseInt(sessionStorage.getItem(BUSY_RETRY_KEY) || '0');
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

  // ============ 详情页主流程 ============

  function detailPageMain() {
    log('详情页模式');
    addStyle(`
      ${PAGE_CSS}
      #postlist { width: 100% !important; }
      #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; }
      #postlist ignore_js_op { text-align: center; }
      ${forceVisibleCSS('#postlist')}
    `);

    removeUnused();
    scrubPageLazyLoad();
  }

  // ============ 首页主流程 ============

  function homePageMain() {
    log('首页模式');
    addStyle(PAGE_CSS);
    removeUnused();
    // watch=false：首页不挂 MutationObserver（见 scrubPageLazyLoad 注释）
    scrubPageLazyLoad(false);
  }

  // ============ 列表页主流程 ============

  async function listPageMain() {
    const { fid, page } = getPageInfo();
    if (!fid) {
      log('非列表页，跳过');
      return;
    }

    // URL 是列表页但不代表正文就是帖子表格。
    // 首次访问 / 浏览器重启后（_safe 尚未建立）服务端返回「18+ 年龄门」中间页，URL 仍是 forum-103-1.html；
    // 此时既没有行可以注入，移动版请求也会被挡下。直接退出，省掉 3 次请求 + 2×1.5s 退避。
    if (!document.getElementById('threadlisttableid')) {
      log('页面无帖子表格（18+ 年龄门或异常页），跳过列表页处理；'
        + 'document-start 的抢跑请求在这种页面必然拿到门页、被判为"被 safe 挑战页挡下"，属预期而非故障');
      return;
    }

    injectStyles();
    removeUnused();
    scrubPageLazyLoad();

    const pageNo = parseInt(page);
    watchAutoLoad(fid, pageNo);

    log(`请求移动版: forum-${fid}-${page}.html?mobile=2（移动 UA）`);
    // 直接消费文档开始时抢跑的那个 Promise：Promise 可重复 await，成功路径命中缓存/pending，
    // 失败路径也不必再补发一次「不带重试」的请求
    let result = earlyListFetch ? await earlyListFetch : null;
    if (!result || !mobileResultOk(result)) {
      log('抢跑请求无效，改为带重试获取');
      result = await fetchMobileThumbsByPage(fid, pageNo, true);
    }
    // 防御性解构：带重试流程同样可能给出非预期结果（GM API 缺失/异常、上游改签名），
    // 一旦直接链式访问 result.mapping 就可能整页静默无图（异常会被 onDomReady 的 catch 吞掉）
    const mapping = (result && result.mapping) || {};
    const fallbackTids = (result && result.fallbackTids) || [];
    log(`获取到 ${Object.keys(mapping).length} 个帖子的缩略图，${fallbackTids.length} 个需从详情页加载`);

    // 预连接已学到的图床域名（抢跑分支在 document-start 已经连过，这里会自动去重）
    preconnectImageHosts(mapping);

    processTable(mapping);

    if (fallbackTids.length > 0) {
      const allTbodies = document.querySelectorAll('#threadlisttableid tbody[id^=normalthread_]');
      const fallbackBatch = Array.from(allTbodies).filter(tb => {
        const tid = tb.id?.match(/\d+/)?.[0];
        return tid && fallbackTids.includes(tid);
      });
      if (fallbackBatch.length > 0) {
        loadFallbackThumbs(fallbackBatch);
      }
    }
  }

  // ============ 入口 ============
  // @run-at document-start：本函数体在 <html> 解析前执行，此时只有 location 可用、DOM 还不存在。
  // 把两件不依赖 DOM 的事提前做掉：① 用上次学到的图床域名抢先握手；② 发出移动版请求。
  // 两者都与页面自身的 HTML/CSS/JS 加载并行；其后的 DOM 处理统一等 DOMContentLoaded。
  const earlyPageInfo = getPageInfo();
  let earlyListFetch = null;

  // 图床域名是长期稳定的，用上次学到的域名在 t=0 就建连，把握手挪出图片关键路径
  preconnectLearnedHosts();

  if (earlyPageInfo.fid) {
    earlyListFetch = fetchMobileThumbsByPage(earlyPageInfo.fid, parseInt(earlyPageInfo.page), false);
    // catch 必须补：GM API 缺失或抛同步异常时这个 Promise 会 reject，
    // 没有 catch 就是 unhandled rejection（控制台噪音，且掩盖真实失败原因）。
    // 这里失败无需处理——DOM 就绪后 listPageMain 仍会用带重试的流程重取一次
    earlyListFetch.then(result => {
      if (mobileResultOk(result)) preconnectImageHosts(result.mapping);
    }).catch(err => {
      console.warn('[色花堂缩略图] 抢跑请求异常，忽略（DOM 就绪后会带重试重取）:', err);
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
    // 兜底：若脚本被延迟注入（例如手动重跑），此时 DOM 已就绪
    onDomReady();
  }
})();

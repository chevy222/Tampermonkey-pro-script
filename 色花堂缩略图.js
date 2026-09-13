// ==UserScript==
// @name         色花堂缩略图
// @namespace    http://98tang.com/
// @version      2.4
// @description  PC版列表页加载移动版缩略图、宽屏布局、清理无用元素；搜索页栏目过滤与详情图加载；详情页宽屏去广告；搜索繁忙自动刷新并宽屏；列表页按真实视口几何判定首屏优先加载，非首屏按需加载以节省带宽。
//   v1.7：彻底移除全部懒加载（含原生 loading=lazy，后台标签页/无布局时也能立即请求）；decoding 统一为 async 不阻塞渲染；缩略图域名 preconnect 预连接提速；移动版请求失败自动重试且只缓存成功结果；列表/搜索/详情三页懒加载清除逻辑合并精简约300行。
//   v1.8：详情图请求增加反爬拦截页检测与退避重试，被拦截的帖子不再被永久标记、后续可重试。
//   v1.9：lazyload 构造函数拦截改为普通函数（new 不再抛 TypeError）；列表页自动加载仅在请求有效时推进页码、无效/被拦批次回滚标记自动重试；移动版空响应区分拦截页与 UA 未生效并告警；详情图统一仅接受 http(s)；搜索页 tid 数字校验；缩略图缓存键加入 fid。
//   v1.10：修复自动加载失败重试定时器不触发（debounceTimer 触发后未清空，回滚批次只能靠下次滚动被动补跑）；放弃批次时恢复已处理标记，避免被 observer 重新入队重复请求。
//   v2.2：@run-at 提前到 document-start；仅在有帖子表格时处理；首屏前 6 行立即请求并标注 high 优先级，其余延迟加载 + 3.5s 兜底全量放行；预连接提前；整组图失败时移除空容器。
//   v2.3（2026-09-13 实测重写，见文件内各段实测数据）：
//     ① 首屏判定由硬编码「前 6 行」改为按 getBoundingClientRect() 真实几何计算——实测行高恒为
//        410px、一屏只有 1.7 行，旧值等于多抢 3 倍图片，且固定行数在任何分辨率下都不准；
//     ② 取消「注入后 3.5s 无条件放行全部非首屏图」——实测该定时器在 +3.99s 一次性涌出 48 张
//        /约 6.4MB，而对照实验证明它对首屏耗时毫无帮助（246ms vs 241ms）；改为原生 lazy 按需加载
//        + 仅前台可见页生效的长时兜底，不看内容就离开时最多省下 6MB/48 个请求；
//     ③ 页面级 CSS / 样式注入 / 三页通用懒加载清除各自收敛为一处，删掉冗余的 watchNv、无用
//        变量与死 CSS；MutationObserver 去掉 class 监听（每张缩略图加载完都会改 class，纯噪音）；
//     ④ 修正 v2.2 注释中"追加查询串会被图床挂起"的错误结论（实测正常返回），并补齐图床真实
//        机制（Cloudflare + Backblaze B2，无服务端缩放；浏览器自动协商 WebP）。
//   v2.4（2026-09-13 回归实测修复）：
//     ① 修复 TM 沙箱隔离缺陷：带 @grant 时脚本内 window 是包装对象，纯赋值不透传到页面——
//        interceptLazyLoad 对 LazyLoad / lazyload / IntersectionObserver 的覆盖自 v1.7 起
//        从未真正生效（实测详情页页面上下文中 lazyload 仍是站点原库、IO 仍为 native），
//        功能一直靠 forceEagerImg 的 DOM 级防线掩盖；现全部改经 unsafeWindow 写入真实页面；
//     ② 首页不再挂常驻 MutationObserver（mainContainer 兜底到 body 等于监听整个文档，
//        实测首页 64 图零懒加载、无动态新增场景，首轮 forceEagerAll 已全覆盖）；
//     ③ 非首屏兜底放行 15s → 10s（实测转可见后 10s 内原生 lazy 已取完视口附近的图）。
//   v2.4.1（2026-09-13 审计第一批剩余项）：
//     ① 修复审计 #1：listPageMain 改为直接 await 抢跑的 earlyListFetch Promise——旧写法在抢跑
//        失败时会真的再发一次不带重试的请求（失败结果不写缓存、pending 已删，无复用路径可命中），
//        失败路径从 1+1+3 次请求降为 1+3 次；
//     ② 修复审计 #2：createThumbWrap 的张数封顶由硬编码 5 改为 MAX_THUMBS_PER_POST 常量联动，
//        并在常量注释中标注「CSS 只定义到 n5」的联动约束。
//   v2.4.2（2026-09-13 审计第二批次清偿，#3/#4/#5/#7/#8/#11/#12/#15）：
//     ① 搜索页与详情页逐字重复的"强制图片可见"CSS 收敛为 forceVisibleCSS()（#3）；
//     ② fetchMobileThumbs 内联的 safeid 判定改用已有的 isSafePage()（#4）；
//     ③ 'sehuaBusyRetry' 字面量提为 BUSY_RETRY_KEY 常量，函数内五处引用点全部统一（#5）；
//        （v2.4.2 初版留下过 `const retryKey = BUSY_RETRY_KEY` 的局部别名，已删除）
//     ④ watchImages 的 attributeFilter 改由 LAZY_ATTRS 派生，两份清单永不再脱钩（#7）；
//     ⑤ 详情页重试参数提为 DETAIL_RETRY_TIMES / DETAIL_RETRY_BASE_MS 常量（#8）；
//     ⑥ visibilitychange 监听改为首次排期兜底时才注册，详情/首页不再常驻空定时器（#11）；
//     ⑦ @description 补 v2.3 起的核心行为变化"首屏几何判定 + 非首屏按需加载"（#12）；
//     ⑧ eager/lazy 两分支的 img.complete 缓存兜底对称化（#15）。
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
  // 实际间隔 = 基数 + 第几次×基数：2s / 4s（与旧版硬编码行为一致）
  const DETAIL_RETRY_TIMES = 3;
  const DETAIL_RETRY_BASE_MS = 2000;

  // 搜索页要过滤的栏目
  const BLOCK_FORUMS = ['求片问答悬赏区', '资源出售区', 'AI专区', '国产自拍', 'TXT小说下载'];

  // 过滤开关状态的 localStorage 键名
  const FILTER_STORAGE_KEY = 'sehuaFilterState';

  // 搜索繁忙重试计数的 sessionStorage 键名（v2.4.2 提为常量，原三处字面量 + 一处局部变量）
  const BUSY_RETRY_KEY = 'sehuaBusyRetry';

  // 所有可能的懒加载属性（按优先级排序）
  const LAZY_ATTRS = ['file', 'zoomfile', 'data-original', 'data-src', 'data-loadsrc', 'data-thumb', 'data-lazy-src', 'original', 'data-url'];

  // ============ 首屏判定 / 非首屏加载策略（v2.3 重写） ============
  //
  // 【为什么不再用固定行数】实测 1440x708 视口、容器宽 1440px 时，注入缩略图后每个帖子行高
  // 恒为 410px → 一屏只能完整看到 1.7 行。而 v2.2 写死 EAGER_ROWS=6，等于把 6 行 = 12 张图
  // （约 1.6MB）按高优先级抢先请求，比真实首屏所需的 4~6 张多出一倍以上。
  // 更要紧的是行高随窗口宽度成比例变化（缩略图按百分比宽），固定行数在任何分辨率下都不准。
  //
  // 【新判据】逐行按 getBoundingClientRect().top 判断。注入是按 DOM 顺序逐行进行的，处理到第 k 行时
  // 上面 k-1 行都已插入缩略图且高度已定型（CSS 给了 aspect-ratio，无需等图加载就有正确盒高），
  // 因此第 k 行的 top 是准确的，判断天然适配任意窗口尺寸与任意滚动位置。
  const FOLD_SLACK_PX = 120;   // 首屏下方留一点余量，半露出的行也按首屏处理

  function isAboveFold(tb) {
    return tb.getBoundingClientRect().top < window.innerHeight + FOLD_SLACK_PX;
  }

  // 【为什么非首屏不再"到点全量放行"】v2.2 在注入后 3.5s 无条件把全部非首屏图改成 eager。
  // 实测（冷缓存、1440x708）：48 张 / 约 6.4MB 会在 +3.99s 一次性涌出，而用户此时多半还没滚到那里。
  // 关键对照实验（同一批真实 URL，带缓存破坏串强制走网络，60 张共 8.0MB）：
  //   · 只请求首屏 12 张          → 中位完成 246ms
  //   · 60 张全部同时请求         → 首屏那 12 张中位完成 241ms，全部 60 张 1.7s 完成
  // 即"非首屏抢带宽拖慢首屏"在本站并不成立（浏览器本来就按视口/优先级排队），
  // 3.5s 全量放行既没有首屏收益，又凭空替用户预下载了 6MB。故改为按需加载。
  //
  // 【但仍保留兜底】原生 loading=lazy 在「后台/隐藏标签页」「元素无布局尺寸」时不会发起请求
  // （实测 Agent Window 里 document.hidden === true 时确实一张都不请求，这也是 v1.7 当年彻底
  // 删掉懒加载的原因）。折中方案：
  //   · 隐藏页一律不主动放行——用户不在看的时候替他下载整页图片才是真的浪费；
  //     页面重新可见后交给原生 lazy 处理（浏览器会立刻加载视口附近的图）。
  //   · 前台可见页用长时定时器兜底，防御浏览器懒加载启发式漏掉个别图而永久停在占位态。
  // v2.4：15000 → 10000。实测页面转可见后 10s 内浏览器原生 lazy 已把视口附近的图取完，
  // 兜底只防启发式漏网的个别图；缩短可减少漏加载图停留 shimmer 的最坏时长
  const LAZY_SAFETY_MS = 10000;
  let lazySafetyTimer = null;

  // 兜底放行：只在页面可见时执行
  function releaseStaleLazy() {
    lazySafetyTimer = null;
    if (document.visibilityState !== 'visible') return;   // 隐藏页交还给原生 lazy
    const imgs = document.querySelectorAll('.sehua-thumb img[loading="lazy"]');
    if (imgs.length === 0) return;
    console.log(`[色花堂缩略图] 兜底放行 ${imgs.length} 张原生懒加载未取走的缩略图`);
    imgs.forEach(img => { img.loading = 'eager'; });
  }

  // 排期兜底（已排则不重复排，避免持续新增导致永不触发）
  // v2.4.2（审计 #11）：visibilitychange 监听改为首次排期时才注册——原先在 IIFE 顶层
  // 无条件注册，详情页/首页这类根本不会创建 lazy 缩略图的页面也常驻，每次切回前台
  // 都白排一个 10s 定时器。懒注册后只有真正用上按需加载的页面（列表/搜索）才有此开销
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

  // 站内占位图标 / 用户头像 / base64 占位图的特征串，用于把装饰图排除在缩略图之外
  const PLACEHOLDER_MARKERS = ['static/image', 'uc_server', 'none.gif'];

  function isPlaceholder(url) {
    if (url.indexOf('data:') === 0) return true;
    return PLACEHOLDER_MARKERS.some(marker => url.indexOf(marker) !== -1);
  }

  // 获取图片真实URL（从各种懒加载属性中提取）
  function getRealSrc(img) {
    for (const attr of LAZY_ATTRS) {
      const val = img.getAttribute(attr);
      if (val && !isPlaceholder(val)) return val;
    }
    const src = img.getAttribute('src') || img.currentSrc;
    if (src && src.startsWith('http') && !isPlaceholder(src)) return src;
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

  // ============ 移动版缩略图获取原理（2026-09-04 抓包 + 2026-09-13 复测） ============
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
  //
  // 3. 反爬（WAF）依赖浏览器会话 Cookie：
  //    站点有 _safe cookie 校验——不带 _safe 的请求只会收到约 900B 的 safeid JS 挑战页（isSafePage 可检测）。
  //    Tampermonkey 发 GM 请求时默认自动附上目标域名的浏览器 Cookie（_safe 随请求带出），
  //    下面 headers 里显式写的 Cookie: mobile=2 会被 TM「合并」到浏览器 Cookie 之后
  //    （TM 官方文档 cookie 条目 / 5.6.6239 更新日志 "merge given cookies"，不会覆盖丢失 _safe）。
  //    若日志频繁出现"疑似被反爬拦截"多为请求过快被限流，内建重试会兜底。
  //    ⚠️ v2.2 起本请求提前到 document-start：首次访问时 _safe 由主文档响应头写入，
  //       文档开始执行时该 Cookie 已落库，因此提前发送是安全的；万一仍被拦，DOM 就绪后的
  //       带重试流程会补一次（见 listPageMain）。
  //
  // 4. 解析映射：.n5_htmk = 帖子卡片；卡片内 a[href*=viewthread] 的 tid=N 即帖子 ID
  //    （DOMParser 会把相对 href 解析成绝对地址，tid=(\d+) 正则照常命中）；
  //    缩略图地址由 getRealSrc 按 LAZY_ATTRS 依次探测（触屏模板用 data-original）；
  //    用户头像(/uc_server/...)与站内占位图标已被 getRealSrc 的 uc_server / static/image 过滤排除。
  //    实测命中率：forum-37 第 1/2/3/5 页均为「30 个帖子全部拿到映射，0 个需要回详情页兜底」。
  //
  // 5. mobile=2 双保险：URL 参数 + Cookie 都写 mobile=2，强制 Discuz 走触屏版（=2）
  //    而非标准手机版（=1，纯文字无图）。实测仅移动 UA 不带参数时服务端也会返回触屏模板，
  //    保留 mobile=2 意图更明确且无害。
  //
  // 6. 已知边界：置顶帖在移动版顶部是纯文字列表（无缩略图），因此 PC 列表的置顶行不会注入缩略图，
  //    属预期行为（与移动版展示一致），非 bug。
  //
  // 7. 缩略图图床实测（2026-09-13 修正 v2.2 的错误结论）：
  //    · 图片只有原图，没有小图变体。响应头显示前端是 Cloudflare（CF-Cache-Status: HIT）、
  //      回源 X-Canonical-Cache-Host: b2img.etboo.cc（Backblaze B2）。B2 是纯对象存储，
  //      不提供图片处理，因此 ?w= / ?imageView2/ / ?x-oss-process= / ?imageMogr2/ 这类缩放参数
  //      全部被忽略（实测 7 种写法 Content-Length 一律 174530，与不带参数完全一致）。
  //      → 缩略图只能整张下载，省流量只能靠"少请求 / 按需请求"。
  //    · 「追加查询串会被挂起」是错的：实测带 ?bsk=xxx 的 URL 70~72ms 正常返回同一张图，
  //      可重复验证。v2.2 的这条注释已删除，避免误导后续优化。
  //    · 图床要求 Referer 必须是本站（无 Referer 直接 403；带站点 Referer 200），
  //      所以缩略图 <img> 绝不能设 referrerPolicy="no-referrer"。
  //    · 浏览器会自动协商 WebP（Vary: accept；带 image/webp 的 Accept 头返回 image/webp），
  //      无需脚本干预，实际下载量比 curl 测得的 JPEG 体积更小。
  //    · Cache-Control: max-age=2592000（30 天），因此"冷缓存"只影响某个帖子第一次被看到；
  //      同一帖子第二次出现必然命中缓存。
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
              // （v2.4.2 起复用 isSafePage，原先这里又内联写了一遍 indexOf —— 审计 #4）
              if (isSafePage(resp.responseText)) {
                console.error('[色花堂缩略图] 移动版请求疑似被反爬拦截页挡下:', url);
              } else {
                console.error('[色花堂缩略图] 未找到移动版结构(.n5_htmk)，可能自定义 User-Agent 头未生效而拿到了 PC 版页面');
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
                const src = getRealSrc(img);
                if (src && src.startsWith('http') && !urls.includes(src)) {
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

  // 页面级布局修正（v2.3：原先在列表/搜索/繁忙/详情/首页 5 处重复内联，现收敛为一处）
  const PAGE_CSS = `
    ${WIDE_CSS}
    #ct { width: auto !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; }
    body { overflow-x: hidden !important; }
  `;

  // 缩略图相关 CSS
  const THUMB_CSS = `
    .sehua-thumb { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
    .sehua-thumb { --img-width: calc((100% - 32px) / 5); }
    .sehua-thumb > a, .sehua-thumb > img { display: flex; align-items: center; justify-content: center; text-decoration: none; overflow: hidden; width: var(--img-width) !important; transition: width 0.2s ease; }
    .sehua-thumb img { height: auto !important; aspect-ratio: 3/2; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; background: #f5f5f5; box-sizing: border-box !important; width: 100% !important; transition: border-color 0.2s ease, transform 0.2s ease; }
    .sehua-thumb img:hover { border-color: #4a90d9; transform: scale(1.03); }
    .sehua-thumb.n1 { --img-width: 50%; }
    .sehua-thumb.n2 { --img-width: 40%; }
    .sehua-thumb.n3 { --img-width: calc((100% - 16px) / 3); }
    .sehua-thumb.n4 { --img-width: calc((100% - 24px) / 4); }
    .sehua-thumb > a.portrait, .sehua-thumb > img.portrait { width: calc(var(--img-width) * 0.7) !important; }
    .sehua-thumb > a.portrait img, .sehua-thumb > img.portrait { aspect-ratio: 2/3; }
    .sehua-thumb img.sehua-loading { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: sehua-shimmer 1.5s infinite; }
    @keyframes sehua-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  `;

  // 统一注入 <style>（v2.3：原先 6 处各自 createElement('style')，收敛为一处）
  function addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 强制容器内所有图片立即可见的页面级 CSS
  // （v2.4.2 收敛审计 #3：搜索页 #threadlist 与详情页 #postlist 原各写一份，
  //   四行内容逐字相同仅选择器不同；站点对懒加载图加 visibility:hidden 等图出来再显示）
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

  // 删除无用元素
  function removeUnused() {
    document.querySelectorAll('.show-text.cl, .show-text4.pad-tb-10, .show-text2.pad-tb-10, #f_pst, .wp.mtn, .h10, #newspecial, #newspecialtmp').forEach(el => el.remove());
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
    // v2.3：attributeFilter 去掉 'class'。每张缩略图加载完都会 classList.remove('sehua-loading')，
    // 分页/筛选也会成片改 class，而 forceEagerImg 只依赖 src / 懒加载属性，监听 class 纯属噪音。
    // v2.4.2（审计 #7）：地址属性清单改由 LAZY_ATTRS 派生，与 getRealSrc 的探测表永不再脱钩
    // （原先手写 8 个、与 LAZY_ATTRS 的 9 个不同步，data-thumb 等变化会漏监听）；
    // 其余 4 个是状态属性：src/lazy/loadsrc 是站点脚本会改写的，data-lazy 是 forceEagerImg
    // 自己会 removeAttribute 的。均为现清单的超集，只会多触发幂等回调，不会漏。
    observer.observe(mainContainer(), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: LAZY_ATTRS.concat(['src', 'lazy', 'loadsrc', 'data-lazy'])
    });
  }

  // 拦截 Discuz 懒加载（三页共用）
  // v2.4 沙箱修复：脚本带 @grant（沙箱模式）时，脚本内的 window 是包装对象——读取页面
  // 全省会透传，但纯赋值（window.x = y）只写进沙箱，页面侧完全看不到。2026-09-13 回归
  // 实测坐实：详情页页面上下文中 window.lazyload 仍是站点原库（function lazyload(className)
  // 带 .imgs）、IntersectionObserver 仍是 [native code]——即下述全局覆盖自 v1.7 起从未生效，
  // 功能一直靠 forceEagerImg 的 DOM 级防线（设 src + lazyloaded 标记，站点 showImage 碰到
  // 标记即跳过）掩盖。因此对页面全局的读写一律改走 unsafeWindow。
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
  // watch=false 跳过 MutationObserver：仅首页使用——mainContainer() 在首页兜底到
  // document.body，挂 Observer 等于监听整个文档（审计 #10，2026-09-13 回归坐实）；
  // 实测首页 64 张图零懒加载、无动态新增场景，首轮 forceEagerAll 已全覆盖，不监听
  function scrubPageLazyLoad(watch = true) {
    forceEagerAll();
    if (watch) watchImages();
    interceptLazyLoad();
  }

  // ============ 缩略图注入 ============

  // 创建缩略图容器
  //   urls  该帖的图片地址（调用方已截断到 MAX_THUMBS_PER_POST）
  //   tid   帖子 ID，非空时每张图包一层 <a target=_blank> 指向详情页
  //   eager true = 首屏（立即请求 + high 优先级）；false = 非首屏（原生懒加载，按需请求）
  function createThumbWrap(urls, tid, eager) {
    const wrap = document.createElement('div');
    // v2.4.1 修复审计 #2：封顶值与 MAX_THUMBS_PER_POST 联动（原先硬编码 5，
    // 调常量会导致 slice 给 8 张、class 仍是 n5，按 5 列宽排版错位）
    const n = Math.min(Math.max(urls.length, 1), MAX_THUMBS_PER_POST);
    wrap.className = 'sehua-thumb n' + n;
    const href = tid ? `https://${location.hostname}/thread-${tid}-1-1.html` : null;

    urls.forEach(url => {
      const img = document.createElement('img');
      img.decoding = 'async';   // 异步解码：解码不阻塞主线程渲染
      img.classList.add('sehua-loading');

      const container = href ? document.createElement('a') : img;
      if (href) {
        container.href = href;
        container.target = '_blank';
        container.appendChild(img);
      }
      wrap.appendChild(container);

      const onload = () => {
        img.classList.remove('sehua-loading');
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

      // 缓存兜底（v2.4.2 审计 #15：两分支对称）：complete 为 true 后不会再触发
      // load/error 事件——naturalWidth === 0 是被浏览器缓存住的失败结果，必须直接
      // 走 onerror，否则该图会带着 shimmer 占位永远卡住。lazy 图在预取距离内时
      // 同样可能立即命中缓存完成，事件或已派发完毕，监听器收不到回调。
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
  function processRow(tr, thumbMap) {
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
    let injected = 0, moved = 0, eager = 0;
    document.querySelectorAll('#threadlisttableid tr').forEach(tr => {
      const th = tr.querySelector('th');
      const hadThumb = th?.querySelector('.sehua-thumb');
      const hadEm = th?.querySelector('.tps em');

      processRow(tr, thumbMap);

      if (!hadThumb && th?.querySelector('.sehua-thumb')) {
        injected++;
        if (th.querySelector('.sehua-thumb img[fetchpriority="high"]')) eager++;
      }
      if (!hadEm && th?.querySelector('.tps em')) moved++;
    });
    console.log(`[色花堂缩略图] 注入 ${injected} 个缩略图（${eager} 个在首屏内立即加载，其余交给原生按需加载），移动 ${moved} 个日期`);
  }

  // ============ 移动版缩略图缓存与预连接 ============

  const thumbCache = {};
  const pendingPages = {};

  // 取某一页的移动版缩略图映射
  //   allowRetry=false 用于「文档开始时抢跑」的那次：只发一次，不与页面加载争资源；
  //   失败结果不写入缓存、并清空 pending，让 DOM 就绪后的带重试流程可以重新发起。
  function fetchMobileThumbsByPage(fid, page, allowRetry = true) {
    const key = fid + '_' + page;   // 缓存键带 fid，避免跨版块同页码串缓存
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    if (pendingPages[key]) return pendingPages[key];
    const fetchPromise = (allowRetry ? fetchMobileThumbsWithRetry(fid, page) : fetchMobileThumbs(fid, page))
      .then(result => {
        // 只缓存有效结果：拦截页/空响应不缓存，下次还能重试
        if (mobileResultOk(result)) thumbCache[key] = result;
        delete pendingPages[key];
        return result;
      });
    pendingPages[key] = fetchPromise;
    return fetchPromise;
  }

  // 对缩略图所在域名预建连接（DNS + TCP + TLS），缩短首图耗时。
  // 注意不要加 crossorigin：本站缩略图是普通 <img>（非 CORS 请求），加了反而会多建一条连接。
  function preconnectImageHosts(mapping) {
    if (!document.head) return;   // document-start 阶段 <head> 可能尚未建立
    const hosts = new Set();
    Object.values(mapping).forEach(urls => urls.forEach(u => {
      try { hosts.add(new URL(u, location.origin).origin); } catch (e) {}
    }));
    hosts.forEach(h => {
      if (h === location.origin) return;
      // 去重：自动加载多批时会重复调用，避免插入相同域名的多个 preconnect
      if (document.querySelector(`link[rel="preconnect"][href="${h}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = h;
      document.head.appendChild(link);
    });
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
                const u = getRealSrc(img);
                if (u && u.startsWith('http') && urls.indexOf(u) === -1 && urls.length < MAX_DETAIL_IMGS) urls.push(u);
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
  // ⚠️ 2026-09-13 未能实测复现：站点确实加载了 static/js/autoloadpage.js、#autopbn 也存在且可见
  //    （rel="forum.php?mod=forumdisplay&fid=37&page=6"），但在 Agent Window 的后台标签页里
  //    滚到底部不外乎 document.hidden === true，站点的滚动加载始终没触发，无法取样。
  //    该分支按 Discuz 原版行为保留（校验、回滚、去重逻辑本身是自洽的），但属于"未经真实触发验证"。

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
      console.log(`[色花堂缩略图] 自动加载第 ${targetPage} 页内容，处理 ${batch.length} 个帖子`);
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
    console.log('[色花堂缩略图] 已监听自动加载，起始页 ' + initialPage);
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
      console.log(`[色花堂缩略图] 搜索页加载 ${allLis.length} 个可见帖子的详情图（并发${MAX_CONCURRENT}）`);

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
      .sehua-loading { color: #999; font-size: 12px; text-align: center; padding: 8px; }
      .slst.mtw { width: 100% !important; }
      /* 搜索页：强制所有图片立即显示（v2.4.2 收敛，见 forceVisibleCSS） */
      ${forceVisibleCSS('#threadlist')}
    `);

    removeUnused();
    scrubPageLazyLoad();

    const switchWrap = addForumSwitches();
    if (!switchWrap) {
      // 未登录时 search.php 只返回空壳，没有 .sttl.mbn，直接跳过
      console.log('[色花堂缩略图] 未找到 .sttl.mbn，跳过搜索页处理');
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
    console.log(`[色花堂缩略图] 检测到"搜索繁忙"（第${retryCount + 1}次），4 秒后自动刷新`);

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
    console.log('[色花堂缩略图] 详情页模式');
    addStyle(`
      ${PAGE_CSS}
      #postlist { width: 100% !important; }
      #postlist ignore_js_op img.zoom { display: block; margin-left: auto; margin-right: auto; }
      #postlist ignore_js_op { text-align: center; }
      /* 详情页：强制所有图片立即显示（v2.4.2 收敛，见 forceVisibleCSS） */
      ${forceVisibleCSS('#postlist')}
    `);

    removeUnused();
    scrubPageLazyLoad();
  }

  // ============ 首页主流程 ============

  function homePageMain() {
    console.log('[色花堂缩略图] 首页模式');
    addStyle(PAGE_CSS);
    removeUnused();
    // v2.3：与其余页面统一，首页同样清一遍懒加载（原先首页漏掉了这一步，
    // 首页若有 loading=lazy 图会停在占位态）
    // v2.4：watch=false，首页不挂 MutationObserver（见 scrubPageLazyLoad 注释）
    scrubPageLazyLoad(false);
  }

  // ============ 列表页主流程 ============

  async function listPageMain() {
    const { fid, page } = getPageInfo();
    if (!fid) {
      console.log('[色花堂缩略图] 非列表页，跳过');
      return;
    }

    // URL 是列表页但不代表正文就是帖子表格。
    // 首次访问（还没有 _safe Cookie）时服务端返回「18+ 年龄门」中间页，URL 仍是 forum-103-1.html；
    // 此时既没有行可以注入，移动版请求也会被反爬挡下。直接退出，省掉 3 次请求 + 2×1.5s 退避。
    if (!document.getElementById('threadlisttableid')) {
      console.log('[色花堂缩略图] 页面无帖子表格（疑似 18+ 年龄门/异常页），跳过列表页处理');
      return;
    }

    injectStyles();
    removeUnused();
    scrubPageLazyLoad();

    const pageNo = parseInt(page);
    watchAutoLoad(fid, pageNo);

    console.log(`[色花堂缩略图] 请求移动版: forum-${fid}-${page}.html`);
    // 直接消费文档开始时抢跑的那个 Promise（v2.4.1 修复审计 #1）。
    // 旧写法 fetchMobileThumbsByPage(fid, pageNo, false) 有个隐蔽缺陷：抢跑失败时
    // 缓存未写入、pending 已删除，这次调用不会命中任何复用路径，而是真的再发一次
    // 「不带重试」的请求——失败路径白付 1 次请求 + 1 个 RTT（最坏 1+1+3=5 次）。
    // 成功路径下两种写法行为完全一致（命中缓存/pending）；Promise 可重复 await。
    let result = earlyListFetch ? await earlyListFetch : null;
    if (!result || !mobileResultOk(result)) {
      console.log('[色花堂缩略图] 抢跑请求无效，改为带重试获取');
      result = await fetchMobileThumbsByPage(fid, pageNo, true);
    }
    // 防御性解构：带重试流程同样可能给出非预期结果（GM API 缺失/异常、上游改签名）。
    // 后续全部改用局部变量，不再直接链式访问 result.mapping / result.fallbackTids ——
    // 否则一处 null 就会让整页缩略图静默消失（异常被 onDomReady 的 catch 吞掉）
    const mapping = (result && result.mapping) || {};
    const fallbackTids = (result && result.fallbackTids) || [];
    console.log(`[色花堂缩略图] 获取到 ${Object.keys(mapping).length} 个帖子的缩略图，${fallbackTids.length} 个需从详情页加载`);

    // 对缩略图域名预建连接，加速图片请求（抢跑分支已在文档开始时建过，这里会去重）
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
  // 实测（forum-103-1.html，冷启动）：DOMContentLoaded 约 3.35s，移动版请求本身约 757ms，
  // 旧版要等 DOM 就绪才发请求 → 首张缩略图约 4.9s 才出现。
  // 因此这里把「不依赖 DOM」的移动版请求提前发出，与页面自身的 HTML/CSS/JS 加载并行；
  // 所有 DOM 相关处理统一推迟到 DOMContentLoaded，逻辑与旧版保持一致。
  const earlyPageInfo = getPageInfo();
  let earlyListFetch = null;
  if (earlyPageInfo.fid) {
    earlyListFetch = fetchMobileThumbsByPage(earlyPageInfo.fid, parseInt(earlyPageInfo.page), false);
    // 请求一返回就先握手缩略图 CDN，把 DNS/TCP/TLS 也挪到 DOM 之前的并行窗口里
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
        console.log('[色花堂缩略图] 搜索页模式');
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

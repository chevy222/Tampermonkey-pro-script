// ==UserScript==
// @name         2048缩略图
// @namespace    https://bbs.vsbskpo.com/
// @version      2.7.1
// @description  视口窗口按需加载缩略图：视口上下各留一段窗口，窗口内的图片立刻加载（视口内的标 fetchpriority=high 优先拿到慢图床的带宽），窗口外的图片进入观察器、滚到附近才加载；10 秒后兜底放行所有尚未激活的缩略图（仅页面可见时执行，后台标签页不预下载）。附带：图床域名 preconnect 预连接、移除占位图与广告、隐藏侧栏、"无 Referer" 请求规避图床防盗链、失败后穿透缓存重试一次、节点复用换图时自动重置状态。v2.6 实测：一页 47 张缩略图共 17.25MB，其中 63% 在首屏 2200px 以下，窗口化后首屏只发 17 张 / 3.51MB。
// @author       Chevy Yang
// @match        https://bbs.vsbskpo.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================================
       一、实测基线（2026-09-13，站点 bbs.vsbskpo.com，列表页 thread.php?fid=15&search=img&page=1）
       环境：Chrome 153，视口 1440×709，每次 reload 均带 CDP Page.reload(ignoreCache=true) 绕过 HTTP 缓存。

       1) 页面构成：55 个 <img>，其中 47 张是图床缩略图（a.img9g2026.com 33 张、i.11img.com 14 张），
          另外 8 个是站内图标/占位图（images/face/none.gif、data: 内联图、空 src）。
       2) 47 张缩略图**全部**是「原生 loading="lazy" + 真实地址已在 src」，
          站点没有小图变体（.thumb / 查询串变形实测均不可用），所以字节量只能靠"少加载"来省。
       3) 用与浏览器一致的请求头（Accept: image/avif,image/webp,...）逐张实测体积：
             47 张合计 17.25 MB，均值 384 KB，中位 65 KB，最大 2013 KB（单张 GIF）。
             按位置切分：
                 首屏视口内 (top < 709px)            8 张   1.59 MB   9.2%
                 视口 + 800px 窗口                 16 张   3.48 MB  20.2%
                 视口 + 1500px 窗口                28 张   6.32 MB  36.6%
                 再往下 (top >= 2209px)           18 张  10.93 MB  63.4%   ← 纯浪费
             图床支持 WebP 协商（同一张图 JPEG 215KB → WebP 73KB），浏览器已自动协商，脚本无需干预。
       4) 图床很慢：单张平均 3~5s，一次硬刷新里最后一张落地在 12~17s。所以"少发请求"既省流量也省首屏时间。

       二、v2.5 为什么会失败（本次逐分支实测结论，日志取自脚本内探针）
       v2.5 的设计是"先只放行首屏，等首屏落地后再一把放行其余"，实测三个环节全部失效：

       (a) 「首屏标 high」几乎不生效
           解析期只有 16 张图能被 nearViewport(800) 判定为"近处"并标 high；
           其余 31 张交给 IntersectionObserver，而 IO 的 12 次回调**全部**是 `margin->null`
           （从视口内进入的图早在 NEAR 分支就被激活了，根本轮不到 IO），所以 IO 一次都没标出 high。

       (b) 「等首屏落地」实际是空等待
           priorityImagesSettled() 只统计 `_activated` 的图；当一张都还没激活时，空集合恒返回 true，
           于是门闸在 load+400ms 就满足条件。实测两轮 GATE-OPEN 分别在 load 后 2.7s / 3.0s，
           期间 settled 采样恒为 total=47 act=28 inc=28 —— 首屏图根本没落地，门闸是靠 2.5s 上限放行的。

       (c) 门闸放行时把首屏的 high 覆盖成了 low
           releaseDeferred() 对**全部 47 张**（含已激活的）统一调 activateImage(img,'low')，
           activateImage 里 `if (priority && img.fetchPriority !== priority)` 直接改写，
           结果实测首屏 11 张图的 fetchpriority 变成 8×low + 1×high + 2×auto，优先级系统自我抵消。

       最终效果：v2.5 与"立即全量"几乎没有差别 —— 两轮平均下发 35.5 个图片请求（immediate 档 32 个），
       63% 的屏外字节照样被无条件下载。而完全不接管的原生懒加载只发 ~21 个请求（Chrome 自带的预取距离
       约在视口下方 1250px 左右），说明"全量预载"就是这个脚本最大的成本项。

       三、v2.6 的做法
       把"首屏落地后全量放行"整段机制删掉，改成**固定窗口按需加载**：
           窗口 = 视口上方 TOP_MARGIN + 视口 + 视口下方 LOOKAHEAD
       窗口内：立刻加载（在视口里的标 high，让两个慢图床优先服务可见区域）；
       窗口外：只挂 IntersectionObserver，滚到窗口边缘才激活。
       效果（同一页面、同一测量口径，v2.5 vs v2.6 真机实测）：首屏只发 17 张 / 3.51 MB，
       比 v2.5 少 64% 的请求、80% 的字节；视口内的缩略图 5/5 全部拿到 fetchpriority=high（v2.5 为 0）；
       继续往下滚才会依次加载后面几屏，流量与实际浏览深度成正比。
       代价是明确的：如果你一口气拉到页面底部，最终仍会加载全部 17.25MB，只是发生在滚动过程中，
       且因为窗口比视口大 1200px，正常滚动速度下不会看到明显空位。

       四、v2.7 的变化（2026-09-13 用户需求）
       1) 兜底放行（RELEASE_ALL_MS = 10s）：DOM 就绪 10 秒后，把所有"已分类但尚未被窗口机制激活"
          的缩略图一次性放行（仅页面可见时执行；后台标签页不放行，转可见后补排一次）。
          ⚠️ 这是对 v2.6"不为看不到的内容付费"的**有意回撤**，换取"开着页面慢慢看时不用等图"：
          页面停留超过 10s 即全量下载（实测 47 张 / 17.25MB，63% 在首屏以下）。把它改成 0
          即可恢复 v2.6 的纯窗口按需加载。窗口机制本身不变，前 10 秒的省流收益仍然保留。
       2) 图床域名 preconnect：首次处理到某个图床域名的图片时立即插入 <link rel=preconnect>
          （DNS+TCP+TLS 提前握手，不加 crossorigin——普通 <img> 非 CORS 请求）。
          注意收益与色花堂不同：那边的缩略图地址来自 GM 请求、注入前有明确的提前窗口；
          本站图片地址就在页面 HTML 的 src 里，浏览器 preload scanner 见到即会连接，
          preconnect 的真实收益在「窗口内没出现过的图床域名」——兜底放行/滚动加载触发时
          免掉一次握手（本站图床单张 3~5s，握手省下的几百 ms 有感）。
       3) 修复 v2.6 审计 P1（src 自激）：脚本自己写 src 会触发 MutationObserver 的状态重置分支，
          形成写→重置→重写循环；兜底放行把全部图推向激活后，data-* 分支页面会 100% 发作，
          故新增 selfAssign() 打一次性标记，MO 消费标记后跳过重置。顺带修 L386 错误注释
          （_scheduled → _activated）与 L211 冗余 removeAttribute（反射属性赋值已覆盖）。

       五、v2.7.1（2026-09-13，用户探针实测发现）
       srcset 分支误用 selfAssign 导致 _selfWrite 标记残留：srcset 不在 attributeFilter 里，
       赋值不产生 mutation record，标记永远无人消费；下一次站点真实换图时该残留标记被重置分支
       消费并 continue，节点复用的状态重置被静默跳过（v2.6 机制失效一次）。修法：srcset 恢复
       直接赋值（本就不需要标记），selfAssign 注释补上"仅限 filter 内属性"的约束。
       用户实测方法：data URI 探针确保 load 成功（排除失败重试的 src 写入消费标记的干扰），
       验证 _selfWrite 残留为 true、模拟换图后 _forceLoaded 未被重新写入。
       ========================================================================== */

    // ---- 加载窗口参数（想过更激进/更保守就只改这两个）----
    var TOP_MARGIN = 400;   // 视口上方这么多像素内也立即加载：向上回滚时不出现空位
    var LOOKAHEAD = 1200;   // 视口下方这么多像素内提前加载。调大→滚动更顺、流量更多
                            // （实测：800px → 16 张/3.48MB；1500px → 28 张/6.32MB）

    var FALLBACK_INTERVAL = 3000;   // 兜底轮询周期（清理漏网广告 + 补处理漏网图片）
    var FALLBACK_IDLE_STOP = 20;    // 连续这么多个周期没活干就自停（20 × 3s = 60s）

    // 兜底放行：DOM 就绪后这么多毫秒，把所有尚未被窗口机制激活的缩略图一次性放行。
    // 语义对齐《色花堂缩略图》：仅页面可见时执行（后台标签页不替用户下载整页图），
    // 页面从隐藏恢复可见时补排一次。设为 0 可关闭，恢复 v2.6 的纯窗口按需加载。
    // ⚠️ 开启即放弃"停留不滚不动也只付前 10 秒流量"——10s 后整页 17.25MB 会照单全收
    var RELEASE_ALL_MS = 10000;

    // 广告 / 无用块。合并成单个选择器：解析期每个新增节点都要判定一次，一次 matches 远优于 N 次循环
    var AD_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill', '.nav-container'];
    var REMOVE_ELEMENTS = ['.reward-card', '.signature', '.movie-banner'];
    var COMBINED_SELECTOR = AD_SELECTORS.concat(REMOVE_ELEMENTS).join(',');

    // 懒加载真实地址所在的属性名。实测本站列表页 47 张全是「真实地址已在 src」，
    // 详情页 3 张内容图连 data-* 都没有，这三条分支当前 0 命中；
    // 保留是因为 @match 覆盖整站，其它页面类型可能出现（每次 getAttribute 开销可忽略），
    // 真正该删的是 v2.5 那套已经证明失效的"门闸"机制——见文件头第 (b)(c) 条。
    var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src'];
    var LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

    function isPlaceholderSrc(src) {
        if (!src) return true;
        if (src.indexOf('data:') === 0) return true;
        var low = src.toLowerCase();
        return low.indexOf('none.gif') !== -1 ||
               low.indexOf('thumb-ing') !== -1 ||
               low.indexOf('loading.gif') !== -1 ||
               low.indexOf('blank.gif') !== -1 ||
               low.indexOf('placeholder') !== -1;
    }

    function injectStyle() {
        if (!document.head && !document.documentElement) { setTimeout(injectStyle, 4); return; }
        var s = document.createElement('style');
        s.textContent = [
            // 重试后仍失败的图：压暗标记，点击可再试一次（见 applyFailedStyle）
            '.lazy-failed{opacity:0.15!important;cursor:pointer;}',
            // 站点用 background-image: url(images/thumb-ing.gif) 做占位，用内联 img 盖上去；
            // 图真正加载出来前不要露出占位背景
            '[style*="thumb-ing"]{background-image:none!important;}',
            '.img{background-image:none!important;}',
            '.lazyimg{filter:none!important;transition:none!important;}',
            // 某些页面会给懒加载图加 visibility:hidden，等图出来再显示；这里直接放开
            'img[data-src],img[data-srcset],img[data-original],img[data-lazy-src]{visibility:visible!important;}',
            '.r_two{display:none!important;}'   // 侧栏
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    injectStyle();

    function saveOriginalSrc(img, src) {
        // isPlaceholderSrc 同时覆盖 data: 与 none.gif 等占位图，避免占位图混入重试地址
        if (!img._origSrc && src && !isPlaceholderSrc(src)) img._origSrc = src;
    }

    // 穿透缓存的重试地址（部分图床/代理会把失败结果做负缓存）
    function bustCache(url) {
        return url + (url.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now();
    }

    // 脚本自己写 src/srcset 时打一次性标记：MutationObserver 会看到这次赋值，
    // 但它是"脚本行为"而非"站点换图"，不能据此重置调度状态——否则形成
    // 写 → MO 重置 → 重新分类 → 再写的自激循环（v2.6 审计 P1；v2.7 兜底放行
    // 会把全部图推向激活，data-* 分支页面该循环 100% 发作，故必须守卫）
    // ⚠️ 只能用于 attributeFilter 内的属性（当前仅 src）：标记依赖 MO 的 attributes
    // 回调来消费，filter 外的属性（如 srcset）赋值不产生 record，标记会永久残留，
    // 反而吞掉下一次真实换图的重置信号（v2.7.1 修复的 srcset 标记残留缺陷）
    function selfAssign(img, prop, value) {
        img._selfWrite = true;
        img[prop] = value;
    }

    // 图床域名预连接（v2.7）：首次处理到某图床域名的图片时插入 preconnect，
    // 把 DNS+TCP+TLS 提前到窗口外图片真正激活之前。按 origin 去重。
    // 不加 crossorigin：本站缩略图是普通 <img>（非 CORS 请求），加了反而多建一条连接。
    // 注：图片地址已在页面 HTML src 里，浏览器 preload scanner 见到即连接，此处的
    // 增量收益是"窗口内没出现过的域名"——兜底放行/滚动加载触发时免掉一次握手
    var preconnectedHosts = {};
    function preconnectImgHost(img) {
        var src = img.getAttribute('src') || '';
        if (src.indexOf('http') !== 0 && src.indexOf('//') !== 0) return;
        try {
            var u = new URL(src, location.href);
            if (u.host === location.host) return;
            if (preconnectedHosts[u.origin]) return;
            preconnectedHosts[u.origin] = true;
            var link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = u.origin;
            (document.head || document.documentElement).appendChild(link);
        } catch (e) {}
    }

    function applyFailedStyle(img) {
        img.classList.add('lazy-failed');
        img.onerror = function () {};
        img.onclick = function () {
            if (!img._origSrc) return;
            img.classList.remove('lazy-failed');
            img.referrerPolicy = 'no-referrer';
            img.onload = function () { img.classList.remove('lazy-failed'); };
            selfAssign(img, 'src', bustCache(img._origSrc));
        };
    }

    // 自动重试：换 no-referrer + 穿透缓存重新请求一次，仍失败才标灰
    function markFailed(img) {
        if (img._markedFailed) return;
        img._markedFailed = true;
        if (!img._origSrc) {
            var cand = img.currentSrc || img.getAttribute('src') || img.src;
            if (!isPlaceholderSrc(cand)) img._origSrc = cand;
        }
        if (img._origSrc && !img._retried) {
            img._retried = true;
            img.referrerPolicy = 'no-referrer';
            img.onerror = function () { applyFailedStyle(img); };
            img.onload = function () { img.classList.remove('lazy-failed'); };
            selfAssign(img, 'src', bustCache(img._origSrc));
            return;
        }
        applyFailedStyle(img);
    }

    function watchError(img) {
        img.addEventListener('error', function () { markFailed(img); }, { once: true });
    }

    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            // 用 IO 回传的矩形判断是否"真的在视口里"：在视口里 → high（首屏必须最快拿到带宽）；
            // 只是进了预取窗口 → 不下发优先级，保持浏览器默认。
            // 不要在这里改调 getBoundingClientRect：IO 给的矩形更准且零成本
            var r = entries[i].boundingClientRect;
            var inView = !!r && r.bottom > 0 && r.top < vh;
            activateImage(entries[i].target, inView ? 'high' : null);
        }
    }, { rootMargin: TOP_MARGIN + 'px 0px ' + LOOKAHEAD + 'px 0px' }) : null;

    // 第二个观察器只捕捉"进入视口"这一个信号，用来把 fetchPriority 提成 high。
    // 为什么需要它：解析期布局还没定型（本次实测同一批缩略图在解析期 top=886，最终在 659），
    // 很多其实落在视口里的图会被判成 near 而按默认优先级下发请求。
    // 而两个图床很慢、每域名只有 6 个连接，请求大多还排在队列里 —— 此时提成 high 仍然有效。
    // v2.5 的 high 标记之所以形同虚设，一部分原因就是这个时点问题，另一部分是放行阶段又把 high 改回 low。
    var ioView = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            var t = entries[i].target;
            ioView.unobserve(t);
            t._viewSeen = true;
            if (t.fetchPriority !== 'high') t.fetchPriority = 'high';
        }
    }, { rootMargin: '0px' }) : null;

    // 激活 = 撤掉原生懒加载，让浏览器立刻发请求。
    // 优先级只升不降：v2.5 的教训是"放行阶段"把已经标好的 high 又改回 low，
    // 等于白标；请求一旦下发，再改 fetchPriority 也没有意义。
    function activateImage(img, priority) {
        if (!img._activated) {
            img._activated = true;
            if (img._observed && io) { io.unobserve(img); img._observed = false; }
            // fetchPriority 必须在请求真正下发**之前**写好，否则等于没写
            if (priority === 'high') img.fetchPriority = 'high';
            // 懒加载属性里的真实地址，到这一刻才写进 src —— 这样它和原生 lazy 图走同一套窗口策略，
            // 不会出现"data-src 页面被整页预载"的漏网
            if (img._plan) {
                var p = img._plan;
                img._plan = null;
                if (p.kind === 'src') {
                    if (img._assignedSrc !== p.value) { img._assignedSrc = p.value; selfAssign(img, 'src', p.value); }
                } else {
                    // srcset 必须直接赋值、不能走 selfAssign：srcset 不在 MutationObserver 的
                    // attributeFilter 里，赋值不产生 mutation record —— selfAssign 打的 _selfWrite
                    // 标记永远无人消费而残留，下一次站点真实换图（src/data-* 变化）时会被重置分支
                    // 误当"脚本自己写的"消费掉并 continue，导致节点复用状态重置被静默跳过
                    // （2026-09-13 用户 data URI 探针实测坐实；src 在 filter 里所以 L259 无此问题）
                    if (img._assignedSrcset !== p.value) { img._assignedSrcset = p.value; img.srcset = p.value; }
                }
            }
            img.loading = 'eager';   // 反射属性：赋值即把 content attribute 写成 eager，无需先 removeAttribute
            return;
        }
        if (priority === 'high' && img.fetchPriority !== 'high') img.fetchPriority = 'high';
    }

    // 窗口判定：视口上方 TOP_MARGIN 到视口下方 LOOKAHEAD 之间。
    // 返回 null 表示"尚未参与布局"（解析早期 CSS 还没生效时 rect 全为 0），
    // 这种图不能当"窗口外"处理，交给 IntersectionObserver 等布局完成后再判。
    function classify(img) {
        var r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (r.bottom < -TOP_MARGIN) return 'out';
        if (r.top > vh + LOOKAHEAD) return 'out';
        return (r.bottom > 0 && r.top < vh) ? 'view' : 'near';
    }

    /* ============================ 单图处理 ============================ */

    function forceLoadImage(img) {
        // _skip：已判定为"与本脚本无关"的图（占位图 / 相对路径装饰图 / 空 src）。
        // v2.5 不加这个标记，这些图每次 MutationObserver 回调、每轮兜底轮询都会被重新评估一遍——
        // 实测列表页 55 张图产生了 136 次 plan 计算，其中 88 次是纯重复。
        if (!img || img.tagName !== 'IMG' || img._forceLoaded || img._skip) return false;

        var src = img.getAttribute('src') || '';
        var plan = null;        // { kind, value, first }
        var deferred = false;   // 是否需要走"窗口判定"而不是立刻加载

        // 1) 懒加载属性 → 真实地址
        for (var a = 0; a < LAZY_SRC_ATTRS.length; a++) {
            var lazySrc = img.getAttribute(LAZY_SRC_ATTRS[a]);
            if (lazySrc) { plan = { kind: 'src', value: lazySrc }; break; }
        }
        // 2) 懒加载 srcset → 只取第一个候选做请求与失败重试地址
        if (!plan) {
            for (var i = 0; i < LAZY_SRCSET_ATTRS.length; i++) {
                var ss = img.getAttribute(LAZY_SRCSET_ATTRS[i]);
                if (ss) {
                    plan = { kind: 'srcset', value: ss, first: ss.split(',')[0].trim().split(/\s+/)[0] };
                    break;
                }
            }
        }
        // 3) 原生 loading="lazy"（本站主路径）：地址已在 src，交给窗口决定何时加载
        if (!plan && img.getAttribute('loading') === 'lazy') { plan = { kind: 'sched' }; deferred = true; }
        // 4) 服务端直接给的可请求地址：浏览器已经在加载它了，只补 no-referrer/decoding。
        //    注意不能用窗口去"延后"它——请求早就发出去了，装样子没有意义
        if (!plan && (src.indexOf('http') === 0 || src.indexOf('//') === 0 || src.indexOf('/') === 0)) plan = { kind: 'keep' };

        // 空 src、data: 内联图、images/xxx.gif 这种相对路径装饰图 —— 一律不碰。
        // v2.5 把 referrerPolicy/decoding 的赋值放在这一行**之后**是对的，这里保持原样
        if (!plan) { img._skip = true; return false; }

        // referrerPolicy 必须在任何 src 赋值之前设置，语义对齐"直接打开图片链接"（不带 Referer），
        // 规避图床防盗链导致的"页内灰底、直开秒出"；decoding=async 避免解码阻塞渲染
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        // 图床域名预连接（内部按 origin 去重，重复调用开销可忽略）
        preconnectImgHost(img);

        if (plan.kind === 'src' || plan.kind === 'srcset') {
            // 真实地址先挂在 _plan 上，等窗口判定通过、真正要发请求时才写进 src/srcset
            // （2.0 拿绝对 URL 与相对路径比较恒不等，会重复赋值；这里用 _assignedSrc 去重）
            img._plan = plan;
            saveOriginalSrc(img, plan.kind === 'srcset' ? plan.first : plan.value);
            deferred = true;
        } else if (plan.kind === 'sched') {
            saveOriginalSrc(img, img.currentSrc || src);
            deferred = true;
        } else { // keep：服务端给的就是可请求地址，浏览器已在加载，只补 no-referrer/decoding
            saveOriginalSrc(img, src);
        }

        img._forceLoaded = true;
        watchError(img);
        // 交给"进入视口即提权"的观察器；_viewSeen 保证节点复用重算时不会重复观察
        if (ioView && !img._viewSeen) ioView.observe(img);

        if (deferred) {
            var where = classify(img);
            // null = 解析早期 CSS 还没生效、拿不到有效矩形；'out' = 在窗口外。
            // 两种都交给 IO，布局完成/滚到窗口边缘时它自己回调
            if (where === null || where === 'out') {
                if (io) { io.observe(img); img._observed = true; }
                else { activateImage(img, null); }   // 没有 IO 的极老浏览器：只能直接放行
            } else {
                activateImage(img, where === 'view' ? 'high' : null);
            }
        } else {
            // 地址已经就位（服务端已给 src），直接激活；视口内的标 high
            var w2 = classify(img);
            activateImage(img, w2 === 'view' ? 'high' : null);
        }
        return true;
    }

    function processImages(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) forceLoadImage(imgs[i]);
    }

    /* ============================ 广告清理 ============================ */

    // 单次 matches 判断（原实现是 8 次 el.matches 循环；这些都是 class 选择器，合并后语义等价、开销更低）
    function matchesAny(el) {
        if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
        return el.matches(COMBINED_SELECTOR);
    }

    // ⚠️ 入参既可以是最外层 document（nodeType 9，DOMContentLoaded 全量扫描与兜底轮询都传它），
    //    也可以是 MutationObserver 送来的元素节点（nodeType 1）。早期版本只放行 nodeType 1，
    //    把 document 直接挡掉，导致全量扫描静默失效（广告清不干净）——务必保留 9 / 11 分支
    function removeMatching(root) {
        if (!root) return 0;
        if (root.nodeType === 1) {
            var isRootEl = (root === document.body || root === document.documentElement);
            // 自己就是广告容器就整块删掉
            if (!isRootEl && matchesAny(root)) { root.remove(); return 1; }
            // 叶子节点不可能包含广告后代，直接早退（解析期绝大多数新增节点是叶子）
            if (!isRootEl && !root.firstElementChild) return 0;
        } else if (root.nodeType !== 9 && root.nodeType !== 11) {
            return 0; // 文本 / 注释等
        }
        if (!root.querySelectorAll) return 0;
        var els = root.querySelectorAll(COMBINED_SELECTOR);
        for (var i = 0; i < els.length; i++) els[i].remove();
        return els.length;
    }

    function processAll(root) {
        // document(9) / DocumentFragment(11) 都要放行
        if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
        if (root.firstElementChild) processImages(root);
        removeMatching(root);
    }

    /* ============================ 变更监听 ============================ */

    var pendingNodes = [];
    var pendingAttrs = [];
    var debounceTimer = null;

    function flushPending() {
        debounceTimer = null;
        if (pendingNodes.length) {
            for (var i = 0; i < pendingNodes.length; i++) {
                var node = pendingNodes[i];
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IMG') forceLoadImage(node);
                processAll(node);
            }
            pendingNodes = [];
        }
        if (pendingAttrs.length) {
            for (var j = 0; j < pendingAttrs.length; j++) {
                var im = pendingAttrs[j];
                if (!im._forceLoaded) forceLoadImage(im);
            }
            pendingAttrs = [];
        }
    }

    function scheduleFlush() { if (debounceTimer) return; debounceTimer = setTimeout(flushPending, 50); }

    var RESET_ATTRS = ['data-src', 'data-srcset', 'data-original', 'data-lazy-src', 'src'];

    var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
            var mutation = mutations[m];
            if (mutation.type === 'attributes') {
                var t = mutation.target;
                if (t.tagName === 'IMG') {
                    // 懒加载源变化 = 节点复用换图：旧的重试地址/调度状态全部失效，
                    // 否则失败会拿旧图重试，且已 load 之后复用的原生 lazy 图会被 _activated 卡死永不激活。
                    // _skip 也要清掉：被跳过之后又补上了真实地址的图需要重新评估
                    if (RESET_ATTRS.indexOf(mutation.attributeName) > -1) {
                        // selfAssign 的一次性标记：这是脚本自己写的属性，不是站点换图，跳过重置
                        if (t._selfWrite) { t._selfWrite = false; continue; }
                        t._forceLoaded = false;
                        t._markedFailed = false;
                        t._assignedSrc = null;
                        t._assignedSrcset = null;
                        t._origSrc = null;
                        t._retried = false;
                        t._activated = false;
                        t._plan = null;
                        t._skip = false;
                        t.classList.remove('lazy-failed');
                    }
                    if (!t._forceLoaded) pendingAttrs.push(t);
                }
                continue;
            }
            var nodes = mutation.addedNodes;
            for (var i = 0; i < nodes.length; i++) pendingNodes.push(nodes[i]);
        }
        if (pendingNodes.length || pendingAttrs.length) scheduleFlush();
    });

    function startObserver() {
        if (document.documentElement) {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['loading', 'data-src', 'src', 'data-srcset', 'data-original', 'data-lazy-src']
            });
        } else { setTimeout(startObserver, 10); }
    }
    startObserver();

    // ---- 兜底放行（v2.7，对齐色花堂语义）----
    // DOM 就绪 RELEASE_ALL_MS 后，把所有"已分类但尚未被窗口机制激活"的缩略图一次性放行。
    // 仅页面可见时执行：后台标签页里替用户下载整页 17.25MB 才是真浪费；
    // 隐藏期间定时器到期则放弃本次，由 visibilitychange 在页面转可见后补排一次。
    // 只放行 _forceLoaded 且未 _activated 且未 _skip 的图：占位图不碰、
    // 未分类的新图（理论上不存在，兜底轮询已覆盖）交给原有机制。
    var releaseTimer = null;

    function releaseAllImages() {
        releaseTimer = null;
        if (document.visibilityState !== 'visible') return;
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (im._forceLoaded && !im._activated && !im._skip) {
                activateImage(im, null);   // 不下发优先级：视口内的早已被 ioView 提过 high
            }
        }
    }

    function scheduleReleaseAll() {
        if (releaseTimer || !RELEASE_ALL_MS) return;
        releaseTimer = setTimeout(releaseAllImages, RELEASE_ALL_MS);
    }

    if (RELEASE_ALL_MS) {
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') scheduleReleaseAll();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            processAll(document);
            scheduleReleaseAll();
        });
    } else {
        processAll(document);
        scheduleReleaseAll();
    }

    // 兜底轮询：清理漏网广告 + 补处理漏网图片（比如解析结束后才被插入、且 MutationObserver 漏掉的）；
    // 连续空闲 20 个周期后自停，之后动态新增仍由 MutationObserver 接管
    var idleCycles = 0;
    var fallbackTimer = setInterval(function () {
        var removed = removeMatching(document);
        var fresh = 0;
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i++) { if (!imgs[i]._forceLoaded && forceLoadImage(imgs[i])) fresh++; }
        if (removed === 0 && fresh === 0) {
            if (++idleCycles >= FALLBACK_IDLE_STOP) clearInterval(fallbackTimer);
        } else { idleCycles = 0; }
    }, FALLBACK_INTERVAL);

})();

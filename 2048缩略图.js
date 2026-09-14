// ==UserScript==
// @name         2048缩略图
// @namespace    https://bbs.vsbskpo.com/
// @version      2.8
// @description  视口窗口按需加载缩略图：窗口内的图立刻加载（视口内的标 fetchpriority=high），窗口外的滚到附近才加载；10 秒后兜底放行所有尚未激活的缩略图（仅页面可见时执行，后台标签页不预下载）。附带：图床域名 preconnect、移除占位图与广告、隐藏侧栏、"无 Referer" 请求规避图床防盗链、失败后穿透缓存有限次重试、节点复用换图时自动重置状态。
// @author       Chevy Yang
// @match        https://bbs.vsbskpo.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================================
       设计要点（以最终实现为准）

       1) 加载窗口：视口上方 TOP_MARGIN 到视口下方 LOOKAHEAD 之间的图立刻加载；
          窗口外的只挂 IntersectionObserver，滚到窗口边缘才激活。
          窗口内且确实落在视口里的图标 fetchpriority=high（优先占用图床带宽），
          进窗口但不在视口里的不下发优先级。优先级只升不降。
       2) 主路径是原生 loading="lazy"：站点在 src 里给的就是真实地址，"何时加载"由窗口决定。
          data-src / data-original / data-lazy-src / data-srcset 分支保留但当前无命中
          （@match 覆盖整站，其它页面类型可能出现，getAttribute 开销可忽略）。
          服务端已给出可请求绝对地址的图（keep 分支）浏览器早就在下载，脚本只补
          no-referrer / decoding，不做延后 —— 因此这类页面不受窗口保护。
       3) 10 秒兜底放行（RELEASE_ALL_MS）：DOM 就绪后时长一到，把所有尚未被窗口激活的缩略图
          一次性放行；仅页面可见时执行，隐藏标签页不放行、转可见后补排一次；设为 0 关闭。
          这是有意的取舍：开着页面慢慢看时不必等图，代价是停留超过该时长就整页下载。
       4) 图床：域名不固定，同一页可能出现多个（单页常见 2~5 个域名、单域名可占几十张）。
          每个 origin 建一条 preconnect（DNS+TCP+TLS 提前握手），不加 crossorigin ——
          这些是普通 <img> 非 CORS 请求。图片地址本来就在页面 src 里、preload scanner 见到即连接，
          所以 preconnect 的增量收益主要在"窗口内尚未出现的域名"：滚动/兜底放行时省一次握手。
       5) 图床只认"无 Referer"：缩略图统一 referrerPolicy="no-referrer"（语义对齐"直接打开图片
          链接"），规避防盗链导致的页内灰底；失败时穿透缓存有限次重试，仍失败则压暗标记、点一下可再试。
          图床支持 WebP 协商（浏览器自动处理，脚本不干预）且响应很慢，所以"少发请求"同时省流量与
          时间；站点没有可用的缩略图变体，字节量只能靠"少加载"来控制。
       6) 去广告与侧栏：.recs-* / .nav-container 删除，.reward-card / .signature / .movie-banner
          删除；侧栏 .r_two 用 CSS 隐藏而非删除，避免影响站点自身的布局计算。
       7) 节点复用换图：src / data-* 变化视为"换了图"，需重置该图的调度与重试状态；
          脚本自己写 src 时用一次性 _selfWrite 标记让 MutationObserver 跳过重置，避免自激循环。
          该标记只对 attributeFilter 内的属性有效 —— srcset 不在其中，故 srcset 直接赋值并用
          _assignedSrcset 去重（给它打标记会残留，进而吞掉下一次真实换图的重置信号）。
       ========================================================================== */

    // 加载窗口边界（调大 = 滚动更顺、流量更多；调小 = 更省流量）
    var TOP_MARGIN = 400;   // 视口上方这么多像素内也立即加载：向上回滚时不出现空位
    var LOOKAHEAD = 1200;   // 视口下方这么多像素内提前加载

    var FALLBACK_INTERVAL = 3000;   // 兜底轮询周期（清理漏网广告 + 补处理漏网图片）
    var FALLBACK_IDLE_STOP = 20;    // 连续这么多个周期没活干就自停（20 × 3s = 60s）

    // 兜底放行：DOM 就绪后这么多毫秒，把所有尚未被窗口机制激活的缩略图一次性放行。
    // 仅页面可见时执行（后台标签页不替用户下载整页图），页面从隐藏恢复可见时补排一次。
    // 设为 0 可关闭，只保留纯窗口按需加载。⚠️ 开启即接受"停留超时后整页图片照单全收"
    var RELEASE_ALL_MS = 10000;

    // 广告 / 无用块。合并成单个选择器：解析期每个新增节点都要判定一次，一次 matches 远优于 N 次循环
    var AD_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill', '.nav-container'];
    var REMOVE_ELEMENTS = ['.reward-card', '.signature', '.movie-banner'];
    var COMBINED_SELECTOR = AD_SELECTORS.concat(REMOVE_ELEMENTS).join(',');

    // 懒加载真实地址所在的属性名。本站主路径是"真实地址已在 src"，这几条分支当前无命中；
    // 保留是因为 @match 覆盖整站，其它页面类型可能出现（每次 getAttribute 开销可忽略）
    var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src'];
    var LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

    // 占位图判定：站点用 none.gif / thumb-ing.gif / loading.gif / blank.gif 之类做占位。
    // 'placeholder' 只按**文件名前缀**匹配——用子串匹配会误伤正常图片路径里含该词的地址
    function isPlaceholderSrc(src) {
        if (!src) return true;
        if (src.indexOf('data:') === 0) return true;
        var low = src.toLowerCase();
        if (low.indexOf('none.gif') !== -1 ||
            low.indexOf('thumb-ing') !== -1 ||
            low.indexOf('loading.gif') !== -1 ||
            low.indexOf('blank.gif') !== -1) return true;
        var file = low.split('#')[0].split('?')[0].split('/').pop();
        return file.indexOf('placeholder') === 0;
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

    // 脚本自己写 src 时打一次性标记：MutationObserver 会看到这次赋值，但它是"脚本行为"、
    // 不是"站点换图"，不能据此重置调度状态——否则会形成 写 → MO 重置 → 重新分类 → 再写 的自激循环。
    // ⚠️ 只能用于 attributeFilter 内的属性（当前仅 src）：标记依赖 MO 的 attributes 回调来消费，
    //    filter 外的属性（如 srcset）赋值不产生 record，标记会永久残留，
    //    反而吞掉下一次真实换图的重置信号 —— 故 srcset 必须直接赋值。
    function selfAssign(img, prop, value) {
        img._selfWrite = true;
        img[prop] = value;
    }

    // 图床域名预连接：首次处理到某图床域名的图片时插入 <link rel=preconnect>，
    // 把 DNS+TCP+TLS 提前到窗口外图片真正激活之前，按 origin 去重。
    // 不加 crossorigin：本站缩略图是普通 <img>（非 CORS 请求），加了反而多建一条连接。
    // 注：地址本来就在页面 src 里、preload scanner 见到即连接，此处的增量收益是
    // "窗口内还没出现过的域名"——兜底放行/滚动加载触发时免掉一次握手。
    var preconnectedHosts = {};
    var PRECONNECT_RETRY = 25;   // 4ms × 25 ≈ 100ms，足够等到 <head>/<html> 建立

    function preconnectImgHost(img) {
        var src = img.getAttribute('src') || '';
        if (src.indexOf('http') !== 0 && src.indexOf('//') !== 0) return;
        var origin;
        try {
            var u = new URL(src, location.href);
            if (u.host === location.host) return;
            origin = u.origin;
        } catch (e) { return; }
        if (!origin || preconnectedHosts[origin]) return;
        preconnectedHosts[origin] = true;   // 先占位，避免同一域名并发插入多条
        insertPreconnect(origin, 0);
    }

    // 真正插入 <link rel=preconnect>。
    // ⚠️ document-start 阶段 <head> 与 <html> 可能都还没建立：必须重试，不能在这里放弃。
    //    若插入失败就放弃、而占位标记又已写入，该域名在本页会**永久**失去预连接，
    //    且异常被吞掉时完全静默（表现为"这个图床从没预连接过"）。
    //    因此失败时撤销占位，让后面同类图片再试一次。
    function insertPreconnect(origin, tries) {
        var parent = document.head || document.documentElement;
        if (!parent) {
            if (tries < PRECONNECT_RETRY) setTimeout(function () { insertPreconnect(origin, tries + 1); }, 4);
            else delete preconnectedHosts[origin];
            return;
        }
        var link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        try {
            parent.appendChild(link);
        } catch (e) {
            delete preconnectedHosts[origin];
        }
    }

    var MAX_IMG_RETRY = 2;   // 每张图最多自动重试次数（穿透缓存重来），超过就压暗交给手动重试

    function applyFailedStyle(img) {
        img.classList.add('lazy-failed');
    }

    // 手动重试：点一下压暗的图，用 no-referrer + 穿透缓存再请求一次
    function manualRetry(img) {
        if (!img.classList.contains('lazy-failed') || !img._origSrc) return;
        img.classList.remove('lazy-failed');
        img.referrerPolicy = 'no-referrer';
        selfAssign(img, 'src', bustCache(img._origSrc));
    }

    // 失败处理：换 no-referrer + 穿透缓存重试（有次数上限，避免反复失败不停产生新 URL），
    // 仍失败才压暗标记、交给点击手动重试
    function markFailed(img) {
        if (!img._forceLoaded) return;   // 已判定与本脚本无关的图不参与
        if (!img._origSrc) {
            var cand = img.currentSrc || img.getAttribute('src') || img.src;
            if (!isPlaceholderSrc(cand)) img._origSrc = cand;
        }
        var tries = img._retryTimes || 0;
        if (img._origSrc && tries < MAX_IMG_RETRY) {
            img._retryTimes = tries + 1;
            img.referrerPolicy = 'no-referrer';
            selfAssign(img, 'src', bustCache(img._origSrc));
            return;
        }
        applyFailedStyle(img);
    }

    // 事件一律用 addEventListener 注册：img.onerror / img.onclick 是属性式赋值，
    // 会顶掉站点自己注册的处理器（本站有站点脚本在给图片挂事件）。
    // 每个节点只绑定一次，节点复用换图后这些处理器继续复用（读的是元素当前状态）
    function watchError(img) {
        if (img._retryBound) return;
        img._retryBound = true;
        img.addEventListener('error', function () { markFailed(img); });
        img.addEventListener('load', function () { img.classList.remove('lazy-failed'); });
        img.addEventListener('click', function () { manualRetry(img); });
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
    // 为什么需要它：解析期布局还没定型，很多最终落在视口里的图会被判成 near 而按默认优先级下发请求；
    // 而图床很慢、单域名并发连接有限，请求大多还排在队列里 —— 此时提成 high 仍然有效。
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
    // 优先级只升不降：请求一旦下发，再改 fetchPriority 就没有意义，而"放行时统一改低"会让已标好的优先级白费。
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
                    // （src 在 filter 里，所以 src 分支没有这个问题）
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
        // 必须记住结论，否则每次 MutationObserver 回调、每轮兜底轮询都会把这些图重新评估一遍
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
        // referrerPolicy / decoding 的赋值必须排在这行之后：_skip 的图不做任何修改
        if (!plan) { img._skip = true; return false; }

        // referrerPolicy 必须在任何 src 赋值之前设置，语义对齐"直接打开图片链接"（不带 Referer），
        // 规避图床防盗链导致的"页内灰底、直开秒出"；decoding=async 避免解码阻塞渲染
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        // 图床域名预连接（内部按 origin 去重，重复调用开销可忽略）
        preconnectImgHost(img);

        if (plan.kind === 'src' || plan.kind === 'srcset') {
            // 真实地址先挂在 _plan 上，等窗口判定通过、真正要发请求时才写进 src / srcset；
            // 用 _assignedSrc / _assignedSrcset 记录已写入值，避免重复赋值
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

    // ⚠️ 入参既可能是 document（nodeType 9：DOMContentLoaded 全量扫描与兜底轮询都传它），
    //    也可能是 DocumentFragment（11）或 MutationObserver 送来的元素（1）。
    //    三个都必须放行：把 document 挡掉会让全量扫描静默失效（广告清不干净）
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
                    // 源地址变化 = 节点复用换图：旧的重试地址与调度状态全部失效，
                    // 否则失败会拿旧图重试，且已 load 过的原生 lazy 图会被 _activated 卡死永不激活。
                    // _skip 也要清掉：先被跳过、之后又补上真实地址的图需要重新评估
                    if (RESET_ATTRS.indexOf(mutation.attributeName) > -1) {
                        // selfAssign 的一次性标记：这是脚本自己写的属性、不是站点换图，跳过重置
                        if (t._selfWrite) { t._selfWrite = false; continue; }
                        t._forceLoaded = false;
                        t._retryTimes = 0;
                        t._assignedSrc = null;
                        t._assignedSrcset = null;
                        t._origSrc = null;
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

    // ---- 兜底放行 ----
    // DOM 就绪 RELEASE_ALL_MS 后，把所有"已分类但尚未被窗口机制激活"的缩略图一次性放行。
    // 仅页面可见时执行：后台标签页里替用户下载整页图才是真浪费；
    // 隐藏期间定时器到期则放弃本次，由 visibilitychange 在页面转可见后补排一次。
    // 只放行 _forceLoaded 且未 _activated 且未 _skip 的图：占位图不碰，
    // 未分类的新图交给原有机制（兜底轮询 / MutationObserver 覆盖）
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

    // 隐藏期间到期的那次由这里补排（定时器已清空，所以能重新排上）
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

    // 兜底轮询：清理漏网广告 + 补处理漏网图片（解析结束后才插入、且 MutationObserver 漏掉的节点）；
    // 连续 FALLBACK_IDLE_STOP 个周期没活干就自停（默认 20 × 3s = 60s）。
    // 自停后的边界：它负责的是"扫描当前文档"，之后新增的节点仍由 MutationObserver 接管；
    // 若某类节点既不产生 addedNodes、又需要重新评估，自停后就没人补处理了
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

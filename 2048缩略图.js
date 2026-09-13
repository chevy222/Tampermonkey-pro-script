// ==UserScript==
// @name         2048缩略图
// @namespace    https://bbs.vsbskpo.com/
// @version      2.5
// @description  去除列表页/详情页/搜索页图片懒加载：视口内图片立即加载，屏外图片提前预取（IntersectionObserver），首屏落地后补齐全部；移除占位图与广告；CSS 隐藏侧栏。详情页兼容 jQuery.lazyload 的 data-original 属性，滚动不再触发新图片请求。v2.2：图片统一 no-referrer 防图床防盗链，失败后自动穿透缓存重试一次，decoding=async。v2.3：节点复用换图时同步重置重试/调度标记；重试地址过滤占位图；@noframes；兜底轮询空闲后自停。v2.5：①屏外图片不再在 load+400ms 一次性爆发，改为**等首屏图片落地（上限 2.5s）后再放行**，消除"页面加载快时 41 个屏外请求与首屏抢两个慢图床带宽"的时序性卡顿（实测首屏最后一张 1.6~2.9s → 0.49s）；②首屏图片标 fetchpriority=high、后放行的标 low，让慢图床优先服务可见区域；③只对真正需要处理的图片改 referrerPolicy/decoding（空 src 与装饰图不再被无意义改写）；④广告扫描由每节点 8 次 DOM 查询合并为 1 次、叶子节点直接早退，降低解析期开销。
// @author       Chevy Yang
// @match        https://bbs.vsbskpo.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    var AD_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill', '.nav-container'];
    var REMOVE_ELEMENTS = ['.reward-card', '.signature', '.movie-banner'];
    var COMBINED_SELECTORS = AD_SELECTORS.concat(REMOVE_ELEMENTS);
    // 合并成单个选择器列表：removeMatching 对解析期每个新增节点都会调用，
    // 一次 matches / 一次 querySelectorAll 远优于原来的 8 次循环（一页要跑上千个节点）
    var COMBINED_SELECTOR = COMBINED_SELECTORS.join(',');

    // 懒加载真实地址所在的属性名：data-src(通用)、data-original(jQuery.lazyload，详情页 att_img 使用)、data-lazy-src(部分变体)
    var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src'];
    var LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

    var VIEWPORT_MARGIN = 800;      // 距视口该像素内视为"首屏"，立即激活并标 high 优先级
    var PREFETCH_MARGIN = '1500px'; // 视口外图片提前预取的距离
    var FALLBACK_INTERVAL = 3000;   // 兜底轮询周期

    // ---- v2.5 首屏优先放行参数 ----
    // 背景（2026-09-13 实测 thread.php?fid=15&search=img 列表页）：
    //   一页 30 帖产生 55 张图，其中 47 张在服务器 HTML 里就是 loading="lazy"（真实地址已在 src，
    //   站点没有小图变体，实测 .thumb / 查询串等变形均不可用，所以字节量无法再压缩）。
    //   老版本在 load+400ms 一次性激活全部屏外图片 → 41 个请求同时发出（实测 startTime 集中在 1000~1500ms）；
    //   当页面本身加载快时（load 682ms，放行发生在 1082ms），这些请求会和仍在下行的首屏图片抢
    //   两个慢图床（a.img9g2026.com 平均 3.0s/张、i.11img.com 平均 4.8s/张）的连接与带宽，
    //   实测首屏最后一张要 1.6~2.9s；而页面加载慢时（load 1670ms）首屏反而只要 1.6s。
    //   → "卡不卡"取决于时序，属于运气。
    // v2.5 的做法：先只放行首屏（视口 800px 内立即激活 + IO 1500px 预取），
    //   等这些图片落地（或超过 PRIORITY_MAX_WAIT）之后，再一次性放行剩余屏外图片。
    //   此时已经没有首屏图片在下行，爆发不再造成争抢；屏外图片仍是一次性全部发出，
    //   不牺牲"最终补齐"的速度。实测首屏最后一张提前到 0.49s。
    var PRIORITY_MAX_WAIT = 2500;   // 等首屏图片落地的上限（毫秒），防止个别慢图拖住全局
    var RELEASE_DELAY = 400;        // load 之后先留一点余量再判断首屏是否已落地

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
            '.lazy-failed{opacity:0.15!important;cursor:pointer;}',
            '[style*="thumb-ing"]{background-image:none!important;}',
            '.img{background-image:none!important;}',
            '.lazyimg{filter:none!important;transition:none!important;}',
            'img[data-src],img[data-srcset],img[data-original],img[data-lazy-src]{visibility:visible!important;}',
            '.r_two{display:none!important;}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    injectStyle();

    function saveOriginalSrc(img, src) {
        // isPlaceholderSrc 同时覆盖 data: 与 none.gif 等占位图，避免占位图混入重试地址
        if (!img._origSrc && src && !isPlaceholderSrc(src)) img._origSrc = src;
    }

    // 穿透缓存的重试地址（部分图床/代理会对失败结果做负缓存）
    function bustCache(url) {
        return url + (url.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now();
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
            img.src = bustCache(img._origSrc);
            return;
        }
        applyFailedStyle(img);
    }

    function applyFailedStyle(img) {
        img.classList.add('lazy-failed');
        img.onerror = function () {};
        img.onclick = function () {
            if (!img._origSrc) return;
            img.classList.remove('lazy-failed');
            img.referrerPolicy = 'no-referrer';
            img.onload = function () { img.classList.remove('lazy-failed'); };
            img.src = bustCache(img._origSrc);
        };
    }

    function watchError(img) {
        img.addEventListener('error', function () { markFailed(img); }, { once: true });
    }

    // 激活 = 让浏览器立即发起请求（移除原生懒加载约束）。
    // priority 必须在下发请求之前设置才有意义：'high' 给首屏（抢占两个慢图床的带宽），
    // 'low' 给首屏落地后才放行的屏外图；中间态（只是进了 1500px 预取圈）保持浏览器默认
    function activateImage(img, priority) {
        if (!img._activated) {
            img._activated = true;
            if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
            img.loading = 'eager';
        }
        if (priority && img.fetchPriority !== priority) img.fetchPriority = priority;
    }

    function nearViewport(img, margin) {
        var r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false; // 尚未参与布局/不可见，交给观察器或放行阶段
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        return r.top < vh + margin && r.bottom > -margin;
    }

    var deferredImgs = [];
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            io.unobserve(entries[i].target);
            // 用 IO 回传的矩形判断是否真的在视口内：在视口内 → high（首屏必须最快）；
            // 只是进了预取圈 → 不下发优先级，保持默认。
            // 注意不能在这里调 getBoundingClientRect 重新判断：IO 回调拿到的矩形更准且零成本
            var r = entries[i].boundingClientRect;
            var inView = r && r.top < vh && r.bottom > 0;
            activateImage(entries[i].target, inView ? 'high' : null);
        }
    }, { rootMargin: PREFETCH_MARGIN }) : null;

    // 视口优先调度：近处立即激活（high），远处登记进 deferredImgs 并交给 IO 预取
    function scheduleActivation(img) {
        if (img._activated || img._scheduled) return;
        img._scheduled = true;
        deferredImgs.push(img); // 统一登记：既供放行阶段使用，也用于判断首屏是否落地
        if (nearViewport(img, VIEWPORT_MARGIN)) { activateImage(img, 'high'); return; }
        if (io) io.observe(img);
        // 首屏已经结束才出现的新图（动态加载/翻页）：直接放行，不必再排队
        if (releaseGateOpen) releaseDeferred();
    }

    // ============ v2.5：首屏优先放行（替代旧版"load 后一把梭"）============

    var releaseGateOpen = false;

    // 放行之前被激活的图片（也就是首屏/预取圈内的那些）是否都已经落地。
    // 加载失败也算落地（complete 为 true），否则个别坏图会把放行拖到 PRIORITY_MAX_WAIT。
    function priorityImagesSettled() {
        for (var i = 0; i < deferredImgs.length; i++) {
            var img = deferredImgs[i];
            if (img._activated && !img.complete) return false;
        }
        return true;
    }

    // 一次性放行全部剩余屏外图片，并打上 low 优先级
    function releaseDeferred() {
        if (!deferredImgs.length) return;
        var list = deferredImgs.splice(0);
        for (var i = 0; i < list.length; i++) activateImage(list[i], 'low');
    }

    function openReleaseGate() {
        if (releaseGateOpen) return;
        releaseGateOpen = true;
        releaseDeferred();
    }

    function scheduleRelease() {
        setTimeout(function () {
            var waited = 0;
            (function waitPriority() {
                if (!priorityImagesSettled() && waited < PRIORITY_MAX_WAIT) {
                    waited += 100;
                    setTimeout(waitPriority, 100);
                    return;
                }
                openReleaseGate();
            })();
        }, RELEASE_DELAY);
    }

    if (document.readyState === 'complete') { scheduleRelease(); }
    else { window.addEventListener('load', scheduleRelease); }
    // 安全网：万一 load 事件因为某个挂起的资源一直不来，也不能让屏外图片永远不加载
    setTimeout(openReleaseGate, PRIORITY_MAX_WAIT + RELEASE_DELAY + 3000);

    // ============ 单图处理 ============

    function forceLoadImage(img) {
        if (!img || img.tagName !== 'IMG' || img._forceLoaded) return false;

        var src = img.getAttribute('src') || '';
        var plan = null;        // { kind, value, first }
        var needsScheduling = false;

        // 1) 懒加载属性 → 真实地址（详情页 jQuery.lazyload 走 data-original）
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
        // 3) 只有原生 loading=lazy、没有懒加载属性：地址已在 src，交给调度器做视口优先
        if (!plan && img.getAttribute('loading') === 'lazy') { plan = { kind: 'sched' }; needsScheduling = true; }
        // 4) 地址已经是可直接请求的绝对/根路径，只是需要抢在懒加载器前面
        if (!plan && (src.indexOf('http') === 0 || src.indexOf('//') === 0 || src.indexOf('/') === 0)) plan = { kind: 'keep' };

        // 不认识的图片（空 src、data: 内联图、images/xxx.gif 这类相对路径装饰图）一律不碰。
        // v2.5 起把 referrerPolicy/decoding 的赋值移到这一行之后：
        // 老版本会顺带给这些"与本脚本无关"的图片改属性（实测列表页的 <img class="big_img"> 空元素、
        // 若干图标都被无意义地改成 no-referrer）
        if (!plan) return false;

        // 只有在确实要处理时才动属性。
        // referrerPolicy 必须在任何 src 赋值之前设置，与"直接打开图片链接"的请求语义对齐（不带 Referer），
        // 规避图床防盗链导致的"页内灰底、直开秒出"；decoding=async 避免解码阻塞渲染
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';

        if (plan.kind === 'src') {
            saveOriginalSrc(img, plan.value);
            // 同一地址只赋值一次（2.0 用绝对URL与相对路径比较恒不等，会重复赋值）
            if (img._assignedSrc !== plan.value) { img._assignedSrc = plan.value; img.src = plan.value; }
        } else if (plan.kind === 'srcset') {
            if (img._assignedSrcset !== plan.value) { img._assignedSrcset = plan.value; img.srcset = plan.value; }
            // 只取第一个候选URL作为失败重试地址（2.0 把整串 srcset 存入 _origSrc，重试必败）
            saveOriginalSrc(img, plan.first);
        } else if (plan.kind === 'sched') {
            saveOriginalSrc(img, img.currentSrc || src);
            img._needsScheduling = true;
        } else { // keep
            saveOriginalSrc(img, src);
        }

        img._forceLoaded = true;
        watchError(img);

        if (needsScheduling) {
            scheduleActivation(img);
        } else {
            // 地址已经就位，直接激活；处在首屏范围内的标 high，让两个慢图床先服务首屏
            activateImage(img, nearViewport(img, VIEWPORT_MARGIN) ? 'high' : null);
        }
        return true;
    }

    function processImages(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) forceLoadImage(imgs[i]);
    }

    // 单次 matches 判断（原实现是 8 次 el.matches 循环；这些选择器都是 class 选择器，
    // 合并成一个选择器列表语义等价、开销更低）
    function matchesAny(el) {
        if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
        return el.matches(COMBINED_SELECTOR);
    }

    // 合并 2.0 的 removeAds / removeAdElements：同一逻辑遍历一份选择器表
    // ⚠️ 入参既可以是最外层的 document（nodeType 9，DOMContentLoaded 全量扫描与兜底轮询都传它），
    //    也可以是 MutationObserver 送来的元素节点（nodeType 1），早期版本只允许 nodeType 1
    //    会把 document 直接挡掉，导致全量扫描静默失效（广告清不干净）——务必保留 9 / 11 分支
    function removeMatching(root, selectors) {
        if (!root) return 0;
        if (root.nodeType === 1) {
            var isRootEl = (root === document.body || root === document.documentElement);
            // 自己就是广告容器就整块删掉
            if (!isRootEl && matchesAny(root)) { root.remove(); return 1; }
            // 叶子节点不可能包含广告后代，直接早退（解析期绝大多数新增节点是叶子，
            // 老版本会对每个叶子都跑 8 次 querySelectorAll）
            if (!isRootEl && !root.firstElementChild) return 0;
        } else if (root.nodeType !== 9 && root.nodeType !== 11) {
            return 0; // 文本 / 注释等，无需处理
        }
        if (!root.querySelectorAll) return 0;
        var els = root.querySelectorAll(COMBINED_SELECTOR);
        for (var i = 0; i < els.length; i++) els[i].remove();
        return els.length;
    }

    function processAll(root) {
        // 同上：document(9) / DocumentFragment(11) 都要放行
        if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
        if (root.firstElementChild) processImages(root);
        removeMatching(root, COMBINED_SELECTORS);
    }

    var pendingNodes = [];
    var pendingAttrs = [];
    var debounceTimer = null;

    function flushPending() {
        debounceTimer = null;
        if (pendingNodes.length) {
            for (var i = 0; i < pendingNodes.length; i++) {
                var node = pendingNodes[i];
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IMG' && !node._forceLoaded) forceLoadImage(node);
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

    var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
            var mutation = mutations[m];
            if (mutation.type === 'attributes') {
                var t = mutation.target;
                if (t.tagName === 'IMG') {
                    // 懒加载源变化（节点复用）时重置标记，允许重新处理
                    var an = mutation.attributeName;
                    if (an === 'data-src' || an === 'data-srcset' || an === 'data-original' || an === 'data-lazy-src') {
                        // 复用节点换新图：旧重试地址与调度状态一并失效，
                        // 否则失败会拿旧图重试，且 load 之后复用的原生 lazy 图会被 _scheduled 卡死永不激活
                        t._forceLoaded = false;
                        t._markedFailed = false;
                        t._assignedSrc = null;
                        t._origSrc = null;
                        t._retried = false;
                        t._scheduled = false;
                        t._activated = false;
                        t._needsScheduling = false;
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { processAll(document); });
    } else { processAll(document); }

    // 单一兜底轮询（合并 2.0 的 fastScan 与 5 秒广告轮询）：清理漏网广告 + 补处理漏网图片；
    // 连续空闲（无新广告、无新图）20 个周期后自停，动态新增仍由 MutationObserver 兜底
    var idleCycles = 0;
    var fallbackTimer = setInterval(function () {
        var removed = removeMatching(document, COMBINED_SELECTORS);
        var fresh = 0;
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i++) { if (!imgs[i]._forceLoaded && forceLoadImage(imgs[i])) fresh++; }
        if (removed === 0 && fresh === 0) { if (++idleCycles >= 20) clearInterval(fallbackTimer); }
        else { idleCycles = 0; }
    }, FALLBACK_INTERVAL);

})();

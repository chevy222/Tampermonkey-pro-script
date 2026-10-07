// ==UserScript==
// @name         2048缩略图
// @namespace    https://fby.hfz300.com/
// @version      3.0
// @description  视口窗口按需加载缩略图。视口内的立即加载并标 fetchpriority=high；窗口内其余排队逐张放行；窗口外的滚到附近才加载。附带：图床 preconnect、屏蔽占位图与广告、隐藏侧栏、跨域缩略图 no-referrer、失败重试与点击重试、节点复用换图自动重置。
// @author       Chevy Yang
// @match        https://bbs.hdaksog.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================== 可调参数 ============================== */

    // 加载窗口：视口上方 TOP_MARGIN 到视口下方 LOOKAHEAD 之间算"窗口"
    var TOP_MARGIN = 300;
    var LOOKAHEAD = 800;

    // 放行节奏：视口外的图排队，每隔这么多毫秒放行一张；视口内的图插队立即放行。
    // 图床对单客户端限速，同时在飞的请求越少，正在看的那张出图越快
    var ACTIVATE_INTERVAL_MS = 100;

    // 兜底放行：DOM 就绪后这么多毫秒，把仍在排队的图按同一节奏放完；设为 0 关闭
    var RELEASE_ALL_MS = 10000;

    // 兜底轮询：清理漏网广告 + 补处理漏网图片，连续这么多轮无活可干就自停
    var FALLBACK_INTERVAL = 3000;
    var FALLBACK_IDLE_STOP = 20;

    // 单图失败自动重试上限，每轮换一次查询串绕开已缓存的失败结果
    var MAX_IMG_RETRY = 2;

    // 广告与无用块，命中即整块移除
    var REMOVE_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill',
                            '.nav-container', '.movie-banner'];
    var REMOVE_SELECTOR = REMOVE_SELECTORS.join(',');

    // 预连接插入的重试次数：document-start 阶段 <head> 可能还没建立（4ms × 25 ≈ 100ms）
    var PRECONNECT_RETRY = 25;

    /* ============================== 样式 ============================== */

    function injectStyle() {
        if (!document.head && !document.documentElement) { setTimeout(injectStyle, 4); return; }
        var s = document.createElement('style');
        s.textContent = [
            // 重试后仍失败的图：压暗标记，点击重试（见 markFailed / manualRetry）
            '.lazy-failed{opacity:0.15!important;cursor:pointer;}',
            // 站点给每个缩略图容器挂了 inline 的占位背景 background-image: url(images/thumb-ing.gif)。
            // 置空后这张 59KB 的占位图不再下载，未出图的格子露出父容器 .display 的 #ced4da 底色
            '[style*="thumb-ing"]{background-image:none!important;}',
            // 侧栏（详情页作者信息卡）
            '.r_two{display:none!important;}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    injectStyle();

    /* ============================== 图床预连接 ============================== */

    // 按 origin 去重，每个域名只建一条，不加 crossorigin（缩略图是普通 <img> 非 CORS 请求）。
    // 缩略图地址本来就写在页面 src 里、preload scanner 见到即连接，所以这里的增量收益在
    // "窗口内尚未出现过的图床域名"——排队放行时省一次握手（实测单次 TCP+TLS ≈ 340ms）
    var preconnectedHosts = {};

    // 只返回需要预连接的跨域 origin：同源不建；https 页面里的 http 源不建
    // （按混合内容规则它最终不会走 http，预连接只会白建一条连接）
    function crossOriginOf(url) {
        try {
            var u = new URL(url, location.href);
            if (u.host === location.host) return null;
            if (u.protocol === 'http:' && location.protocol === 'https:') return null;
            return u.origin;
        } catch (e) { return null; }
    }

    function preconnectHost(origin) {
        if (!origin || preconnectedHosts[origin]) return;
        preconnectedHosts[origin] = true;   // 先占位，避免同一域名并发插入多条
        insertPreconnect(origin, 0);
    }

    function insertPreconnect(origin, tries) {
        var parent = document.head || document.documentElement;
        if (!parent) {
            // <head> 还没建立：重试；用尽仍失败就撤销占位，让后面同域名的图再试一次
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

    /* ============================== 失败与重试 ============================== */

    // 穿透缓存的重试地址：部分图床/代理会把失败结果做负缓存
    function bustCache(url) {
        return url + (url.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now();
    }

    // 脚本自己写 src（重试）时打一次性标记，让 MutationObserver 跳过这次"换图"重置，
    // 否则重置会清掉重试计数并重新入队，形成循环。src 在 attributeFilter 内，标记必被消费
    function selfAssignSrc(img, src) {
        img._selfWrite = true;
        img.src = src;
    }

    // 手动重试：点压暗的图，换 no-referrer + 穿透缓存再请求一次。
    // 缩略图整体位于帖子链接 <a> 内部，必须拦下这次点击，否则会连带跳到详情页
    // （卡片下方的标题链接不受影响，仍可进入帖子）
    function manualRetry(img, e) {
        if (!img.classList.contains('lazy-failed') || !img._origSrc) return;
        e.preventDefault();
        e.stopPropagation();
        img.classList.remove('lazy-failed');
        img.referrerPolicy = 'no-referrer';
        selfAssignSrc(img, bustCache(img._origSrc));
    }

    // 自动重试有次数上限，用尽则压暗标记，交给点击手动重试
    function markFailed(img) {
        if (!img._forceLoaded || !img._origSrc) return;
        var tries = img._retryTimes || 0;
        if (tries < MAX_IMG_RETRY) {
            img._retryTimes = tries + 1;
            img.referrerPolicy = 'no-referrer';
            selfAssignSrc(img, bustCache(img._origSrc));
            return;
        }
        img.classList.add('lazy-failed');
    }

    // 事件一律用 addEventListener 注册：img.onerror / img.onclick 是属性式赋值，
    // 会顶掉站点自己挂的处理器。每个节点只绑一次，节点复用换图后这些处理器继续复用
    function watchError(img) {
        if (img._retryBound) return;
        img._retryBound = true;
        img.addEventListener('error', function () { markFailed(img); });
        img.addEventListener('load', function () { img.classList.remove('lazy-failed'); });
        img.addEventListener('click', function (e) { manualRetry(img, e); });
    }

    /* ============================== 放行队列 ============================== */

    // 视口外的图不一次性放行，而是排队逐张放：
    // 图床对单客户端限速，同时放行几十张只会把每张的完成时间拉长；逐张放行时长队被压短，
    // 正在看的图出得更快。视口内的图不入队（见 io / ioView 回调）
    var activateQueue = [];
    var activateTimer = null;

    function pumpActivate() {
        if (activateTimer || !activateQueue.length) return;
        activateTimer = setTimeout(function () {
            activateTimer = null;
            var img = activateQueue.shift();
            if (img && !img._activated) activateImage(img, null);
            pumpActivate();
        }, ACTIVATE_INTERVAL_MS);
    }

    function enqueueActivate(img) {
        if (img._activated || activateQueue.indexOf(img) > -1) return;
        activateQueue.push(img);
        pumpActivate();
    }

    // 图插队（进入视口）或被换掉时出队
    function dequeueActivate(img) {
        var i = activateQueue.indexOf(img);
        if (i > -1) activateQueue.splice(i, 1);
        if (!activateQueue.length && activateTimer) { clearTimeout(activateTimer); activateTimer = null; }
    }

    /* ============================== 观察器 ============================== */

    // 窗口观察器：进入窗口的图，确实落在视口里的立即放行并提权，其余排队
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            var img = entries[i].target;
            if (img._activated) { io.unobserve(img); img._observed = false; continue; }
            // 用 IO 回传的矩形判断是否真的在视口里，比在这里调 getBoundingClientRect 更准也更省
            var r = entries[i].boundingClientRect;
            var inView = !!r && r.bottom > 0 && r.top < vh;
            if (inView) { dequeueActivate(img); activateImage(img, 'high'); }
            else enqueueActivate(img);
        }
    }, { rootMargin: TOP_MARGIN + 'px 0px ' + LOOKAHEAD + 'px 0px' }) : null;

    // 视口观察器（rootMargin 0）：只捕捉"真的进入视口"这一个信号。
    // 解析期布局还没定型，一些最终落在视口里的图会被判成"窗口内但不在视口"而排队；
    // 它负责让这些图插队立即放行，并把已放行但还排在浏览器队列里的图提成 high
    var ioView = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            var t = entries[i].target;
            ioView.unobserve(t);
            t._viewSeen = true;
            if (!t._activated) { dequeueActivate(t); activateImage(t, 'high'); }
            else if (t.fetchPriority !== 'high') t.fetchPriority = 'high';
        }
    }, { rootMargin: '0px' }) : null;

    /* ============================== 单图处理 ============================== */

    // 激活 = 撤掉原生懒加载，让浏览器立刻发请求。优先级只升不降：
    // 请求一旦下发，再改 fetchPriority 就没有意义，放行时统一改低会让已标好的优先级白费
    function activateImage(img, priority) {
        if (!img._activated) {
            img._activated = true;
            if (img._observed && io) { io.unobserve(img); img._observed = false; }
            // fetchPriority 必须在请求真正下发之前写好，否则等于没写
            if (priority === 'high') img.fetchPriority = 'high';
            img.loading = 'eager';
            return;
        }
        if (priority === 'high' && img.fetchPriority !== 'high') img.fetchPriority = 'high';
    }

    // 窗口判定：'view' 视口内 / 'near' 窗口内但在视口外 / 'out' 窗口外。
    // 返回 null 表示尚未参与布局（解析早期 CSS 还没生效时 rect 全为 0），
    // 这种图不能当"窗口外"处理，交给 IntersectionObserver 等布局完成后再判
    function classify(img) {
        var r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (r.bottom < -TOP_MARGIN) return 'out';
        if (r.top > vh + LOOKAHEAD) return 'out';
        return (r.bottom > 0 && r.top < vh) ? 'view' : 'near';
    }

    function forceLoadImage(img) {
        // _skip：已判定"与本脚本无关"的图（占位图、相对路径装饰图、空 src）。
        // 结论必须记住，否则每次 MutationObserver 回调、每轮兜底轮询都会重新评估一遍
        if (!img || img.tagName !== 'IMG' || img._forceLoaded || img._skip) return false;

        var src = img.getAttribute('src') || '';
        // 只处理可请求的绝对地址；空 src、data: 内联图、images/xxx.gif 这类相对路径装饰图一律不碰
        if (!src || src.indexOf('data:') === 0 ||
            (src.indexOf('http') !== 0 && src.indexOf('//') !== 0 && src.indexOf('/') !== 0)) {
            img._skip = true;
            return false;
        }

        // referrerPolicy 必须在任何请求下发之前写好；decoding=async 避免解码阻塞渲染。
        // 同源图不受防盗链影响，不设置 no-referrer
        var origin = crossOriginOf(src);
        if (origin) {
            img.referrerPolicy = 'no-referrer';
            preconnectHost(origin);
        }
        img.decoding = 'async';

        img._origSrc = src;
        img._forceLoaded = true;
        watchError(img);
        if (ioView && !img._viewSeen) ioView.observe(img);

        // 服务端已给出可请求地址（原生加载）的图，浏览器早就在下载了，
        // 只补上面的两个属性就够了——用窗口去"延后"它没有意义
        if (img.getAttribute('loading') !== 'lazy') return true;

        var where = classify(img);
        if (where === 'view') {
            activateImage(img, 'high');
        } else if (where === 'near') {
            enqueueActivate(img);
        } else if (io) {
            io.observe(img);
            img._observed = true;
        } else {
            activateImage(img, null);   // 没有 IntersectionObserver 的极老浏览器：只能直接放行
        }
        return true;
    }

    function processImages(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) forceLoadImage(imgs[i]);
    }

    /* ============================== 广告清理 ============================== */

    function removeMatching(root) {
        // 入参可能是 document(9)：DOMContentLoaded 全量扫描与兜底轮询都传它；
        // 也可能是 DocumentFragment(11) 或 MutationObserver 送来的元素(1)，三者都要放行
        if (!root) return 0;
        if (root.nodeType === 1) {
            var isRootEl = (root === document.body || root === document.documentElement);
            // 自己就是广告容器就整块删掉
            if (!isRootEl && root.matches && root.matches(REMOVE_SELECTOR)) { root.remove(); return 1; }
            // 叶子节点不可能包含广告后代，直接早退（解析期绝大多数新增节点是叶子）
            if (!isRootEl && !root.firstElementChild) return 0;
        } else if (root.nodeType !== 9 && root.nodeType !== 11) {
            return 0;   // 文本 / 注释等
        }
        if (!root.querySelectorAll) return 0;
        var els = root.querySelectorAll(REMOVE_SELECTOR);
        for (var i = 0; i < els.length; i++) els[i].remove();
        return els.length;
    }

    function processAll(root) {
        // document(9) / DocumentFragment(11) 都要放行
        if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
        if (root.firstElementChild) processImages(root);
        removeMatching(root);
    }

    /* ============================== 变更监听 ============================== */

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
            for (var j = 0; j < pendingAttrs.length; j++) forceLoadImage(pendingAttrs[j]);
            pendingAttrs = [];
        }
    }

    function scheduleFlush() { if (debounceTimer) return; debounceTimer = setTimeout(flushPending, 50); }

    var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
            var mutation = mutations[m];
            if (mutation.type === 'attributes') {
                // attributeFilter 只订阅了 src，所以每条记录都是"换图"
                var t = mutation.target;
                if (t.tagName === 'IMG') {
                    // selfAssignSrc 的一次性标记：这是脚本自己写的 src，不是站点换图，跳过重置
                    if (t._selfWrite) { t._selfWrite = false; continue; }
                    // src 变化 = 节点复用换图（详情页点击 .pimg 会把地址写进 .big_img[src]）：
                    // 旧的重试地址、重试计数、排队与激活状态全部失效，重新评估
                    dequeueActivate(t);
                    t._forceLoaded = false;
                    t._retryTimes = 0;
                    t._origSrc = null;
                    t._activated = false;
                    t._viewSeen = false;
                    t._skip = false;
                    t.classList.remove('lazy-failed');
                    pendingAttrs.push(t);
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
            // 不订阅 loading：脚本自己会把 loading 改成 eager，订阅它只会白白增加回调
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
        } else { setTimeout(startObserver, 10); }
    }
    startObserver();

    /* ============================== 兜底放行 ============================== */

    // DOM 就绪 RELEASE_ALL_MS 后，把仍在排队的图按正常节奏放完（逐张，不是一次性全放）。
    // 仅页面可见时执行：隐藏标签页里替用户下载整页图才是真浪费；
    // 隐藏期间到期则放弃本次，由 visibilitychange 在页面转可见后补排一次
    var releaseTimer = null;

    function releaseAllImages() {
        releaseTimer = null;
        if (document.visibilityState !== 'visible') return;
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (im._forceLoaded && !im._activated && !im._skip) enqueueActivate(im);
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

    /* ============================== 兜底轮询 ============================== */

    // 清理漏网广告 + 补处理漏网图片（解析结束后才插入、且 MutationObserver 漏掉的节点）；
    // 连续 FALLBACK_IDLE_STOP 个周期没活干就自停。自停后新增的节点仍由 MutationObserver 接管
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

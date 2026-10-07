// ==UserScript==
// @name         2048缩略图
// @namespace    https://fby.hfz300.com/
// @version      4.0
// @description  打开页面即全量预加载全部图片：滑动窗口控制并发、失败自动重试与死图床熔断、右下角常驻加载进度。不监听滚动，滚动不触发任何加载。附带去广告、隐藏侧栏、图床 preconnect、跨域图 no-referrer、节点复用自动重试。
// @author       Chevy Yang
// @match        https://bbs.hdaksog.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================== 可调参数 ============================== */

    // 同时在途的图片请求数上限；每张结算（成功或放弃）后立刻补下一张。
    // 图床对单客户端限速且吞吐波动很大（实测同一批冷请求两次跑相差最多 1.6 倍），限住在飞数的
    // 收益是"靠前的图先完成"而不是总耗时。4 ~ 16 之间的差别被图床自身波动淹没，8 取的是保守值；
    // 突发并发（一次几十张）实测反而更慢
    var MAX_IMG_IN_FLIGHT = 8;

    // 单图失败重试次数与退避基数（另加 0~400ms 抖动）
    var IMG_RETRY_TIMES = 2;
    var IMG_RETRY_BASE_MS = 800;

    // 单张图的总等待上限，跨所有重试共享；超时按失败结算并释放窗口位。
    // 只是兜底：实测单张冷启动（含 TCP+TLS ≈ 340ms）约 0.9 秒
    var IMG_TOTAL_WAIT_MS = 20000;

    // 同一图床连续硬失败（浏览器派发 error：DNS 失败 / 连接被拒 / HTTP 错误）这么多次即判不可达，
    // 该域名还没开始的图片直接判失败，不再白占窗口位。
    // 超时不算——一次冷启动抖动不该把整个域名判死。任一成功即清零
    var HOST_FAIL_THRESHOLD = 3;

    // 加载状态：全部结算后延迟这么久开始淡出（淡出 0.3s，再 0.4s 后移除）
    var PROGRESS_HIDE_DELAY_MS = 2500;

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
            // 放弃加载的图：压暗标记，点击重新排队再试
            '.lazy-failed{opacity:0.15!important;cursor:pointer;}',
            // 站点给每个缩略图容器挂了 inline 的加载中占位图 background-image: url(images/thumb-ing.gif)。
            // 那是一个 59KB 的 gif 且 background-size:cover 会把它放大铺满整格；
            // 置空后这张图不再下载，未出图的格子露出父容器 .display 的 #ced4da 底色
            '[style*="thumb-ing"]{background-image:none!important;}',
            // 侧栏（详情页作者信息卡）
            '.r_two{display:none!important;}',
            // 右下角加载状态。样式与色花堂缩略图保持一致：
            // 加载中黑底、全部成功绿底、有失败橙底，结算后淡出
            '#thumb-progress{position:fixed;right:14px;bottom:14px;z-index:2147483646;' +
                'padding:7px 14px;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;' +
                'font-size:12px;line-height:1.4;box-shadow:0 2px 10px rgba(0,0,0,.25);' +
                'transition:opacity .3s ease;pointer-events:none;}' +
            '#thumb-progress.thumb-progress-done{background:rgba(35,120,60,.85);}' +
            '#thumb-progress.thumb-progress-partial{background:rgba(150,70,20,.88);}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    injectStyle();

    /* ============================== 图床预连接 ============================== */

    // 图片的 src 会被本脚本摘掉交给窗口统一放行，preload scanner 因此看不到图床地址，
    // 首次握手必须由这里提前完成（实测单次 TCP+TLS ≈ 340ms）。
    // 按 origin 去重；不加 crossorigin（缩略图是普通 <img> 非 CORS 请求）
    var preconnectedHosts = {};

    // 只返回需要预连接的跨域 origin：同源不建；https 页面里的 http 源不建
    // （按混合内容规则它最终不会走 http，预连接只会白建一条连接）。
    // 图床域名轮换很频繁，出现 http-only 域名的可能是真实的，这条不是死分支
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

    /* ============================== 加载状态 ============================== */

    var badge = null;
    var hideTimer = null;
    var removeTimer = null;

    var totalCount = 0;      // 已登记进窗口的图片总数
    var finishedCount = 0;   // 已结算（成功或放弃）
    var failedCount = 0;     // 其中放弃的

    function renderProgress() {
        if (!totalCount) return;
        if (!badge || !badge.isConnected) {
            var parent = document.body || document.documentElement;
            if (!parent) return;
            badge = document.createElement('div');
            badge.id = 'thumb-progress';
            parent.appendChild(badge);
        }
        // 图片是边解析边登记的，totalCount 会一直涨到解析结束，
        // 所以"全部结算完"必须加上解析结束这个条件，否则第一张图结算时就会误判成终态
        var done = finishedCount >= totalCount && document.readyState !== 'loading';
        badge.classList.toggle('thumb-progress-done', done && failedCount === 0);
        badge.classList.toggle('thumb-progress-partial', done && failedCount > 0);
        if (!done) {
            // 又有新图登记（或某张图开始重试）：撤销已经排上的淡出，继续显示进度
            clearTimeout(hideTimer); hideTimer = null;
            clearTimeout(removeTimer); removeTimer = null;
            badge.style.opacity = '';
            badge.textContent = '缩略图加载中 ' + finishedCount + '/' + totalCount;
            return;
        }
        badge.textContent = failedCount
            ? '缩略图 ' + (totalCount - failedCount) + '/' + totalCount + '（' + failedCount + ' 张失败）'
            : '缩略图 ' + totalCount + ' 张已加载';
        if (hideTimer) return;
        hideTimer = setTimeout(function () {
            hideTimer = null;
            if (!badge) return;
            badge.style.opacity = '0';
            removeTimer = setTimeout(function () {
                removeTimer = null;
                if (badge) badge.remove();
            }, 400);
        }, PROGRESS_HIDE_DELAY_MS);
    }

    /* ============================== 加载调度 ============================== */

    // pending 等待窗口位 / inflight 已发请求未结算 / idle 已释放窗口位待转换 /
    // backoff 失败等待重试 / settled 已结算（成功或放弃）
    var pending = [];
    var inFlight = 0;
    var backoff = 0;
    var hostFails = {};

    function pump() {
        while (inFlight < MAX_IMG_IN_FLIGHT && pending.length) {
            var img = pending.shift();
            if (img && img._state === 'queued') startRequest(img);
        }
        checkDone();
    }

    // 首次与第一次重试用原地址（保持缓存键规范、命中图床 30 天缓存），之后才穿透缓存
    function startRequest(img) {
        img._state = 'inflight';
        inFlight++;
        img._timer = setTimeout(function () { failImg(img, false); }, IMG_TOTAL_WAIT_MS);
        setSrc(img, img._tries <= 1 ? img._url : bustCache(img._url, img._tries));
    }

    // 脚本自己写 src（摘掉占位地址 / 放行 / 重试）时记下写进去的值，让 MutationObserver
    // 知道这条 src 记录是自己写的、不是站点换图。不能用一个"读过就清"的布尔标记：
    // 摘 src 与随后写回 src 会落进同一批 mutation 记录，布尔标记会被前一条消耗掉，
    // 后一条就被误判成换图，把刚排好的状态连窗口位一起清掉
    function setSrc(img, url) {
        img._selfSrc = url;
        img.src = url;
    }

    function bustCache(url, n) {
        return url + (url.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now() + n;
    }

    function releaseSlot(img) {
        if (img._state !== 'inflight') return;
        clearTimeout(img._timer);
        img._timer = null;
        img._state = 'idle';
        if (inFlight > 0) inFlight--;
    }

    // 结算成功：图床健康度清零，立刻让窗口补下一张
    function succeed(img) {
        if (img._state === 'settled') return;
        releaseSlot(img);
        img._state = 'settled';
        hostFails[img._host] = 0;
        img.classList.remove('lazy-failed');
        finishedCount++;
        renderProgress();
        pump();
    }

    // 放弃加载。这里不自己补窗口：调用方（failImg / manualRetry）会在处理完队列变动后再统一 pump
    function giveUp(img) {
        if (img._state === 'settled') return;
        releaseSlot(img);
        img._state = 'settled';
        img._failed = true;
        img.classList.add('lazy-failed');
        failedCount++;
        finishedCount++;
        renderProgress();
    }

    // isHard：浏览器派发的 error（DNS 失败 / 连接被拒 / HTTP 错误），计入图床健康度；
    // 超时传 false，不参与判定。
    // 只在第一次失败时计数：同一张图自己的重试不再累加，否则一张坏图（本页 46/47 张图同域）
    // 重试 3 次就够把整个域名判死、连带丢掉所有还在排队的图
    function failImg(img, isHard) {
        if (img._state === 'settled') return;
        var host = img._host;
        releaseSlot(img);
        if (isHard && img._tries === 0) {
            var n = (hostFails[host] || 0) + 1;
            hostFails[host] = n;
            if (n >= HOST_FAIL_THRESHOLD) {
                dropHost(host);
                giveUp(img);
                pump();
                return;
            }
        }
        img._tries++;
        if (img._tries > IMG_RETRY_TIMES) { giveUp(img); pump(); return; }
        img._state = 'backoff';
        backoff++;
        setTimeout(function () {
            if (img._state !== 'backoff') return;
            backoff--;
            img._state = 'queued';
            pending.push(img);
            pump();
        }, IMG_RETRY_BASE_MS * img._tries + Math.round(Math.random() * 400));
    }

    // 图床判死：该域名还没开始的图直接结算为失败
    function dropHost(host) {
        for (var i = pending.length - 1; i >= 0; i--) {
            if (pending[i]._host === host) giveUp(pending.splice(i, 1)[0]);
        }
    }

    // 没有排队、没有在飞、没有退避中的图，就是全部结算完了。
    // 兜底：真出现缺口（站点中途把某张已登记的图改成同源地址或清掉 src）时按失败结算，
    // 不让状态永远停在"加载中"——当前站点行为下不会走到这里
    function checkDone() {
        if (!totalCount || pending.length || inFlight || backoff) return;
        if (finishedCount >= totalCount) return;
        failedCount += totalCount - finishedCount;
        finishedCount = totalCount;
        renderProgress();
    }

    /* ============================== 事件 ============================== */

    // 事件一律用 addEventListener 注册：img.onerror / img.onclick 是属性式赋值，
    // 会顶掉站点自己挂的处理器。每个节点只绑一次，节点复用换图后继续复用
    function watchImg(img) {
        if (img._bound) return;
        img._bound = true;
        img.addEventListener('load', function () { if (img.naturalWidth > 0) succeed(img); });
        img.addEventListener('error', function () { failImg(img, true); });
        img.addEventListener('click', function (e) { manualRetry(img, e); });
    }

    // 放弃加载的图：点一下重新排队再试。
    // 图片整体位于帖子链接 <a> 内部，必须拦下这次点击，否则会连带跳到详情页
    //（卡片下方的标题链接不受影响，仍可正常进帖子）
    function manualRetry(img, e) {
        if (!img.classList.contains('lazy-failed') || !img._url) return;
        e.preventDefault();
        e.stopPropagation();
        if (img._state === 'settled') {
            finishedCount--;
            if (img._failed) { failedCount--; img._failed = false; }
        }
        img.classList.remove('lazy-failed');
        img._tries = 0;
        // 用户明确要求重试，把该图床的熔断计数清掉，否则图床已被判死时这次点击会被立刻放弃
        hostFails[img._host] = 0;
        img._state = 'queued';
        pending.push(img);
        pump();
    }

    /* ============================== 图片登记 ============================== */

    // 只接管跨域图片（图床）；站内图标、相对路径装饰图、空 src 一律不碰。
    // 空 src 不标记 _picked：站点稍后才会写进去（例如详情页的 .big_img），等 src 变了再登记。
    // data: 内联图必须在这里挡掉：new URL 会给出 origin "null"，会把 no-referrer 和一条
    // href="null" 的无效 preconnect 打到它身上（页面实测有 1 张 data: 图）
    function pickImage(img) {
        if (!img || img.tagName !== 'IMG' || img._picked) return;
        var src = img.getAttribute('src') || '';
        if (!src) return;
        if (src.indexOf('data:') === 0) { img._picked = true; return; }
        var host = crossOriginOf(src);
        if (!host) { img._picked = true; return; }

        img._picked = true;
        img._url = src;
        img._host = host;
        img._tries = 0;
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        preconnectHost(host);
        watchImg(img);
        if (!img._counted) { img._counted = true; totalCount++; renderProgress(); }

        // 已经抓完的图（命中缓存、或站点在脚本接管前就把请求发出去了）：直接结算，不再重发。
        // succeed 对没占窗口位的图不会去减计数，所以这里不必先假占一个位
        if (img.complete && img.naturalWidth > 0) {
            succeed(img);
            return;
        }

        if (img.getAttribute('loading') === 'lazy') {
            // 摘掉 src 交给窗口统一放行。只要还挂着原生 loading=lazy，浏览器自己的视距阈值
            // 就会越过窗口把整页请求一次打出去（实测 47 张里有 40 张会被浏览器自己抓走）；
            // 顺序也不能反：先摘 src 再把 loading 改成 eager，否则当前这一张会立刻发请求
            img._selfSrc = null;
            img.removeAttribute('src');
            img.loading = 'eager';
            img._state = 'queued';
            pending.push(img);
            pump();
        } else {
            // 服务端已给出可请求地址且没标 lazy：浏览器早就在下载，
            // 这里只登记进度并挂上失败处理，占一个窗口位等它结算
            img._state = 'inflight';
            inFlight++;
            img._timer = setTimeout(function () { failImg(img, false); }, IMG_TOTAL_WAIT_MS);
            pump();
        }
    }

    function sweep(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) pickImage(imgs[i]);
    }

    // src 被站点改写 = 节点复用换图（详情页点 .pimg 会把新地址写进 .big_img[src]）：
    // 旧地址、重试次数、窗口位与结算状态全部作废，重新登记。
    // _counted 保留，同一个元素不重复计入总数
    function resetImage(img) {
        clearTimeout(img._timer);
        img._timer = null;
        if (img._state === 'inflight' && inFlight > 0) inFlight--;
        var i = pending.indexOf(img);
        if (i > -1) pending.splice(i, 1);
        if (img._state === 'settled') {
            finishedCount--;
            if (img._failed) { failedCount--; img._failed = false; }
        }
        img._state = null;
        img._picked = false;
        img._tries = 0;
        img.classList.remove('lazy-failed');
    }

    /* ============================== 广告清理 ============================== */

    var pendingNodes = [];
    var pendingAttrs = [];
    var debounceTimer = null;

    // root 只有两种来源：MutationObserver 送来的新增元素(1)，或 DOM 就绪后的全量扫描传的 document(9)
    function removeMatching(root) {
        if (!root) return;
        if (root.nodeType === 1) {
            var isRootEl = (root === document.body || root === document.documentElement);
            if (!isRootEl && root.matches(REMOVE_SELECTOR)) { root.remove(); return; }
            // 叶子节点不可能包含广告后代，直接早退（解析期绝大多数新增节点是叶子）
            if (!isRootEl && !root.firstElementChild) return;
        } else if (root.nodeType !== 9) {
            return;   // 文本 / 注释等
        }
        var els = root.querySelectorAll(REMOVE_SELECTOR);
        for (var i = 0; i < els.length; i++) els[i].remove();
    }

    function processAdded(node) {
        if (node.nodeType !== 1) return;
        // IMG 只走图片登记：它不可能命中广告选择器，不必再走一遍 removeMatching
        if (node.tagName === 'IMG') { pickImage(node); return; }
        sweep(node);
        removeMatching(node);
    }

    function flushPending() {
        debounceTimer = null;
        if (pendingNodes.length) {
            for (var i = 0; i < pendingNodes.length; i++) processAdded(pendingNodes[i]);
            pendingNodes = [];
        }
        if (pendingAttrs.length) {
            for (var j = 0; j < pendingAttrs.length; j++) pickImage(pendingAttrs[j]);
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
                if (t.tagName !== 'IMG') continue;
                // 脚本自己写进 src 的值（放行、重试、摘掉占位地址）：不是站点换图，跳过
                if (t._selfSrc === t.getAttribute('src')) continue;
                resetImage(t);
                pendingAttrs.push(t);
                continue;
            }
            var nodes = mutation.addedNodes;
            for (var i = 0; i < nodes.length; i++) pendingNodes.push(nodes[i]);
        }
        if (pendingNodes.length || pendingAttrs.length) scheduleFlush();
    });

    function startObserver() {
        if (document.documentElement) {
            // 只订阅 src：脚本自己会把 loading 改成 eager，订阅它只会白白增加回调
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
        } else { setTimeout(startObserver, 10); }
    }
    startObserver();

    /* ============================== 启动 ============================== */

    // 解析期已经由 MutationObserver 逐节点登记，DOM 就绪后再全量扫一遍，
    // 兜住极少数没走 addedNodes 分支的节点；同时补渲染一次状态，
    // 让"图在解析结束前就全部结算完"的情况也能收敛到终态
    function onDomReady() {
        sweep(document);
        removeMatching(document);
        renderProgress();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDomReady);
    } else {
        onDomReady();
    }

})();

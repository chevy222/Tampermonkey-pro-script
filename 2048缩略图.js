// ==UserScript==
// @name         2048缩略图
// @namespace    https://fby.hfz300.com/
// @version      3.4
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

    // 同时在途的图片请求数上限
    var MAX_IMG_IN_FLIGHT = 8;

    // 单图失败重试次数与退避基数（另加 0~400ms 抖动）
    var IMG_RETRY_TIMES = 2;
    var IMG_RETRY_BASE_MS = 800;

    // 单张图的总等待上限，跨所有重试共享；超时按失败结算
    var IMG_TOTAL_WAIT_MS = 20000;

    // 同一图床连续硬失败这么多次即判不可达，该域名未开始的图直接跳过；任一成功即清零
    var HOST_FAIL_THRESHOLD = 3;

    // ============ 失败记忆（localStorage） ============
    // 记住加载失败的图和死图床，刷新页面后直接跳过，不再重复重试
    var BAD_IMAGE_KEY = 't2048BadImages';
    var BAD_IMAGE_TTL = 5 * 60 * 1000;      // 硬失败（404 / 连接被拒）的单张图记忆时长
    var BAD_IMAGE_MAX = 300;
    var SLOW_IMAGE_KEY = 't2048SlowImages';
    var SLOW_IMAGE_TTL = 60 * 1000;         // 超时（只是慢）的单张图记忆时长
    var SLOW_IMAGE_MAX = 300;
    var DEAD_HOST_KEY = 't2048DeadHosts';
    var DEAD_HOST_TTL = 10 * 60 * 1000;     // 判死的图床记忆时长
    var DEAD_HOST_MAX = 16;
    var IMG_HOST_KEY = 't2048ImgHosts';     // 见过的图床域名，供下次 document-start 抢先握手
    var IMG_HOST_MAX = 4;

    // 全部加载完后延迟多久开始淡出进度条
    var PROGRESS_HIDE_DELAY_MS = 2500;

    // 广告与无用块，命中即整块移除
    var REMOVE_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill',
                            '.nav-container', '.movie-banner'];
    var REMOVE_SELECTOR = REMOVE_SELECTORS.join(',');

    // 预连接插入的重试次数
    var PRECONNECT_RETRY = 25;

    /* ============================== 样式 ============================== */

    function injectStyle() {
        if (!document.head && !document.documentElement) { setTimeout(injectStyle, 4); return; }
        var s = document.createElement('style');
        s.textContent = [
            // 放弃加载的图：压暗标记，点击重新排队再试
            '.lazy-failed{opacity:0.15!important;cursor:pointer;}',
            // 去掉站点自带的加载中占位 gif
            '[style*="thumb-ing"]{background-image:none!important;}',
            // 侧栏（详情页作者信息卡）
            '.r_two{display:none!important;}',
            // 右下角加载状态提示
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

    /* ============================== 失败记忆 ============================== */

    var badImages = {};
    var slowImages = {};
    var deadHosts = {};

    function writeStampTable(key, table) {
        try { localStorage.setItem(key, JSON.stringify(table)); } catch (e) {}
    }

    // 读一张表，顺手清掉过期项
    function readStampTable(key, ttl) {
        var raw;
        try { raw = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
        if (!raw || typeof raw !== 'object' || raw instanceof Array) return {};
        var now = Date.now(), out = {}, pruned = false;
        for (var k in raw) {
            if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
            var t = raw[k];
            if (!k || typeof t !== 'number' || now - t > ttl) { pruned = true; continue; }
            out[k] = t;
        }
        if (pruned) writeStampTable(key, out);
        return out;
    }

    // 超过上限时丢掉最早的一条
    function trimStamps(stamps, max, key) {
        var keys = Object.keys(stamps);
        if (keys.length > max) {
            keys.sort(function (a, b) { return stamps[a] - stamps[b]; })
                .slice(0, keys.length - max)
                .forEach(function (k) { delete stamps[k]; });
        }
        writeStampTable(key, stamps);
    }

    // soft=true 表示这次失败只是超时/慢，进短 TTL 的表；否则按硬失败记 5 分钟
    function rememberBadImage(url, soft) {
        if (!url) return;
        if (soft) { slowImages[url] = Date.now(); trimStamps(slowImages, SLOW_IMAGE_MAX, SLOW_IMAGE_KEY); }
        else { badImages[url] = Date.now(); trimStamps(badImages, BAD_IMAGE_MAX, BAD_IMAGE_KEY); }
    }

    // 命中失败记忆就跳过（不请求、不占窗口位）
    function knownBad(url) { return !!(badImages[url] || slowImages[url]); }

    // 忘掉某张图的失败记录（用户点重试时用）
    function forgetBadImage(url) {
        if (!badImages[url] && !slowImages[url]) return;
        delete badImages[url];
        delete slowImages[url];
        writeStampTable(BAD_IMAGE_KEY, badImages);
        writeStampTable(SLOW_IMAGE_KEY, slowImages);
    }

    function rememberDeadHost(origin) {
        if (!origin) return;
        deadHosts[origin] = Date.now();
        trimStamps(deadHosts, DEAD_HOST_MAX, DEAD_HOST_KEY);
        forgetHostInList(origin);
    }

    // 图床恢复可用时立刻忘掉它
    function forgetHost(origin) {
        if (!deadHosts[origin]) return;
        delete deadHosts[origin];
        writeStampTable(DEAD_HOST_KEY, deadHosts);
    }

    function loadFailureMemory() {
        badImages = readStampTable(BAD_IMAGE_KEY, BAD_IMAGE_TTL);
        slowImages = readStampTable(SLOW_IMAGE_KEY, SLOW_IMAGE_TTL);
        deadHosts = readStampTable(DEAD_HOST_KEY, DEAD_HOST_TTL);
    }

    /* -------- 已见过的图床域名：供下次 document-start 抢先握手 -------- */

    function readHostList() {
        var a;
        try { a = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]'); } catch (e) { return []; }
        if (!(a instanceof Array)) return [];
        return a.filter(function (h) { return typeof h === 'string' && h; });
    }

    function writeHostList(list) {
        try { localStorage.setItem(IMG_HOST_KEY, JSON.stringify(list.slice(0, IMG_HOST_MAX))); } catch (e) {}
    }

    function rememberHost(origin) {
        var cur = readHostList();
        if (cur[0] === origin) return;
        var next = [origin].concat(cur.filter(function (h) { return h !== origin; }))
                           .filter(function (h) { return !deadHosts[h]; });
        writeHostList(next);
    }

    function forgetHostInList(origin) {
        var cur = readHostList(), next = cur.filter(function (h) { return h !== origin; });
        if (next.length !== cur.length) writeHostList(next);
    }

    // document-start 调用：用上次学到的图床域名抢先握手
    function preconnectLearnedHosts() {
        readHostList().forEach(function (h) { preconnectHost(h); });
    }

    /* ============================== 图床预连接 ============================== */

    // 图片 src 被脚本摘掉后，浏览器预加载扫描器看不到图床地址，需要脚本提前建连
    var preconnectedHosts = {};

    // 只返回跨域 origin；同源返回 null
    function crossOriginOf(url) {
        try {
            var u = new URL(url, location.href);
            if (u.host === location.host) return null;
            return u.origin;
        } catch (e) { return null; }
    }

    function preconnectHost(origin) {
        if (!origin || preconnectedHosts[origin] || deadHosts[origin]) return;
        preconnectedHosts[origin] = true;
        insertPreconnect(origin, 0);
    }

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

    /* ============================== 加载状态 ============================== */

    var badge = null;
    var badgeClosed = false;
    var hideTimer = null;
    var removeTimer = null;

    var totalCount = 0;
    var finishedCount = 0;
    var failedCount = 0;

    function renderProgress() {
        if (badgeClosed || !totalCount) return;
        if (!badge || !badge.isConnected) {
            var parent = document.body || document.documentElement;
            if (!parent) return;
            badge = document.createElement('div');
            badge.id = 'thumb-progress';
            parent.appendChild(badge);
        }
        var done = finishedCount >= totalCount && document.readyState !== 'loading';
        badge.classList.toggle('thumb-progress-done', done && failedCount === 0);
        badge.classList.toggle('thumb-progress-partial', done && failedCount > 0);
        if (!done) {
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
                badgeClosed = true;
            }, 400);
        }, PROGRESS_HIDE_DELAY_MS);
    }

    /* ============================== 加载调度 ============================== */

    // pending 等待窗口位 / inflight 已发请求 / backoff 失败等待重试 / settled 已结算
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

    // 前两次重试用原地址（命中缓存），之后才穿透缓存
    function startRequest(img) {
        img._state = 'inflight';
        inFlight++;
        img._timer = setTimeout(function () { failImg(img, false); }, IMG_TOTAL_WAIT_MS);
        setSrc(img, img._tries <= 1 ? img._url : bustCache(img._url, img._tries));
    }

    // 记录脚本自己写进去的 src，避免 MutationObserver 误判为站点换图
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

    // 图加载成功：清零图床健康度计数，立刻补下一张
    function succeed(img) {
        if (img._state === 'settled') {
            // 迟到的 load：超时被按失败结算后请求才完成，收回压暗标记
            if (img._failed) { img._failed = false; failedCount--; renderProgress(); }
            img.classList.remove('lazy-failed');
            return;
        }
        releaseSlot(img);
        img._state = 'settled';
        hostFails[img._host] = 0;
        forgetHost(img._host);
        img.classList.remove('lazy-failed');
        finishedCount++;
        renderProgress();
        pump();
    }

    // 放弃加载这张图
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
    // 超时传 false，不参与熔断判定
    function failImg(img, isHard) {
        if (img._state === 'settled') return;
        var host = img._host;
        releaseSlot(img);
        if (isHard) {
            if (img._tries === 0) hostFails[host] = (hostFails[host] || 0) + 1;
            if (hostFails[host] >= HOST_FAIL_THRESHOLD) {
                rememberDeadHost(host);
                dropHost(host);
                giveUp(img);
                pump();
                return;
            }
        }
        img._tries++;
        // 重试用尽：按失败性质记账——硬失败记 5 分钟，超时只记 60 秒
        if (img._tries > IMG_RETRY_TIMES) { rememberBadImage(img._url, !isHard); giveUp(img); pump(); return; }
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

    function checkDone() {
        if (!totalCount || pending.length || inFlight || backoff) return;
        if (finishedCount >= totalCount) return;
        failedCount += totalCount - finishedCount;
        finishedCount = totalCount;
        renderProgress();
    }

    /* ============================== 事件 ============================== */

    // 事件用 addEventListener 注册，避免顶掉站点自己的处理器
    function watchImg(img) {
        if (img._bound) return;
        img._bound = true;
        img.addEventListener('load', function () { if (img.naturalWidth > 0) succeed(img); });
        img.addEventListener('error', function () { failImg(img, true); });
        img.addEventListener('click', function (e) { manualRetry(img, e); });
    }

    // 放弃加载的图：点一下重新排队再试，同时拦下点击避免跳到详情页
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
        // 清除这张图的失败记忆与该图床的熔断计数
        forgetBadImage(img._url);
        forgetHost(img._host);
        hostFails[img._host] = 0;
        img._state = 'queued';
        pending.push(img);
        pump();
    }

    /* ============================== 图片登记 ============================== */

    // 只接管跨域图片（图床）；站内图标、空 src 一律不碰
    function pickImage(img) {
        if (!img || img.tagName !== 'IMG' || img._picked) return;

        var cur = img.getAttribute('src');
        var src = cur || '';
        var lazy = img.getAttribute('data-src') || img.getAttribute('data-original') ||
                   img.getAttribute('data-lazy-src') || '';
        if (lazy && (!src || src.indexOf('data:') === 0)) src = lazy.trim();

        // https 页面里的 http 图片升级成 https
        if (location.protocol === 'https:' && src.indexOf('http://') === 0) {
            src = 'https://' + src.slice(7);
        }

        if (!src) return;                                              // 还没拿到地址，等 src 变了再看
        if (src.indexOf('data:') === 0) { img._picked = true; return; } // 纯内联图，不归脚本管
        var host = crossOriginOf(src);
        if (!host) { img._picked = true; return; }

        img._picked = true;
        img._url = src;
        img._host = host;
        img._tries = 0;
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        preconnectHost(host);
        rememberHost(host);
        watchImg(img);
        if (!img._counted) { img._counted = true; totalCount++; renderProgress(); }

        // 命中失败记忆：直接按失败结算，不发请求
        if (knownBad(img._url)) {
            img._state = 'settled';
            img._failed = true;
            img.classList.add('lazy-failed');
            finishedCount++;
            failedCount++;
            renderProgress();
            return;
        }

        // 需要自己发请求：src 是占位图或挂了原生 loading=lazy
        if (cur !== img._url || img.getAttribute('loading') === 'lazy') {
            img._selfSrc = null;
            img.removeAttribute('src');
            img.loading = 'eager';
            img._state = 'queued';
            pending.push(img);
            pump();
            return;
        }

        // 已经是真实地址在下载：直接结算
        if (img.complete && img.naturalWidth > 0) {
            succeed(img);
            return;
        }

        // 浏览器早就在下载了，计入在飞数
        img._state = 'inflight';
        inFlight++;
        img._timer = setTimeout(function () { failImg(img, false); }, IMG_TOTAL_WAIT_MS);
        pump();
    }

    function sweep(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) pickImage(imgs[i]);
    }

    // src 被站点改写 = 节点复用换图：旧状态全部作废，重新登记
    function resetImage(img) {
        clearTimeout(img._timer);
        img._timer = null;
        if (img._state === 'inflight' && inFlight > 0) inFlight--;
        if (img._state === 'backoff' && backoff > 0) backoff--;
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

    function removeMatching(root) {
        if (!root) return;
        if (root.nodeType === 1) {
            var isRootEl = (root === document.body || root === document.documentElement);
            if (!isRootEl && root.matches(REMOVE_SELECTOR)) { root.remove(); return; }
            if (!isRootEl && !root.firstElementChild) return;
        } else if (root.nodeType !== 9) {
            return;
        }
        var els = root.querySelectorAll(REMOVE_SELECTOR);
        for (var i = 0; i < els.length; i++) els[i].remove();
    }

    function processAdded(node) {
        if (node.nodeType !== 1) return;
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
                var t = mutation.target;
                if (t.tagName !== 'IMG') continue;
                // 脚本自己写进 src 的值跳过
                if (t._selfSrc === t.getAttribute('src')) continue;
                resetImage(t);
                pendingAttrs.push(t);
                continue;
            }
            var nodes = mutation.addedNodes;
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                // 单个 IMG 就地登记，不进批量
                if (node.nodeType === 1 && node.tagName === 'IMG') pickImage(node);
                else pendingNodes.push(node);
            }
        }
        if (pendingNodes.length || pendingAttrs.length) scheduleFlush();
    });

    function startObserver() {
        if (document.documentElement) {
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

    // 先读回失败记忆，再用上次学到的图床域名抢先握手
    loadFailureMemory();
    preconnectLearnedHosts();

    function onDomReady() {
        sweep(document);
        removeMatching(document);
        checkDone();
        renderProgress();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDomReady);
    } else {
        onDomReady();
    }

})();

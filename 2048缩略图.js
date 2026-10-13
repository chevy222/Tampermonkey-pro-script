// ==UserScript==
// @name         2048缩略图
// @namespace    https://fby.hfz300.com/
// @version      3.8
// @description  打开页面即全量预加载全部图片：滑动窗口控制并发、失败自动重试与死图床熔断、右下角常驻加载进度。不监听滚动，滚动不触发任何加载。附带去广告、隐藏侧栏、图床 preconnect、跨域图 no-referrer、节点复用自动重试；失败图压暗 + ↻ 角标/点击手动重试（赦免失败记忆）；迟到 load 回收。加载引擎与「色花堂缩略图」同构：imgQueue/imgInFlight/loadThumb/done/trackHostResult。<picture>/srcset 图不接管；广告块先清后扫。
// @author       Chevy Yang
// @match        https://bbs.hdaksog.com/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================== 可调参数 ============================== */

    // 版本号，document-start 阶段写到 <html data-t2048="..."> 上（兼作双注入哨兵）
    const VERSION = '3.8';

    // 防双注入（Tampermonkey 装重 / 多渠道注入）：先占位，后到的实例原路退出。
    // 两个实例的 observer 会互相 resetImage 涨 _gen，把对方的加载闭包全部短路，图永远不结算
    if (document.documentElement.getAttribute('data-t2048')) return;
    document.documentElement.setAttribute('data-t2048', VERSION);

    // 运行日志开关（排查时改成 true）
    const DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[2048缩略图]', ...args); };

    // 同时在途的图片请求数上限（0 = 不限制）
    const MAX_IMG_IN_FLIGHT = 8;

    // 单图失败重试次数与退避基数（另加 0~400ms 抖动）
    const IMG_RETRY_TIMES = 2;
    const IMG_RETRY_BASE_MS = 800;

    // 单张图的总等待上限，跨所有重试共享；超时按失败结算
    const IMG_TOTAL_WAIT_MS = 20000;

    // 同一图床连续硬失败这么多次即判不可达，该域名未开始的图直接跳过；任一成功即清零
    const HOST_FAIL_THRESHOLD = 3;

    // ============ 失败记忆（localStorage） ============
    // 记住加载失败的图和死图床，刷新页面后直接跳过，不再重复重试
    const BAD_IMAGE_KEY = 't2048BadImages';
    const BAD_IMAGE_TTL = 5 * 60 * 1000;      // 硬失败（404 / 连接被拒）的单张图记忆时长
    const BAD_IMAGE_MAX = 300;
    const SLOW_IMAGE_KEY = 't2048SlowImages';
    const SLOW_IMAGE_TTL = 60 * 1000;         // 超时（只是慢）的单张图记忆时长
    const SLOW_IMAGE_MAX = 300;
    const DEAD_HOST_KEY = 't2048DeadHosts';
    const DEAD_HOST_TTL = 10 * 60 * 1000;     // 判死的图床记忆时长
    const DEAD_HOST_MAX = 16;
    const IMG_HOST_KEY = 't2048ImgHosts';     // 见过的图床域名，供下次 document-start 抢先握手
    const IMG_HOST_MAX = 4;

    // 全部加载完后延迟多久开始淡出进度条
    const PROGRESS_HIDE_DELAY_MS = 2500;

    // 广告与无用块，命中即整块移除
    const REMOVE_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill',
                              '.nav-container', '.movie-banner'];
    const REMOVE_SELECTOR = REMOVE_SELECTORS.join(',');

    // 预连接插入的重试次数
    const PRECONNECT_RETRY = 25;

    /* ============================== 样式 ============================== */

    function injectStyle() {
        if (!document.head && !document.documentElement) { setTimeout(injectStyle, 4); return; }
        const s = document.createElement('style');
        s.textContent = `
            /* 放弃加载的图：压暗标记，点击重新排队再试 */
            .lazy-failed{opacity:0.15!important;cursor:pointer;}
            /* 重试角标：挂在失败图外层容器右上角，比压暗的图本身更好认 */
            .lazy-retry{position:absolute;top:4px;right:4px;z-index:5;display:flex;align-items:center;
                justify-content:center;width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,.65);
                color:#fff;font-size:13px;line-height:1;cursor:pointer;}
            .lazy-retry:hover{background:rgba(0,0,0,.85);}
            /* 去掉站点自带的加载中占位 gif */
            [style*="thumb-ing"]{background-image:none!important;}
            /* 侧栏（详情页作者信息卡） */
            .r_two{display:none!important;}
            /* 右下角加载状态提示 */
            #thumb-progress{position:fixed;right:14px;bottom:14px;z-index:2147483646;
                padding:7px 14px;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;
                font-size:12px;line-height:1.4;box-shadow:0 2px 10px rgba(0,0,0,.25);
                transition:opacity .3s ease;pointer-events:none;}
            #thumb-progress.thumb-progress-done{background:rgba(35,120,60,.85);}
            #thumb-progress.thumb-progress-partial{background:rgba(150,70,20,.88);}
        `;
        (document.head || document.documentElement).appendChild(s);
    }
    injectStyle();

    /* ============================== 失败记忆 ============================== */

    const badImages = new Set();
    const badImageStamps = {};
    const slowImages = new Set();
    const slowImageStamps = {};
    const deadHostStamps = {};

    function writeStampTable(key, table) {
        try { localStorage.setItem(key, JSON.stringify(table)); } catch (e) {}
    }

    // 读一张"名称 -> 时间戳"表，顺手清掉过期项
    function readStampTable(key, ttl) {
        let raw = {};
        try { raw = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
        if (!raw || typeof raw !== 'object' || raw instanceof Array) return {};
        const now = Date.now();
        const out = {};
        let pruned = false;
        for (const k of Object.keys(raw)) {
            const t = raw[k];
            if (!k || typeof t !== 'number' || now - t > ttl) { pruned = true; continue; }
            out[k] = t;
        }
        if (pruned) writeStampTable(key, out);
        return out;
    }

    // 超过上限时丢掉最早的一条
    function trimStamps(stamps, set, max, key) {
        const keys = Object.keys(stamps);
        if (keys.length > max) {
            keys.sort((a, b) => stamps[a] - stamps[b])
                .slice(0, keys.length - max)
                .forEach(k => { delete stamps[k]; set.delete(k); });
        }
        writeStampTable(key, stamps);
    }

    // soft=true 表示这次失败只是超时/慢，进短 TTL 的表；否则按硬失败记 5 分钟
    function rememberBadImage(url, soft) {
        if (!url) return;
        if (soft) {
            slowImageStamps[url] = Date.now();
            slowImages.add(url);
            trimStamps(slowImageStamps, slowImages, SLOW_IMAGE_MAX, SLOW_IMAGE_KEY);
        } else {
            badImageStamps[url] = Date.now();
            badImages.add(url);
            trimStamps(badImageStamps, badImages, BAD_IMAGE_MAX, BAD_IMAGE_KEY);
        }
    }

    // 手动重试前的"赦免"：把某张图从两张表里除名并落盘
    function forgetImage(url) {
        let dirty = false;
        if (badImages.delete(url)) { delete badImageStamps[url]; dirty = true; }
        if (slowImages.delete(url)) { delete slowImageStamps[url]; dirty = true; }
        if (dirty) {
            writeStampTable(BAD_IMAGE_KEY, badImageStamps);
            writeStampTable(SLOW_IMAGE_KEY, slowImageStamps);
        }
    }

    function rememberDeadHost(origin) {
        if (!origin) return;
        deadHostStamps[origin] = Date.now();
        deadHosts.add(origin);
        trimStamps(deadHostStamps, deadHosts, DEAD_HOST_MAX, DEAD_HOST_KEY);
        dropPreconnectHost(origin);
    }

    // 图床恢复可用时立刻忘掉它
    function forgetHost(origin) {
        if (!deadHosts.has(origin)) return;
        deadHosts.delete(origin);
        delete deadHostStamps[origin];
        writeStampTable(DEAD_HOST_KEY, deadHostStamps);
    }

    // 启动时把 TTL 内的失败记录读回来
    function loadFailureMemory() {
        const bad = readStampTable(BAD_IMAGE_KEY, BAD_IMAGE_TTL);
        Object.assign(badImageStamps, bad);
        Object.keys(bad).forEach(k => badImages.add(k));

        const hosts = readStampTable(DEAD_HOST_KEY, DEAD_HOST_TTL);
        Object.assign(deadHostStamps, hosts);
        Object.keys(hosts).forEach(k => deadHosts.add(k));

        const slow = readStampTable(SLOW_IMAGE_KEY, SLOW_IMAGE_TTL);
        Object.assign(slowImageStamps, slow);
        Object.keys(slow).forEach(k => slowImages.add(k));
    }

    /* -------- 已见过的图床域名：供下次 document-start 抢先握手 -------- */

    function readHostList() {
        try {
            const a = JSON.parse(localStorage.getItem(IMG_HOST_KEY) || '[]');
            if (!(a instanceof Array)) return [];
            return a.filter(h => typeof h === 'string' && h);
        } catch (e) { return []; }
    }

    function writeHostList(list) {
        try { localStorage.setItem(IMG_HOST_KEY, JSON.stringify(list.slice(0, IMG_HOST_MAX))); } catch (e) {}
    }

    function rememberHost(origin) {
        const cur = readHostList();
        if (cur[0] === origin) return;
        const next = [origin].concat(cur.filter(h => h !== origin))
                           .filter(h => !deadHosts.has(h));
        writeHostList(next);
    }

    // 把某个域名从预连接名单里剔除
    function dropPreconnectHost(origin) {
        const cur = readHostList();
        const next = cur.filter(h => h !== origin);
        if (next.length !== cur.length) writeHostList(next);
    }

    // document-start 调用：用上次学到的图床域名抢先握手
    function preconnectLearnedHosts() {
        readHostList().forEach(h => preconnectHost(h));
    }

    /* ============================== 图床预连接 ============================== */

    // 图片 src 被脚本摘掉后，浏览器预加载扫描器看不到图床地址，需要脚本提前建连
    const preconnectedHosts = {};

    // 图片地址的 origin；解析失败返回 null（同源判定在 pickImage 里做）
    function imageOrigin(url) {
        try { return new URL(url, location.href).origin; } catch (e) { return null; }
    }

    function preconnectHost(origin) {
        if (!origin || preconnectedHosts[origin] || deadHosts.has(origin)) return;
        preconnectedHosts[origin] = true;
        insertPreconnect(origin, 0);
    }

    function insertPreconnect(origin, tries) {
        const parent = document.head || document.documentElement;
        if (!parent) {
            if (tries < PRECONNECT_RETRY) setTimeout(() => insertPreconnect(origin, tries + 1), 4);
            else delete preconnectedHosts[origin];
            return;
        }
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        try {
            parent.appendChild(link);
        } catch (e) {
            delete preconnectedHosts[origin];
        }
    }

    /* ============================== 加载进度提示 ============================== */

    const thumbProgress = {
        total: 0, settled: 0, failed: 0, el: null, timer: null, removeTimer: null, closed: false,

        add(count) {
            this.total += count;
            clearTimeout(this.timer);
            clearTimeout(this.removeTimer);
            this.removeTimer = null;
            if (this.el) this.el.style.opacity = '';
            this.render();
        },

        settle(failed) {
            this.settled++;
            if (failed) this.failed++;
            this.render();
            if (this.settled >= this.total) {
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.hide(), PROGRESS_HIDE_DELAY_MS);
            }
        },

        // 手动重试成功 / 迟到 load 回收：只把之前那次失败减回去，total/settled 都不动
        revive() {
            if (this.failed > 0) this.failed--;
            this.render();
        },

        // 节点复用换图：撤回上一次结算（新一次 loadThumb 会重新结算）
        unsettle(failed) {
            if (this.settled > 0) this.settled--;
            if (failed && this.failed > 0) this.failed--;
            this.render();
        },

        render() {
            if (this.closed || this.total === 0) return;
            const el = this.mount();
            const done = this.settled >= this.total && document.readyState !== 'loading';
            el.classList.toggle('thumb-progress-done', done && this.failed === 0);
            el.classList.toggle('thumb-progress-partial', done && this.failed > 0);
            if (!done) {
                clearTimeout(this.timer); this.timer = null;
                clearTimeout(this.removeTimer); this.removeTimer = null;
                el.style.opacity = '';
                el.textContent = `缩略图加载中 ${this.settled}/${this.total}`;
                return;
            }
            el.textContent = this.failed > 0
                ? `缩略图 ${this.total - this.failed}/${this.total}（${this.failed} 张失败）`
                : `缩略图 ${this.total} 张已加载`;
            if (this.timer) return;
            this.timer = setTimeout(() => {
                this.timer = null;
                if (!this.el) return;
                this.el.style.opacity = '0';
                this.removeTimer = setTimeout(() => {
                    this.removeTimer = null;
                    if (this.el) { this.el.remove(); this.el = null; }
                    this.closed = true;
                }, 400);
            }, PROGRESS_HIDE_DELAY_MS);
        },

        mount() {
            if (this.el && this.el.isConnected) return this.el;
            const parent = document.body || document.documentElement;
            if (!parent) return null;
            this.el = document.createElement('div');
            this.el.id = 'thumb-progress';
            parent.appendChild(this.el);
            return this.el;
        },

        hide() {
            if (!this.el) return;
            this.el.style.opacity = '0';
        }
    };

    /* ============================== 加载调度 ============================== */

    // pending 等待窗口位 / inflight 已发请求；窗口位按次持有，重试排到队尾
    const imgQueue = [];
    let imgInFlight = 0;

    // 图床健康度：连续硬失败判死；任一成功即清零解封；超时不参与
    const hostFailStreak = new Map();
    const deadHosts = new Set();

    function pumpImgQueue() {
        while (imgQueue.length > 0 && (MAX_IMG_IN_FLIGHT <= 0 || imgInFlight < MAX_IMG_IN_FLIGHT)) {
            imgQueue.shift()();
        }
    }

    function trackHostResult(origin, outcome) {
        if (!origin) return;
        if (outcome === 'ok') {
            hostFailStreak.delete(origin);
            forgetHost(origin);
            return;
        }
        const streak = (hostFailStreak.get(origin) || 0) + 1;
        hostFailStreak.set(origin, streak);
        if (streak >= HOST_FAIL_THRESHOLD) rememberDeadHost(origin);
    }

    // 前两次尝试用原地址（命中缓存直接成功），之后才穿透缓存
    function attemptUrl(url, attempt) {
        if (attempt <= 1) return url;
        return url + (url.indexOf('?') === -1 ? '?' : '&') + '_r=' + Date.now() + attempt;
    }

    // 记录脚本自己写进去的 src，避免 MutationObserver 误判为站点换图
    function setImgSrc(img, url) {
        img._selfSrc = url;
        img.src = url;
    }

    // 加载一张图。manual=true 为角标/点击手动重试：不 add/settle，赦免记忆后强行发请求
    // count=false 用于节点复用重登记（total 已记过，不重复计数）
    function loadThumb(img, url, manual = false, count = true) {
        const origin = imageOrigin(url);
        // 生成代号：站点改写 src（节点复用）或再次手动重试时作废本闭包，
        // 陈旧的 load/error/timer/队列任务全部短路，防止错记到新图上
        const gen = (img._gen = (img._gen || 0) + 1);
        let startedAt = 0;
        let attempt = 0;
        let settled = false;
        let failedFlag = false;
        let holding = false;
        let timer = null;

        const releaseSlot = () => {
            if (!holding) return;
            holding = false;
            img._holding = false;
            imgInFlight--;
            pumpImgQueue();
        };

        const done = (failed, outcome) => {
            if (settled || img._gen !== gen) return;
            settled = true;
            failedFlag = failed;
            img._wasSettled = true;
            img._wasFailed = failed;
            clearTimeout(timer);
            releaseSlot();

            if (!failed) trackHostResult(origin, 'ok');
            else if (outcome === 'hard') { rememberBadImage(url); trackHostResult(origin, 'hard'); }
            else if (outcome === 'timeout') rememberBadImage(url, true);
            else if (outcome === 'cached-hard') rememberBadImage(url);

            if (manual) {
                if (!failed) {
                    // 手动重试成功：失败计数减回去，顺手清掉暗态和角标
                    thumbProgress.revive();
                    unmarkFailed(img);
                } else {
                    // 又挂了：恢复暗态 + 角标，还能再试
                    markFailed(img);
                }
            } else {
                thumbProgress.settle(failed);
                if (failed) markFailed(img);
            }
        };

        // 把下一次尝试排进队列（队尾）
        const queueAttempt = () => {
            if (settled || img._gen !== gen) return;
            const task = () => {
                if (settled || img._gen !== gen) return;
                imgInFlight++;
                holding = true;
                img._holding = true;
                if (attempt === 0) startedAt = performance.now();
                if (!manual && deadHosts.has(origin)) { done(true, 'skip'); return; }
                const nextUrl = attemptUrl(url, attempt);
                // 首次且属性已是真实地址 = 浏览器正在下载，不重复赋值打断它；重试必须重新赋值触发再取
                if (attempt > 0 || img.getAttribute('src') !== nextUrl) setImgSrc(img, nextUrl);
                // 命中缓存时直接结算
                if (img.complete) {
                    const ok = img.naturalWidth > 0;
                    done(!ok, ok ? 'ok' : 'cached-hard');
                    return;
                }
                armWait();
            };
            task._img = img;   // resetImage 据此出队
            imgQueue.push(task);
            pumpImgQueue();
        };

        const armWait = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (img._gen === gen) onTimeout(); },
                Math.max(0, IMG_TOTAL_WAIT_MS - (performance.now() - startedAt)));
        };

        function retryLater() {
            attempt++;
            releaseSlot();
            const delay = IMG_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 400);
            timer = setTimeout(() => { if (img._gen === gen) queueAttempt(); }, delay);
        }

        function onTimeout() {
            if (settled || img._gen !== gen) return;
            clearTimeout(timer);
            if (attempt >= IMG_RETRY_TIMES) { done(true, 'timeout'); return; }
            retryLater();
        }

        function onError() {
            if (settled || img._gen !== gen) return;
            clearTimeout(timer);
            if (attempt >= IMG_RETRY_TIMES) { done(true, 'hard'); return; }
            retryLater();
        }

        img.addEventListener('load', () => {
            if (img._gen !== gen) return;
            if (img.naturalWidth > 0) {
                if (settled && failedFlag) {
                    // 迟到 load：已按失败结算后请求才完成，撤回失败记账与暗态
                    failedFlag = false;
                    img._wasFailed = false;
                    thumbProgress.revive();
                    unmarkFailed(img);
                    return;
                }
                done(false, 'ok');
            } else {
                onError();   // load 了但宽度为 0 = 坏图，按错误走重试链
            }
        });
        img.addEventListener('error', onError);

        if (count) thumbProgress.add(1);
        // 命中失败记忆：直接跳过（manual 模式已在 manualRetry 里赦免，强行放行）
        if (!manual && (badImages.has(url) || slowImages.has(url) || deadHosts.has(origin))) {
            log('命中失败记忆，跳过:', url);
            done(true, 'skip');
            return;
        }
        queueAttempt();
    }

    /* ============================== 失败兜底与手动重试 ============================== */

    // 失败图的 ↻ 重试角标：挂到 img 的外层容器（通常是 <a>）。
    // 容器定位不是 relative 就补一个——只当定位基准，不带偏移，不影响布局
    function attachRetryBadge(img) {
        if (img._retryBadge) return;
        const parent = img.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) return;
        try {
            if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        } catch (e) {}
        const badge = document.createElement('span');
        badge.className = 'lazy-retry';
        badge.textContent = '↻';
        badge.title = '重试这张图';
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();   // 别顺着外层 <a> 跳详情页
            manualRetry(img, e);
        });
        parent.appendChild(badge);
        img._retryBadge = badge;
    }

    function detachRetryBadge(img) {
        const badge = img._retryBadge;
        if (badge) {
            if (badge.parentNode) badge.parentNode.removeChild(badge);
            img._retryBadge = null;
        }
    }

    function markFailed(img) {
        img.classList.add('lazy-failed');
        attachRetryBadge(img);
    }

    function unmarkFailed(img) {
        img.classList.remove('lazy-failed');
        detachRetryBadge(img);
    }

    // 只绑一次：点击压暗的图 = 重试（load/error 在 loadThumb 里按次绑定，靠 _gen 防串）
    function watchImg(img) {
        if (img._bound) return;
        img._bound = true;
        img.addEventListener('click', (e) => manualRetry(img, e));
    }

    // 放弃加载的图：点一下 / 点角标重新排队再试，同时拦下点击避免跳到详情页
    function manualRetry(img, e) {
        if (!img.classList.contains('lazy-failed') || !img._url) return;
        e.preventDefault();
        e.stopPropagation();
        unmarkFailed(img);
        // 赦免这张图的失败记忆与该图床的熔断计数，否则重试会被记忆检查自己挡回来
        forgetImage(img._url);
        forgetHost(img._host);
        hostFailStreak.delete(img._host);
        loadThumb(img, img._url, true, false);
    }

    /* ============================== 图片登记 ============================== */

    // 只接管跨域图片（图床）；站内图标、空 src、data: 内联图一律不碰
    function pickImage(img) {
        if (!img || img.tagName !== 'IMG' || img._picked) return;

        // <picture>/<source> 或 srcset 让浏览器自选 URL：改 img.src 不生效，
        // 强接会导致记忆/熔断记错对象、重试链路断掉——这类图整个不接管，交给浏览器
        if (img.closest('picture') || img.getAttribute('srcset')) { img._picked = true; return; }

        const cur = img.getAttribute('src');
        let src = cur || '';
        const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') ||
                   img.getAttribute('data-lazy-src') || '';
        if (lazy && (!src || src.indexOf('data:') === 0)) src = lazy.trim();

        // https 页面里的 http 图片升级成 https
        if (location.protocol === 'https:' && src.indexOf('http://') === 0) {
            src = 'https://' + src.slice(7);
        }

        if (!src) return;                                                // 还没拿到地址，等 src 变了再看
        if (src.indexOf('data:') === 0) { img._picked = true; return; } // 纯内联图，不归脚本管
        const host = imageOrigin(src);
        if (!host || host === location.origin) { img._picked = true; return; }   // 同源图交给浏览器

        img._picked = true;
        img._url = src;
        img._host = host;
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        preconnectHost(host);
        rememberHost(host);
        watchImg(img);
        // 节点复用重登记时 total 已记过，不重复计数
        const count = !img._counted;
        if (count) img._counted = true;

        // 需要自己发请求：src 是占位图或挂了原生 loading=lazy，摘掉等 loadThumb 统一发
        if (cur !== img._url || img.getAttribute('loading') === 'lazy') {
            img._selfSrc = null;
            img.removeAttribute('src');
            img.loading = 'eager';
        }

        loadThumb(img, img._url, false, count);
    }

    function sweep(root) {
        if (!root || !root.querySelectorAll) return;
        const imgs = root.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) pickImage(imgs[i]);
    }

    // src 被站点改写 = 节点复用换图：旧闭包作废、槽位回收、出队、撤回上次结算，等重新登记
    function resetImage(img) {
        img._gen = (img._gen || 0) + 1;
        if (img._holding) { img._holding = false; imgInFlight--; pumpImgQueue(); }
        for (let i = imgQueue.length - 1; i >= 0; i--) {
            if (imgQueue[i]._img === img) imgQueue.splice(i, 1);
        }
        if (img._wasSettled) {
            thumbProgress.unsettle(img._wasFailed);
            img._wasSettled = false;
            img._wasFailed = false;
        }
        img._picked = false;
        unmarkFailed(img);
    }

    /* ============================== 广告清理 ============================== */

    function removeMatching(root) {
        if (!root) return;
        if (root.nodeType === 1) {
            const isRootEl = (root === document.body || root === document.documentElement);
            if (!isRootEl && root.matches(REMOVE_SELECTOR)) { root.remove(); return; }
            if (!isRootEl && !root.firstElementChild) return;
        } else if (root.nodeType !== 9) {
            return;
        }
        const els = root.querySelectorAll(REMOVE_SELECTOR);
        for (let i = 0; i < els.length; i++) els[i].remove();
    }

    /* ============================== 变化监听 ============================== */

    const pendingNodes = [];
    const pendingAttrs = [];
    let debounceTimer = null;

    function processAdded(node) {
        if (node.nodeType !== 1) return;
        // 先清广告再扫图：否则广告块里的图会被登记（total++/入队）后整块删掉，
        // 20s 超时才结算，还被误记进 slowImages
        removeMatching(node);
        if (!node.isConnected) return;   // 节点自身就是广告块，刚被摘掉
        sweep(node);
    }

    function flushPending() {
        debounceTimer = null;
        if (pendingNodes.length) {
            for (let i = 0; i < pendingNodes.length; i++) processAdded(pendingNodes[i]);
            pendingNodes.length = 0;
        }
        if (pendingAttrs.length) {
            for (let j = 0; j < pendingAttrs.length; j++) pickImage(pendingAttrs[j]);
            pendingAttrs.length = 0;
        }
    }

    function scheduleFlush() { if (debounceTimer) return; debounceTimer = setTimeout(flushPending, 50); }

    const observer = new MutationObserver((mutations) => {
        for (let m = 0; m < mutations.length; m++) {
            const mutation = mutations[m];
            if (mutation.type === 'attributes') {
                const t = mutation.target;
                if (t.tagName !== 'IMG') continue;
                // 脚本自己写进 src 的值跳过
                if (t._selfSrc === t.getAttribute('src')) continue;
                resetImage(t);
                pendingAttrs.push(t);
                continue;
            }
            const nodes = mutation.addedNodes;
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
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
        removeMatching(document);
        sweep(document);
        thumbProgress.render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDomReady);
    } else {
        onDomReady();
    }

})();

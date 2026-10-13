// ==UserScript==
// @name         2048缩略图
// @namespace    https://fby.hfz300.com/
// @version      3.12
// @description  打开页面即全量预加载全部图片：滑动窗口控制并发（全局 + 单域名分池）、失败自动重试与死图床熔断、右下角常驻加载进度。不监听滚动，滚动不触发任何加载。附带去广告、隐藏侧栏、图床 preconnect、跨域图 no-referrer、节点复用自动重试；失败图压暗 + ↻ 角标/点击手动重试（赦免失败记忆）；迟到 load 回收。单图总等待预算只累计「请求真正发出后」的在途时间——图床冷却、重试退避、排队等窗口位均不计时，杜绝冷却结束后秒判超时的假失败风暴。<picture>/srcset 图不接管；广告块先清后扫。
// 失败记忆 t2048BadImages：硬失败的单图与判死的图床共用一张表（TTL 5min）。要恢复尝试：清掉该键后刷新即可。
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
    const VERSION = '3.12';

    // 防双注入（Tampermonkey 装重 / 多渠道注入）：先占位，后到的实例原路退出。
    // 两个实例的 observer 会互相 resetImage 涨 _gen，把对方的加载闭包全部短路，图永远不结算
    if (document.documentElement.getAttribute('data-t2048')) return;
    document.documentElement.setAttribute('data-t2048', VERSION);

    // 运行日志开关（排查时改成 true）
    const DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[2048缩略图]', ...args); };

    // 同时在途的图片请求数上限（0 = 不限制）
    // 16：检索页常见 10+ 个图床，若只给 8，单域上限 6 的一个大图床就占掉 6 席，
    // 其余图床只能抢 2 席——整页吞吐被锁死，饥饿图床还会攒超时误触熔断。
    // 真实并发仍由 PER_HOST_IN_FLIGHT 分池控制，这里只是别让全局闸成为瓶颈。
    const MAX_IMG_IN_FLIGHT = 16;

    // 单图失败重试次数与退避基数（另加 0~400ms 抖动）
    const IMG_RETRY_TIMES = 2;
    const IMG_RETRY_BASE_MS = 800;

    // 单张图的总等待上限，跨所有重试共享；超时按失败结算
    const IMG_TOTAL_WAIT_MS = 20000;

    // 同一图床连续硬失败这么多次即判不可达，该域名未开始的图直接跳过；任一成功即清零
    const HOST_FAIL_THRESHOLD = 3;
    // 同一图床连续「超时」这么多次同样判不可达；取值为一个并发窗口（PER_HOST_IN_FLIGHT），
    // 使整窗同时挂住的场景在第一批即可熔断
    // 同一图床连续「超时」这么多次判为不可用。取两个并发窗口的大小：
    // 单个窗口的图全部超时属于「这一批恰好很慢」，不足以判定整个图床不可用
    const HOST_TIMEOUT_THRESHOLD = 12;

    // 图床熔断的冷却时长与轮次：熔断只做冷却，冷却结束自动重开、继续派发；
    // 连续这么多轮冷却后仍拿不到一次成功，才在本次页面加载内彻底放弃
    const HOST_COOLDOWN_MS = 10000;
    const HOST_COOLDOWN_ROUNDS = 3;

    // 单域名在途上限。Chrome 对同一 origin 的 HTTP/1.1 只给约 6 条连接，
    // 全局上限放任不管会让多余的请求滞留在浏览器 socket 队列里空等，
    // 而脚本的等待计时照跑 → 未真正发出的请求被误判超时 → 重试 → 更堵。
    const PER_HOST_IN_FLIGHT = 6;

    // ============ 失败记忆（localStorage） ============
    // 记住加载失败的图与判死的图床，刷新页面后直接跳过，不再重复重试。
    // 图床以 HOST_KEY_PREFIX + origin 的形式和图片共用同一张表，
    // 因此清掉 BAD_IMAGE_KEY 会把图级与图床级记忆一起清掉
    const BAD_IMAGE_KEY = 't2048BadImages';
    const BAD_IMAGE_TTL = 5 * 60 * 1000;      // 硬失败（404 / 连接被拒）的记忆时长
    const BAD_IMAGE_MAX = 300;
    const HOST_KEY_PREFIX = '#host#';
    const IMG_HOST_KEY = 't2048ImgHosts';     // 见过的图床域名，供下次 document-start 抢先握手
    const IMG_HOST_MAX = 4;

    // 全部加载完后延迟多久开始淡出进度条
    const PROGRESS_HIDE_DELAY_MS = 2500;

    // 广告与无用块，命中即整块移除
    // .reward-card：帖子下方的「打赏楼主」推广卡（站点后加的广告位，
    // 含 200 金币打赏按钮/累计打赏统计/求片区导流文案，整棵树删掉）
    const REMOVE_SELECTORS = ['.recs-wrapper', '.recs-head', '.recs-row', '.recs-pill',
                              '.nav-container', '.movie-banner', '.reward-card'];
    const REMOVE_SELECTOR = REMOVE_SELECTORS.join(',');

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

    // 记一次硬失败（含被熔断跳过与判死的图床）
    function rememberBadImage(url) {
        if (!url) return;
        badImageStamps[url] = Date.now();
        badImages.add(url);
        trimStamps(badImageStamps, badImages, BAD_IMAGE_MAX, BAD_IMAGE_KEY);
    }

    // 手动重试前的"赦免"：把某张图（或图床键）从表里除名并落盘
    function forgetImage(url) {
        if (!badImages.delete(url)) return;
        delete badImageStamps[url];
        writeStampTable(BAD_IMAGE_KEY, badImageStamps);
    }

    // 图床在失败表里的键：与图片共用一张表，故清 BAD_IMAGE_KEY 即同时赦免图床
    function hostKey(origin) { return HOST_KEY_PREFIX + origin; }
    function isDeadHost(origin) { return !!origin && badImages.has(hostKey(origin)); }

    function rememberDeadHost(origin) {
        if (!origin) return;
        rememberBadImage(hostKey(origin));
        dropPreconnectHost(origin);
    }

    // 图床恢复可用时立刻忘掉它
    function forgetHost(origin) {
        if (!origin) return;
        forgetImage(hostKey(origin));
    }

    // 启动时把 TTL 内的失败记录读回来（图级与图床级在同一张表里，一并恢复）
    function loadFailureMemory() {
        const bad = readStampTable(BAD_IMAGE_KEY, BAD_IMAGE_TTL);
        Object.assign(badImageStamps, bad);
        Object.keys(bad).forEach(k => badImages.add(k));
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
                           .filter(h => !isDeadHost(h));
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
        if (!origin || preconnectedHosts[origin] || isDeadHost(origin)) return;
        preconnectedHosts[origin] = true;
        insertPreconnect(origin);
    }

    function insertPreconnect(origin) {
        const parent = document.head || document.documentElement;
        if (!parent) { delete preconnectedHosts[origin]; return; }
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
        total: 0, settled: 0, failed: 0, el: null, timer: null, removeTimer: null,

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
        },

        // 手动重试成功 / 迟到 load 回收：把已计入的失败数撤回一次，total/settled 都不动
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
            if (this.total === 0) return;
            const el = this.mount();
            const done = this.settled >= this.total && document.readyState !== 'loading';
            el.classList.toggle('thumb-progress-done', done && this.failed === 0);
            el.classList.toggle('thumb-progress-partial', done && this.failed > 0);
            if (!done) {
                clearTimeout(this.timer); this.timer = null;
                clearTimeout(this.removeTimer); this.removeTimer = null;
                el.style.opacity = '';
                el.textContent = this.failed > 0
                    ? `缩略图已完成 ${this.settled}/${this.total}（${this.failed} 张失败）`
                    : `缩略图已完成 ${this.settled}/${this.total}`;
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
                    // 只把节点摘掉、引用清空，不置 closed：
                    // 页面后续再动态插入图片时胶囊还能重新建出来（总数继续累加）
                    if (this.el) { this.el.remove(); this.el = null; }
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
        }
    };

    /* ============================== 加载调度 ============================== */

    // pending 等待窗口位 / inflight 已发请求；窗口位按次持有，重试排到队尾
    const imgQueue = [];
    let imgInFlight = 0;

    // 图床健康度：连续硬失败判死；任一成功即清零解封；超时另用更宽的阈值也判死
    const hostFailStreak = new Map();
    const hostTimeoutStreak = new Map();
    const hostCooldown = new Map();

    // 每个域名的在途计数，配合 PER_HOST_IN_FLIGHT 做分池限流
    const inFlightByHost = new Map();

    function pumpImgQueue() {
        for (let i = 0; i < imgQueue.length; ) {
            if (MAX_IMG_IN_FLIGHT > 0 && imgInFlight >= MAX_IMG_IN_FLIGHT) break;
            const task = imgQueue[i];
            // 只做准入判断；真正的计数在 task 内部（挂着陈旧代号的任务会提前返回，
            // 若在这里先加计数就会漏还一个配额，把该域名永久卡死）
            if ((inFlightByHost.get(task._host) || 0) >= PER_HOST_IN_FLIGHT) { i++; continue; }
            imgQueue.splice(i, 1);
            task();
        }
    }

    function trackHostResult(origin, outcome) {
        if (!origin) return;
        if (outcome === 'ok') {
            hostFailStreak.delete(origin);
            hostTimeoutStreak.delete(origin);
            hostCooldown.delete(origin);
            forgetHost(origin);
            return;
        }
        // 整体挂住不回的图床同样不可用，必须能走到熔断，
        // 否则超时类失败永远熔断不了，每轮刷新都全量重试
        if (outcome === 'timeout') {
            const n = (hostTimeoutStreak.get(origin) || 0) + 1;
            hostTimeoutStreak.set(origin, n);
            if (n >= HOST_TIMEOUT_THRESHOLD) openHostCooldown(origin);
            return;
        }
        const streak = (hostFailStreak.get(origin) || 0) + 1;
        hostFailStreak.set(origin, streak);
        if (streak >= HOST_FAIL_THRESHOLD) openHostCooldown(origin);
    }

    // 熔断只是让该图床进入冷却，冷却结束自动重开；连续多轮都拿不到成功才彻底放弃
    function openHostCooldown(origin) {
        const prev = hostCooldown.get(origin);
        const rounds = (prev ? prev.rounds : 0) + 1;
        hostCooldown.set(origin, { until: Date.now() + HOST_COOLDOWN_MS, rounds: rounds });
        hostFailStreak.delete(origin);
        hostTimeoutStreak.delete(origin);
        log(`图床进入冷却（第 ${rounds} 轮）: ${origin}`);
        if (rounds > HOST_COOLDOWN_ROUNDS) {
            rememberDeadHost(origin);   // 本次页面内放弃，并让下一页也不再硬撞
            hostCooldown.delete(origin);
        }
    }

    // 图床冷却剩余时间；> 0 表示这一轮先别发请求
    function hostCooldownWait(origin) {
        const c = hostCooldown.get(origin);
        return c ? Math.max(0, c.until - Date.now()) : 0;
    }

    // 冷却超过轮次上限后已交给失败记忆处理，这里只判记忆
    function hostGaveUp(origin) {
        return isDeadHost(origin);
    }

    // 前两次尝试用原地址（命中缓存直接成功）；
    // 只有在「上一次请求已经结束」的硬错误重试时才换地址破缓存。
    // 超时重试绝不能换地址、也不能重赋同值：那会取消浏览器仍在排队/在途的那次请求，
    // 把它重新排到队尾，越重试越慢。
    function attemptUrl(url, attempt, refetch) {
        if (!refetch) return url;
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
        let startedAt = 0;    // 本次请求真正发出的时刻（在途计时起点）
        let waitUsed = 0;     // 跨重试累计的在途等待毫秒；冷却/排队/退避不计入
        let attempt = 0;
        let settled = false;
        let failedFlag = false;
        let holding = false;
        let heldHost = null;   // 本闭包当前占用的域名配额，释放时归还
        let refetch = false;   // 下次派发是否必须换新地址（仅硬错误重试时置真）
        let timer = null;

        const releaseSlot = () => {
            if (!holding) return;
            holding = false;
            img._holding = false;
            imgInFlight--;
            const used = inFlightByHost.get(heldHost) || 0;
            inFlightByHost.set(heldHost, Math.max(0, used - 1));
            pumpImgQueue();
        };

        const done = (failed, outcome) => {
            if (settled || img._gen !== gen) return;
            // 已经解出画面（naturalWidth > 0）就按成功结算：用户看得见内容，
            // 再压暗只会让人以为图坏了。标记失败并不会中止请求，图仍会把剩余部分下完。
            if (failed && img.naturalWidth > 0) { failed = false; outcome = 'partial'; }
            settled = true;
            failedFlag = failed;
            img._wasSettled = true;
            img._wasFailed = failed;
            clearTimeout(timer);
            releaseSlot();

            // partial = 已解出画面但没传完，不计入图床健康度
            if (!failed) { if (outcome === 'ok') trackHostResult(origin, 'ok'); }
            else if (outcome === 'hard') { rememberBadImage(url); trackHostResult(origin, 'hard'); }
            else if (outcome === 'timeout') trackHostResult(origin, 'timeout');
            else if (outcome === 'cached-hard') rememberBadImage(url);
            // skip 不进失败记忆：它只说明「这张没试过」（图床冷却中或已判死），
            // 记下来会让下一页把同一批图直接判死，整页变砖

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
            // 结算时还没解出画面、之后数据才到的图：复核一次并撤回暗态与失败计数
            if (failed) recheckAfterFail();
        };

        // 失败后的复核。数据可能刚好在结算之后才到，此时图已经能看见，
        // 再压着只会让人以为图坏了。固定 2s/6s 两点复核会miss慢图床的数据到达
        // （实测 12 张已解出画面仍被压暗），改为持续轮询：每 2s 查一次，
        // 直到图解出画面、节点换代或超过 60s 上限
        function recheckAfterFail() {
            const deadline = Date.now() + 60000;
            const tick = () => {
                if (img._gen !== gen) return;
                if (!settled || !failedFlag) return;
                if (img.naturalWidth > 0) {
                    failedFlag = false;
                    img._wasFailed = false;
                    thumbProgress.revive();
                    unmarkFailed(img);
                    return;
                }
                if (Date.now() < deadline) setTimeout(tick, 2000);
            };
            setTimeout(tick, 2000);
        }

        // 把下一次尝试排进队列（队尾）
        const queueAttempt = () => {
            if (settled || img._gen !== gen) return;
            const task = () => {
                if (settled || img._gen !== gen) return;
                imgInFlight++;
                holding = true;
                heldHost = origin;
                img._holding = true;
                img._heldHost = origin;
                inFlightByHost.set(origin, (inFlightByHost.get(origin) || 0) + 1);
                if (!manual) {
                    // 图床冷却中：整批往后挪，等冷却结束再试，不计失败也不占槽位
                    const wait = hostCooldownWait(origin);
                    if (wait > 0) { reQueueAfter(wait); return; }
                    if (hostGaveUp(origin)) { done(true, 'skip'); return; }
                }
                const nextUrl = attemptUrl(url, attempt, refetch);
                // 只有地址真的变了才赋值：对同一 URL 重新赋值会取消浏览器在途/排队的请求
                if (img.getAttribute('src') !== nextUrl) setImgSrc(img, nextUrl);
                // 命中缓存时直接结算
                if (img.complete) {
                    const ok = img.naturalWidth > 0;
                    done(!ok, ok ? 'ok' : 'cached-hard');
                    return;
                }
                // 总等待预算只累计「请求真正发出后」的在途时间：
                // 冷却等待、重试退避、排队等窗口位都不计时。否则这些时间会先耗尽预算，
                // 重新派发的图被秒判超时 → 超时喂熔断计数 → 再冷却 → 更多秒判，恶性循环
                startedAt = performance.now();
                armWait();
            };
            task._img = img;     // resetImage 据此出队
            task._host = origin; // pumpImgQueue 据此做域名分池
            imgQueue.push(task);
            pumpImgQueue();
        };

        const armWait = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (img._gen === gen) onTimeout(); },
                Math.max(0, IMG_TOTAL_WAIT_MS - waitUsed));
        };

        // 图床冷却期间把这次派发整体推迟，不结算也不占槽位
        const reQueueAfter = (wait) => {
            releaseSlot();
            timer = setTimeout(() => { if (img._gen === gen) queueAttempt(); }, wait + 50);
        };

        function retryLater(hard) {
            attempt++;
            refetch = hard;   // 只有「请求已经结束」的硬错误才换地址重发
            waitUsed += performance.now() - startedAt;   // 本次在途时长计入总预算，退避等待不计
            releaseSlot();
            const delay = IMG_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 400);
            timer = setTimeout(() => { if (img._gen === gen) queueAttempt(); }, delay);
        }

        function onTimeout() {
            if (settled || img._gen !== gen) return;
            clearTimeout(timer);
            waitUsed += performance.now() - startedAt;
            // 超时按失败送进 done()，是否真的算失败由 done() 依据「有没有解出画面」判定；
            // 不重发（重赋 src 会取消在途请求并重排队尾）
            done(true, 'timeout');
        }

        function onError() {
            if (settled || img._gen !== gen) return;
            clearTimeout(timer);
            if (attempt >= IMG_RETRY_TIMES) { done(true, 'hard'); return; }
            retryLater(true);
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
        // 命中图级失败记忆：直接跳过（manual 模式已在 manualRetry 里赦免，强行放行）
        // 图床记忆已并入图级表，这里只需查图级表
        if (!manual && badImages.has(url)) {
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
        hostCooldown.delete(img._host);   // 手动重试视为用户要求立刻重开该图床
        loadThumb(img, img._url, true, false);
    }

    /* ============================== 图片登记 ============================== */

    // 站内占位图特征。详情页的帖子图就是「src=./images/thumb-ing.gif + data-original=真地址」，
    // 必须在这里就把真地址换上来：否则它会被当成同源图永久放弃接管，
    // 最后只能靠站点自己的滚动脚本换图 —— 表现就是「滚到才出图」，
    // 直接违背本脚本「不依赖滚动触发」的承诺。
    const PLACEHOLDER_NAME_RE = /thumb-ing|thumbing|none\.gif|spacer\.gif|loading\.gif|blank\.gif|grey\.gif/i;
    function isPlaceholderSrc(src) {
        if (!src) return true;
        if (src.indexOf('data:') === 0) return true;
        if (/^(https?:)?\/\//i.test(src)) return PLACEHOLDER_NAME_RE.test(src);
        return true;   // 相对路径一律当占位：真图床不会用相对地址
    }

    // 只接管跨域图片（图床）；站内图标、空 src、data: 内联图一律不碰
    function pickImage(img) {
        if (!img || img.tagName !== 'IMG' || img._picked) return;

        // <picture>/<source> 或 srcset 让浏览器自选 URL：改 img.src 不生效，
        // 强接会导致记忆/熔断记错对象、重试链路断掉——这类图整个不接管，交给浏览器
        if (img.closest('picture') || img.getAttribute('srcset')) { img._picked = true; return; }

        const cur = img.getAttribute('src');
        let src = cur || '';
        const lazy = (img.getAttribute('data-src') || img.getAttribute('data-original') ||
                   img.getAttribute('data-lazy-src') || '').trim();
        // src 是站内占位图时，真地址在 data-* 上，换上来（否则会被当同源图永久放弃）
        if (lazy && isPlaceholderSrc(src)) src = lazy;

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
        // 列表页缩略图：点开帖子走新标签，免得看完帖回来丢掉整页已加载的结果
        // （只在列表页加，详情页正文图不动，避免把正文图链接也变成新标签）
        if (location.pathname.indexOf('thread.php') !== -1) {
            const a = img.closest('a');
            if (a && !a.getAttribute('target')) { a.target = '_blank'; a.rel = 'noopener'; }
        }
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
        if (img._holding) {
            img._holding = false;
            imgInFlight--;
            const used = inFlightByHost.get(img._heldHost) || 0;
            inFlightByHost.set(img._heldHost, Math.max(0, used - 1));
            pumpImgQueue();
        }
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
        // 既顶大进度分母，又要等超时才结算
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

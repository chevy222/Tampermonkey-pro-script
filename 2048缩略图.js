// ==UserScript==
// @name         2048缩略图
// @namespace    https://bbs.vsbskpo.com/
// @version      2.4
// @description  去除列表页/详情页/搜索页图片懒加载：视口内图片立即加载，屏外图片提前预取（IntersectionObserver），页面加载完成后补齐全部；移除占位图与广告；CSS 隐藏侧栏。详情页兼容 jQuery.lazyload 的 data-original 属性，滚动不再触发新图片请求。v2.2：图片统一 no-referrer 防图床防盗链（页内加载失败但直开能出的根因），失败后自动穿透缓存重试一次，decoding=async。v2.3：节点复用换图时同步重置重试/调度标记（旧地址重试、原生 lazy 图卡住不激活的根因）；重试地址过滤占位图；@noframes；兜底轮询空闲后自停。
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
    // 懒加载真实地址所在的属性名：data-src(通用)、data-original(jQuery.lazyload，详情页 att_img 使用)、data-lazy-src(部分变体)
    var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src'];
    var LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
    var VIEWPORT_MARGIN = 800;      // 距视口该像素内立即激活
    var PREFETCH_MARGIN = '1500px'; // 视口外图片提前预取的距离
    var FALLBACK_INTERVAL = 3000;   // 兜底轮询周期

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

    // 激活 = 让浏览器立即发起请求（移除原生懒加载约束）
    function activateImage(img) {
        if (img._activated) return;
        img._activated = true;
        if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
        img.loading = 'eager';
    }

    function nearViewport(img, margin) {
        var r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false; // 尚未参与布局/不可见，交给观察器或兜底
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        return r.top < vh + margin && r.bottom > -margin;
    }

    var deferredImgs = [];
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
                io.unobserve(entries[i].target);
                activateImage(entries[i].target);
            }
        }
    }, { rootMargin: PREFETCH_MARGIN }) : null;

    // 视口优先调度：近处立即激活，远处登记为提前预取
    function scheduleActivation(img) {
        if (img._activated || img._scheduled) return;
        img._scheduled = true;
        deferredImgs.push(img); // 统一登记，供页面加载完成后兜底补齐
        if (nearViewport(img, VIEWPORT_MARGIN)) { activateImage(img); return; }
        if (io) io.observe(img);
    }

    // 页面加载完成后网络空闲，把剩余未激活的全部放行（含 display:none 等 IO 覆盖不到的）
    function flushDeferred() {
        var list = deferredImgs.splice(0);
        for (var i = 0; i < list.length; i++) activateImage(list[i]);
    }
    if (document.readyState === 'complete') { setTimeout(flushDeferred, 600); }
    else { window.addEventListener('load', function () { setTimeout(flushDeferred, 400); }); }

    function forceLoadImage(img) {
        if (!img || img.tagName !== 'IMG' || img._forceLoaded) return false;

        // 关键修复：在任何 src 赋值前设置，与"直接打开图片链接"的请求语义对齐（不带 Referer），
        // 规避图床防盗链导致的"页内灰底、直开秒出"；decoding=async 避免解码阻塞渲染
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';

        var processed = false;
        var src = img.getAttribute('src') || '';

        for (var a = 0; a < LAZY_SRC_ATTRS.length; a++) {
            var lazySrc = img.getAttribute(LAZY_SRC_ATTRS[a]);
            if (lazySrc) {
                saveOriginalSrc(img, lazySrc);
                // 同一地址只赋值一次（2.0 用绝对URL与相对路径比较恒不等，会重复赋值）
                if (img._assignedSrc !== lazySrc) { img._assignedSrc = lazySrc; img.src = lazySrc; }
                processed = true;
                break;
            }
        }
        if (!processed) {
            for (var i = 0; i < LAZY_SRCSET_ATTRS.length; i++) {
                var ss = img.getAttribute(LAZY_SRCSET_ATTRS[i]);
                if (ss) {
                    if (img._assignedSrcset !== ss) { img._assignedSrcset = ss; img.srcset = ss; }
                    // 只取第一个候选URL作为失败重试地址（2.0 把整串srcset存入_origSrc，重试必败）
                    saveOriginalSrc(img, ss.split(',')[0].trim().split(/\s+/)[0]);
                    processed = true;
                    break;
                }
            }
        }

        if (!processed && img.getAttribute('loading') === 'lazy') {
            saveOriginalSrc(img, img.currentSrc || src);
            processed = true;
            img._needsScheduling = true; // 视口优先：交给调度器决定立即或延迟激活
        }

        if (!processed && (src.indexOf('http') === 0 || src.indexOf('//') === 0 || src.indexOf('/') === 0)) {
            saveOriginalSrc(img, src);
            processed = true;
        }

        if (processed) {
            img._forceLoaded = true;
            watchError(img);
            if (img._needsScheduling) scheduleActivation(img);
            // 已直接赋 src 的图片同步移除原生 loading=lazy，
            // 否则浏览器仍会推迟实际抓取（data-src 路径 + loading=lazy 共存时）
            else activateImage(img);
        }
        return processed;
    }

    function processImages(root) {
        if (!root || !root.querySelectorAll) return;
        var imgs = root.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) forceLoadImage(imgs[i]);
    }

    function matchesAny(el, selectors) {
        if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
        for (var s = 0; s < selectors.length; s++) {
            if (el.matches(selectors[s])) return true;
        }
        return false;
    }

    // 合并 2.0 的 removeAds / removeAdElements：同一逻辑遍历一份选择器表
    function removeMatching(root, selectors) {
        if (!root) return 0;
        var removed = 0;
        if (root !== document.body && root !== document.documentElement && matchesAny(root, selectors)) {
            root.remove();
            return 1;
        }
        if (!root.querySelectorAll) return 0;
        for (var s = 0; s < selectors.length; s++) {
            var els = root.querySelectorAll(selectors[s]);
            for (var i = 0; i < els.length; i++) { els[i].remove(); removed++; }
        }
        return removed;
    }

    function processAll(root) {
        processImages(root);
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

// ==UserScript==
// @name         探花
// @namespace    http://thbt6.com/
// @version      2.0
// @description  探花BT：列表页居中显示详情页预览大图 + 列表/详情页去广告
// @author       Chevy Yang
// @match        https://dja.532232.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/**
 * ============================================================
 * 站点结构（改代码前先读这段）
 * ============================================================
 * 【列表页】
 *   UL.list > LI > span.list_item > a[href="/movie.php?classid=..&e=<token>"]
 *   这些节点整体包在 DIV#content.site-content.row 里。
 *   ⚠️ #content 就是列表容器，把整个 #content 删掉 = 整页列表消失。
 *   能删的广告位见 CONFIG.adSelectors（列表页命中 #hf-container / #dp-container）。
 *   分页是整页刷新（不是 SPA 路由），所以每翻一页脚本自然重跑一次。
 *
 * 【详情页】
 *   也已 SPA 化：服务端只回 ~3.5KB 空壳
 *     <div id="app"></div> + <script>var __data__ = {...}</script>
 *   图片由 /js/movie.js 的 render_template() 在浏览器端生成。
 *   GM_xmlhttpRequest 不执行页面 JS，拿不到 DOM，只能从空壳的
 *   __data__ 内联 JSON 里正则取字段（旧的 .img_item / base64 解码全部失效）。
 *   详情页还额外挂有一个正文内的广告图墙 DIV#icon-wrapper > DIV.partner-zone。
 *   注意正文里这些是【真内容】，不能碰：
 *     .video-infos / .video-description（发布时间/格式/大小/时长/分辨率/Hash）
 *     .preview-grid > .capture-col（站点自己的预览图）
 *     P#magnet-link、下载/复制磁力按钮、.pagination-nav（上一篇/下一篇）
 *
 * 【预览图】
 *   地址：https://{domain_image}/capture/{picture_dir}/t4.jpg
 *   站点自己在 <picture> 里放了两条，但同一时刻只显示一条：
 *     <source media="(max-width:767.98px)" srcset=".../t2.jpg">   ← 移动分支
 *     <img src=".../t4.jpg">                                       ← 桌面分支
 *   本脚本只取【桌面分支 t4.jpg】。
 *   t4 有横有竖（横 1200x694 居多；竖如 1200x2086 / 1000x1742），
 *   所以只给【竖版】设高度上限，横版按原始尺寸撑满，避免竖版满宽撑到近 2000px 高。
 * ============================================================
 */

(function () {
    'use strict';

    const CONFIG = {
        // 只取站点桌面分支的那一张；要换图改这个文件名即可
        imageName: 't4.jpg',

        // 竖版图的高度上限（px）。横版图不受此限、按原始尺寸显示；0 = 竖版也不限
        portraitMaxHeight: 640,

        // 在标题后显示 "1280x720" 分辨率徽章
        showResolutionBadge: true,

        // 列表页与详情页都要清掉的广告块
        adSelectors: [
            '#hf-container',   // 顶部广告条（10 条外链图）
            '#dp-container',   // 底部广告条（10 条外链图）
            '#icon-wrapper'    // 详情页正文里的"合作伙伴"广告图墙（10 张）
        ],

        // 页脚的 SEO 链接农场：25 条指向 *.259298.com 的垃圾外链，站长自己标"广告联系"。
        // 想保留页脚就改成 false。
        removeFooterFarm: true,

        maxConcurrent: 6,          // 并发抓取详情页数
        requestTimeout: 15000,     // 详情页请求超时
        listPollInterval: 300,     // 等列表渲染的轮询间隔
        listMaxWait: 15000         // 等列表渲染的最长时间
    };

    const CLASS = {
        preview: 'tht-preview',
        loading: 'tht-loading',   // ⚠️ 别用 .preview-loading，站点自己的预览组件在用
        badge: 'tht-badge',
        empty: 'tht-empty',
        portrait: 'tht-portrait'
    };

    function buildStyles() {
        const portraitMax = CONFIG.portraitMaxHeight > 0 ? CONFIG.portraitMaxHeight + 'px' : 'none';

        return `
            /* .row 站点原生 max-width:1000px，不放宽的话预览图只能用到 1000px；
               .videos-list 原生 overflow:hidden，会把放大的图裁掉。两条都是承重的。 */
            .row, #site-navigation ul { max-width: 100% !important; }
            .videos-list, .video-list-content { overflow: visible !important; }

            .${CLASS.preview} {
                display: block !important;
                margin: 10px auto 2px !important;
                padding: 8px 6px !important;
                text-align: center !important;
                background: rgba(0, 0, 0, 0.04) !important;
                border-radius: 5px !important;
            }
            .${CLASS.preview} > a {
                display: block !important;
                line-height: 0 !important;
            }
            .${CLASS.preview} img {
                display: block !important;
                margin: 0 auto !important;
                width: auto !important;
                height: auto !important;
                max-width: 100% !important;
                border-radius: 3px !important;
                background: rgba(0, 0, 0, 0.06) !important;
            }
            /* 只有竖版图才限高：横版按原始尺寸撑满，竖版不撑到近 2000px */
            .${CLASS.preview} img.${CLASS.portrait} {
                max-height: ${portraitMax} !important;
            }

            .${CLASS.loading} {
                display: inline-block !important;
                margin-top: 6px !important;
                padding: 3px 8px !important;
                font-size: 12px !important;
                color: #666 !important;
                background: #f0f0f0 !important;
                border-radius: 3px !important;
            }
            .${CLASS.badge} {
                margin-left: 8px !important;
                padding: 2px 8px !important;
                font-size: 12px !important;
                color: #fff !important;
                border-radius: 3px !important;
                white-space: nowrap !important;
            }
            .${CLASS.empty} {
                display: inline-block !important;
                margin-top: 6px !important;
                font-size: 12px !important;
                color: #999 !important;
            }
        `;
    }

    let stylesInjected = false;

    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const style = document.createElement('style');
        style.textContent = buildStyles();
        document.head.appendChild(style);
    }

    // 只清真正的广告位；#content 里装着列表/正文，绝不能删
    function removeAds() {
        CONFIG.adSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
        });

        if (CONFIG.removeFooterFarm) {
            const footer = document.getElementById('colophon');
            if (footer) footer.remove();
        }
    }

    // ---------------- GM 请求队列 ----------------

    function getGMRequest() {
        if (typeof GM_xmlhttpRequest !== 'undefined') return GM_xmlhttpRequest;
        if (typeof GM !== 'undefined' && GM.xmlHttpRequest) return GM.xmlHttpRequest;
        return null;
    }

    let activeRequests = 0;
    const requestQueue = [];
    const processedUrls = new Set();

    function processQueue() {
        const gmRequest = getGMRequest();

        while (activeRequests < CONFIG.maxConcurrent && requestQueue.length > 0) {
            const task = requestQueue.shift();

            if (!gmRequest) {
                task.errorCallback('GM_xmlhttpRequest 不可用');
                continue;
            }

            activeRequests++;
            let settled = false;

            // 幂等收尾：无论 onload/onerror/ontimeout 谁先到，都只结算一次
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                activeRequests--;
                try { fn(arg); } catch (e) { console.error('[探花缩略图]', e); }
                processQueue();
            };

            gmRequest({
                method: 'GET',
                url: task.url,
                timeout: CONFIG.requestTimeout,
                onload: res => {
                    if (res.status && (res.status < 200 || res.status >= 400)) {
                        finish(task.errorCallback, 'HTTP ' + res.status);
                    } else {
                        finish(task.callback, res.responseText || '');
                    }
                },
                onerror: () => finish(task.errorCallback, '请求失败'),
                ontimeout: () => finish(task.errorCallback, '请求超时')
            });
        }
    }

    function fetchDetailPage(url, callback, errorCallback) {
        requestQueue.push({ url, callback, errorCallback });
        processQueue();
    }

    // ---------------- 解析详情页空壳 ----------------

    function parseDetail(html) {
        const out = { imageUrl: null, resolution: null };
        if (!html) return out;

        // "domain_image":"image.sohu-cdn.com" / "picture_dir":237591367564358
        const domM = html.match(/"domain_image"\s*:\s*"([^"]+)"/);
        const dirM = html.match(/"picture_dir"\s*:\s*(\d+)/);
        if (domM && dirM) {
            out.imageUrl = 'https://' + domM[1] + '/capture/' + dirM[1] + '/' + CONFIG.imageName;
        }

        // "resolution":"1280x720"
        const resM = html.match(/"resolution"\s*:\s*"(\d+)\s*x\s*(\d+)"/);
        if (resM) {
            out.resolution = { width: +resM[1], height: +resM[2], text: resM[1] + 'x' + resM[2] };
        }

        return out;
    }

    function isHighDefinition(r) {
        if (!r) return false;
        return (r.width >= 1920 && r.height >= 1080) || (r.width >= 1080 && r.height >= 1920);
    }

    // ---------------- 渲染 ----------------

    function appendNotice(li, text, color) {
        const span = document.createElement('span');
        span.className = CLASS.empty;
        span.textContent = text;
        if (color) span.style.color = color;   // 默认色由 .tht-empty 的 CSS 提供
        li.appendChild(span);
    }

    function addBadge(li, resolution) {
        const link = li.querySelector('a[href*="movie.php"]');
        if (!link) return;

        const badge = document.createElement('span');
        badge.className = CLASS.badge;
        badge.textContent = resolution.text;
        badge.style.background = isHighDefinition(resolution) ? '#4CAF50' : '#9e9e9e';
        link.insertAdjacentElement('afterend', badge);
    }

    function addPreview(li, imageUrl, detailUrl) {
        const box = document.createElement('div');
        box.className = CLASS.preview;

        const link = document.createElement('a');
        link.href = detailUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = '点击查看详情';

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = '预览图';
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        img.addEventListener('load', function () {
            // 竖版图才加限高类；横版图按原始尺寸显示
            if (this.naturalHeight > this.naturalWidth) {
                this.classList.add(CLASS.portrait);
            }
        });
        img.addEventListener('error', () => {
            box.remove();
            appendNotice(li, '无预览图');
        });

        link.appendChild(img);
        box.appendChild(link);
        li.appendChild(box);
    }

    function addPreviewToItem(li, detailUrl) {
        if (processedUrls.has(detailUrl)) return;
        processedUrls.add(detailUrl);

        const loading = document.createElement('span');
        loading.className = CLASS.loading;
        loading.textContent = '🔄 加载中...';
        li.appendChild(loading);

        fetchDetailPage(detailUrl, html => {
            loading.remove();
            const data = parseDetail(html);

            if (CONFIG.showResolutionBadge && data.resolution) {
                addBadge(li, data.resolution);
            }

            if (data.imageUrl) {
                addPreview(li, data.imageUrl, detailUrl);
            } else {
                appendNotice(li, '无预览图');
            }
        }, () => {
            loading.remove();
            appendNotice(li, '❌ 加载失败', '#ff6b6b');
        });
    }

    // ---------------- 列表扫描 ----------------

    function findListItems() {
        const items = [];

        // 第一条是当前真实结构；第二条锚在容器 .videos-list 上，万一 ul 的类名被换还能兜住。
        const selectors = ['ul.list > li', '.videos-list ul li'];
        let listItems = [];
        for (const s of selectors) {
            const found = document.querySelectorAll(s);
            if (found.length > 0) { listItems = found; break; }
        }

        listItems.forEach(li => {
            const link = li.querySelector('a[href*="movie.php"]');
            if (!link) return;

            const href = link.getAttribute('href');
            if (!href) return;

            const fullUrl = href.startsWith('http') ? href
                : href.startsWith('/') ? location.origin + href
                : location.origin + '/' + href;

            items.push({ li, href: fullUrl });
        });

        return items;
    }

    // 详情页：站点 JS 异步渲染，广告会晚于 document-idle 才出现，所以挂观察器持续清。
    // 只监听 childList，渲染完成后基本不再触发；观察器随页面一起销毁，不需要手动停机
    // （翻上一篇/下一篇是整页刷新，本来就是新实例）。
    // 注意：详情页【只去广告】，不加宽布局（列表页的 injectStyles 不在这里跑）。
    function watchDetailPage() {
        let pending = false;

        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            // 微任务合并：一次渲染里成百上千条 mutation 只触发一次清理
            Promise.resolve().then(() => {
                pending = false;
                removeAds();
            });
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
        removeAds();
    }

    function init() {
        // 详情页：只去广告，不动布局
        if (/movie\.php/i.test(location.pathname)) {
            watchDetailPage();
            return;
        }

        injectStyles();

        const startedAt = Date.now();

        // 列表内容由站点 JS 渲染，这里轮询等 ul.list 出现
        (function waitForList() {
            const items = findListItems();

            if (items.length > 0) {
                removeAds();
                items.forEach(({ li, href }) => addPreviewToItem(li, href));
                return;
            }

            if (Date.now() - startedAt < CONFIG.listMaxWait) {
                setTimeout(waitForList, CONFIG.listPollInterval);
            }
        })();
    }

    init();
})();

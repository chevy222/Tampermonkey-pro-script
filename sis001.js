// ==UserScript==
// @name         sis001
// @namespace    https://sis001.com/
// @version      1.2
// @description  在 sis001.com 全站列表页中从详情页抓取缩略图直接显示
// @author       Chevy Yang
// @match        https://www.sis001.com/forum/forum-*.html
// @match        https://www.sis001.com/forum/forumdisplay.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    var THUMB_MAX = 3;
    // 详情页 HTML 抓取并发数：浏览器对同域 HTTP/1.1 约有 6 个并发连接，8 可保持队列饱和
    var CONCURRENCY = 8;

    function isUiImg(src) {
        if (!src) return true;
        var isSis = src.indexOf('sis001.com') !== -1 || src.indexOf('sis.la') !== -1;
        if (isSis) {
            if (src.indexOf('/images/') !== -1) return true;
            if (src.indexOf('pic.php') !== -1) return true;
            if (src.indexOf('attachments/month_') !== -1) return true;
            if (src.indexOf('avatar') !== -1) return true;
            if (src.indexOf('smilies') !== -1) return true;
            if (src.indexOf('star_level') !== -1) return true;
            if (src.indexOf('joinvip') !== -1) return true;
            if (src.indexOf('folder') !== -1) return true;
            if (src.indexOf('pin_') !== -1) return true;
            if (src.indexOf('agree') !== -1) return true;
            if (src.indexOf('attachicons') !== -1) return true;
            if (src.indexOf('paypic') !== -1) return true;
            if (src.indexOf('common/') !== -1) return true;
            if (src.indexOf('csg-') !== -1 && src.indexOf('.gif') !== -1) return true;
        }
        if (src.indexOf('.gif') !== -1 && src.indexOf('img.sis.la') === -1 && src.indexOf('qpic.ws') === -1) return true;
        return false;
    }

    function extractImgsFromHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var pidTables = doc.querySelectorAll('table[id^="pid"]');
        if (!pidTables.length) return [];
        var firstPid = pidTables[0].id.replace('pid', '');
        var postbody = doc.getElementById('postmessage_' + firstPid);
        if (!postbody) return [];
        var imgs = postbody.querySelectorAll('img');
        var result = [];
        for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].src;
            if (!isUiImg(src)) result.push(src);
        }
        return result;
    }

    var overlay = null;

    function showOverlay(src) {
        if (overlay) removeOverlay();
        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;';
        var fullImg = document.createElement('img');
        fullImg.src = src;
        fullImg.style.cssText = 'max-width:95vw;max-height:95vh;object-fit:contain;';
        overlay.appendChild(fullImg);
        overlay.onclick = removeOverlay;
        document.body.appendChild(overlay);
        document.addEventListener('keydown', overlayEsc);
    }

    function removeOverlay() {
        if (overlay) { overlay.remove(); overlay = null; }
        document.removeEventListener('keydown', overlayEsc);
    }

    function overlayEsc(e) { if (e.key === 'Escape') removeOverlay(); }

    function createThumbRow(imgs, tid) {
        var tr = document.createElement('tr');
        tr.className = 'thumb-row';
        tr.setAttribute('data-tid', tid);
        var td = document.createElement('td');
        td.colSpan = 7;
        td.style.cssText = 'padding:8px 10px 10px 80px;background:#e0e8d0;border-top:1px solid #c8d0a8;';
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;';
        var count = Math.min(imgs.length, THUMB_MAX);
        for (var i = 0; i < count; i++) {
            (function (idx) {
                var item = document.createElement('div');
                item.style.cssText = 'position:relative;width:400px;height:300px;overflow:hidden;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer;';
                var img = document.createElement('img');
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
                img.decoding = 'async';
                img.loading = 'eager';
                img.src = imgs[idx];
                item.onclick = function () { showOverlay(imgs[idx]); };
                item.appendChild(img);
                if (idx === THUMB_MAX - 1 && imgs.length > THUMB_MAX) {
                    var badge = document.createElement('span');
                    badge.style.cssText = 'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);color:#fff;font-size:14px;font-weight:bold;padding:4px 10px;border-radius:4px;pointer-events:none;';
                    badge.textContent = '+' + (imgs.length - THUMB_MAX);
                    item.appendChild(badge);
                }
                wrap.appendChild(item);
            })(i);
        }
        td.appendChild(wrap);
        tr.appendChild(td);
        return tr;
    }

    var fetchQueue = [];
    var activeCount = 0;
    var processedTids = new Set();

    function processQueue() {
        while (activeCount < CONCURRENCY && fetchQueue.length) {
            var task = fetchQueue.shift();
            activeCount++;
            fetchOne(task);
        }
    }

    function fetchOne(task) {
        var tid = task.tid;
        var row = task.row;
        var url = '/forum/thread-' + tid + '-1-1.html';
        fetch(url, { credentials: 'same-origin' })
            .then(function (r) { if (r.ok) return r.text(); throw new Error('http ' + r.status); })
            .then(function (html) {
                var imgs = extractImgsFromHtml(html);
                if (imgs.length) {
                    var thumbRow = createThumbRow(imgs, tid);
                    row.parentNode.insertBefore(thumbRow, row.nextSibling);
                }
            })
            .catch(function () {})
            .finally(function () {
                activeCount--;
                processQueue();
            });
    }

    function enqueue(tid, row) {
        if (processedTids.has(tid)) return;
        processedTids.add(tid);
        fetchQueue.push({ tid: tid, row: row });
    }

    function getRowTid(row) {
        var span = row.querySelector('span[id^="thread_"]');
        if (!span) return null;
        return span.id.replace('thread_', '');
    }

    function getForumId() {
        var m = location.pathname.match(/forum-(\d+)-/);
        if (m) return m[1];
        var params = new URLSearchParams(location.search);
        var fid = params.get('fid');
        if (fid) return fid;
        return null;
    }

    // 置顶/推荐/普通主题分散在多个 table#forum_N 中：
    // 推荐主题与置顶贴均为 tbody[id^="stickthread_"]，普通贴为 tbody[id^="normalthread_"]，
    // 必须全量收集而不是只取包含第一个 normalthread 的 table
    function getThreadRows() {
        var tbodies = document.querySelectorAll('tbody[id^="stickthread_"], tbody[id^="normalthread_"]');
        var rows = [];
        for (var i = 0; i < tbodies.length; i++) {
            var trs = tbodies[i].children;
            for (var j = 0; j < trs.length; j++) {
                if (trs[j].tagName === 'TR') rows.push(trs[j]);
            }
        }
        return rows;
    }

    // 「固定主題」区块的帖子内容不变，无需加载缩略图；
    // 区块标题位于 table > thead.separation 中（固定主題/重要主題/推荐主题/版块主题）
    function isFixedThread(row) {
        var table = row.closest('table');
        if (!table) return false;
        var head = table.querySelector('thead.separation');
        if (!head) return false;
        return head.textContent.indexOf('固定') !== -1;
    }

    function processList() {
        var fid = getForumId();
        if (!fid) return;
        var rows = getThreadRows();
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.className.indexOf('category') !== -1) continue;
            if (row.classList.contains('thumb-row')) continue;
            if (isFixedThread(row)) continue;
            var tid = getRowTid(row);
            if (!tid) continue;
            enqueue(tid, row);
        }
        processQueue();
    }

    var observer = new MutationObserver(function (mutations) {
        var hasRealChange = false;
        for (var m = 0; m < mutations.length; m++) {
            var added = mutations[m].addedNodes;
            for (var i = 0; i < added.length; i++) {
                var n = added[i];
                if (n.nodeType !== 1) continue;
                // 缩略图行自身插入不算新内容；其余新增节点才需要重新扫描
                if (n.tagName === 'TR' && n.classList.contains('thumb-row')) continue;
                hasRealChange = true;
            }
        }
        if (hasRealChange) processList();
    });

    function startObserver() {
        var fid = getForumId();
        if (!fid) return;
        var tbody = document.querySelector('tbody[id^="normalthread_"], tbody[id^="stickthread_"]');
        if (tbody) {
            // 所有主题 table（置顶/推荐/普通）都在同一个 FORM 内
            observer.observe(tbody.closest('form') || document.body, { childList: true, subtree: true });
        } else {
            setTimeout(startObserver, 200);
        }
    }

    processList();
    startObserver();

})();

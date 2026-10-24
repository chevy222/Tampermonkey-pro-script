// ==UserScript==
// @name         U9A9
// @namespace    https://u9a9.my/
// @version      1.4
// @description  U9A9：列表页把详情页的预览图搬到列表显示（最多 5 张，横图 4:3、竖图 3:4 居中裁切），缩略图组右上角显示图片数量/剩余数量；清掉全站推广（横幅、导航推广位、假告示条、详情页侧栏与 JuicyAds）
// @author       Chevy Yang
// @match        https://u9a9.my/*
// @match        https://u9a9.com/*
// @match        https://u9a9.org/*
// @match        https://u9a9.de/*
// @match        https://u9a9.win/*
// @match        https://u9a9.su/*
// @grant        GM_xmlhttpRequest
// @connect      u9a9.my
// @connect      u9a9.com
// @connect      u9a9.org
// @connect      u9a9.de
// @connect      u9a9.win
// @connect      u9a9.su
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * ============================================================
 * 站点结构（2026-10-24 实测，改代码前先读这段）
 * ============================================================
 * 【列表页】
 *   table.torrent-list > tbody > tr
 *   第 2 个 td 里 a[href="/view/<type>/<hash>"] 是详情链接；
 *   整行 6 个 td（分类图标 / 标题 / 下载+磁力 / 大小 / 日期 / 广告）。
 *   分页是整页刷新（/?type=2&p=N），搜索也是同一张表（/?type=2&search=...），
 *   所以脚本每翻一页自然重跑一次，不需要观察器。
 *
 * 【详情页】
 *   div.img-container > img（张数 1 至数十张不等，实测单帖最多 31 张；
 *   首页多是 1-2 张，第二页起多图帖很常见）。src 是协议相对地址
 *   //i2.66img.pics/...，必须补 https:。图床允许站内 referer 直连
 *   （列表页实测能加载），所以缩略图不设 referrerPolicy，避免因缺 referer 被拒。
 *
 * 【图片加载】
 *   不用原生懒加载（img.loading='lazy'）：缩略图一进 DOM 就排队，
 *   由 token bucket 控节奏（每秒 10 张、在途 ≤10），滚不滚动都按同一节奏下。
 *   注意这里是"图片层"的队列，跟上面抓详情页 HTML 的队列是两套，互不相干。
 *
 * 【广告】
 *   全站推广链接都带 class="adclick"（点击统计标记），这是唯一可靠的判据，
 *   比记"第几个元素"强 —— 站点换顺序也不会误删地址告示。
 *   - 列表页两个 alert：第 1 个是地址发發页告示（无 adclick，保留），
 *     第 2 个「推薦AI短劇」整条都是广告（有 adclick，整条删）
 *   - 详情页：nav 推广 li、首尾 .row.ad 横幅、两整块 .panel-body.ad-m-text 侧栏、
 *     正文上方的 JuicyAds <ins data-width data-height>
 *   - JuicyAds 的 ins 和 .img-container 同处一个 .panel-body，只能删它外层的 .row，
 *     连 panel 一起删会把正文图带走
 *
 * 【角标语义】
 *   详情页图片多于 5 张时显示 "+N"（没搬过来的剩余张数）；
 *   不超过 5 张时显示总数（此时"剩余"是 0，严格显示 0 等于没有角标）。
 *
 * 【版式】
 *   1 张：居中占半行；2 张：各占一半铺满一行；3/4/5 张：各占 1/3、1/4、1/5。
 *   角标挂在 .u9-thumbs 容器上，不挂在最后一张图上 —— 单张图 404 会被 error
 *   摘掉，挂图上角标就跟着消失。右边距按张数算：多张贴整行右侧，1 张退到那半行图的右边缘。
 * ============================================================
 */

(function () {
  'use strict';

  const VERSION = '1.4';

  // 防双注入：同版本已占位则退出；旧版本占位（值不同）不退出，改写哨兵接管
  if (document.documentElement.getAttribute('data-u9a9') === VERSION) return;
  document.documentElement.setAttribute('data-u9a9', VERSION);

  // ============================ 可调参数 ============================

  const CFG = {
    maxThumbs: 5,          // 每个帖子最多搬几张图
    maxConcurrent: 6,      // 并发抓详情页数（对齐浏览器同域连接数）
    requestTimeout: 15000, // 单个详情页请求超时
    maxTries: 2,           // 详情页请求次数上限（含首次）
    retryDelay: 1200,      // 重试前的等待
    gap: 8,                // 缩略图间距
    imgStartPerSec: 10,    // 每秒最多让几张图开始下载（token bucket 补 token 速率）
    imgInflightMax: 10,    // 同时最多几张图在途
    imgTokenCap: 10,       // 开页先放几张 token（首屏不用等节奏）
    imgTimeout: 15000,     // 单张图兜底超时：图床挂起不回调时释放名额
    removeAds: true        // 清掉站点的推广：横幅、导航推广位、假告示条、详情页侧栏与 JuicyAds
  };

  // ============================ 样式 ============================

  const CSS = `
    .u9-thumb-row > td {
      padding: 10px 12px 14px !important;
      background: #f7f8fa !important;
      border-top: 0 !important;
    }
    .u9-thumbs {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;    /* 1 张时居中；2 张及以上正好铺满 */
      align-items: flex-start;    /* 关键：否则同一行的横图会被竖图拉高，4:3 框变成 3:4 */
      gap: ${CFG.gap}px;
      width: 100%;
    }
    .u9-thumb {
      display: block;
      position: relative;         /* 角标挂在这张图右上角 */
      flex: 0 0 auto;
      width: var(--u9-w, 50%);    /* 由 JS 按张数算：1 张 50%，2 张 1/2，…，5 张 1/5 */
      box-sizing: border-box;     /* 边框算进宽度，否则 5 张会差几像素换行 */
      aspect-ratio: 4 / 3;
      overflow: hidden;
      border: 1px solid #dcdcdc;
      border-radius: 4px;
      background: #e9ecef;
      text-decoration: none !important;
    }
    /* 竖图加载完成后切 3:4 竖框；两种框都是 object-fit:cover，居中裁切不拉伸 */
    .u9-thumb.u9-port { aspect-ratio: 3 / 4; }
    .u9-thumb img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
    }
    .u9-badge {
      position: absolute;
      top: 6px;
      /* 贴"整组"的右边缘，由 JS 按张数算：多张时铺满整行=0，1 张时半行居中=25% */
      right: var(--u9-badge-r, 6px);
      z-index: 1;
      min-width: 22px;
      padding: 1px 7px;
      font-size: 12px;
      line-height: 18px;
      text-align: center;
      color: #fff;
      background: rgba(0, 0, 0, 0.62);
      border-radius: 10px;
      pointer-events: none;
    }
    .u9-note {
      display: inline-block;
      padding: 6px 2px;
      font-size: 12px;
      color: #999;
    }
  `;

  let stylesInjected = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  }

  // ============================ 工具 ============================

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 详情页图片地址是 //i2.66img.pics/...，必须补协议；
  // 空值/非法/data: 一律丢掉（new URL 会把 null 串成 "null" 并返回合法假地址，先挡）
  function toHttpUrl(raw) {
    if (!raw) return null;
    try {
      const u = new URL(raw, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // ============================ 网络 ============================

  // GM 优先（不受页面 CSP 限制）；脚本管理器没给 GM 时退回同源 fetch
  function request(url) {
    return new Promise(resolve => {
      let gm = null;
      if (typeof GM_xmlhttpRequest === 'function') gm = GM_xmlhttpRequest;
      else if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') gm = GM.xmlHttpRequest.bind(GM);

      if (gm) {
        gm({
          method: 'GET',
          url,
          timeout: CFG.requestTimeout,
          onload: r => resolve(r && r.status >= 200 && r.status < 400 ? r.responseText : null),
          onerror: () => resolve(null),
          ontimeout: () => resolve(null)
        });
        return;
      }

      // fetch 分支也必须自己兜超时：只握手不回数据时 fetch 的 Promise 永不落地，
      // 队列的 active 计数就减不掉，6 个名额漏光后整页缩略图永久卡在"加载中"
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CFG.requestTimeout);
      fetch(url, { credentials: 'same-origin', signal: ctl.signal })
        .then(r => (r.ok ? r.text() : null))
        .catch(() => null)
        .then(v => { clearTimeout(timer); resolve(v); });
    });
  }

  // 请求队列：并发 ≤ maxConcurrent，先入先出（列表从上往下灌）
  const queue = [];
  let active = 0;

  function enqueue(job) {
    queue.push(job);
    pump();
  }

  function pump() {
    while (active < CFG.maxConcurrent && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve()
        .then(job)
        .catch(e => console.error('[U9A9缩略图]', e))
        .finally(() => { active--; pump(); });
    }
  }

  // ============================ 解析详情页 ============================

  // 返回 null=请求/结构失败（可重试）；[]=详情页真的没图
  function parseImages(html) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const box = doc.querySelector('.img-container');
    if (!box) return null;

    const out = [];
    box.querySelectorAll('img').forEach(img => {
      const url = toHttpUrl(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
      if (url && !out.includes(url)) out.push(url);
    });
    return out;
  }

  async function fetchImages(url) {
    for (let i = 0; i < CFG.maxTries; i++) {
      if (i) await sleep(CFG.retryDelay);
      const images = parseImages(await request(url));
      if (images !== null) return images;
    }
    return null;
  }

  // ============================ 去广告 ============================

  // 站点的推广链接全部挂着 class="adclick"（点击统计标记），以它为判据，
  // 比记"第几个 alert"可靠得多 —— 站点调整顺序不会误删地址告示。
  function removeAds() {
    if (!CFG.removeAds) return;

    // 1) 列表页「推薦AI短劇」那条 alert：内容全是广告链接 → 删；
    //    地址告示那条（u9dz.cc / 永久域名）里没有 adclick → 保留
    document.querySelectorAll('.alert').forEach(el => {
      if (el.querySelector('.adclick, [data-id]')) el.remove();
    });

    // 2) 导航栏里的站外推广 li。删完 ul 会空出来占位，一起清掉
    document.querySelectorAll('li.adclick').forEach(el => el.remove());
    document.querySelectorAll('ul.navbar-nav').forEach(ul => {
      if (!ul.children.length) ul.remove();
    });

    // 3) 页首 / 页尾横幅（每块 4-6 张 banner 图，列表页与详情页都有）
    document.querySelectorAll('.row.ad').forEach(el => el.remove());

    // 4) 详情页侧栏文字广告：整个 .panel 一起删，否则留个空框
    document.querySelectorAll('.panel-body.ad-m-text').forEach(el => {
      (el.closest('.panel') || el).remove();
    });

    // 5) JuicyAds 广告位（<ins data-width data-height>）。
    //    列表页在表格下方的 .center.hidden-xs 里，详情页在正文上方的 .row 里。
    //    只删 <ins> 会留下空壳，而且加载它的 jads.js 还在跑 —— 一块删。
    //    判据里显式排除 .img-container / .torrent-list / .pagination，
    //    免得哪个容器挑错把正文图或分页带走
    document.querySelectorAll('ins[data-width][data-height]').forEach(ins => {
      const box = ins.closest('.row, .center');
      if (box && !box.querySelector('.img-container, .torrent-list, .pagination')) box.remove();
      else ins.remove();
    });
    // 兜底：jads.js 若不在上面那些容器里，也摘掉，别让它继续要广告
    document.querySelectorAll('script[src*="jads.co"]').forEach(sc => sc.remove());
  }

  // ============================ 图片加载节流 ============================

  // token bucket，口径对齐色花堂/2048：每秒最多放 imgStartPerSec 张开始下载，
  // 同时在途不超过 imgInflightMax。不用 img.loading='lazy' —— 缩略图一律进队，
  // 滚不滚动都按节奏下，既不会一次性把图床打满，也不用等用户滚到才出图。
  const imgLoader = (() => {
    let tokens = CFG.imgTokenCap;
    let inflight = 0;
    const jobs = [];
    let timer = null;

    function pump() {
      while (jobs.length && tokens > 0 && inflight < CFG.imgInflightMax) {
        tokens--;
        inflight++;
        jobs.shift()(() => { inflight--; pump(); });
      }
      // 有活才开定时器，队列空了立刻停，不留空转
      if (jobs.length && !timer) {
        timer = setInterval(() => {
          tokens = Math.min(CFG.imgTokenCap, tokens + 1);
          pump();
          if (!jobs.length && timer) { clearInterval(timer); timer = null; }
        }, 1000 / CFG.imgStartPerSec);
      }
    }

    return { push(job) { jobs.push(job); pump(); } };
  })();

  // ============================ 渲染 ============================

  function renderThumbs(td, images, detailUrl) {
    const shown = images.slice(0, CFG.maxThumbs);
    const wrap = document.createElement('div');
    wrap.className = 'u9-thumbs';

    // 1 张：居中占半行；2 张：各一半铺满；3/4/5 张：等分整行。
    // 必须再减 1px 留余量：若按 (100% - 间隙) / n 算，n 张加间隙正好等于 100%，
    // 浏览器亚像素舍入一旦超出就会把最后一张挤到下一行（2 张变两行、5 张变 4+1）
    const cols = shown.length;
    wrap.style.setProperty('--u9-w', cols <= 1
      ? '50%'
      : `calc((100% - ${(cols - 1) * CFG.gap - 1}px) / ${cols})`);
    // 角标的右边距跟着"组"的边界走：≥2 张时组铺满整行，贴容器右侧 6px；
    // 1 张时那张只占半行且居中，右边缘在 75% 处，所以要退 25% + 6px
    wrap.style.setProperty('--u9-badge-r', cols <= 1 ? 'calc(25% + 6px)' : '6px');

    shown.forEach(src => {
      const a = document.createElement('a');
      a.className = 'u9-thumb';
      a.href = detailUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';

      // 占位框先上，--u9-w 已按张数算好，图片陆续到位也不会挤动布局
      a.appendChild(img);
      wrap.appendChild(a);

      // 队首轮到这一张才赋 src。load / error / 兜底超时三条路径都必须回调 done，
      // 否则在途计数减不掉，6 个名额会被慢慢漏光、后面的图永远不出来
      imgLoader.push(done => {
        let settled = false;
        let bail = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (bail) clearTimeout(bail);
          done();
        };

        // 竖图（高>宽）切 3:4 竖框；横图/方图保持默认 4:3
        img.addEventListener('load', () => {
          if (img.naturalWidth && img.naturalWidth < img.naturalHeight) a.classList.add('u9-port');
          finish();
        }, { once: true });
        // 单张坏图只摘掉自己，不影响同一帖其它图
        img.addEventListener('error', () => { a.remove(); finish(); }, { once: true });

        bail = setTimeout(finish, CFG.imgTimeout);
        img.src = src;
      });
    });

    // 有图没搬完 → "+N"；全搬完或不足 5 张 → 总数。
    // 角标挂在 .u9-thumbs 上而不是最后一张图上：末图 404 会被 error 摘掉，
    // 挂在图上角标就跟着一起消失，挂容器上则始终跟着整组走
    const remain = images.length - shown.length;
    if (cols) {
      const badge = document.createElement('span');
      badge.className = 'u9-badge';
      badge.textContent = remain > 0 ? '+' + remain : String(images.length);
      wrap.appendChild(badge);
    }

    td.appendChild(wrap);
  }

  // ============================ 列表页 ============================

  function collectRows() {
    const rows = [];
    document.querySelectorAll('table.torrent-list tbody tr').forEach(tr => {
      if (tr.classList.contains('u9-thumb-row')) return;
      const link = tr.querySelector('a[href^="/view/"]');
      if (!link) return;
      rows.push({ tr, href: new URL(link.getAttribute('href'), location.href).href });
    });
    return rows;
  }

  function processRow(tr, detailUrl) {
    if (tr.dataset.u9a9Done) return;
    tr.dataset.u9a9Done = '1';

    // 缩略图独占一整行，避免挤窄标题列（colspan 跟随原行的列数）
    const thumbRow = document.createElement('tr');
    thumbRow.className = 'u9-thumb-row';
    const td = document.createElement('td');
    td.colSpan = tr.children.length || 6;
    thumbRow.appendChild(td);
    tr.insertAdjacentElement('afterend', thumbRow);

    const note = document.createElement('span');
    note.className = 'u9-note';
    note.textContent = '预览图加载中…';
    td.appendChild(note);

    enqueue(async () => {
      const images = await fetchImages(detailUrl);
      note.remove();

      if (images === null) {
        td.appendChild(Object.assign(document.createElement('span'), {
          className: 'u9-note',
          textContent: '预览图加载失败'
        }));
        return;
      }

      if (!images.length) {
        thumbRow.remove();   // 详情页没图就别留空行
        return;
      }

      renderThumbs(td, images, detailUrl);
    });
  }

  function init() {
    // 广告清理列表页和详情页都要走，必须放在 rows 为空的提前返回之前
    removeAds();

    const rows = collectRows();
    if (!rows.length) return;   // 详情页/其它页面：缩略图不做，广告上面已经清完

    injectStyles();
    rows.forEach(({ tr, href }) => processRow(tr, href));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

// 隔离测试 harness：在罐装页面里注入脚本源码并执行断言。
// 用法（bsk evaluate）：(async()=>{await fetch('/harness.js').then(r=>r.text()).then(t=>eval(t));return await window.runTest('场景名');})()
window.runTest = async (name) => {
  const R = [];
  const ok = (n, c) => R.push((c ? 'PASS' : 'FAIL') + ' | ' + n);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  const IMG = 'http://127.0.0.1:8765/img.gif';
  // 加时间戳防浏览器缓存：否则"回滚代码跑旧断言"这类验证会拿到缓存里的新源码，结论全假
  const SRC_SEHUA = await (await fetch('/sehua.js?t=' + Date.now())).text();
  const SRC_T2048 = await (await fetch('/t2048.js?t=' + Date.now())).text();

  // ---- 罐装 XHR 响应（色花堂）----
  const MOBILE_LIST = '<html><body>' +
    '<div class="n5_htmk"><div class="zttpsl cl"><span class="zttpsz">7</span></div><a href="https://bhagq.4yl7j.com/viewthread.php?tid=101">甲</a><img file="http://127.0.0.1:8765/slow.gif"></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=102">乙</a></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=103">丙</a><img file=\'https://tu.example.invalid/a"1.jpg\'></div>' +
    '<div class="n5_htmk"><div class="zttpsl cl"><span class="zttpsz">22</span></div><a href="https://bhagq.4yl7j.com/viewthread.php?tid=105">戊</a><img file="http://127.0.0.1:8765/wide.svg"><img file="http://127.0.0.1:8765/tall.svg"><img file="http://127.0.0.1:8765/wide.svg?w2"><img file="http://127.0.0.1:8765/tall.svg?t2"><img file="http://127.0.0.1:8765/wide.svg?w3"><img file="http://127.0.0.1:8765/tall.svg?t3"></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=106">己</a><img file="http://127.0.0.1:8765/img.gif?b=2"><img file="http://127.0.0.1:8765/img.gif?b=3"></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=107">庚</a><img file="data/attachment/h"><img file="data/attachment/h"></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=104">丁</a><img src="static/image/none.gif"></div>' +
    '</body></html>';
  // 纯布局场景专用：只含 105/106（不含需要回捞的帖子，避免回捞把分母从 8 追加到 12）
  const LAYOUT_LIST = '<html><body>' +
    '<div class="n5_htmk"><div class="zttpsl cl"><span class="zttpsz">22</span></div><a href="https://bhagq.4yl7j.com/viewthread.php?tid=105">戊</a><img file="http://127.0.0.1:8765/wide.svg"><img file="http://127.0.0.1:8765/tall.svg"><img file="http://127.0.0.1:8765/wide.svg?w2"><img file="http://127.0.0.1:8765/tall.svg?t2"><img file="http://127.0.0.1:8765/wide.svg?w3"><img file="http://127.0.0.1:8765/tall.svg?t3"></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=106">己</a><img file="http://127.0.0.1:8765/img.gif?b=2"><img file="http://127.0.0.1:8765/img.gif?b=3"></div>' +
    '</body></html>';
  const MOBILE_SAFEID = '<html><body><div>safeid 挑战页</div></body></html>';  const MOBILE_EMPTY = '<html><body>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=101">甲</a></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=102">乙</a></div>' +
    '<div class="n5_htmk"><a href="https://bhagq.4yl7j.com/viewthread.php?tid=103">丙</a></div>' +
    '</body></html>';
  const DETAIL_HTML = '<html><body><div class="pcb"><div class="t_f">' +
    '<img file="' + IMG + '"><img file="' + IMG + '?b=2">' +
    '</div></div></body></html>';

  const SC = {
    // ================= 色花堂 =================
    'sehua-list': {
      src: SRC_SEHUA, wait: 9000, pillId: 'sehua-progress', watchPill: true,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d, calls, pillLog }) => {
        const th101 = d.querySelector('#normalthread_101 th');
        const th102 = d.querySelector('#normalthread_102 th');
        const th103 = d.querySelector('#stickthread_103 th');
        ok('101 注入缩略图 1 张', th101.querySelectorAll('.sehua-thumb img').length === 1);
        ok('101 图址为 http 可加载', (th101.querySelector('.sehua-thumb img').getAttribute('src') || '').indexOf('127.0.0.1') !== -1);
        ok('102 走回捞注入 2 张', th102.querySelectorAll('.sehua-thumb img').length === 2);
        ok('103 含引号图址不破结构', th103.querySelectorAll('.sehua-thumb img').length === 1 && th103.querySelector('.sehua-thumb').children.length === 1);
        ok('103 引号图址被编码透传', (th103.querySelector('.sehua-thumb img').getAttribute('src') || '').indexOf('%22') !== -1);
        const th107 = d.querySelector('#normalthread_107 th');
        ok('107 坏图卡片（无扩展名 data/attachment/h）走详情页回捞并注入真图', !!th107 && th107.querySelectorAll('.sehua-thumb img').length === 2 && /img\.gif/.test(th107.querySelector('.sehua-thumb img').getAttribute('src') || ''));
                ok('帖子行 td 全部删除（单列化）', d.querySelectorAll('#threadlisttableid tbody[id^=normalthread_] td, #threadlisttableid tbody[id^=stickthread_] td').length === 0);
        const em = d.querySelector('#normalthread_101 .sehua-date em');
        ok('日期搬入标题下', !!em);
        ok('em 原类名保留', !!em && em.className === 'xg1');
        ok('外层 span 担纲样式', !!em && em.parentElement.className === 'sehua-date');
        ok('#autopbn 浮动翻页按钮随广告清除', !d.getElementById('autopbn'));
        ok('标准分页链接不受影响', !!d.querySelector('.pg a.nxt'));
        ok('广告文本已删', !d.querySelector('.show-text.cl'));
        ok('分类行已删', !d.getElementById('cats'));
        ok('保留 #separatorline（站点 forumchecknew 依赖，删了会报 parentNode 错误）', !!d.getElementById('separatorline'));
        ok('.show-text2 广告已删（它是赌博广告链，非"查看新帖"入口——那靠站点 AJAX 插入 #forumnewshow）', !d.querySelector('#threadlisttableid .show-text2'));
        ok('非帖子行的多列行已删（否则 table-layout:fixed 把标题压进 30px 图标列）', !d.querySelector('#threadlisttableid .thhead') && d.querySelectorAll('#separatorline tr').length === 0);
        ok('宽屏+缩略图样式在页', [...d.querySelectorAll('style')].some(s => s.textContent.indexOf('.sehua-thumb') !== -1 && s.textContent.indexOf('table-layout: fixed') !== -1));
        ok('GM 共 3 次（映射1 + 回捞2：102/107）', calls.length === 3);
        ok('映射 URL 带 mobile=2', /forum-95-1\.html\?mobile=2/.test(calls[0] || ''));
        ok('回捞 URL 指向 102', /tid=102/.test(calls[1] || ''));
        ok('101 显示图片总数角标 7', (() => { const n = d.querySelector('#normalthread_101 .sehua-num'); return !!n && n.textContent === '7'; })());
        ok('102（无总数）不显示角标', !d.querySelector('#normalthread_102 .sehua-num'));
        ok('缩略图按方向选框（方图/横图归 4:3 横框 cover）', (() => { const i = d.querySelector('#normalthread_101 .sehua-thumb img'); const a = i && i.closest('a'); return !!a && getComputedStyle(a).aspectRatio.replace(/\s/g, '') === '4/3' && getComputedStyle(i).objectFit === 'cover'; })());
        ok('101 img 保留 data-original 且与 src 同址', (() => { const i = d.querySelector('#normalthread_101 .sehua-thumb img'); return !!i && i.getAttribute('data-original') === i.getAttribute('src'); })());
        ok('101 img 带 lazy imagelist 类', (() => { const i = d.querySelector('#normalthread_101 .sehua-thumb img'); return !!i && /lazy/.test(i.className) && /imagelist/.test(i.className); })());
        ok('胶囊出现并计数', pillLog.some(p => /^缩略图：成功 \d+( · 等待 \d+)?( · 失败 \d+)? · 共 \d+$/.test(p.text)));
        // 四段守恒：成功+失败+等待 ≤ 共，且成功数只增不减（语义全程一致，无需区分中间态/终态）
        const parse = t => {
          if (!/^缩略图：成功 \d+/.test(t)) return null;
          const v = { ok: +( /成功 (\d+)/.exec(t)[1]), wait: 0, fail: 0, total: +( /· 共 (\d+)/.exec(t)[1]) };
          const w = /· 等待 (\d+)/.exec(t); if (w) v.wait = +w[1];
          const f = /· 失败 (\d+)/.exec(t); if (f) v.fail = +f[1];
          return v;
        };
        const arr = pillLog.map(p => parse(p.text)).filter(Boolean);
        const parsed = arr.map(a => [a.ok, a.wait, a.fail, a.total]);
        ok('成功+失败+等待 ≤ 共', parsed.every(a => a[0] + a[1] + a[2] <= a[3]));
        ok('成功数只增不减', arr.every((a, i) => i === 0 || a.ok >= arr[i - 1].ok));
        ok('共（分母）恒定', new Set(parsed.map(a => a[3])).size === 1);
        const done = pillLog.find(p => { const a = parse(p.text); return a && a.fail === 1 && a.total === 6; });
        ok('胶囊完成态 成功 5 · 失败 1 · 共 6（等待为 0 不显示）', !!done);
        ok('失败完成态为 partial 橙', pillLog.some(p => { const a = parse(p.text); return a && a.fail === 1 && a.total === 6 && /partial/.test(p.cls); }));
        ok('胶囊完成后淡出/移除', pillLog.some(p => p.op === '0') || !d.getElementById('sehua-progress'));
        // 终态（绿/橙）出现后不允许回退——分批派发时批间隙曾误判 settled>=total 导致一闪一闪
        const isFinal = p => /sehua-(done|partial)/.test(p.cls);
        const firstFinal = pillLog.findIndex(isFinal);
        ok('胶囊终态出现后不再回退（不闪绿/橙）', firstFinal === -1 || pillLog.slice(firstFinal).every(isFinal));
      }
    },
    'sehua-safeid': {
      src: SRC_SEHUA, wait: 2500,
      gm: [{ re: /forum-\d+-\d+\.html/, html: MOBILE_SAFEID }],
      assert: ({ ok, d, calls }) => {
        ok('被拦恰好重试 2 次', calls.length === 2);
        ok('两次都是映射请求', calls.every(u => /forum-95-1\.html/.test(u)));
        ok('被拦不注入任何缩略图', d.querySelectorAll('.sehua-thumb').length === 0);
        ok('被拦不出现胶囊', !d.getElementById('sehua-progress'));
      }
    },
    'sehua-empty': {
      src: SRC_SEHUA, wait: 9000,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_EMPTY },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d, calls }) => {
        ok('空页只请求 1 次映射（不当被拦重试）', calls.filter(u => /forum-95-1/.test(u)).length === 1);
        ok('GM 共 4 次（1映射+3回捞）', calls.length === 4);
        ok('101/102/103 都回捞到 2 张', [101, 102, 103].every(t => d.querySelector('#normalthread_' + t + ' th, #stickthread_' + t + ' th').querySelectorAll('.sehua-thumb img').length === 2));
      }
    },
    'sehua-late-success': {
      src: SRC_SEHUA, wait: 14500, pillId: 'sehua-progress', watchPill: true,
      assert: ({ ok, pillLog }) => {
        const last = pillLog[pillLog.length - 1];
        // 超时是"等待"不是"失败"：超时段不该出现"张失败"
        ok('超时段不计失败（只有明确 error 才算失败）', !pillLog.some(p => /失败 [1-9]/.test(p.text)));
        // 超时到迟到之间（图仍在加载）胶囊不能进入终态、更不能淡出
        const firstWaitingAt = pillLog.findIndex(p => /等待 [1-9]/.test(p.text));
        const firstFinalAt = pillLog.findIndex(p => /sehua-(done|partial)/.test(p.cls));
        ok('超时后胶囊显示"等待"（不淡出）', firstWaitingAt >= 0);
        ok('终态只在迟到结果落地后出现', firstFinalAt === -1 || (firstWaitingAt >= 0 && firstFinalAt > firstWaitingAt));
        ok('迟到成功补结算（最终全成功）', !!last && /^缩略图：成功 2 · 共 2$/.test(last.text));
      }
    },
    // P0-2 回归：同伴图迟到落地时不能清掉黑洞图的兜底计时器，否则 undecided 永久泄漏、胶囊永不淡出。
    // 用"一张 11.2s 迟到成功 + 一张永不回调的黑洞图"构造同伴场景
    'sehua-blackhole-peer': {
      src: SRC_SEHUA, wait: 36000, pillId: 'sehua-progress', watchPill: true,
      assert: ({ ok, d, pillLog }) => {
        const parse = t => {
          if (!/^缩略图：成功 \d+/.test(t)) return null;
          const v = { ok: +(/成功 (\d+)/.exec(t)[1]), wait: 0, fail: 0, total: +(/· 共 (\d+)/.exec(t)[1]) };
          const w = /· 等待 (\d+)/.exec(t); if (w) v.wait = +w[1];
          const f = /· 失败 (\d+)/.exec(t); if (f) v.fail = +f[1];
          return v;
        };
        const arr = pillLog.map(p => parse(p.text)).filter(Boolean);
        // 10s 两张都超时 → 等待 2；11.2s 迟到成功落地 → 等待 1、成功 1
        ok('两张图超时后胶囊显示等待 2', arr.some(a => a.wait === 2 && a.total === 2));
        ok('同伴迟到落地后仍有 1 张等待', arr.some(a => a.wait === 1 && a.ok === 1 && a.total === 2));
        // 关键：没有"超时两次判失败"的兜底——黑洞图跨过 30s 仍显示等待 1，失败数始终为 0
        const last = arr[arr.length - 1];
        ok('黑洞图不被兜底判死（30s 后仍等待 1、失败 0）', !!last && last.wait === 1 && last.fail === 0);
        ok('胶囊不淡出（挂着等用户刷新介入）', !!d.getElementById('sehua-progress'));
        // 账目自洽：迟到成功只 settled++，没有 sweep 制造的越界
        ok('账目自洽（成功+失败+等待 = 共）', !!last && last.ok + last.fail + last.wait === last.total);
      }
    },
    // P1-1 回归：迟到成功之后 src 又被改成坏址（站点 lazyload/其他脚本重复赋值），error 不应导致二次结算。
    // 时机选在胶囊淡出前（迟到成功后 2.5 秒内）——修复前会 render 出"成功 2 · 失败 1 · 共 2"这种加法不成立的文案
    'sehua-late-then-error': {
      src: SRC_SEHUA, wait: 12500, pillId: 'sehua-progress', watchPill: true,
      assert: async ({ ok, d, sleep }) => {
        const parse = t => {
          if (!/^缩略图：成功 \d+/.test(t)) return null;
          const v = { ok: +(/成功 (\d+)/.exec(t)[1]), wait: 0, fail: 0, total: +(/· 共 (\d+)/.exec(t)[1]) };
          const w = /· 等待 (\d+)/.exec(t); if (w) v.wait = +w[1];
          const f = /· 失败 (\d+)/.exec(t); if (f) v.fail = +f[1];
          return v;
        };
        const pill = () => document.getElementById('sehua-progress');
        // 12.5s：慢图（11.2s）已迟到成功，胶囊还在（淡出要在 13.7s）
        const before = pill() && pill().textContent;
        ok('迟到成功后胶囊为全成功', !!before && /^缩略图：成功 2 · 共 2$/.test(before));
        // 把慢图的 src 改成坏址：load 已完成，这次会触发 error
        const imgs = [...d.querySelectorAll('#postlist img')];
        const slow = imgs[imgs.length - 1];
        slow.src = 'http://127.0.0.1:8765/nonexistent-404.gif';
        await sleep(1200);
        const after = pill() && pill().textContent;
        // 守卫生效：文案不变。守卫失效时 settled 越界，会显示"成功 2 · 失败 1 · 共 2"（加法不成立）
        ok('迟到成功后再来 error 不重复结算', !!after && after === before);
        const v = parse(after || '');
        ok('账目自洽（成功+失败+等待 = 共）', !!v && v.ok + v.fail + v.wait === v.total);
      }
    },
    'sehua-detail': {
      src: SRC_SEHUA, wait: 4000, pillId: 'sehua-progress', watchPill: true,
      assert: ({ ok, d, pillLog }) => {
        const zoom = d.querySelector('#postlist img.zoom');
        const msg = d.querySelectorAll('#postlist .message img')[0];
        const icon = [...d.querySelectorAll('#postlist img')].find(i => (i.getAttribute('src') || '').indexOf('static/image') !== -1);
        const avatar = [...d.querySelectorAll('#postlist img')].find(i => (i.getAttribute('src') || '').indexOf('uc_server') !== -1);
        const empty = d.querySelectorAll('#postlist .message img')[1];
        ok('占位图换真址', (zoom.getAttribute('src') || '').indexOf('data:') === 0);
        ok('空 src 换真址', (msg.getAttribute('src') || '').indexOf('data:') === 0);
        ok('lazyloaded 标记', zoom.getAttribute('lazyloaded') === 'true' && msg.getAttribute('lazyloaded') === 'true');
        ok('站内图标不动', !!icon && icon.getAttribute('src').indexOf('static/image') !== -1);
        ok('头像不动', !!avatar && avatar.getAttribute('src').indexOf('uc_server') !== -1);
        ok('file 为空的 img 不动', empty.getAttribute('src') === 'none.gif');
        ok('无 .../null 假址', ![...d.querySelectorAll('#postlist img')].some(i => (i.getAttribute('src') || '').indexOf('/null') !== -1));
        ok('详情样式在页', [...d.querySelectorAll('style')].some(s => s.textContent.indexOf('#postlist') !== -1 && s.textContent.indexOf('loading.gif') !== -1));
        ok('胶囊完成 成功 2 · 共 2（无失败无等待时不显示）', pillLog.some(p => /^缩略图：成功 2 · 共 2$/.test(p.text)));
        ok('胶囊全成功为 done 绿', pillLog.some(p => /sehua-done/.test(p.cls)));
      }
    },
    'sehua-detail-preloaded': {
      src: SRC_SEHUA, wait: 4000, pillId: 'sehua-progress', watchPill: true,
      assert: ({ ok, d, pillLog }) => {
        const imgs = [...d.querySelectorAll('#postlist img.zoom')];
        ok('4 张内容图全部计入（2 占位 + 2 直出）', imgs.length === 4 && imgs.every(i => i.dataset.watched === '1'));
        ok('胶囊共 4（站点已直出的图也计数）', pillLog.some(p => /· 共 4/.test(p.text)));
        ok('直出图 src 未被脚本重设', imgs.slice(2).every(i => /\/img\.gif\?d[34]/.test(i.getAttribute('src') || '')));
      }
    },
    'sehua-search': {
      src: SRC_SEHUA, wait: 4000, pillId: 'sehua-progress', watchPill: true, clear: true,
      gm: [{ re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }],
      assert: async ({ ok, d, calls, pillLog, sleep }) => {
        ok('5 个过滤开关渲染', d.querySelectorAll('.sehua-forum-switch input').length === 5);
        ok('默认隐藏 201/203', d.getElementById('thread201').style.display === 'none' && d.getElementById('thread203').style.display === 'none');
        ok('202 可见', d.getElementById('thread202').style.display !== 'none');
        ok('只给可见结果取图（1 次）', calls.length === 1 && /tid=202/.test(calls[0]));
        ok('202 注入 2 张缩略图', d.getElementById('thread202').querySelectorAll('.sehua-thumb img').length === 2);
        ok('胶囊完成 成功 2 · 共 2（无失败无等待时不显示）', pillLog.some(p => /^缩略图：成功 2 · 共 2$/.test(p.text)));
        ok('初访不写存储（仅切换时写）', localStorage.getItem('sehuaFilterState') === null);
        ok('检索页宽屏单列样式在页', [...d.querySelectorAll('style')].some(s => s.textContent.indexOf('#threadlist li.pbw') !== -1));
        // 动态切换：取消勾选 201 -> 可见并补跑取图
        const cb201 = [...d.querySelectorAll('.sehua-forum-switch input')].find(i => i.dataset.forum === '求片问答悬赏区');
        cb201.checked = false;
        cb201.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1200);
        ok('取消勾选后 201 可见', d.getElementById('thread201').style.display !== 'none');
        ok('补跑一轮给 201 取图', calls.length === 2 && /tid=201/.test(calls[1]));
        ok('201 注入 2 张缩略图', d.getElementById('thread201').querySelectorAll('.sehua-thumb img').length === 2);
        let saved2 = null; try { saved2 = JSON.parse(localStorage.getItem('sehuaFilterState')); } catch (e) {}
        ok('切换后状态更新', !!saved2 && saved2['求片问答悬赏区'] === false);
      }
    },
    'sehua-filter': {
      src: SRC_SEHUA, wait: 2500,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_EMPTY },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, calls }) => {
        ok('筛选参数透传 typeid', /typeid=3/.test(calls[0] || ''));
        ok('筛选参数透传 orderby', /orderby=lastpost/.test(calls[0] || ''));
      }
    },
    'sehua-busy': {
      src: SRC_SEHUA, wait: 900,
      preset: () => sessionStorage.setItem('sehuaBusyRetry', '2'),
      assert: ({ ok, d }) => {
        const tip = [...d.querySelectorAll('div')].find(x => x.textContent.indexOf('秒后自动刷新') !== -1);
        ok('倒计时提示出现', !!tip);
        ok('计数接续为第 3/5 次', !!tip && /第 3\/5 次/.test(tip.textContent));
        ok('sessionStorage 计数 +1', sessionStorage.getItem('sehuaBusyRetry') === '3');
        ok('不进入检索页处理', d.querySelectorAll('.sehua-forum-switch').length === 0);
      }
    },
    'sehua-cooldown': {
      src: SRC_SEHUA, wait: 900,
      preset: () => sessionStorage.setItem('sehuaBusyRetry', '3'),
      assert: ({ ok, d }) => {
        ok('冷却页不刷新（无提示）', ![...d.querySelectorAll('div')].some(x => x.textContent.indexOf('秒后自动刷新') !== -1));
        ok('冷却页清零计数', sessionStorage.getItem('sehuaBusyRetry') === null);
      }
    },
    'sehua-crossclear': {
      src: SRC_SEHUA, wait: 1500,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_EMPTY },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      preset: () => sessionStorage.setItem('sehuaBusyRetry', '3'),
      assert: ({ ok }) => {
        ok('非搜索页也清零繁忙计数', sessionStorage.getItem('sehuaBusyRetry') === null);
      }
    },
    'sehua-double': {
      src: SRC_SEHUA, wait: 9000, injectTwice: true,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d, calls }) => {
        const total = d.querySelectorAll('.sehua-thumb img').length;
        ok('哨兵占位', d.documentElement.getAttribute('data-sehua') === '5.17');
        ok('双跑第二次被哨兵拦截', calls.length === 3);
        ok('GM 共 3 次（1 映射 + 2 回捞，无重复请求）', calls.length === 3 && calls.some(u => /tid=102/.test(u)) && calls.some(u => /tid=107/.test(u)));
        ok('双跑不重复注入（仍 6 张）', total === 6);
        ok('双跑 td 仍为 0', d.querySelectorAll('#threadlisttableid tbody[id^=normalthread_] td, #threadlisttableid tbody[id^=stickthread_] td').length === 0);
        ok('双跑日期不重复', d.querySelectorAll('.sehua-date').length === 4);
      }
    },
    't2048-late-src': {
      src: SRC_T2048, wait: 2500, pillId: 'thumb-progress', watchPill: true,
      assert: async ({ ok, d, sleep, pillLog }) => {
        const imgs = [...d.querySelectorAll('#postlist img')].slice(0, 5);
        ok('初始 5 张占位图换址', imgs.every(i => (i.getAttribute('src') || '').indexOf('127.0.0.1') !== -1));
        ok('胶囊完成 成功 5 · 共 5（无失败无等待时不显示）', pillLog.some(p => /^缩略图：成功 5 · 共 5$/.test(p.text)));
        // 模拟站点 jQuery lazyload 的滚动换入动作：设同值 src + removeAttr data-original
        imgs.forEach(i => { const s = i.getAttribute('src'); i.setAttribute('src', s); i.removeAttribute('data-original'); });
        await sleep(500);
        ok('同值 src 不触发重复 watch（watched 仍 5）', d.querySelectorAll('[data-watched]').length === 5);
        ok('src 保持真址不变', imgs.every(i => (i.getAttribute('src') || '').indexOf('127.0.0.1') !== -1));
        ok('站点移除 data-original 后无影响', imgs.every(i => !i.getAttribute('data-original')));
        ok('胶囊未因同值写入回到中间态', pillLog.every(p => !/已完成 [0-4]\/5/.test(p.text) || pillLog.indexOf(p) < 3));
      }
    },
    't2048-ajax': {
      src: SRC_T2048, wait: 2500,
      assert: async ({ ok, d, sleep }) => {
        // 初始：lazy 图 eager 化 + 占位图换址（thread.php 罐装页）
        const first = d.querySelectorAll('#threadlist img');
        const baseWatched = d.querySelectorAll('[data-watched]').length;
        ok('初始 lazy 改 eager', first[0].getAttribute('loading') === 'eager');
        ok('初始占位图换址', (first[1].getAttribute('src') || '').indexOf('127.0.0.1') !== -1);
        // 模拟站点 AJAX 插入新帖子行（含 data-original 占位图）
        const li = d.createElement('li');
        li.innerHTML = '<a href="/read.php?tid=9"><img src="thumb-ing.gif" data-original="http://127.0.0.1:8765/img.gif"></a>';
        d.getElementById('threadlist').appendChild(li);
        await sleep(500);
        const fresh = li.querySelector('img');
        ok('AJAX 新图被 childList 监听捕获并换址', (fresh.getAttribute('src') || '').indexOf('127.0.0.1') !== -1);
        ok('AJAX 新图改 eager', fresh.getAttribute('loading') === 'eager');
        ok('AJAX 新图计入胶囊', d.querySelectorAll('[data-watched]').length === baseWatched + 1);
      }
    },
    'sehua-home': {
      src: SRC_SEHUA, wait: 600, clear: true,
      assert: async ({ ok, d, sleep }) => {
        const sw = d.getElementById('sehua-queue-switch');
        ok('开关渲染在"新帖瀑布流"导航项右边', !!sw && sw.previousElementSibling && sw.previousElementSibling.id === 'mn_portal');
        const cb = sw && sw.querySelector('input');
        ok('默认勾选', !!cb && cb.checked);
        const label = sw.querySelector('label');
        ok('开关带"队列模式"文字', !!label && /队列模式/.test(label.textContent));
        ok('不使用会被站点 #nv span 规则隐藏的 span', !sw.querySelector('span'));
        ok('开关文字实际可见（渲染宽度>30px）', label.getBoundingClientRect().width > 30);
        ok('开关字体与导航项一致（白色/加粗/14px）', (() => { const s = getComputedStyle(label); return s.color === 'rgb(255, 255, 255)' && s.fontWeight === '700' && s.fontSize === '14px'; })());
        cb.click();
        await sleep(100);
        ok('取消勾选写 localStorage(0)', localStorage.getItem('sehuaQueueMode') === '0' && !cb.checked);
        cb.click();
        await sleep(100);
        ok('重新勾选写 localStorage(1)', localStorage.getItem('sehuaQueueMode') === '1' && cb.checked);
      }
    },
    'sehua-queue-off': {
      src: SRC_SEHUA, wait: 900, clear: true, preInsert: true,
      preset: () => localStorage.setItem('sehuaQueueMode', '0'),
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d }) => {
        const imgs = [...d.querySelectorAll('.sehua-thumb img')];
        ok('关闭队列：开关不勾', !d.getElementById('sehua-queue-switch').querySelector('input').checked);
        ok('关闭队列：所有图立即设 src（旧的一次性加载）', imgs.length >= 10 && imgs.every(i => i.getAttribute('src')));
      }
    },
    'sehua-no-nav': {
      src: SRC_SEHUA, wait: 1000, clear: true, preInsert: true, preRemoveNav: true,
      preset: () => localStorage.setItem('sehuaQueueMode', '0'),
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d }) => {
        ok('无导航项：开关不渲染', !d.getElementById('sehua-queue-switch'));
        ok('无导航项也同步 localStorage：关闭队列生效（所有图立即有 src）', (() => { const imgs = [...d.querySelectorAll('.sehua-thumb img')]; return imgs.length >= 10 && imgs.every(i => i.getAttribute('src')); })());
      }
    },
    'sehua-hang': {
      src: SRC_SEHUA, wait: 22000,
      gm: [{ re: /forum-\d+-\d+\.html/, hang: true }],
      assert: ({ ok, d, calls }) => {
        ok('映射请求永不回调：18 秒自建超时兜底后发起第 2 次重试（不卡死）', calls.filter(u => /forum-95-1/.test(u)).length >= 2);
        ok('挂起期间不注入缩略图、不出现胶囊', d.querySelectorAll('.sehua-thumb').length === 0 && !d.getElementById('sehua-progress'));
      }
    },
    'sehua-layout': {
      src: SRC_SEHUA, wait: 9000, preInsert: true, pillId: 'sehua-progress', watchPill: true,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: LAYOUT_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d, pillLog }) => {
        const w105 = d.querySelector('#normalthread_105 .sehua-thumb');
        const w106 = d.querySelector('#normalthread_106 .sehua-thumb');
        const imgs105 = [...w105.querySelectorAll('img')];
        const imgs106 = [...w106.querySelectorAll('img')];
        const wrapW = w105.getBoundingClientRect().width;
        const a105 = imgs105[0].closest('a');
        const aS = getComputedStyle(a105);
        ok('105 六张图每张约 1/5 宽（每行最多 5 张）', Math.abs(a105.getBoundingClientRect().width / wrapW - 1 / 5) < 0.04);
        ok('105 第六张换到第二行', imgs105.length === 6 && imgs105[5].getBoundingClientRect().top > imgs105[0].getBoundingClientRect().top + 5);
        ok('106 两张图各半行', Math.abs(imgs106[0].closest('a').getBoundingClientRect().width / w106.getBoundingClientRect().width - 0.5) < 0.06);
        // 按方向选框：横图/方图 4:3（cover 横向居中裁切），竖图 3:4（裁上下）
        const aLand = imgs105[0].closest('a');   // wide.svg 160x90
        const aPort = imgs105[1].closest('a');   // tall.svg 90x160
        ok('横图框 4:3（默认框，加载前后不跳）', getComputedStyle(aLand).aspectRatio.replace(/\s/g, '') === '4/3' && !aLand.classList.contains('sehua-port'));
        ok('横图 img 用 cover 填满框（裁左右）', getComputedStyle(imgs105[0]).objectFit === 'cover' && getComputedStyle(imgs105[0]).objectPosition.indexOf('50%') === 0);
        ok('竖图加载后切 3:4 竖框（裁上下）', getComputedStyle(aPort).aspectRatio.replace(/\s/g, '') === '3/4' && aPort.classList.contains('sehua-port'));
        ok('竖图 img 不拉伸（保持原比例）', getComputedStyle(imgs105[1]).objectFit !== 'cover');
        ok('img 保留 data-original', imgs105.every(i => /\.svg/.test(i.getAttribute('data-original') || '')));
        ok('img 带 lazyloaded 标记（防站点 lazyload 绕过池）', imgs105.every(i => i.getAttribute('lazyloaded') === 'true'));
        ok('img 保留 class="lazy imagelist"', imgs105.every(i => /lazy/.test(i.className) && /imagelist/.test(i.className)));
        ok('角标显示该帖总数 22', (() => { const n = w105.querySelector('.sehua-num'); return !!n && n.textContent === '22'; })());
        ok('106 无总数不显示角标', !w106.querySelector('.sehua-num'));
        // 分母恒定（结构建好时一次定型，不随池调度逐张涨）；终态出现后不回退
        const totals = [...new Set(pillLog.map(p => { const m = /· 共 (\d+)/.exec(p.text); return m ? m[1] : null; }).filter(Boolean))];
        ok('胶囊分母恒定（不追击）', totals.length === 1 && totals[0] === '8');
        const isFinal = p => /sehua-(done|partial)/.test(p.cls);
        const firstFinal = pillLog.findIndex(isFinal);
        ok('胶囊终态出现后不再回退（不闪绿）', firstFinal === -1 || pillLog.slice(firstFinal).every(isFinal));
      }
    },
    'sehua-throttle': {
      src: SRC_SEHUA, wait: 700, clear: true, preInsert: true,
      gm: [
        { re: /forum-\d+-\d+\.html/, html: MOBILE_LIST },
        { re: /mod=viewthread&tid=(\d+)/, html: DETAIL_HTML }
      ],
      assert: ({ ok, d }) => {
        const imgs = [...d.querySelectorAll('.sehua-thumb img')];
        const started = imgs.filter(i => i.getAttribute('src'));
        const notStarted = imgs.filter(i => !i.getAttribute('src'));
        ok('限速生效：700ms 时仍有图未设 src（令牌桶节奏）', imgs.length >= 10 && imgs.length - started.length > 0);
        ok('加载前默认框为 4:3 横框（横图不跳）', notStarted.length > 0 && notStarted.every(i => { const a = i.closest('a'); return a && getComputedStyle(a).aspectRatio.replace(/\s/g, '') === '4/3'; }));
        ok('首屏突发额度生效（至少 6 张已开始加载）', started.length >= 6);
      }
    },
    't2048-switch': {
      src: SRC_T2048, wait: 600, clear: true,
      assert: async ({ ok, d, sleep }) => {
        const sw = d.getElementById('t2048-queue-switch');
        ok('开关渲染在"搜索"导航项右边', !!sw && sw.previousElementSibling && /搜索/.test(sw.previousElementSibling.textContent));
        const cb = sw && sw.querySelector('input');
        ok('默认勾选', !!cb && cb.checked);
        ok('开关带"队列模式"文字且可见', !!sw && /队列模式/.test(sw.textContent) && sw.querySelector('label').getBoundingClientRect().width > 30);
        ok('开关字体与导航一致（白色/加粗/14px）', (() => { const s = getComputedStyle(sw.querySelector('label')); return s.color === 'rgb(255, 255, 255)' && s.fontWeight === '700' && s.fontSize === '14px'; })());
        cb.click();
        await sleep(100);
        ok('取消勾选写 localStorage(0)', localStorage.getItem('t2048QueueMode') === '0' && !cb.checked);
        cb.click();
        await sleep(100);
        ok('重新勾选写 localStorage(1)', localStorage.getItem('t2048QueueMode') === '1');
      }
    },
    't2048-queue-off': {
      src: SRC_T2048, wait: 900, clear: true,
      preset: () => localStorage.setItem('t2048QueueMode', '0'),
      assert: ({ ok, d }) => {
        const imgs = [...d.querySelectorAll('#threadlist img')].filter(i => !i.closest('picture'));
        const started = imgs.filter(i => /IMG|127\.0\.0\.1/.test(i.getAttribute('src') || ''));
        ok('关闭队列：开关不勾', !d.getElementById('t2048-queue-switch').querySelector('input').checked);
        ok('关闭队列：图片立即设 src（旧行为）', started.length >= 2);
      }
    },
    // ================= 2048 end =================
    't2048-batch-refresh': {
      src: SRC_T2048, wait: 14000, pillId: 'thumb-progress', watchPill: true,
      assert: async ({ ok, d, sleep }) => {
        // 14s 时：慢图 10s 超时记未决 → 13.2s 迟到落地 → 已进入终态并开始淡出计时
        const pill = d.getElementById('thumb-progress');
        ok('迟到落地后无陈旧失败', !pill || !/失败 [1-9]/.test(pill.textContent));
        // 再来一张新图：observer 捕获 → add() → 此时不得显示上一批的陈旧失败
        const li = d.createElement('div');
        li.innerHTML = '<img src="thumb-ing.gif" data-original="http://127.0.0.1:8765/img.gif?nb">';
        d.getElementById('postlist').appendChild(li);
        await sleep(1500);
        const pill2 = d.getElementById('thumb-progress');
        ok('新图触发重建的胶囊', !!pill2);
        ok('重建胶囊不显示陈旧失败（超时从未计为失败）', !!pill2 && !/失败 [1-9]/.test(pill2.textContent));
      }
    },
    't2048-late-success': {
      src: SRC_T2048, wait: 14500, pillId: 'thumb-progress', watchPill: true,
      assert: ({ ok, pillLog }) => {
        const last = pillLog[pillLog.length - 1];
        ok('迟到成功补结算（最终全成功）', !!last && /^缩略图：成功 2 · 共 2$/.test(last.text));
        ok('超时态确实出现过（证明场景有效）', pillLog.some(p => /等待 [1-9]/.test(p.text)));
      }
    },
    't2048-list': {
      src: SRC_T2048, wait: 3000, pillId: 'thumb-progress', watchPill: true, setterTest: true,
      assert: ({ ok, d, pillLog, srcLog }) => {
        ok('广告 4 类全清', !d.querySelector('.nav-container') && !d.querySelector('.recs-wrapper') && !d.querySelector('.movie-banner') && !d.querySelector('.reward-card'));
        ok('.r_two 隐藏样式在页', [...d.querySelectorAll('style')].some(s => s.textContent.indexOf('.r_two') !== -1));
        const imgs = d.querySelectorAll('#threadlist img');
        const lazy = imgs[0], ph = imgs[1], pic = imgs[2], dataImg = imgs[3];
        ok('原生 lazy 改 eager 且不动 src', lazy.getAttribute('loading') === 'eager' && (lazy.getAttribute('src') || '').indexOf('127.0.0.1') !== -1);
        ok('占位图换 data-original 真址', (ph.getAttribute('src') || '').indexOf('127.0.0.1') !== -1 && ph.getAttribute('loading') === 'eager');
        ok('picture 内图不碰', (pic.getAttribute('src') || '').indexOf('thumb-ing') !== -1);
        ok('data: 真址跳过不换址', (dataImg.getAttribute('src') || '').indexOf('thumb-ing') !== -1);
        ok('列表页锚点补 target=_blank', d.querySelector('#threadlist a').target === '_blank');
        ok('eager 先于 src 赋值', srcLog.every(e => e[0] === 'eager'));
        ok('胶囊完成 成功 2 · 共 2（无失败无等待时不显示）', pillLog.some(p => /^缩略图：成功 2 · 共 2$/.test(p.text)));
        ok('哨兵已占位', d.documentElement.getAttribute('data-t2048') === '5.4');
        const styleCount = [...d.querySelectorAll('style')].filter(s => s.textContent.indexOf('thumb-progress') !== -1).length;
        ok('双跑只注入一份样式', styleCount === 1);
      }
    },
    't2048-read': {
      src: SRC_T2048, wait: 3000, pillId: 'thumb-progress', watchPill: true, observerTest: true,
      assert: async ({ ok, d, pillLog, sleep }) => {
        // 先等胶囊淡出节点移除（它自身也是 DOM 变动，会连带触发一次 sweep），避开时序撞车
        await sleep(1600);
        const imgs = d.querySelectorAll('#postlist img');
        const placeholders = [...imgs].slice(0, 5);
        ok('5 张占位图全部换址', placeholders.every(i => (i.getAttribute('src') || '').indexOf('127.0.0.1') !== -1));
        ok('换址后均为 eager', placeholders.every(i => i.getAttribute('loading') === 'eager'));
        ok('站内图标不动', (imgs[5].getAttribute('src') || '').indexOf('icon.example.invalid') !== -1);
        ok('data: 图不动', (imgs[6].getAttribute('src') || '').indexOf('data:') === 0 && imgs[6].getAttribute('loading') !== 'eager');
        ok('胶囊完成 成功 5 · 共 5（无失败无等待时不显示）', pillLog.some(p => /^缩略图：成功 5 · 共 5$/.test(p.text)));
        // 观察者：新插入的图
        const li = d.createElement('li');
        li.innerHTML = '<img src="thumb-ing.gif" data-original="' + IMG + '">';
        d.getElementById('postlist').appendChild(li);
        await sleep(400);
        ok('观察者处理新插入图', (li.querySelector('img').getAttribute('src') || '').indexOf('127.0.0.1') !== -1);
        // 注：不测"站点把 src 改回占位"——真实站点不做（jQuery lazyload 只设同值 src），
        // 且其换入时会 removeAttr data-original，sweep 选择器此后匹配不到该图，
        // "src 自愈"在真实链路里本就不成立，详见审核结论
        // 新插入广告块（内含图）
        const ad = d.createElement('div');
        ad.className = 'recs-wrapper';
        ad.innerHTML = '<img src="thumb-ing.gif" data-original="' + IMG + '">';
        d.body.appendChild(ad);
        await sleep(400);
        ok('先清广告再扫图', !d.querySelector('.recs-wrapper') && !ad.isConnected);
      }
    }
  };

  const sc = SC[name];
  if (!sc) return ['FAIL | 未知场景 ' + name];
  if (sc.clear) { localStorage.clear(); sessionStorage.clear(); }
  if (sc.preset) sc.preset();
  // 注入前往表格追加两行帖子，让缩略图任务数超过一批（DISPATCH_BATCH=3），分批才可观测
  if (sc.preInsert) {
    const table = document.getElementById('threadlisttableid');
    [105, 106].forEach(t => {
      const tb = document.createElement('tbody');
      tb.id = 'normalthread_' + t;
      tb.innerHTML = '<tr><th><a href="#">帖子' + t + '</a></th><td class="by"><em class="xg1">2026-10-16</em></td><td>a</td><td>1</td></tr></tr>';
      table.appendChild(tb);
    });
  }
  // 注入前移除"新帖瀑布流"导航项：验证没有导航项的页面也同步 localStorage 开关状态
  if (sc.preRemoveNav) {
    const li = document.getElementById('mn_portal');
    if (li) li.remove();
  }
  const calls = [];
  if (sc.gm) {
    window.GM_xmlhttpRequest = o => {
      calls.push(o.url);
      let text = null;
      for (const h of sc.gm) {
        const m = o.url.match(h.re);
        if (m) {
          if (h.hang) return;   // 永不回调：模拟 TM 请求"连接后挂起"（onTimeout 失效）
          text = (typeof h.html === 'function' ? h.html(m) : h.html);
          break;
        }
      }
      setTimeout(() => { if (text === null) o.onerror(); else o.onload({ responseText: text }); }, 0);
    };
  }
  let srcLog = [];
  let restoreSrc = null;
  if (sc.setterTest) {
    const proto = HTMLImageElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    srcLog = [];
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { srcLog.push([this.getAttribute('loading'), v]); desc.set.call(this, v); }
    });
    restoreSrc = () => Object.defineProperty(proto, 'src', desc);
  }
  let injectError = null;
  const inject = () => { try { new Function(sc.src)(); } catch (e) { injectError = e; } };
  inject();
  if (sc.injectTwice) inject();
  ok('注入无异常', !injectError);
  if (injectError) R.push('FAIL | 注入异常: ' + injectError.message);
  const pillLog = [];
  const t0 = Date.now();
  while (Date.now() - t0 < sc.wait) {
    if (sc.watchPill && sc.pillId) {
      const el = document.getElementById(sc.pillId);
      if (el) pillLog.push({ t: Date.now() - t0, text: el.textContent, cls: el.className, op: el.style.opacity });
    }
    await sleep(60);
  }
  if (restoreSrc) restoreSrc();
  await sc.assert({ ok, d: document, calls, pillLog, srcLog, sleep });
  return R;
};

# Tampermonkey-enhance

针对图片/视频论坛的一小组 Tampermonkey 用户脚本。核心目标只有一个：**把"打开列表页就把整页图全下载"改成"只加载你真正会看到的那部分"**，顺带清掉广告与无用元素。

脚本只在本机浏览器里改页面行为——不发请求抓取、不上传任何数据、不修改站点内容。

---

## 脚本一览

| 脚本 | 目标站点 | 版本 | 一句话 |
|---|---|---|---|
| `2048缩略图.js` | `bbs.vsbskpo.com` | 2.8 | 视口窗口按需加载缩略图（图片地址本来就在页面里） |
| `色花堂缩略图.js` | `bhagq.4yl7j.com` | 2.6 | 抓移动版模板的缩略图注入 PC 列表页（PC 页本来没有图） |
| `探花缩略图.js` | `sdy.685886.xyz` | 2.0 | 列表页居中显示详情页预览大图（单张）+ 列表/详情页去广告 |
| `sis001缩略图.js` | `www.sis001.com` | 1.2 | 列表页从详情页抓缩略图 |

> `sis001缩略图.js` 尚未做逐行审查与实测。

## 安装

1. 浏览器安装 Tampermonkey；
2. 两种方式二选一：把 `.js` 文件**直接拖到 TM 面板**里；或 TM 面板 → 添加新脚本 → 清空编辑器 → 粘贴脚本全文 → `Ctrl+S`；
3. 打开对应站点，脚本自动生效（多为 `@run-at document-start`，`探花缩略图` 为 `document-idle`，刷新页面即可）。

改完脚本后注意：**TM 里存的副本与仓库里的文件是两份东西**，改完仓库文件要重新导入 TM 才会生效。

---

## 2048缩略图.js

### 原理

- **加载窗口** = 视口上方 `TOP_MARGIN` + 视口 + 下方 `LOOKAHEAD`。窗口内的图立刻加载（确实落在视口里的还会标 `fetchpriority=high`，优先占用图床带宽）；窗口外的只挂 `IntersectionObserver`，滚到窗口边缘才激活。优先级只升不降。
- **兜底放行**：DOM 就绪 `RELEASE_ALL_MS` 后，把仍未激活的图一次性放行；仅页面可见时执行，隐藏标签页不放行、转可见后补排一次。
- 图床域名 `preconnect`；删除站内广告块、CSS 隐藏侧栏；缩略图统一 `referrerPolicy="no-referrer"`（**本站图床只认"无 Referer"**）；失败自动重试（穿透缓存，上限 2 次），仍失败压暗、点一下再试；节点复用换图时自动重置调度状态。
- `@grant none`：直接跑在页面上下文，无 GM API、无日志输出。

### 可调参数（文件顶部）

| 参数 | 默认 | 说明 |
|---|---|---|
| `TOP_MARGIN` | 400 | 视口上方这么多像素内也立即加载（向上回滚不留空位） |
| `LOOKAHEAD` | 1200 | 视口下方提前加载的距离；调大=滚动更顺、流量更多 |
| `RELEASE_ALL_MS` | 10000 | 兜底放行延时；**设 0 可关闭**，恢复纯窗口按需加载 |
| `FALLBACK_INTERVAL` / `FALLBACK_IDLE_STOP` | 3000 / 20 | 兜底轮询周期与空闲自停（20×3s=60s） |
| `MAX_IMG_RETRY` | 2 | 单图失败自动重试上限 |
| `AD_SELECTORS` / `REMOVE_ELEMENTS` | 站内广告类名 | 命中即删除 |

### 这个站点的约束（改代码前先看）

- **图片在列表页是「原生 `loading=lazy` + 真实地址已写在 `src`」，检索页则是 `data-src`**。所以"取真实地址"必须两者都看（曾因只读 `src` 导致检索页整页漏掉 preconnect）。
- 图床**域名不固定**，单页常见 2~5 个；不要假设只有一两个域名。
- 该站搜索有 **180 秒/次冷却**（普通会员），且访问 `search.php?sch_time=newatc` 也计一次搜索；超限跳"对不起180秒内只能进行一次搜索"。
- 与本系列另一个站点共用同一类 WAF（`safeid` 挑战页）。高频访问后所有页面都可能先返回挑战页（约 1.1KB、无图），此时脚本空转无害，等挑战通过即可。

### 实测（v2.8）

- 列表页：`img 60 / 接管 53 / 激活 21 / 观察 32 / 跳过 7`；10 秒后全部激活（53/53）。
- 关键字检索结果页：`img 71（64 张 data-src）/ 激活 9 / 观察 56`，`preconnect 4 条`。

---

## 色花堂缩略图.js

### 原理

PC 列表页本身**没有缩略图**，脚本改成"从移动版模板取图，注入 PC 页"：

- 用 `GM_xmlhttpRequest` 带 **Android 移动 UA** 请求 `forum-{fid}-{page}.html?mobile=2`，服务端按 UA 返回触屏模板，解析 `.n5_htmk` 卡片得到 `tid → 该帖缩略图` 映射；
- 按真实几何（`getBoundingClientRect().top`）判定首屏，逐行注入缩略图；同时把行单列化、把发帖日期搬进标题下方、清掉表格内的广告行；
- 首屏图立即加载并标 high，其余交给原生 `loading=lazy`，另有 `LAZY_SAFETY_MS` 兜底放行；
- 搜索页：按栏目过滤结果 + 只对**可见**结果取详情图（并发 5），筛选变化时自动补跑；
- 详情页：宽屏 + 去广告 + 图片可见；搜索繁忙自动刷新（有次数上限）。

### 可调参数（文件顶部）

| 参数 | 默认 | 说明 |
|---|---|---|
| `MOBILE_UA` | Android Chrome | 服务端分发触屏模板的**唯一开关**，别乱改 |
| `FOLD_SLACK_PX` | 120 | 首屏下方余量（实测行高 409px，一屏 1.7 行） |
| `LAZY_SAFETY_MS` | 10000 | 兜底放行延时；**设 0 可关闭** |
| `MAX_THUMBS_PER_POST` | 5 | 每帖最多几张；**调到 5 以上必须同步补 `THUMB_CSS` 的 `n6~nN` 规则** |
| `MAX_CONCURRENT` | 5 | 详情页取图并发 |
| `MAX_DETAIL_IMGS` / `MAX_BUSY_RETRY` | 5 / 5 | 详情页单帖取图上限 / 搜索繁忙重试上限 |
| `MOBILE_RETRY_TIMES` / `_DELAY` | 2 / 1500ms | 移动版请求重试 |
| `DETAIL_RETRY_TIMES` / `_BASE_MS` | 3 / 2000ms | 详情页被拦后的退避重试（2s/4s/6s） |
| `PAGE_CACHE_TTL` / `_MAX` | 5 分钟 / 10 条 | 移动版映射的会话级缓存 |
| `DEBUG` | false | 叙事型日志开关，**排查时改成 true** |

### 这个站点的约束（改代码前先看）

1. **必须用 GM 请求 + 移动 UA**。浏览器端伪装 UA 打开会被触屏模板自带的 `common.js` 用 `"ontouchend" in document` 判定后踢回 `forum.php?mobile=1`（实测复现）；GM 请求不执行 JS，所以只有 XHR 路径能稳定拿到触屏模板。
2. **反爬依赖会话 Cookie `_safe`**。显式写的 `Cookie: mobile=2` 会被 TM「合并」到浏览器 Cookie 之后，不要改成覆盖写法。首访/浏览器重启后 `_safe` 尚未建立，`document-start` 的抢跑请求必然拿到门页并被判为"被 safe 挑战页挡下"——属预期。
3. **图床强制校验 Referer**：缩略图 `<img>` **绝不能**加 `referrerPolicy="no-referrer"`（会 403）。
4. **图床没有缩略图变体**（缩放参数全被忽略），省流量只能靠"少请求 / 按需请求"；图片有 30 天缓存。
5. 站点有 18+ 年龄门，且域名会轮换（脚本内 URL 一律用 `location.hostname` 拼）。

### 实测（v2.6）

- 列表页 11 页逐页一致：`30 帖 / 62 图 / 立即加载 4 张 / 懒加载 58 张`，行高恒 409px，日期搬移 30/30，表格内广告行整块清除（tbody 32→30）。
- 10 秒兜底：前台不滚动停留 10 秒会放行剩余 56~58 张（≈7MB）；反之 3.2 秒时只请求 7~10 张。
- 会话级映射缓存命中时，第二次加载 **0 次移动版请求**仍能出全部缩略图。
- 搜索页：30 条结果→过滤隐藏 21 条→只对 9 条可见结果取图（并发 5 生效）；取消勾选后自动补跑 8 条。

---

## 探花缩略图.js

### 原理

站点 2026-10 改版，**列表页与详情页都变成了 JS 渲染**：服务端只回一个壳 + `window.__data__` 内联 JSON，内容由 `/js/*.js` 在浏览器端生成。所以"抓静态 HTML 解析 DOM"的老办法全部失效（老版脚本的 `.img_item` 选择器与 base64 解码逻辑已死）。

- **列表页**：`document-idle` 后站点 JS 才渲染，所以轮询等 `UL.list` 出现再逐条处理；分页是整页刷新，不用 history 钩子。
- **详情页**：用 `GM_xmlhttpRequest` 取壳（约 3.5KB）——它**不执行页面 JS**，拿不到 DOM——直接正则从内联 JSON 里取 `domain_image` / `picture_dir` / `resolution`。
- **预览图**：`https://{domain_image}/capture/{picture_dir}/t4.jpg`，只取这一张（站点桌面分支）。
- **居中显示**：外层 `text-align: center` + `img{margin:0 auto}`；横版按原始尺寸撑满，竖版封顶 `portraitMaxHeight`。
- **去广告**：列表页与详情页都删 `#hf-container` / `#dp-container` / `#icon-wrapper`，外加页脚的 SEO 链接农场。**绝不删 `#content`**——它就是列表/正文容器，删了等于删内容。详情页内容是异步渲染的，所以挂 `MutationObserver`（只监听 `childList`）持续清，**不设停机时间**：观察器随页面销毁自动回收，翻上/下一篇本来就是整页刷新，这样连"渲染完才注入的广告"也能清掉（已用延迟注入的广告实测验证）。
- **详情页只去广告、不动布局**：列表页那套 `.row{max-width:100%}` 加宽**不在详情页执行**，实测详情页 `#page/#content/article` 宽度与改前完全一致（1172/1000/1000）。
- **承重样式别乱删**：站点原生 `.row` 是 `max-width:1000px`、`.videos-list` 是 `overflow:hidden`，这两条覆盖去掉后预览图会被压回 1000px 并被裁掉。反过来 `.container` 在新版站点出现 0 次，是纯死选择器，已删。

### ⚠️ 这个站最容易踩的两个坑

1. **`DIV#content` 就是列表容器，绝对不能删。** 老版本脚本里的 `document.getElementById('content').remove()` 本意是删广告位，改版后 `#content` 变成了列表本身 → 一删整页列表消失（本脚本历史 bug 的最大来源）。真正的广告位只有 `#hf-container` / `#dp-container`。
2. **类名避开 `.preview-loading` / `.capture-col`**：站点自己的预览组件在用，撞名会互相干扰。本脚本统一 `tht-` 前缀。

### 可调参数（文件顶部）

| 参数 | 默认 | 说明 |
|---|---|---|
| `imageName` | `t4.jpg` | 只取站点桌面分支那一张；想换/加图改这里 |
| `portraitMaxHeight` | 640 | **竖版**图高度上限（px）；横版不受限，**设 0 = 竖版也不限** |
| `showResolutionBadge` | true | 标题后显示 `1280x720` 徽章 |
| `adSelectors` | `#hf-container` / `#dp-container` / `#icon-wrapper` | 列表页与详情页都要删的广告块；想留哪个从这里删一行 |
| `removeFooterFarm` | true | 删页脚的 SEO 链接农场（25 条站外垃圾外链）；**false = 保留页脚** |
| `maxConcurrent` / `requestTimeout` | 6 / 15000ms | 详情页并发与超时 |
| `listPollInterval` / `listMaxWait` | 300ms / 15000ms | 等站点渲染出列表的轮询间隔与总时长 |

### 这个站点的约束（改代码前先看）

1. **详情页 `<picture>` 里有两条分支**：`<source media="(max-width:767.98px)" srcset="...t2.jpg">`（移动）+ `<img src="...t4.jpg">`（桌面）。站点同时只显示一条，所以"详情页只有一张图"——但同目录下确实还存在 `t2.jpg` / `cover.jpg`（且 `cover.jpg` 并非每部都有）。本脚本只用桌面的 `t4.jpg`。
2. **`t4.jpg` 横竖都有**（横 1200x694 居多；竖见 1200x2086 / 1000x1742 等），必须按 `naturalWidth/naturalHeight` 判方向，否则竖版满宽会撑到近 2000px 高。
3. **列表项结构**：`UL.list > LI > span.list_item > a[href*="movie.php"]`；标题里塞了大量隐藏 `<span>` 反爬字符（取标题文本时要小心）。
4. **`@match` 只写了两个域名**，站点"永久回家地址"在轮换（`thbt5/7/8/9.com` 等），换域名后需自己补一条。
5. **详情页正文里这些是真内容，不能当广告删**：`#primary > main > article > .entry-content` 下的 `.video-infos`（标题）、`.video-description`（发布时间 / 格式 / 大小 / 时长 / 分辨率 / Hash）、`.preview-grid > .capture-col`（站点自己的预览图）、`P#magnet-link` 与下载/复制磁力按钮、`.pagination-nav`（上一篇/下一篇）。**真正的广告只有 `#hf-container` / `#dp-container` / `#icon-wrapper`**（`#icon-wrapper > .partner-zone` 是正文里那面"合作伙伴"广告图墙）。
6. **两个页面顶层结构相同**：`#page > .header.row / .clear / .row / #content`，而 `#content` 下是 `#hf-container` → `#primary` → `#dp-container` → `#colophon`。所以同一套 `removeAds()` 列表页和详情页都能用（这也是 `#content` 绝对不能删的另一重原因：它在两个页面里都装着正文/列表）。

### 实测（v2.3）

**列表页**（`tdc.259298.com/list.php?classid=1`）

- 每项 `1 张预览 + 1 个徽章`，`失败 0`；全部 `src` 都是 `t4.jpg`；横竖都有，全部居中（左右留白恒等）。
- 预览图铺满整行：实测 `li 1137 - padding 20 = 1117`，`.tht-preview` 盒宽就是 1117。
- 横版按原始尺寸渲染（1200x694，容器不够宽时等比例缩到 `max-width`）；竖版封顶 640px 且居中（1200x2086 → 368x640）。
- 历史教训（v2.0 → v2.1）：给**所有**图设 `max-height` 会多余地缩小横版，所以改成只对竖版限高。

**详情页**（`/movie.php?...`）

- 广告改前 4 处全在（`#hf-container` / `#dp-container` / `#icon-wrapper` / 页脚 25 条外链），改后全 ❌。
- 正文 H1 / 8 条元数据 / `.capture-col` 预览图 / 磁力链 / 上下一篇 **全部保留**。
- **延迟注入的广告也会被清掉**：脚本跑完后手工往 `#content` 塞 `#dp-container` 与 `#icon-wrapper`，300ms 内即被观察器移除。
- 布局零改动：`#page 1172 / #content 1000 / article 1000`，改前改后完全一致（详情页不跑加宽样式，也不注入任何 `<style>`）。
- 无悬浮（`position: fixed`）广告；页脚之外没有其他站外链接聚集块。

### 清理记录（v2.3：逐项实测过再删）

**已删**

| 项 | 依据 |
|---|---|
| CSS 里的 `.container` | 新版站点两个页面都 **0 次命中**，纯死选择器 |
| `findListItems` 的 `'.list li'` | 与 `'ul.list > li'` 命中**完全相同的 50 条**；且 `.list` 是通用类名，容易误伤站点其它块 |
| `appendNotice` 里重复的 `'#999'` | 与 `.tht-empty` 的 CSS 默认色重复，改成"只在需要覆盖时才传色" |
| `CONFIG.detailObserveMs` | 观察器改为随页面销毁自然回收，不需要定时停机 |
| `getGMRequest()` 每轮都调用 | 提到 `while` 外，可用性不会中途变化 |
| 旧版残留类名 | 全文件 grep `tht-item` / `tht-container` / `preview-container` / `fullyDecode` / `maxImages` 等 → 只剩注释与合法定义，**无死引用** |

**查过但刻意保留**（是承重/保险，不是残留）

| 项 | 理由 |
|---|---|
| `.row { max-width:100% }` | 站点原生 1000px；去掉后预览图被压回 1000px |
| `.videos-list { overflow:visible }` | 站点原生 `hidden`；去掉后放大的图被裁 |
| `#site-navigation ul { max-width:100% }` | 站点原生 1350px；内容加宽后导航跟着加宽才对齐 |
| `.tht-preview > a { line-height:0 }` | 一行防御，防止将来 img 变回 inline 时出基线缝隙 |
| `findListItems` 的 `'.videos-list ul li'` | 锚点与 `ul.list` 不同，是 ul 类名被换时的保险 |
| `@connect *` | 不锁死域名，避免补 `@match` 时还要同步补 `@connect` |

---

## 两个脚本共通的注意事项

- **"10 秒兜底放行"是有意保留的取舍**：开着页面慢慢看时不必等图，代价是停留超过该时长就整页下载。想要纯窗口按需加载，把 `RELEASE_ALL_MS`（2048）/ `LAZY_SAFETY_MS`（色花堂）设为 `0`。
- **`@match` 只写了单个域名**，站点换域名后脚本会**静默失效**（这些站点换域名很频繁）。脚本内部已经用 `location.hostname` 动态拼 URL，补一条 `@match` 即可复用（色花堂还要补 `@connect`）。
- 两个站点共用同一类 `safeid` WAF：挑战页上脚本空转、无害；色花堂那份有 `isSafePage()` 检测，2048 那份 `@grant none` 无从绕过。
- 排查脚本行为时优先看 `色花堂` 的 `DEBUG = true` 日志；2048 那份不打日志，只能靠 DOM 状态（`_activated` / `_observed` / `_forceLoaded` 等标记）判断。

## 审查与验收记录

| 报告 | 内容 |
|---|---|
| `色花堂缩略图-审查报告-2026-09-14.md` | 问题按 P0/P1/P2 排序 + 修复状态 + 验收实测 |
| `2048缩略图-审查报告-2026-09-14.md` | 同上（含两处"归因误判"的修正说明） |

已修复并在真实浏览器里实测通过：**2048 v2.8**（preconnect 覆盖 `data-src`、非帖子行显式移除、失败重试上限、https 页面跳过 http 源等）、**色花堂 v2.6**（图床域名预连接提前、映射会话缓存、类名冲突、URL 归一化、非帖子行移除等）。

未改动/未定的项：

- 两个脚本的"10 秒全量放行"按需求保留；
- 色花堂的 `watchAutoLoad`（约 100 行）在两次实验里都没被触发，疑似死代码，暂留待人工判定；
- 2048 的 `FALLBACK_INTERVAL` 轮询 60 秒后自停；
- `探花缩略图.js` v2.3 已按 2026-10 改版重构、去广告、并做过一轮冗余/残留清理；`sis001缩略图.js` 尚未审查。

## 文件清单

```
2048缩略图.js / 2048缩略图.js.bak-20260914-2245      # 脚本与修复前备份
色花堂缩略图.js / 色花堂缩略图.js.bak-20260914-2220
探花缩略图.js                                        # v2.3，2026-10 站点改版适配（单张居中大图 + 列表/详情页去广告）
sis001缩略图.js                                      # 同系列，未审查
2048缩略图-审查报告-2026-09-14.md
色花堂缩略图-审查报告-2026-09-14.md
实测截图-*.png                                       # 列表页/搜索页实测截图
```

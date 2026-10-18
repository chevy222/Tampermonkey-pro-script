# 测试

隔离测试：罐装页面 + 假图床，验证两个脚本的 DOM 注入、布局、计数与节流逻辑。
**不碰真实站点**，全部在本地 8765 端口跑。

## 跑起来

```bash
python test/server.py
```

服务器会实时读取仓库根目录的 `色花堂.js` / `2048.js`（改脚本后刷新页面即可，不用重启）。

## 页面

| 路径 | 对应真实页面 |
|---|---|
| `/forum-95-1.html` | 色花堂列表页（SEO 静态 URL） |
| `/forum.php` | 色花堂首页 |
| `/thread-101-1-1.html` | 色花堂详情页（占位图） |
| `/thread-102-1-1.html` | 色花堂详情页（站点已直出真址） |
| `/thread-104-1-1.html` | 色花堂详情页（1 快 + 1 张 11.2 秒慢图） |
| `/thread-106-1-1.html` | 色花堂详情页（1 张 11.2 秒慢图 + 1 张永不回调的黑洞图） || `/thread.php?fid=15&search=img&page=1` | 2048 列表页 |
| `/read.php?tid=1` | 2048 详情页（占位图） |
| `/read-slow.php` | 2048 详情页（1 快 + 1 张 11.2 秒慢图） |
| `/read-slow2.php` | 2048 详情页（1 快 + 1 张 13.2 秒慢图） |

假图床路由：`/img.gif`、`/slow.gif`（0.4s）、`/slow11.gif`（11.2s）、`/slow13.gif`（13.2s）、
`/never.gif`（挂 60 秒，模拟连接后永不回调的黑洞图）、`/wide.svg`、`/tall.svg`。

## 跑断言

用任意能执行页面 JS 的浏览器自动化工具打开页面，注入 harness 后调用场景：

```js
(async () => {
  await fetch('/harness.js').then(r => r.text()).then(t => eval(t));
  return await window.runTest('场景名');
})()
```

`harness.js` 会自动 fetch 并 eval 仓库里的真实脚本源码，所以断言跑的是当前代码，不是副本。

## 场景

**色花堂**：`sehua-list`、`sehua-layout`、`sehua-detail`、`sehua-detail-preloaded`、
`sehua-double`、`sehua-throttle`、`sehua-home`、`sehua-late-success`、`sehua-blackhole-peer`、
`sehua-late-then-error`

**2048**：`t2048-list`、`t2048-switch`、`t2048-read`、`t2048-late-src`、`t2048-ajax`、
`t2048-queue-off`、`t2048-late-success`、`t2048-batch-refresh`

慢图场景（`*-late-success` / `late-then-error` / `batch-refresh` / `blackhole-peer`）需要等 13-36 秒，不是卡住了。
`sehua-blackhole-peer` 最慢：要确认黑洞图跨过 30 秒仍不被判死、胶囊一直挂着。

## 维护提示

- 改 `pill` 的字段结构后，记得 grep 所有断言里的使用点——数组下标和对象属性写法不通用
- 新增断言优先解析胶囊文案的四个数字（成功/等待/失败/共），而不是匹配整串文案
- `server.py` 的 `REPO` 由脚本位置推导，整个仓库可以随意挪位置
- **新场景必须先在修复前 FAIL 过，才算真的抓住了 bug**：`git stash push 色花堂.js 2048.js` 回到旧代码跑一遍，确认断言会红
- **harness 取脚本源码带时间戳参数**（`/sehua.js?t=`）：浏览器有启发式缓存，不加会让"回滚验证"拿到缓存里的新代码，结论全假
- **断言时机要考虑胶囊的 2.5 秒淡出**：等太久节点会被移除，只能验证"不复活"而验证不了账目；要验证数字就得在淡出前动手
- 改 `server.py` 后必须重启 server，否则新路由 404，页面标题会变成 "Error response"、哨兵为 null、断言全 FAIL——遇到全 FAIL 先查页面是否真的加载了
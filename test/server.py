# -*- coding: utf-8 -*-
"""色花堂/2048 隔离测试服务器：罐装页面 + 实时提供仓库脚本源码。仅监听 127.0.0.1。

用法：python test/server.py   然后在浏览器里打开 http://127.0.0.1:8765/forum-95-1.html
"""
import http.server, socketserver, urllib.parse, os, base64

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)      # 仓库根（脚本所在目录的上一级）
PORT = 8765
IMG_URL = 'http://127.0.0.1:%d/img.gif' % PORT
IMG_BYTES = base64.b64decode('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')

LIST_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>list</title>
<style>#nv span { display: none; }</style></head><body>
<div id="hd"><div id="nv_ph"><div class="wp"><div id="nv"><ul><li id="mn_forum"><a href="#" hidefocus="true">论坛BBS</a></li><li id="mn_portal"><a href="portal.php" hidefocus="true" title="Portal">新帖瀑布流<span>Portal</span></a></li></ul></div></div></div></div>
<div class="wp"><div id="ct">
<div class="show-text cl">广告文本</div>
<table id="threadlisttableid">
<tbody id="cats"><tr><th>分类过滤行</th></tr></tbody>
<tbody id="normalthread_101"><tr><th><a href="#">帖子甲标题</a></th><td class="by"><em class="xg1">2026-10-15 12:00</em></td><td>author</td><td>3</td></tr></tbody>
<tbody id="normalthread_102"><tr><th><a href="#">帖子乙标题</a></th><td class="by"><em class="xg1">2026-10-14 12:00</em></td><td>author</td><td>5</td></tr></tbody>
<tbody id="stickthread_103"><tr><th><a href="#">置顶帖标题</a></th><td class="by"><em class="xg1">2026-10-13 12:00</em></td><td>author</td><td>9</td></tr></tbody>
<tbody id="normalthread_107"><tr><th><a href="#">技术交流帖（坏图卡片→回捞）</a></th><td class="by"><em class="xg1">2026-10-17 10:00</em></td><td>author</td><td>2</td></tr></tbody>
<tbody id="separatorline"><tr class="ts"><td>&nbsp;</td><th>&nbsp;</th><td>&nbsp;</td></tr><tr class="thhead"><td></td><th>版块</th><td>作者</td><td>回复</td><td>最后发表</td></tr></tbody>
<tbody><tr><td colspan="3"><div class="show-text2"><a href="forum.php?mod=guide&amp;view=new">点击查看今日新帖</a></div></td></tr></tbody>
</table>
<div class="pg"><a href="forum-95-2.html" class="nxt">下一页 &raquo;</a></div>
<a class="bm_h" href="javascript:;" rel="forum.php?mod=forumdisplay&amp;fid=95&amp;page=2" curpage="1" id="autopbn" onclick="return false;" totalpage="2000">下一页 &raquo;</a>
</div></div></body></html>"""

HOME_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>home</title>
<style>#nv span { display: none; }</style></head><body>
<div id="hd"><div id="nv_ph"><div class="wp"><div id="nv"><ul><li id="mn_forum"><a href="#" hidefocus="true">论坛BBS</a></li><li id="mn_portal"><a href="portal.php" hidefocus="true" title="Portal">新帖瀑布流<span>Portal</span></a></li></ul></div></div></div></div>
<div class="wp"><div id="ct"><div id="diy_chart"><div class="slideshow"><ul><li><img src="https://tu.example.invalid/banner.jpg"></li></ul></div></div><div class="slidebar">推荐版块</div></div></div>
</body></html>"""

DETAIL_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>thread</title></head><body>
<div class="wp"><div id="ct"><div id="postlist">
<div class="pls"><div class="favatar"><img src="uc_server/avatar.php?uid=1"></div></div>
<div class="pcb">
<div class="t_f"><ignore_js_op><img class="zoom" file="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" src="thumb-ing.gif"></ignore_js_op></div>
<div class="message"><img file="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" src=""></div>
<div class="message"><img file="" src="none.gif"></div>
<div><img src="static/image/icon.png"></div>
<div style="width:100%;background:url(loading.gif) no-repeat center;">loading</div>
</div></div></div></div></body></html>"""

LATE_SUCCESS_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>thread</title></head><body>
<div class="wp"><div id="ct"><div id="postlist">
<div class="pcb"><div class="t_f">
<ignore_js_op><img class="zoom" file="__IMG__?fast" src="thumb-ing.gif"></ignore_js_op>
<ignore_js_op><img class="zoom" file="__SLOW__" src="thumb-ing.gif"></ignore_js_op>
</div></div></div></div></body></html>""".replace('__IMG__', IMG_URL).replace('__SLOW__', IMG_URL.replace('/img.gif', '/slow11.gif'))

READ_SLOW2_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>read</title></head><body>
<div id="postlist">
<img src="thumb-ing.gif" data-original="__IMG__?fastb">
<img src="thumb-ing.gif" data-original="__SLOW13__">
</div>
</body></html>""".replace('__IMG__', IMG_URL).replace('__SLOW13__', IMG_URL.replace('/img.gif', '/slow13.gif'))

READ_SLOW_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>read</title></head><body>
<div id="postlist">
<img src="thumb-ing.gif" data-original="__IMG__?fast">
<img src="thumb-ing.gif" data-original="__SLOW__">
</div>
</body></html>""".replace('__IMG__', IMG_URL).replace('__SLOW__', IMG_URL.replace('/img.gif', '/slow11.gif'))

DETAIL_PRELOADED_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>thread</title></head><body><div class="wp"><div id="ct"><div id="postlist">
<div class="pcb"><div class="t_f">
<ignore_js_op><img class="zoom" file="__IMG__?d1" src="thumb-ing.gif"></ignore_js_op>
<ignore_js_op><img class="zoom" file="__IMG__?d2" src=""></ignore_js_op>
<ignore_js_op><img class="zoom" file="__IMG__?d3" src="__IMG__?d3"></ignore_js_op>
<ignore_js_op><img class="zoom" file="__IMG__?d4" src="__IMG__?d4"></ignore_js_op>
</div>
<div><img src="static/image/icon.png"></div>
</div></div></div></body></html>""".replace('__IMG__', IMG_URL)

SEARCH_RESULT_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>search</title></head><body><div class="wp"><div id="ct">
<div class="sttl mbn"><div class="sttl_switch">版块筛选</div></div>
<div class="slst mtw"><ul id="threadlist">
<li class="pbw" id="thread201"><a href="forum-201-1.html">求片问答悬赏区</a> 标题甲</li>
<li class="pbw" id="thread202"><a href="forum-202-1.html">普通讨论区</a> 标题乙</li>
<li class="pbw" id="thread203"><a href="forum-203-1.html">AI专区</a> 标题丙</li>
</ul></div>
</div></div></body></html>"""

SEARCH_BUSY_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>busy</title></head><body>
<div class="wp"><div id="ct"><div id="messagetext">搜索繁忙，请稍后再试</div></div></div></body></html>"""

SEARCH_COOLDOWN_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>cooldown</title></head><body>
<div class="wp"><div id="ct"><div class="alert_error">搜索过于频繁，21:00-01:30限制搜索间隔120秒。</div></div></div></body></html>"""

T2048_LIST_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>threadlist</title></head><body>
<div class="nav-container">nav ad</div>
<ul id="nav"><li><a href="/">首页</a></li><li><a href="/search.php">搜索</a></li></ul>
<div class="recs-wrapper"><div class="recs-head">rec</div><a href="#"><img src="https://ad.example.invalid/ad.jpg"></a></div>
<div class="movie-banner">banner</div>
<div class="reward-card">reward</div>
<div class="r_two">sidebar</div>
<ul id="threadlist">
<li><a href="/read.php?tid=1"><img loading="lazy" src="IMGURL"></a></li>
<li><a href="/read.php?tid=2"><img src="thumb-ing.gif" data-original="IMGURL"></a></li>
<li><picture><source srcset="x"><img src="thumb-ing.gif" data-original="IMGURL"></picture></li>
<li><img src="thumb-ing.gif" data-original="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="></li>
</ul></body></html>""".replace('IMGURL', IMG_URL)

T2048_READ_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>read</title></head><body>
<div class="r_two">sidebar</div>
<div id="postlist">
<div class="pct"><div class="pcb">
<img src="thumb-ing.gif" data-original="IMGURL">
<img src="thumb-ing.gif" data-original="IMGURL">
<img src="thumb-ing.gif" data-original="IMGURL">
<img src="thumb-ing.gif" data-original="IMGURL">
<img src="thumb-ing.gif" data-original="IMGURL">
<img src="https://icon.example.invalid/logo.png">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
</div></div></div></body></html>""".replace('IMGURL', IMG_URL)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        q = urllib.parse.parse_qs(u.query)
        if path == '/search.php':
            html = SEARCH_BUSY_PAGE if q.get('busy') else (SEARCH_COOLDOWN_PAGE if q.get('cooldown') else SEARCH_RESULT_PAGE)
        elif path == '/forum-95-1.html':
            html = LIST_PAGE
        elif path == '/forum.php':
            html = HOME_PAGE
        elif path == '/thread-101-1-1.html':
            html = DETAIL_PAGE
        elif path == '/thread-102-1-1.html':
            html = DETAIL_PRELOADED_PAGE
        elif path == '/thread-104-1-1.html':
            html = LATE_SUCCESS_PAGE
        elif path == '/read-slow.php':
            html = READ_SLOW_PAGE
        elif path == '/read-slow2.php':
            html = READ_SLOW2_PAGE
        elif path == '/thread.php':
            html = T2048_LIST_PAGE
        elif path == '/read.php':
            html = T2048_READ_PAGE
        elif path == '/sehua.js':
            body = open(os.path.join(REPO, '色花堂.js'), encoding='utf-8').read().encode('utf-8')
            return self._send(body, 'text/javascript; charset=utf-8')
        elif path == '/t2048.js':
            body = open(os.path.join(REPO, '2048.js'), encoding='utf-8').read().encode('utf-8')
            return self._send(body, 'text/javascript; charset=utf-8')
        elif path == '/img.gif':
            return self._send(IMG_BYTES, 'image/gif')
        elif path == '/wide.svg':
            return self._send(b'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#c33"/></svg>', 'image/svg+xml')
        elif path == '/tall.svg':
            return self._send(b'<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="#36c"/></svg>', 'image/svg+xml')
        elif path == '/slow.gif':
            import time
            time.sleep(0.4)
            return self._send(IMG_BYTES, 'image/gif')
        elif path == '/slow11.gif':
            # 迟到的成功：超过 IMG_HOLD_TIMEOUT(10s) 才加载完，用于验证 correctFailed
            import time
            time.sleep(11.2)
            return self._send(IMG_BYTES, 'image/gif')
        elif path == '/slow13.gif':
            # 更迟的成功：跨过"10s 超时 + 2.5s 淡出"之后才回来，验证计数与可见性解耦
            import time
            time.sleep(13.2)
            return self._send(IMG_BYTES, 'image/gif')
        elif path == '/harness.js':
            body = open(os.path.join(HERE, 'harness.js'), encoding='utf-8').read().encode('utf-8')
            return self._send(body, 'text/javascript; charset=utf-8')
        else:
            self.send_error(404)
            return
        self._send(html.encode('utf-8'), 'text/html; charset=utf-8')

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print('serving on 127.0.0.1:%d' % PORT, flush=True)
    Server(('127.0.0.1', PORT), Handler).serve_forever()

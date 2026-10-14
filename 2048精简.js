// ==UserScript==
// @name         2048精简
// @namespace    https://fby.hfz300.com/
// @version      1.1
// @description  2048精简版：去广告（推荐块/导航条/影片横幅/打赏卡）；隐藏详情页侧栏；去懒加载/去滚动加载——全站图片改为立即加载。无加载引擎、无进度条、无失败记忆——加载交给浏览器。
// @author       Chevy Yang
// @match        https://bbs.hdaksog.com/*
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 去广告：推荐块、导航条、影片横幅、打赏卡，命中整块移除
  document.querySelectorAll('.recs-wrapper, .recs-head, .recs-row, .recs-pill, .nav-container, .movie-banner, .reward-card').forEach(el => el.remove());

  // 隐藏详情页侧栏（作者信息卡）
  document.head.insertAdjacentHTML('beforeend', '<style>.r_two { display: none !important; }</style>');

  // 去懒加载/去滚动加载：占位图立刻换真地址（真址在 data-original），原生懒图立刻加载
  document.querySelectorAll('img[data-original], img[data-src], img[loading=lazy]').forEach(img => {
    const real = img.getAttribute('data-original') || img.getAttribute('data-src');
    if (real && img.getAttribute('src') !== real) img.src = real;
    img.loading = 'eager';
  });
})();

// ==UserScript==
// @name         探花缩略图
// @namespace    http://thbt6.com/
// @version      1.2
// @description  在探花BT列表中显示详情页的图片预览
// @author       Chevy Yang
// @match        https://fje.326388.xyz/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        maxConcurrent: 12,
        maxImages: 6,
        imageWidth: '200px',
        loadingText: '🔄 加载中...',
        errorText: '❌ 加载失败',
        initDelay: 0
    };

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .row { max-width: 100% !important; }
            .container { max-width: 100% !important; }
            #site-navigation ul { max-width: 100% !important; }
            .videos-list { overflow: visible !important; margin: 0 !important; }
            .video-list-content { overflow: visible !important; }
        `;
        document.head.appendChild(style);
        
        const contentEl = document.getElementById('content');
        if (contentEl) {
            contentEl.remove();
        }
    }
    injectStyles();

    let activeRequests = 0;
    const requestQueue = [];
    const processedUrls = new Set();

    function getGMRequest() {
        if (typeof GM_xmlhttpRequest !== 'undefined') return GM_xmlhttpRequest;
        if (typeof GM !== 'undefined' && GM.xmlHttpRequest) return GM.xmlHttpRequest;
        return null;
    }

    function decodeReversedBase64(encodedStr) {
        try {
            const reversed = encodedStr.split('').reverse().join('');
            const decoded = atob(reversed);
            return decoded;
        } catch (e) {
            return null;
        }
    }

    function decodeStandardBase64(encodedStr) {
        try {
            const decoded = atob(encodedStr);
            return decodeURIComponent(escape(decoded));
        } catch (e) {
            return null;
        }
    }

    function fullyDecode(html, maxDepth = 10) {
        let current = html;
        let depth = 0;
        
        while (depth < maxDepth) {
            if (current.includes('<img') && current.includes('src=')) {
                const hasMoreEncoding = current.match(/var\s+\w+\s*=\s*\w+\(['"]/);
                if (!hasMoreEncoding) {
                    return current;
                }
            }
            
            let encodedData = null;
            
            const singleLineMatch = current.match(/var\s+\w+\s*=\s*\w+\(['"]([A-Za-z0-9+/=]+)['"]\)/);
            if (singleLineMatch && singleLineMatch[1] && singleLineMatch[1].length > 50) {
                encodedData = singleLineMatch[1];
            }
            
            if (!encodedData) {
                const funcCallMatch = current.match(/\w+\(['"]([A-Za-z0-9+/=]{50,})['"]\)/);
                if (funcCallMatch && funcCallMatch[1]) {
                    encodedData = funcCallMatch[1];
                }
            }
            
            if (!encodedData) {
                const base64Content = current.match(/['"]([A-Za-z0-9+/=]{100,})['"]/);
                if (base64Content && base64Content[1]) {
                    encodedData = base64Content[1];
                }
            }
            
            if (!encodedData) {
                break;
            }
            
            let decoded = decodeReversedBase64(encodedData);
            
            if (!decoded || !decoded.includes('<')) {
                decoded = decodeStandardBase64(encodedData);
            }
            
            if (decoded && decoded.includes('<')) {
                current = decoded;
                depth++;
            } else {
                break;
            }
        }
        
        return current;
    }

    function processQueue() {
        if (activeRequests >= CONFIG.maxConcurrent || requestQueue.length === 0) {
            return;
        }

        const task = requestQueue.shift();
        activeRequests++;

        const gmRequest = getGMRequest();
        if (!gmRequest) {
            task.errorCallback('GM_xmlhttpRequest 不可用');
            activeRequests--;
            processQueue();
            return;
        }
        
        gmRequest({
            method: 'GET',
            url: task.url,
            onload: function(response) {
                try {
                    const rawHtml = response.responseText;
                    const decodedHtml = fullyDecode(rawHtml);
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(decodedHtml, 'text/html');
                    task.callback(doc, decodedHtml);
                } catch (e) {
                    task.errorCallback(e.message);
                }
                activeRequests--;
                processQueue();
            },
            onerror: function(error) {
                task.errorCallback('请求失败');
                activeRequests--;
                processQueue();
            }
        });
    }

    function fetchDetailPage(url, callback, errorCallback) {
        requestQueue.push({ url, callback, errorCallback });
        processQueue();
    }

    function extractImagesFromDetail(doc, decodedHtml) {
        const images = [];
        
        const imgItems = doc.querySelectorAll('.img_item img');
        
        imgItems.forEach(img => {
            let src = img.getAttribute('src') || img.getAttribute('data-src');
            if (src) {
                if (src.startsWith('//')) {
                    src = 'https:' + src;
                }
                images.push(src);
            }
        });

        if (images.length === 0 && decodedHtml) {
            const patterns = [
                /src=["'](\/\/[^"']+\.jpg)["']/gi,
                /src=["'](\/\/[^"']*douyin[^"']+)["']/gi,
                /src=["'](https?:\/\/[^"']+\.jpg)["']/gi,
                /<img[^>]+src=["']([^"']+)["']/gi
            ];
            
            for (const regex of patterns) {
                let match;
                regex.lastIndex = 0;
                while ((match = regex.exec(decodedHtml)) !== null) {
                    let src = match[1];
                    if (src.startsWith('//')) {
                        src = 'https:' + src;
                    }
                    if (!images.includes(src) && !src.includes('template') && !src.includes('icon')) {
                        images.push(src);
                    }
                }
                if (images.length > 0) {
                    break;
                }
            }
        }

        return images;
    }

    function extractResolution(decodedHtml) {
        const patterns = [
            /【分辨率】[：:]\s*(\d+)x(\d+)/i,
            /分辨率[：:]\s*(\d+)x(\d+)/i,
            /resolution[：:]\s*(\d+)x(\d+)/i,
            /(\d{3,4})x(\d{3,4})/
        ];
        
        for (const regex of patterns) {
            const match = decodedHtml.match(regex);
            if (match && match[1] && match[2]) {
                const width = parseInt(match[1]);
                const height = parseInt(match[2]);
                return { width, height, text: match[1] + 'x' + match[2] };
            }
        }
        return null;
    }

    function isHighDefinition(resolution) {
        if (!resolution) return false;
        const { width, height } = resolution;
        return (width >= 1920 && height >= 1080) || (width >= 1080 && height >= 1920);
    }

    function adjustMoreIndicatorWidth(container) {
        const moreIndicator = container.querySelector('.more-indicator');
        if (!moreIndicator) return;

        const cs = window.getComputedStyle(container);
        const paddingLeft = parseFloat(cs.paddingLeft) || 0;
        const paddingRight = parseFloat(cs.paddingRight) || 0;
        const gap = parseFloat(cs.gap) || 4;

        const innerWidth = container.clientWidth - paddingLeft - paddingRight;

        const children = Array.from(container.children);
        let imageCount = 0;
        children.forEach(child => {
            if (!child.querySelector('.more-indicator')) {
                imageCount++;
            }
        });

        if (imageCount === 0) return;

        const imageWidth = parseInt(CONFIG.imageWidth);
        const imagesTotalWidth = imageCount * imageWidth + (imageCount - 1) * gap;
        const remainingWidth = innerWidth - imagesTotalWidth - gap;

        if (remainingWidth > 0) {
            moreIndicator.style.width = remainingWidth + 'px';
        } else {
            moreIndicator.style.width = '143px';
        }
    }

    function createImagePreview(images, detailUrl) {
        const container = document.createElement('div');
        container.className = 'preview-container';
        container.style.cssText = `
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 4px !important;
            margin-top: 8px !important;
            padding: 5px !important;
            background: rgba(0,0,0,0.05) !important;
            border-radius: 4px !important;
        `;

        const displayImages = images.slice(0, CONFIG.maxImages);
        let hasPortraitImage = false;
        let loadedCount = 0;
        
        displayImages.forEach(src => {
            const imgWrapper = document.createElement('a');
            imgWrapper.href = detailUrl;
            imgWrapper.target = '_blank';
            imgWrapper.style.cssText = 'display: block; overflow: hidden; border-radius: 3px; flex-shrink: 0;';
            
            const img = document.createElement('img');
            img.src = src;
            img.referrerPolicy = 'no-referrer';
            img.decoding = 'async';
            img.style.cssText = `
                width: ${CONFIG.imageWidth} !important;
                height: 130px !important;
                object-fit: cover !important;
                display: block !important;
            `;
            
            img.addEventListener('load', function() {
                const naturalRatio = this.naturalWidth / this.naturalHeight;
                if (naturalRatio < 1) {
                    const newHeight = 200 * 20 / 13;
                    this.style.height = newHeight + 'px';
                    hasPortraitImage = true;
                }
                loadedCount++;
                if (loadedCount === displayImages.length && hasPortraitImage) {
                    const moreIndicator = container.querySelector('.more-indicator');
                    if (moreIndicator) {
                        moreIndicator.style.height = (200 * 20 / 13) + 'px';
                    }
                }
                adjustMoreIndicatorWidth(container);
            });
            
            img.addEventListener('error', function() {
                this.style.display = 'none';
                loadedCount++;
            });
            
            imgWrapper.appendChild(img);
            container.appendChild(imgWrapper);
        });

        if (images.length > CONFIG.maxImages) {
            const moreWrapper = document.createElement('a');
            moreWrapper.href = detailUrl;
            moreWrapper.target = '_blank';
            moreWrapper.style.cssText = 'display: block; overflow: hidden; border-radius: 3px; text-decoration: none;';
            
            const moreIndicator = document.createElement('span');
            moreIndicator.className = 'more-indicator';
            moreIndicator.textContent = `+${images.length - CONFIG.maxImages}`;
            moreIndicator.style.cssText = `
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                min-width: 0 !important;
                overflow: hidden !important;
                height: 130px !important;
                background: rgba(0,0,0,0.1) !important;
                border-radius: 3px !important;
                font-size: 14px !important;
                color: #666 !important;
                cursor: pointer !important;
            `;
            
            moreWrapper.appendChild(moreIndicator);
            container.appendChild(moreWrapper);
        }

        return container;
    }

    function addPreviewToItem(liElement, detailUrl) {
        if (processedUrls.has(detailUrl)) return;
        processedUrls.add(detailUrl);

        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'preview-loading';
        loadingIndicator.textContent = CONFIG.loadingText;
        loadingIndicator.style.cssText = `
            font-size: 12px !important;
            color: #666 !important;
            margin-top: 5px !important;
            padding: 3px 8px !important;
            background: #f0f0f0 !important;
            border-radius: 3px !important;
            display: inline-block !important;
        `;
        liElement.appendChild(loadingIndicator);

        fetchDetailPage(
            detailUrl,
            function(doc, decodedHtml) {
                const images = extractImagesFromDetail(doc, decodedHtml);
                const resolution = extractResolution(decodedHtml);
                loadingIndicator.remove();

                if (resolution) {
                    const resolutionBadge = document.createElement('span');
                    resolutionBadge.className = 'resolution-badge';
                    resolutionBadge.textContent = resolution.text;
                    const isHD = isHighDefinition(resolution);
                    resolutionBadge.style.cssText = `
                        float: right !important;
                        font-size: 12px !important;
                        color: #fff !important;
                        background: ${isHD ? '#4CAF50' : '#9e9e9e'} !important;
                        padding: 2px 8px !important;
                        border-radius: 3px !important;
                        margin-left: 10px !important;
                    `;
                    const titleLink = liElement.querySelector('a');
                    if (titleLink) {
                        titleLink.style.display = 'inline-block';
                        titleLink.parentNode.insertBefore(resolutionBadge, titleLink.nextSibling);
                    } else {
                        liElement.insertBefore(resolutionBadge, liElement.firstChild);
                    }
                }

                if (images.length > 0) {
                    const previewContainer = createImagePreview(images, detailUrl);
                    liElement.appendChild(previewContainer);
                    adjustMoreIndicatorWidth(previewContainer);
                } else {
                    const noImage = document.createElement('span');
                    noImage.textContent = '无预览图';
                    noImage.style.cssText = `
                        font-size: 12px !important;
                        color: #999 !important;
                        margin-top: 5px !important;
                        display: inline-block !important;
                    `;
                    liElement.appendChild(noImage);
                }
            },
            function(error) {
                loadingIndicator.remove();
                const errorMsg = document.createElement('span');
                errorMsg.textContent = CONFIG.errorText;
                errorMsg.style.cssText = `
                    font-size: 12px !important;
                    color: #ff6b6b !important;
                    margin-top: 5px !important;
                    display: inline-block !important;
                `;
                liElement.appendChild(errorMsg);
            }
        );
    }

    function findListItems() {
        const items = [];
        
        const selectors = [
            'ul.list > li',
            '.videos-list ul li',
            '.list li',
            'ul.list li'
        ];
        
        let listItems = [];
        for (const selector of selectors) {
            listItems = document.querySelectorAll(selector);
            if (listItems.length > 0) {
                break;
            }
        }
        
        listItems.forEach(li => {
            const link = li.querySelector('a[href]');
            if (link) {
                const href = link.getAttribute('href');
                if (href && (href.includes('/html/movie/') || href.includes('/movie.php'))) {
                    items.push({ li, href });
                }
            }
        });

        return items;
    }

    function init() {
        const items = findListItems();

        if (items.length === 0) {
            setTimeout(init, 2000);
            return;
        }

        items.forEach(({ li, href }) => {
            const fullUrl = href.startsWith('http') ? href : 
                           (href.startsWith('/') ? window.location.origin + href : 
                           window.location.origin + '/' + href);
            addPreviewToItem(li, fullUrl);
        });
    }

    let resizeTimer = null;
    window.addEventListener('resize', function() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            document.querySelectorAll('.preview-container').forEach(function(container) {
                adjustMoreIndicatorWidth(container);
            });
        }, 150);
    });

    setTimeout(init, CONFIG.initDelay);
})();

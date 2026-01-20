/**
 * pageContextHelper.js
 * 这个脚本运行在页面的主世界（main world）中，可以访问 React Fiber。
 * 通过 web_accessible_resources 配置后，Content Script 可以注入此脚本。
 * 通信方式：通过 CustomEvent 与 Content Script 通信。
 */
(function () {
    'use strict';

    // 监听来自 Content Script 的请求
    document.addEventListener('mowen-extract-url', function (event) {
        const detail = event.detail || {};
        const tempId = detail.tempId;

        if (!tempId) {
            dispatchResult(null, 'no_tempId');
            return;
        }

        const el = document.querySelector(`[data-mowen-temp-id="${tempId}"]`);
        if (!el) {
            dispatchResult(tempId, 'not_found');
            return;
        }

        try {
            // 查找 React Fiber
            const fiberKey = Object.keys(el).find(function (k) {
                return k.startsWith('__reactFiber');
            });

            if (!fiberKey) {
                dispatchResult(tempId, 'no_fiber');
                return;
            }

            const fiber = el[fiberKey];
            const seen = new WeakSet();
            const urls = [];

            // 递归搜索 URL
            function search(obj, depth) {
                if (!obj || depth > 12 || typeof obj !== 'object') {
                    if (typeof obj === 'string' &&
                        (obj.indexOf('/status/') > -1 || obj.indexOf('/article/') > -1) &&
                        obj.indexOf('/photo/') === -1 &&
                        obj.indexOf('/video/') === -1 &&
                        obj.indexOf('/analytics') === -1) {
                        var url = obj.indexOf('http') === 0 ? obj : 'https://x.com' + obj;
                        if (urls.indexOf(url) === -1) urls.push(url);
                    }
                    return;
                }
                if (seen.has(obj)) return;
                seen.add(obj);

                try {
                    // 优先检查高价值键
                    var priorityKeys = ['permalink', 'url', 'href', 'expanded_url', 'canonical_url', 'link_url'];
                    for (var i = 0; i < priorityKeys.length; i++) {
                        var key = priorityKeys[i];
                        var v = obj[key];
                        if (v && typeof v === 'string' &&
                            (v.indexOf('/status/') > -1 || v.indexOf('/article/') > -1) &&
                            v.indexOf('/photo/') === -1 && v.indexOf('/video/') === -1) {
                            var foundUrl = v.indexOf('http') === 0 ? v : 'https://x.com' + v;
                            if (urls.indexOf(foundUrl) === -1) urls.push(foundUrl);
                        }
                    }

                    // 递归搜索
                    if (Array.isArray(obj)) {
                        for (var j = 0; j < Math.min(obj.length, 10); j++) {
                            search(obj[j], depth + 1);
                        }
                    } else {
                        var keys = Object.keys(obj);
                        for (var k = 0; k < keys.length; k++) {
                            var propKey = keys[k];
                            // 跳过不相关的键
                            if (propKey === 'children' || propKey === '_owner' ||
                                propKey === 'stateNode' || propKey === 'return' ||
                                propKey === 'sibling' || propKey === 'child') continue;
                            try {
                                search(obj[propKey], depth + 1);
                            } catch (e) { }
                        }
                    }
                } catch (e) { }
            }

            // 遍历 Fiber return 链
            var current = fiber;
            var level = 0;
            while (current && level < 25 && urls.length === 0) {
                if (current.memoizedProps) search(current.memoizedProps, 0);
                if (current.pendingProps && urls.length === 0) search(current.pendingProps, 0);
                current = current.return;
                level++;
            }

            // 优先返回 /status/ 链接
            var statusUrl = null;
            for (var s = 0; s < urls.length; s++) {
                if (urls[s].indexOf('/status/') > -1) {
                    statusUrl = urls[s];
                    break;
                }
            }
            var result = statusUrl || urls[0] || null;
            dispatchResult(tempId, result || 'no_url_found');

        } catch (e) {
            dispatchResult(tempId, 'error:' + e.message);
        }
    });

    function dispatchResult(tempId, result) {
        document.dispatchEvent(new CustomEvent('mowen-extract-url-result', {
            detail: { tempId: tempId, result: result }
        }));
    }

    // 标记脚本已加载
    window.__mowenPageContextHelperLoaded = true;
    console.log('[Mowen] pageContextHelper.js 已加载');
})();

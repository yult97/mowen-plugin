
/**
 * 智能提取图片注释 (Caption Extractor)
 * 
 * 策略：
 * 1. 强结构：<figure> <figcaption>, aria-describedby
 * 2. 弱结构：检查图片紧邻的兄弟节点或父容器的文本
 * 3. 过滤：排除不可见元素、长段落、无关文本
 */

export function extractCaptionForImage(img: HTMLImageElement): string | null {
    try {
        // 0. 基础检查
        if (!img || !img.isConnected) return null;

        // 1. 强结构识别 (Strong Structure)

        // 1.1 <figure> <figcaption>
        const figure = img.closest('figure');
        if (figure) {
            const figcaptions = figure.querySelectorAll('figcaption');
            for (const cap of Array.from(figcaptions)) {
                // 确保是该 figure 的直接描述（防止嵌套 figure 干扰，虽然罕见）
                if (cap.closest('figure') === figure) {
                    const text = getCleanText(cap);
                    if (isValidCaption(text)) return text;
                }
            }
        }

        // 1.2 aria-describedby
        const describedBy = img.getAttribute('aria-describedby');
        if (describedBy) {
            const descEl = document.getElementById(describedBy);
            if (descEl) {
                const text = getCleanText(descEl);
                if (isValidCaption(text)) return text;
            }
        }

        // 2. 通用特征识别 (Common Patterns)
        // 检查父容器或兄弟节点是否包含特定 class/id
        const captionSelectors = [
            '.caption', '.img-caption', '.image-caption', '.wp-caption-text',
            '.desc', '.description',
            '[class*="caption"]', '[class*="desc"]',
            'small', '.photo-credit'
        ];

        // 2.1 检查 Next Sibling (紧邻的下一个元素)
        let nextNode = img.nextElementSibling;

        // 如果图片被包裹在 p 或 div 中，检查该 wrapper 的下一个兄弟
        if (!nextNode && img.parentElement) {
            // 限制父级层级，防止跑太远
            const parent = img.parentElement;
            if (['P', 'DIV', 'A', 'SPAN'].includes(parent.tagName) && parent.innerText.length < 200) {
                nextNode = parent.nextElementSibling;
            }
        }

        if (nextNode) {
            // 优先检查是否有特定 class
            if (nextNode.matches(captionSelectors.join(','))) {
                const text = getCleanText(nextNode as HTMLElement);
                if (isValidCaption(text)) return text;
            }

            // 即使没有 class，如果是 div/span/p 且内容很短，也可能是 caption
            if (['DIV', 'SPAN', 'P', 'SMALL', 'CENTER'].includes(nextNode.tagName)) {
                // 必须通过严格的文本检查
                const text = getCleanText(nextNode as HTMLElement);
                // 稍微放宽一点，因为这是紧邻的节点
                if (isValidCaption(text, true)) return text;
            }
        }

        // 2.2 检查特定的父级结构 (有些网站把 caption 和 img 并列放在一个 div 里)
        // <div class="wp-caption"> <img /> <p class="wp-caption-text">...</p> </div>
        const parent = img.parentElement;
        if (parent) {
            const potentialCaption = parent.querySelector(captionSelectors.join(','));
            if (potentialCaption && potentialCaption !== img) {
                const text = getCleanText(potentialCaption as HTMLElement);
                if (isValidCaption(text)) return text;
            }
        }

        return null;

    } catch (e) {
        // Fail-Safe: 任何错误都不应中断提取
        console.warn('[caption] Failed to extract caption:', e);
        return null;
    }
}

// --- Helpers ---

/**
 * 提取并清理元素文本
 * @param el 
 */
function getCleanText(el: HTMLElement): string | null {
    if (!el) return null;

    // 可见性检查 (Visibility Check)
    if (!isVisible(el)) return null;

    // 过滤掉不可见的辅助元素（防止提取到 hidden text）
    // clone 一份来处理，避免修改原始 DOM
    // 但 clone 会丢失 computed style，无法检查子元素的 visibility。
    // 这里采用简单策略：直接取 innerText (innerText 会忽略 display:none 的元素，textContent 不会)
    let text = el.innerText || '';

    // 清理空白
    text = text.replace(/\s+/g, ' ').trim();

    return text.length > 0 ? text : null;
}

/**
 * 检查元素是否可见 (Visibility Check)
 * 必须“所见即所得”
 */
function isVisible(el: HTMLElement): boolean {
    if (!el) return false;

    // 1. 基础属性检查
    // 注意：getComputedStyle 比较昂贵，但为了准确性是必须的。
    // 为了性能，只对潜在的 caption 元素调用，数量级很小。
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }

    // 2. 尺寸检查
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
        return false;
    }

    return true;
}

/**
 * 验证文本是否像一个有效的 caption
 * @param text 
 * @param isWeakSignal 是否是弱信号来源（如普通兄弟节点），需要更严格的检查
 */
function isValidCaption(text: string | null, isWeakSignal = false): boolean {
    if (!text) return false;

    // 1. 长度限制
    if (text.length < 2) return false; // 太短
    if (text.length > 80) return false; // 太长，可能是正文

    // 2. 无意义的默认标注词（直接排除）
    const meaninglessWords = [
        '图片', 'image', 'picture', 'photo', 'img',
        '视频', 'video',
        '动图', 'gif',
        '点击查看大图', '点击放大',
    ];

    const trimmedText = text.trim();

    // 如果整个文本就是这些无意义的词，直接排除
    if (meaninglessWords.some(w => trimmedText === w || trimmedText.toLowerCase() === w.toLowerCase())) {
        return false;
    }

    // 2. 关键词过滤 (Stopwords)
    const stopWords = [
        '点击', 'click', '查看', 'view', '更多', 'more',
        '广告', 'adv', 'sponsor',
        '分享', 'share', '赞', 'like', 'comment',
        '来源', 'source', // 来源通常保留？用户 Feedback 说：允许保留“图片来源/摄影/©”
        // 但如果仅仅是 "Source: Google" 可能没意义，如果是 "图：张三" 可以。
        // 暂时不 strict 过滤 source，除非用户反感。
    ];

    const lowerText = text.toLowerCase();
    if (stopWords.some(w => lowerText.includes(w))) {
        // 特例：如果是 credit 类，允许保留
        if (lowerText.match(/^(图|来源|source|credit|by|©)/)) {
            return true;
        }
        // 如果包含动词性 stopwords，通常是按钮
        if (lowerText.match(/click|view|read|share|like|icon/)) {
            return false;
        }
    }

    // 3. 弱信号的额外检查
    if (isWeakSignal) {
        // 如果是弱信号，甚至不能包含标点符号结尾？或者必须包含特定词？
        // 暂时只依赖长度和停用词。

        // 排除纯数字/日期 (如果只是日期作为 caption 可能意义不大，但也无害)
    }

    return true;
}

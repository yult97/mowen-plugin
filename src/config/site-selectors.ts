/**
 * Site-specific selectors and configuration for content extraction.
 */

// Selectors to find the main article content
export const ARTICLE_SELECTORS = [
    '.available-content',
    '.newsletter-post',
    'article',
    '[role="main"]',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.content',
    'main',
    '#content',
    '.post',
    '.article',
];

// Selectors for Author extraction
export const AUTHOR_SELECTORS = [
    '[rel="author"]',
    '.author',
    '.byline',
    '[itemprop="author"]',
    '.post-author'
];

// Selectors for Publish Time extraction
export const TIME_SELECTORS = [
    'time[datetime]',
    '[itemprop="datePublished"]',
    '.published',
    '.post-date',
    '.date'
];

// Selectors for Junk elements (Ads, Social, Interactive bits) to be removed
export const JUNK_SELECTORS = [
    '.advertisement', '.ads', '.social-share', '.comments', '.related-posts',
    '[aria-hidden="true"]', 'iframe[src*="ads"]',
    // Substack specific
    '.post-ufi', '.like-button-container', '.share-dialog',
    '.subscription-widget-wrap', '.substack-post-footer',
    '.post-header', '.post-ufi-button', '.pencraft.style-button',
    '.portable-archive-header', '.banner', '.post-footer',
    '.profile-hover-card', '.user-hover-card', '.pencraft',
    // Comment sections
    '.vssue', '.vssue-container', '.gitalk-container', '.gitalk',
    '.giscus', '.giscus-frame', '.utterances', '.disqus_thread', '#disqus_thread',
    '.comment-section', '#comments', '[class*="comment"]',
    // VuePress/VitePress
    '.page-edit', '.page-nav', '.page-meta', '.last-updated',
    // Header anchors
    'a.header-anchor', 'a.heading-anchor', 'a.anchor', '.header-anchor',
    // Twitter/X
    '[data-testid="User-Name"]', '[data-testid="UserName"]', '[data-testid="User-Names"]',
    '[data-testid="subscribe"]', '[data-testid="reply"]', '[data-testid="retweet"]',
    '[data-testid="like"]', '[data-testid="bookmark"]', '[data-testid="share"]',
    '[data-testid="analyticsButton"]', '[data-testid="app-text-transition-container"]',
    '[class*="engagement-bar"]', '[class*="reactions-bar"]',
    '[class*="like-count"]', '[class*="retweet-count"]', '[class*="reply-count"]',
    '[class*="share-count"]', '[class*="view-count"]',
    '[class*="subscribe-button"]', '[class*="follow-button"]',
    // Medium specific
    '[data-testid="authorPhoto"]',           // Author avatar
    'img[data-testid="authorPhoto"]',        // Author avatar img
    '[data-testid="storyPublishDate"]',      // Publish date
    'button[aria-label="responses"]',        // Comments button
    'button[data-testid="headerClapButton"]', // Clap button
    'svg[aria-label="clap"]',                // Clap icon
    '[data-testid="headerSocialShareButton"]', // Share buttons
    '[data-testid="audioPlayButton"]',       // Listen to article button
    '.speechify-ignore',                       // Medium audio wrapper
    // Medium author byline patterns
    'a[href*="/@"][rel="noopener follow"]', // Author link in byline
    // Video players
    'video', '.video-player', '.video-container', '.video_iframe', '.video_card',
    '[class*="video-player"]', '[class*="video-controls"]', '[class*="video-bar"]',
    // WeChat video
    '.js_tx_video_container', '.js_video_channel_video', '.video_channel_card_container',
    '.video_card_container', '.mpvideosnap_container', '.video_info_wrap',
    '.video_desc', '.video_channel', '.video_player_container', '.js_video_container',
    '.wx-video', '[class*="video_channel"]', '[class*="mpvideo"]', '[class*="wxvideo"]',
    '.video_play_btn', '.video_progress', '.video_time', '.video_fullscreen',
    '.video_speed', '.video_share', '.video_replay', '.video_attention',
    // WeChat author follow
    '.profile_info_area', '.profile_meta', '.wx_follow_btn', '.js_share_content',
    '[class*="follow"]', '[class*="subscribe"]',
    // iframes
    'iframe:not([src*="mp.weixin"])',
];

// Structural elements to remove in aggressive cleaning
export const STRUCTURAL_SELECTORS = [
    'script', 'style', 'nav', 'header', 'footer', 'aside'
];

// Text patterns to identify metadata blocks for removal
// 这些是通用规则，用于过滤常见的日期、作者等元数据
export const METADATA_TEXT_PATTERNS = [
    // 英文元数据
    /^(written by|reviewed by|edited by|posted by)\s*$/i,
    /^(last edited|last updated|published on)\s*\w+\s+\d+,?\s*\d*$/i,
    /^expert verified$/i,
    /^(blogs?|guides?|articles?)\s*[\/|]\s*(blogs?|guides?|articles?)?$/i,
    // 通用日期格式：支持 ISO 格式 "Published on 2026-01-11"
    /^published\s+(on\s+)?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/i,
    // 中文作者格式："作者：xxx" 或 "作者/公众号：xxx"
    /^作者[：:]/,
    /^作者\/公众号[：:]/,
];

// Selectors for non-content image containers (avatars, author bios, social, etc.)
export const IMAGE_EXCLUDE_PARENT_SELECTORS = [
    // Author/profile related
    '[class*="author"]',
    '[class*="avatar"]',
    '[class*="profile"]',
    '[class*="bio"]',
    '[class*="byline"]',
    '[class*="writer"]',
    '[class*="contributor"]',
    '[class*="reviewer"]',
    // Social sharing
    '[class*="social"]',
    '[class*="share"]',
    '[class*="sharing"]',
    // Substack specific interaction bars
    '[class*="post-ufi"]',
    '[class*="like-button"]',
    '[class*="subscription-widget"]',
    // Header metadata
    '[class*="meta"]',
    '[class*="info-bar"]',
    '[class*="post-header"]',
    '[class*="article-header"]',
    // Footer/related sections
    '[class*="related"]',
    '[class*="recommended"]',
    '[class*="footer"]',
    // Navigation
    '[class*="sidebar"]',
    '[class*="navigation"]',
    '[class*="nav"]',
    // Ads
    '[class*="advertisement"]',
    '[class*="sponsor"]',
    // CTA sections
    '[class*="sidecta"]',
    '[class*="cta"]',
];

// Alt text patterns that suggest an image is decorative
export const DECORATIVE_ALT_PATTERNS = [
    /\bbackground\b/i,
    /\bsidecta\b/i,
    /\bdecorative\b/i,
    /\bbg[-_]?image\b/i,
    /\bcta[-_]?(bg|background)\b/i,
];

// Alt text patterns that suggest and image is an avatar
export const AVATAR_ALT_PATTERNS = [
    /\bavatar\b/i,
    /\bheadshot\b/i,
    /\bportrait\b/i,
    /\bprofile\s*(pic|photo|image|picture)\b/i,
    /\bauthor\s*(photo|image|picture)\b/i,
];

// Keywords in class names that suggest an image is an avatar or profile pic
export const AVATAR_CLASS_KEYWORDS = ['avatar', 'profile-pic', 'author-img', 'headshot', 'portrait'];
export const AVATAR_CLASS_ONLY_KEYWORDS = ['author', 'bio', 'user-icon', 'profile'];

// Twitter/X Quote Tweet 相关选择器
export const TWITTER_SELECTORS = {
    // 推文容器
    tweetContainer: '[data-testid="tweet"]',
    // 推文文本内容
    tweetText: '[data-testid="tweetText"]',
    // 用户名区域
    userName: '[data-testid="User-Name"]',
    // 引用推文链接（嵌套在引用块中）
    quoteTweetLink: 'a[href*="/status/"]',
    // 推文时间
    tweetTime: 'time',
    // 文章容器（用于 X Article 页面）
    articleContainer: '[data-testid="article"]',
    // 主推文区域（排除引用）
    primaryColumn: '[data-testid="primaryColumn"]',
};

// 封面图自动注入黑名单已移除，采用更通用的 DOM 位置探测策略


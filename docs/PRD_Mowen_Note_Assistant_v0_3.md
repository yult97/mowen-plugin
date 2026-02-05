# PRD｜墨问笔记助手（Chrome Extension / MV3）
版本：V0.2（信息架构更新版）  
作者：——  
更新点（相对上一版）：  
- Popup 首页改为“功能总览/入口页”，无论是否已配置 Key 都先展示本插件具备的能力  
- 未配置 API Key 时，不再展示空白提示页；改为明显的 **按钮式 CTA** 引导去设置页配置  
- Options 设置页保留：API Key 配置、默认参数、调试模式，并新增/强化 **测试连接（创建测试笔记）** 流程  
- 其它核心能力保持：网页/公众号剪藏、图片尽可能抓取、超过 19,000 字自动拆分、图片超额转链接、公开/私密可控

---

## 1. 背景与问题
墨问创作者在浏览微信公众号与各类网页时，需要快速将文章内容（文字 + 图片）沉淀为可编辑的墨问笔记，用于整理、引用、再创作。当前痛点：
- 多数网页“复制粘贴”容易丢结构、丢图片或图片回看失效（热链/防盗链）
- 长文章超过笔记字数限制（最大 20,000），容易保存失败
- 公开/私密、图片数量、拆分等参数需要可控且可复用
- 用户希望在设置阶段就能验证 API Key 是否可用（而非保存后才发现失败）

---

## 2. 产品目标与成功标准

### 2.1 产品目标（MVP 必达）
1) 一键剪藏：在微信公众号/新闻/博客等网页，一键提取正文并保存到墨问  
2) 图片能力：对任意网页图片“尽可能抓取并上传”；失败不阻塞文本保存，至少转为可点击链接  
3) 超长自动拆分：以 SAFE_LIMIT=19,000 为阈值自动拆分为多篇笔记；遇到服务端仍报超限则自适应再拆分重试，保证最终创建成功  
4) 权限可控：保存时支持公开/私密；设置页可配置默认值  
5) 图片数量可控：maxImages（0–200，默认 20）；超出图片转链接  
6) 可验证 Key：设置页提供“测试连接”，使用当前 Key 创建测试笔记并回显笔记链接

### 2.2 成功标准（验收口径）
- 新用户：打开 Popup 后 10 秒内能理解插件能做什么，并能找到“配置 API Key”入口  
- 配置环节：测试连接成功率可观（Key 有效时 90%+，网络正常），失败能给出可理解原因  
- 剪藏环节：在常见网页/公众号场景中，文本保存成功率 99%（图片失败不阻塞）  
- 超长：超过 19,000 字文章可自动拆分，最终创建成功率 95%+（接口可用时）  
- maxImages：永不出现负数；超额图片必转链接

---

## 3. 范围与非范围

### 3.1 范围（本期做）
- Chrome 扩展（Manifest V3）
- Popup（420×680）+ Options 设置页
- 内容抽取：公众号定向 + 通用 Readability
- 图片抽取与抓取：覆盖 img/srcset/懒加载/背景图/data/blob 等，多策略抓取
- MCP 适配层：createNote、setPublic、upload（URL/二进制，视 MCP 支持）
- 状态机：首页总览、保存进度、成功/失败、未配置引导
- 测试连接：创建测试笔记并回显链接

### 3.2 非范围（本期不做）
- 强行突破登录/付费墙/验证码站点
- 页面截图/整页归档、视频帧抽取
- 外部中转服务器（MVP 不引入）
- AI 自动摘要/改写（可保留入口但不实现）

---

## 4. 目标用户与场景

### 4.1 用户
- 墨问创作者：日常剪藏素材，整理、再创作

### 4.2 核心场景
1) 公众号文章：一键保存（含图）到墨问  
2) 新闻/博客：一键保存（含懒加载图、srcset、背景图）  
3) 长文：自动拆分为多篇 + 索引笔记（可选）  
4) 图片较多：仅内嵌前 N 张，其余转链接，保证速度与成功率  
5) 新用户：先理解功能，再一键跳转配置 Key，并能测试通过

---

## 5. 信息架构与页面说明

## 5.1 Popup（420×680）——首页总览（新版）
**核心变化**：Popup 首屏不再是“未配置提示页”，而是“功能总览 + 操作入口”。  
无论 Key 是否配置，都展示能力；仅在未配置时，显示显眼 CTA 引导配置。

### 5.1.1 首页布局（建议卡片顺序）
1) **Header**
- 产品名：墨问笔记助手
- 右侧：设置（齿轮）/ 关闭

2) **功能总览卡（Always）**
- 标题：`你可以用它做什么`
- 列表（带 icon）：
  - `一键剪藏公众号/新闻/博客到墨问`
  - `图片尽可能抓取上传，失败自动转链接`
  - `超过 19,000 字自动拆分为多篇`
  - `公开/私密可控，支持默认设置`
- 底部：当前页面来源域名（可选展示）

3) **状态/引导卡（Conditional）**
- 若 `apiKey 未配置`：
  - 大按钮（Primary）：`先去配置 API Key`
  - 次按钮：`查看教程`
  - 文案：`配置后即可开始保存到墨问`
- 若 `apiKey 已配置`：
  - 状态胶囊：`Key 已配置`（可显示最近测试时间）
  - 快捷动作：`开始剪藏`（滚动到剪藏预览区或直接展示预览）

4) **剪藏预览与参数区（Key 已配置时展示；未配置可置灰预览）**
- 文章标题、来源 URL（可折叠）
- 指标：预计字数、图片总数、计划内嵌数、将转链接数
- 处理模式：`一键剪藏`（P0），`AI 智能整理`（P1 占位）
- 权限：Switch `发布公开笔记`
- 图片：Switch `包含图片` + maxImages（显示为只读摘要；编辑在设置页或弹出输入）
- Footer 固定保存区：`保存到墨问`

> 说明：未配置 Key 时，预览区可以显示“需要配置后才能剪藏”，但不要空白。

### 5.1.2 Popup 状态机（简化）
- H0：首页总览（未配置）→ CTA 去设置
- H1：首页总览（已配置，未开始）→ 展示预览
- H2：保存中（进度）→ 显示拆分/图片进度
- H3：成功 → 展示笔记链接（多篇/索引）
- H4：失败 → 可重试/去设置/查看错误

---

## 5.2 Options 设置页（单列卡片）
目标：与 Popup 同一设计语言，完成配置、默认参数管理与可验证闭环。

### 5.2.1 卡片结构
- 卡片 1：API 配置（API Key + 测试连接 + 结果回显）
- 卡片 2：默认设置（默认公开/私密、默认含图、maxImages、创建索引笔记）
- 卡片 3：高级设置（折叠：调试模式等）
- Sticky Footer：恢复默认 / 保存设置（仅有变更时启用）

### 5.2.2 测试连接（必须）
- 使用当前输入框 API Key（不要求先保存）
- 调用 MCP：创建测试笔记（强制私密）
- 成功：回显 `打开测试笔记` 链接；并更新“最近测试时间”
- 失败：映射错误原因（UNAUTHORIZED/NETWORK/RATE_LIMIT/UNKNOWN），支持重试

---

---

## 5.3 统一设计风格与视觉规范（必须补充）

> 目标：Popup 与 Options 在视觉上属于同一产品；整体“轻量、干净、卡片化”，奶油底 + 红色主色，强调可读性与操作明确性。  
> 适配：Popup 420×680；Options 为网页形态（居中单列卡片）。

### 5.3.1 设计关键词
- 奶油底色、轻阴影、卡片化分组
- 红色主按钮强引导（CTA 明确）
- 信息层级清晰：标题 → 说明 → 控件 → 状态反馈
- 留白克制但不空：用“功能总览/引导/预览”填充首屏

### 5.3.2 色彩（Design Tokens）
- 背景：`bg/default = #FBF5EF`
- 卡片：`surface/card = #FFFFFF`
- 描边：`border/default = #E8E0DA`

- 主色（统一红色体系）：
  - `brand/primary = #BF4045`
  - `brand/hover = #A8383D`
  - `brand/active = #8F2F33`
  - `brand/soft = rgba(191,64,69,0.08)`
  - `brand/focus = rgba(191,64,69,0.25)`

- 文本：
  - `text/primary = #1F2937`
  - `text/secondary = #6B7280`
  - `text/disabled = #9CA3AF`
  - `text/on-brand = #FFFFFF`

> 可选弱装饰：顶部淡红光晕（提升质感，避免色带）  
> `radial-gradient(circle at 50% 0%, rgba(191,64,69,0.08), transparent 55%)`

### 5.3.3 排版与间距（推荐值）
- 字号层级（建议）：
  - 页面标题：24 / Semibold
  - 卡片标题：16 / Semibold
  - 字段标题：14 / Medium
  - 正文：14 / Regular
  - 辅助说明：12 / Regular
- 行高：1.4–1.5
- Popup 统一边距：左右 16；卡片间距 12；卡片内边距 16
- Options 统一边距：容器左右 24（小屏 16）；卡片间距 16；卡片内边距 20（小屏 16）

### 5.3.4 组件风格规范
- 卡片（Card）
  - 圆角：16
  - 描边：border/default
  - 阴影（克制）：`0 6px 20px rgba(17,24,39,0.08)`
- 按钮（Button）
  - Primary（主 CTA）：填充 brand/primary，文字 text/on-brand，高度 44，圆角 12
  - Secondary/Outline：描边 brand/primary，文字 brand/primary，背景透明，高度 40（或 36）
  - Disabled：降低对比度，不可点击
  - Focus：2px 外发光 brand/focus
- 开关（Switch）
  - On：brand/primary；Off：中性灰
- 状态胶囊（Pill）
  - 用于 Key 状态：未配置/未验证/已验证（颜色可使用中性色 + 强文案，不必过度彩色）
- Toast/Inline Alert
  - 用于保存成功/失败、测试成功/失败；失败必须可理解且可重试

### 5.3.5 Popup 首页（功能总览 + CTA）的视觉要求
- 首屏必须包含：
  1) 功能总览卡（Always）
  2) 引导卡（未配置 Key 时显示大按钮：`先去配置 API Key`）
  3) 已配置时展示“开始剪藏”或直接展示预览区
- 视觉策略：
  - “功能总览卡”是首屏视觉锚点（icon + 列表 + 简短说明）
  - 未配置状态不允许出现大面积留白；预览区可置灰但要有提示文案

### 5.3.6 Options 设置页的视觉要求
- 单列卡片居中（max-width 860–960）
- API 配置卡在最上方且最突出（含“测试连接”按钮与结果区）
- maxImages 控件不允许出现负数；Stepper 控件风格与按钮一致
- Sticky Footer（恢复默认 / 保存设置）固定底部，轻阴影与内容区分隔


## 6. 功能需求（详细）

## 6.1 内容抽取（P0）
### 6.1.1 输入
- 当前 Tab URL 与 DOM

### 6.1.2 输出（ExtractResult）
- title、sourceUrl、domain、author?、publishTime?
- contentHtml（推荐 HTML）
- blocks（结构化块，用于拆分）
- images（候选图片列表）

### 6.1.3 抽取策略
- 微信公众号：优先定位正文容器（定向策略）
- 通用网页：Mozilla Readability 抽取正文
- 降级：
  1) Readability 失败 → 简化整页（去脚本/导航/评论）
  2) 仍失败 → 提示（P1：选中剪藏）

---

## 6.2 字数限制与自动拆分（P0）
### 6.2.1 阈值
- SAFE_LIMIT = 19,000（内部阈值，不对用户开放）

### 6.2.2 拆分规则
- 拆分优先级：标题块 → 段落/列表/引用 → 句子 → 硬切
- 多篇标题：`原文标题（i/n）`
- 每篇开头加元信息块：来源 URL、作者/公众号、发布时间、剪藏时间（必填）
- 权限：同一组 Part 一致

### 6.2.3 自适应再拆分（必做）
若服务端仍返回“字数超限”：
- 对失败 Part 再拆分（临时阈值 12,000）
- 递归重试最多 3 轮
- 目标：最终创建成功或输出可解释错误（接口不可用等）

---

## 6.3 图片能力（P0，重点）
### 6.3.1 目标与原则
- “尽可能抓取并上传”以保障回看不裂
- 图片失败不得阻塞文本创建：失败即转链接
- 超出 maxImages：不上传，直接转链接

### 6.3.2 maxImages（P0）
- 范围：0–200，默认 20
- 仅允许整数；负数归 0；超过归 200
- 超出数量：转为可点击链接（保留原 URL）

### 6.3.3 图片抽取覆盖面（必须）
按优先级解析真实 URL：
1) img.currentSrc
2) img.src
3) srcset 取最大宽度
4) 懒加载属性：data-src、data-original、data-url、data-lazy、data-srcset、data-actualsrc、data-hires…
5) 背景图：inline style / computedStyle background-image
6) picture/source srcset
7) og:image
8) link[rel=preload][as=image]

输出 ImageCandidate：id、url、kind、order、inMainContent、width/height?、alt?

### 6.3.4 图片抓取 Pipeline（必须）
抓取位置：
- 优先 Service Worker fetch
- 失败则 Content Script fetch（更可能携带上下文）
- data/blob：
  - data：解析 base64
  - blob：必须在 Content Script fetch(blobUrl)

失败分类（用于 UI 与统计）：
- AUTH_OR_HOTLINK（401/403）
- NOT_FOUND（404）
- TIMEOUT_OR_NET
- CORS_OR_BLOCKED
- INVALID_URL
- UNKNOWN

### 6.3.5 上传与替换
- 若 MCP 支持 URL 上传且 URL 可达：优先 URL 上传
- 否则使用二进制上传（若支持）
- 上传成功：替换正文 img src 为 assetUrl
- 上传失败：替换为“图片链接（原文第 X 张）：打开图片”

---

## 6.4 公开/私密（P0）
- Popup 提供开关：`发布公开笔记`
- Options 提供默认值：默认笔记权限（私密/公开）
- 若 createNote 支持 isPublic 参数则直接传；否则创建后调用 setNotePublic

---

## 6.5 索引笔记（P0，可配置）
- Options：`创建索引笔记`（默认开）
- 当拆分为多篇时：
  - 额外创建 1 篇索引笔记（标题：原文标题（索引））
  - 内容包含每一篇的链接与序号
  - 权限与分篇一致（建议与用户选择一致）

---

## 6.6 API Key 配置与测试连接（P0）
### 6.6.1 Key 存储
- chrome.storage.sync 优先（local 兜底）

### 6.6.2 测试连接
- 按钮：`测试连接`
- 动作：使用当前 Key 调用 MCP 创建测试笔记（强制私密）
- 成功回显：noteUrl（可点击打开）
- 失败回显：错误原因（映射）+ 重试

测试笔记规范：
- 标题：`【墨问笔记助手】连接测试（YYYY-MM-DD HH:mm）`
- 内容：固定短文 + 时间戳

---

## 7. 交互与文案（关键点）

### 7.1 Popup（未配置 Key）
- 功能总览始终展示
- CTA 主按钮：`先去配置 API Key`
- 次按钮：`查看教程`
- 辅助说明：`配置后即可开始保存到墨问`

### 7.2 Options（测试连接）
- 成功：`连接成功，已创建测试笔记。` + `打开测试笔记`
- 失败映射：
  - UNAUTHORIZED：`API Key 无效或已过期，请重新生成。`
  - NETWORK：`网络异常，请稍后再试。`
  - RATE_LIMIT：`请求过于频繁，请稍后再试。`
  - UNKNOWN：`测试失败，请重试。`

---

## 8. 技术方案（开发约束）

### 8.1 技术栈
- Chrome Extension Manifest V3
- React + TypeScript
- 构建：Vite（或 Plasmo，建议 Vite）
- 样式：TailwindCSS 或 CSS Modules
- 内容抽取：Mozilla Readability
- 可选清洗：DOMPurify

### 8.2 模块划分
- Popup（UI）
- Options（UI）
- Content Script：DOM 抽取、图片候选解析、blob/data 支持、必要时 fetch fallback
- Service Worker：队列、并发控制、图片抓取/上传、MCP 调用、重试、状态汇总

### 8.3 并发与队列
- 图片上传并发：默认 3
- Part 创建：串行（便于展示进度与失败定位）
- 重试：指数退避最多 3 次（NETWORK/RATE_LIMIT）

---

## 9. 数据结构（对齐实现）

### 9.1 Settings
- apiKey: string
- defaultPublic: boolean
- defaultIncludeImages: boolean
- maxImages: number (0–200)
- createIndexNote: boolean
- debugMode: boolean
- lastTestStatus/At/NoteUrl/Error…（可选缓存）

### 9.2 ExtractResult / Block / ImageCandidate
（沿用上一版 DESIGN.md 的结构定义）

---

## 10. 权限与合规（MV3）
- permissions 最小化（storage、activeTab、scripting、tabs）
- host_permissions：按需配置（或使用 activeTab + fetch 策略）
- API Key 仅保存在本地 storage，不上传第三方

---

## 11. 质量与非功能需求（NFR）
- 可用性：错误可解释、可恢复（重试/去设置）
- 性能：图片并发受控，避免卡死；超时有上限（建议 15s/图）
- 可靠性：文本优先；图片失败不阻塞；超长拆分必成功（可用时）
- 可观测：调试模式输出关键链路日志（抽取、拆分、上传、创建）

---

## 12. 里程碑与交付物（建议）
- M1：UI（Popup 首页总览 + Options 单列卡片）与 Settings 存取
- M2：测试连接（创建测试笔记）+ 错误映射
- M3：正文抽取（公众号+通用）+ 基础保存（无图）
- M4：图片抽取/抓取/上传 Pipeline + maxImages
- M5：超长拆分 + 索引笔记 + 全链路验收

交付物：
- 可运行的 Chrome MV3 扩展项目
- README（安装、配置、测试）
- 验收用例集合（至少覆盖 6 类图片与超长拆分）

---

## 13. 风险与对策
- 防盗链/403：必须降级为链接；保留 query；必要时 content fetch fallback
- Readability 误抽取：提供降级与（后续）选中剪藏
- MCP 能力差异：Adapter 层隔离；上传能力不支持则降级链接
- 用户误认为“已保存=已发布”：权限开关文案与默认值明确，测试笔记强制私密

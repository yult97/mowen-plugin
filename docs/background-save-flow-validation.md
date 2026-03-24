# Background 保存链路验证清单

适用范围：
- `src/background/index.ts`
- `src/background/messageRouter.ts`
- `src/background/saveTaskRuntime.ts`
- `src/background/imagePipeline.ts`
- `src/background/saveNoteFlow.ts`
- `src/popup/Popup.tsx`

目标：
- 验证拆分后主保存链路没有断
- 验证暂停 / 继续 / 取消不会串任务
- 验证图片处理、分片创建、合集创建仍按原链路衔接

## 一、实现者自检

每次改动这条链路后，先执行：

```bash
npm run typecheck
npm run build
```

必须确认：
- 构建通过
- 没有新增 TypeScript 错误
- 没有遗留未使用导出、未使用消息类型、未接线的 helper

建议补充静态检索：

```bash
rg -n "SAVE_NOTE|PAUSE_SAVE|RESUME_SAVE|CANCEL_SAVE|SAVE_NOTE_PAUSED|SAVE_NOTE_RESUMED" src
rg -n "prepareContentForSave|createSplitNotes|createIndexNoteIfNeeded|waitForTaskRunnable|finalizeSaveTask|processImages" src/background
```

重点确认：
- `SAVE_NOTE` 仍由 `messageRouter` 进入 `handleSaveNote`
- `handleSaveNote` 仍串联内容预处理、图片处理、分片创建、合集创建、任务收尾
- `PAUSE_SAVE / RESUME_SAVE / CANCEL_SAVE` 都仍由统一运行态控制

## 二、审查者链路检查

### 1. 消息分发闭环

必须逐项确认：
- Popup 发 `PAUSE_SAVE`，Background 只改当前 `taskId` 对应任务
- 任务在安全点进入 `paused` 后，Background 发 `SAVE_NOTE_PAUSED`
- Popup 仅在 `taskId` 匹配时展示取消确认框
- Popup 发 `RESUME_SAVE` 后，Background 恢复 waiters 并发 `SAVE_NOTE_RESUMED`
- Popup 发 `CANCEL_SAVE` 后，Background 进入 `cancelling` 并终止当前任务
- `SAVE_NOTE_COMPLETE` 只允许当前任务消费

### 2. 安全点覆盖

必须确认以下阶段前都会经过 `waitForTaskRunnable(...)`：
- 每张图片上传前
- 每个分片创建前
- 每次创建重试前
- 合集笔记创建前

判定标准：
- 确认框出现后，不应再进入新的上传或新的 `createNote`
- 已经发出的单个请求可自然结束，但结束后必须停住

### 3. 任务隔离

必须确认：
- 新任务开始前，旧任务上下文会被替换
- 旧 `taskId` 的暂停消息、进度消息、完成消息不会污染新任务 UI
- Popup 的取消确认框必须是 task-scoped，而不是全局布尔状态

## 三、测试者执行路径

当前仓库没有自动化端到端测试，这部分需要手工验证。

### 场景 1：普通文章保存

步骤：
1. 打开一篇普通网页
2. 点击保存
3. 等待保存成功

预期：
- 进度正常推进
- 最终只收到一次成功完成消息
- 成功页展示创建结果

### 场景 2：图片上传中点击取消

步骤：
1. 打开一篇带多张图片的文章
2. 点击保存
3. 在图片上传阶段点击取消
4. 等待确认框出现

预期：
- 确认框出现后，上传数量不再继续递增
- 不再进入新的笔记创建
- 点击继续后才恢复
- 点击停止后任务终止

### 场景 3：长文拆分 2 part 以上

步骤：
1. 打开一篇会被拆分的长文
2. 在第 1 篇创建期间点击取消
3. 等待确认框出现

预期：
- 第 1 个已发出的请求可以自然返回
- 确认框出现后，不得继续创建第 2 篇
- 点击继续后才允许继续后续 part
- 点击停止后后续 part 不得再创建

### 场景 4：合集创建前取消

步骤：
1. 打开启用“创建合集”的长文
2. 等所有分片完成，但合集尚未创建时点击取消

预期：
- 合集笔记不会继续创建
- 点击继续后才允许创建合集
- 点击停止后任务结束

### 场景 5：取消后重新保存

步骤：
1. 发起保存
2. 点击取消并选择停止
3. 回到预览页重新点击保存

预期：
- 新任务 `taskId` 变化
- 旧确认框不再显示
- 新任务从干净状态开始
- 旧任务晚到消息不会影响新任务界面

### 场景 6：关闭再打开 Popup / Side Panel

步骤：
1. 在保存过程中关闭 Popup 或切换 Side Panel 对应页面
2. 重新打开

预期：
- 若任务仍在运行，应恢复当前任务真实状态
- 若任务已暂停，只恢复当前任务的暂停确认态
- 不得恢复旧任务的确认框和旧进度

## 四、建议记录方式

每次手工验证至少记录：
- 页面类型：普通文章 / 多图文章 / 长文拆分 / 合集
- 操作点：上传中取消 / 分片创建中取消 / 合集前取消
- 实际结果：继续是否恢复、停止是否终止、是否有重复创建
- 是否出现旧确认框残留

## 五、当前限制

- 这份清单是可执行验证路径，不等于自动化测试
- 当前仓库缺少浏览器自动化脚本，无法替代真实交互验证
- 如果后续要进一步提高置信度，建议补一套基于 Playwright 的扩展页交互测试

# 通用 Codex Agents 模板

这套 `.codex/agents/*.toml` 是通用模板，不绑定当前项目业务。

适用场景：

- 新项目初始化
- 多代理协作
- 代码排查、代码审查、安全检查、测试设计、文档核对、落地实现

## 文件说明

- `explorer.toml`
  - 用于代码探索、执行路径梳理、问题定位前的信息收集
- `reviewer.toml`
  - 用于代码审查，重点找正确性、安全性、回归和缺失测试
- `docs-researcher.toml`
  - 用于核对官方文档、版本行为和一手资料
- `security-reviewer.toml`
  - 用于安全专项审查
- `tester.toml`
  - 用于测试矩阵、验收场景和覆盖缺口分析
- `implementer.toml`
  - 用于按方案实施代码并完成最小验证

## TOML 结构

目前采用的基础字段是：

```toml
model = "gpt-5.4"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
这里写该 agent 的职责、约束和输出要求
"""
```

## 使用建议

- 想先查明问题，不想直接改代码：用 `explorer`
- 想从 owner 视角找 bug：用 `reviewer`
- 想核实框架或 API 行为：用 `docs-researcher`
- 想看权限、密钥、注入、代理、越权：用 `security-reviewer`
- 想补测试和验收清单：用 `tester`
- 方案明确后开始落地：用 `implementer`

## 迁移到其他项目

复制以下内容即可：

- `.codex/agents/`
- 根目录 `AGENTS.md`（如果你也希望有项目级总约束）

复制后建议按项目特点调整：

- `sandbox_mode`
- 默认模型
- 是否需要更高推理强度
- 是否加入特定技术栈要求（例如前端、后端、扩展、移动端、AI 服务）

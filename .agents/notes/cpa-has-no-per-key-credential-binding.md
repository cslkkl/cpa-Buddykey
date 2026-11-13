# 依据：CPA 没有按 key 绑定账号的能力（2026-11-12）

状态：生效

## 背景

要实现「每把 key 限定只能用某几个号」，先确认 CPA 自己支不支持。

## 结论

不支持。三条证据：

- `access.api-keys` 是纯字符串列表（实测 `GET /v0/management/api-keys` 回
  `{"api-keys":["sk-cpa-example"]}`），没有对象形态、没有附加字段。
- `config.example.yaml` 的 `routing` 段只有 `strategy`（round-robin /
  weighted-round-robin / fill-first）、`session-affinity`、`force-model-prefix`、
  `retry`，没有 per-key 选择器。
- `weight` 能排除账号（非正权重），但那是**凭据级、全局生效**的，不是按 key。

## 支撑的决策

[账号范围用「串行切换启用集合」实现](2026-11-12-account-scope-via-toggle.md)

## 影响

若上游以后支持 per-key credential binding，本实现应整体替换成配置式绑定，
届时 `withScopeLock` 与 `narrowToScope` 可以整段删除。

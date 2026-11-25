# PLAN: rust-service

> 版本：v0.1　程序阶段：P1
> 状态：进行中

## 里程碑总览

| M | 名称 | 目标 | 验收标准 |
|---|---|---|---|
| M1 | 骨架 | crate 与 `add` | `cargo test --locked` |
| M2 | 校验 | 输入溢出处理 | `cargo test --locked` |

## 里程碑详情

### M1 — 骨架

- **影响文件**：`src/lib.rs`。
- **验收标准（可执行）**：
  - [ ] `cargo test --locked` 通过

### M2 — 校验

- **影响文件**：`src/lib.rs`。
- **验收标准（可执行）**：
  - [ ] `cargo test --locked` 通过

#!/usr/bin/env bash
# Walk a minimal workspace through init → status → messages.
# Everything happens in a throwaway directory under $TMPDIR.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
[ -f "$CLI" ] || { echo "build first: npm run build"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wf-demo-XXXXXX")"
REPO="$WORK/demo-service"
mkdir -p "$REPO/docs" "$REPO/src"

cat > "$REPO/PLAN.md" <<'PLAN'
# PLAN: demo-service

| M | 名称 | 目标 |
|---|---|---|
| M1 | 骨架 | 建 crate 与最小入口 |
| M2 | 接口 | 暴露 /health |
PLAN

cat > "$REPO/TODO-M1.md" <<'TODO'
# TODO-M1: 骨架

> 状态：待实现　受验 SHA：实现完成后回填

## 0. 边界

- **影响文件**：
  - `src/lib.rs`

## 3. 验收标准（可执行）

- [ ] `cargo test` 通过
TODO

echo 'pub fn hello() -> &'"'"'static str { "hi" }' > "$REPO/src/lib.rs"

(
  cd "$REPO"
  git init -q
  git config user.email demo@example.com
  git config user.name demo
  git add -A
  git commit -qm init
)

echo "== workspace: $WORK"
echo
echo "== 1. adopt"
node "$CLI" init --root "$WORK" --repo demo-service
echo
echo "== 2. status"
node "$CLI" status --root "$WORK"
echo
echo "== 3. doctor"
node "$CLI" doctor --root "$WORK" || true
echo
echo "== 4. message: main -> user"
node "$CLI" send --root "$WORK" --from main --to user --kind event \
  --subject "M1 待实现" --body "TODO-M1 已就绪，可以安排 TODO agent 领取。"
node "$CLI" inbox --root "$WORK" --role user
echo
echo "== 5. dashboard"
echo "node $CLI web --root $WORK --port 7788"
echo "open http://127.0.0.1:7788"

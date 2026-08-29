#!/usr/bin/env bash
# M1/M2 传输层冒烟：向 TypeScript Runtime 管道输入合法/非法请求，
# 预期输出 ready 通知、各 JSON-RPC 错误码与业务错误。需先 pnpm build:packages。
# 完整聊天链路见 scripts/smoke-chat.mjs（内嵌 mock Provider）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="$(mktemp -d)"
trap 'rm -rf "$DATA_DIR"' EXIT

printf '%s\n' \
  'not json' \
  '{"jsonrpc":"2.0"}' \
  '{"jsonrpc":"2.0","id":1,"method":"runtime.get_status","params":{"requestId":"r1"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"project.create","params":{"requestId":"r2","name":"冒烟项目"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"message.send","params":{"requestId":"r3","sessionId":"missing","content":"hi"}}' \
  '{"jsonrpc":"2.0","id":4,"method":"message.send","params":{}}' \
  '{"jsonrpc":"2.0","id":5,"method":"nope","params":{"requestId":"r5"}}' \
  '{"jsonrpc":"2.0","id":6,"method":"runtime.shutdown"}' \
  | REFLEXION_DATA_DIR="$DATA_DIR" node "$ROOT/apps/runtime/dist/index.js"

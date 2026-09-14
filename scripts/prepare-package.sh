#!/usr/bin/env bash
# 打包前资源准备（tauri build 的 beforeBuildCommand 调用，亦可单独执行）：
#   1. bundle-runtime.mjs      把 TS Runtime 打成单文件 runtime.mjs
#   2. fetch-node-dist.mjs     下载/校验 Node 官方发行版并提取 node 可执行文件
#   3. 拷贝 reflexion-system-runtime（release；每次按当前源码构建）进资源目录
# 全部产物落在 apps/desktop/src-tauri/package-resources/（gitignore），
# 由 tauri.conf.json 的 bundle.resources 打进安装包。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES="$ROOT/apps/desktop/src-tauri/package-resources"

node "$SCRIPT_DIR/bundle-runtime.mjs"
node "$SCRIPT_DIR/fetch-node-dist.mjs"

SIDECAR_SRC="$ROOT/crates/target/release/reflexion-system-runtime"
SIDECAR_SRC_EXE="$SIDECAR_SRC.exe"
# 始终以当前源码构建：cargo 增量，源码新鲜时是秒级 no-op。此前的
# "仅缺失才构建"会把旧 release 二进制原样打进包——W4 打包冒烟实测踩中
# （staged sidecar 报 protocolVersion 1.0，TS runtime 握手拒绝 → 打包后
# system runtime 永久 degraded）。
echo "building reflexion-system-runtime (release)"
(cd "$ROOT" && cargo build --release --manifest-path crates/Cargo.toml)
if [[ ! -f "$SIDECAR_SRC" && ! -f "$SIDECAR_SRC_EXE" ]]; then
  echo "reflexion-system-runtime release build not found after cargo build" >&2
  exit 1
fi

mkdir -p "$RESOURCES/bin"
if [[ -f "$SIDECAR_SRC" ]]; then
  cp "$SIDECAR_SRC" "$RESOURCES/bin/"
else
  cp "$SIDECAR_SRC_EXE" "$RESOURCES/bin/"
fi
echo "package resources staged under $RESOURCES"

#!/usr/bin/env bash
# 打包前资源准备（tauri build 的 beforeBuildCommand 调用，亦可单独执行）：
#   1. bundle-runtime.mjs      把 TS Runtime 打成单文件 runtime.mjs
#   2. fetch-node-dist.mjs     下载/校验 Node 官方发行版并提取 node 可执行文件
#   3. 拷贝 reflexion-system-runtime（release；缺失则现场构建）进资源目录
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
if [[ ! -f "$SIDECAR_SRC" && ! -f "$SIDECAR_SRC_EXE" ]]; then
  echo "building reflexion-system-runtime (release)"
  (cd "$ROOT" && cargo build --release --manifest-path crates/Cargo.toml)
fi

mkdir -p "$RESOURCES/bin"
if [[ -f "$SIDECAR_SRC" ]]; then
  cp "$SIDECAR_SRC" "$RESOURCES/bin/"
else
  cp "$SIDECAR_SRC_EXE" "$RESOURCES/bin/"
fi
echo "package resources staged under $RESOURCES"

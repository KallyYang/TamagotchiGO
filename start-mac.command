#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$SCRIPT_DIR" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。"
  echo "请先安装 Node.js 18 或更高版本，再重新双击此文件。"
  echo
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

node "$SCRIPT_DIR/scripts/launch.js"
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo
  echo "启动失败，退出码: $STATUS"
else
  echo
  echo "服务已停止。"
fi

read -r -p "按回车键关闭窗口..."
exit $STATUS

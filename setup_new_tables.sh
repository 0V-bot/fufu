#!/usr/bin/env bash
# 建表脚本包装：真正逻辑在 setup_new_tables.js（用 Node 文件方式传中文，规避 Git Bash 编码问题）。
# 用法： BASE_TOKEN=xxxx bash ./setup_new_tables.sh
cd "$(dirname "$0")"
exec node ./setup_new_tables.js "$@"

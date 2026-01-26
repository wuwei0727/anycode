#!/bin/bash
# 获取 Codex 模型列表的脚本
# 使用 expect 或 script 命令模拟终端

# 创建临时文件
TMPFILE=$(mktemp)

# 使用 script 命令模拟终端，发送 /model 命令并捕获输出
# 超时 10 秒后自动退出
timeout 10 script -q -c "codex" "$TMPFILE" <<EOF
/model
q
EOF

# 解析输出，提取模型信息
cat "$TMPFILE" | grep -E "^\s*[0-9]+\." | sed 's/\x1b\[[0-9;]*m//g'

# 清理临时文件
rm -f "$TMPFILE"

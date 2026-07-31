#!/usr/bin/env bash
# ============================================================================
# sync-skill.sh — 让本地运行时 skill 与仓库里的 skill 始终保持一致
#
# 为什么需要它：
#   本地运行时 skill 在  ~/.workbuddy/skills/life-wisdom-content-processor/
#   仓库里的 skill 在    <仓库>/workbench/skills/life-wisdom-content-processor/
#   Windows 上无法可靠创建软链接（ln -s 会悄悄变成复制），所以改用本脚本同步。
#   约定：仓库里的那份是「发布源 / 真源」（要推送给朋友的就是它），
#         本地那份是「运行时镜像」（WorkBuddy 实际加载的就是它）。
#
# 用法（在 Git Bash 里跑）：
#   ./tools/sync-skill.sh            # 只显示两边差异，不改动任何文件（默认）
#   ./tools/sync-skill.sh status     # 同上，显示差异
#   ./tools/sync-skill.sh pull       # 仓库 -> 本地（把仓库最新版部署到运行时）
#   ./tools/sync-skill.sh push       # 本地 -> 仓库（把你在本机改的内容收回到仓库，便于 git 提交）
#
# 说明：
#   - pull / push 会先打印差异摘要再复制，不会静默覆盖；
#   - 复制的是整个目录内容（以后若加 references/ 等子文件也会一并同步）；
#   - push 之后记得 `git add / commit / push` 把仓库改动推上去。
# ============================================================================

LOCAL="/c/Users/Administrator/.workbuddy/skills/life-wisdom-content-processor"
REPO="/c/Users/Administrator/WorkBuddy/傅傅的工作台/workbench/skills/life-wisdom-content-processor"

cyan(){ printf '\033[36m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }
red(){ printf '\033[31m%s\033[0m\n' "$1"; }

if [ ! -d "$LOCAL" ]; then red "✗ 本地 skill 目录不存在: $LOCAL"; exit 1; fi
if [ ! -d "$REPO" ]; then red "✗ 仓库 skill 目录不存在: $REPO"; exit 1; fi

show_status(){
  cyan "== 差异对比 =="
  echo "本地(运行时): $LOCAL"
  echo "仓库(发布源): $REPO"
  echo
  if diff -r -q "$LOCAL" "$REPO" >/dev/null 2>&1; then
    green "✓ 两边完全一致，无需同步。"
  else
    yellow "⚠ 两边存在差异，详情如下："
    diff -r -q "$LOCAL" "$REPO"
    echo
    local_m=$(stat -c %Y "$LOCAL/SKILL.md" 2>/dev/null || echo 0)
    repo_m=$(stat -c %Y "$REPO/SKILL.md" 2>/dev/null || echo 0)
    if [ "$local_m" -gt "$repo_m" ]; then
      yellow "→ 本地 SKILL.md 更新（$(date -d @$local_m '+%Y-%m-%d %H:%M')），建议运行: ./tools/sync-skill.sh push"
    elif [ "$repo_m" -gt "$local_m" ]; then
      yellow "→ 仓库 SKILL.md 更新（$(date -d @$repo_m '+%Y-%m-%d %H:%M')），建议运行: ./tools/sync-skill.sh pull"
    fi
  fi
}

do_sync(){
  local from="$1" to="$2" label="$3"
  cyan "== $label =="
  yellow "将复制: $from  ->  $to"
  diff -r -q "$from" "$to" 2>/dev/null | sed 's/^/  差异: /'
  mkdir -p "$to"
  cp -r "$from/." "$to/"
  green "✓ 同步完成。"
}

case "${1:-status}" in
  status) show_status ;;
  pull)   do_sync "$REPO" "$LOCAL" "仓库 → 本地（部署到运行时）" ;;
  push)   do_sync "$LOCAL" "$REPO" "本地 → 仓库（收回改动，随后请 git 提交）" ;;
  *) red "未知参数: $1 （可用: status | pull | push）"; exit 1 ;;
esac

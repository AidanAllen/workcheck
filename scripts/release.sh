#!/usr/bin/env bash
#
# workcheck 发版脚本
#
#   ./scripts/release.sh 1.0.1           发正式版 v1.0.1
#   ./scripts/release.sh 1.1.0-rc.1      发预发布（GitHub 上会标 pre-release）
#   ./scripts/release.sh 1.0.1 --dry-run 只检查、打印将做什么，不改任何东西
#
# 为什么要这个脚本：升一个版本要同步多处版本号（package.json、package-lock.json
# 的两处；docker-compose.yaml 钉版本标签时还有两处），再走提交 / 打标签 / 建 Release。
# 手工做漏一处的后果都不轻 —— 尤其是漏了 compose 的 context，
# 用户下到的还是旧版本的编排文件。
#
# 脚本会做到：
#   1. 前置检查（工作区干净、分支正确、标签不存在、版本号格式）
#   2. 版本号一起改，并断言改后一致
#   3. 跑 selftest，不过就中止
#   4. 提交 + 推 main
#   5. 打附注标签 + 推送
#   6. 按模板生成 Release 说明（本版变化从提交历史自动归类）+ 建 Release
#
# 出错时尽量停在做完一半之前；已经改动的文件会提示你怎么撤。

set -euo pipefail

REPO_SLUG="AidanAllen/workcheck"
TARGET_BRANCH="main"

# ---------------------------------------------------------------- 参数与输出

VERSION=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "用法：$0 <版本号> [--dry-run]" >&2
  echo "例如：$0 1.0.1" >&2
  exit 2
fi

# 去掉可能带上的 v 前缀，内部统一不带
VERSION="${VERSION#v}"
TAG="v$VERSION"

if [ "$DRY_RUN" = "1" ]; then
  info() { echo "[dry-run] $*"; }
else
  info() { echo "$*"; }
fi
die() { echo "错误：$*" >&2; exit 1; }

# 在项目根跑（脚本可能被从别处调用）
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---------------------------------------------------------------- 前置检查

info "== 前置检查 =="

# 版本号格式：要求 semver，允许 -rc.1 这类预发布后缀
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  die "版本号格式不对：$VERSION（应为 1.2.3 或 1.2.3-rc.1）"
fi
IS_PRERELEASE=0
case "$VERSION" in *-*) IS_PRERELEASE=1 ;; esac

for f in package.json package-lock.json docker-compose.yaml scripts/release-notes-template.md scripts/check-version.js; do
  [ -f "$f" ] || die "找不到 $f（请在项目根运行）"
done

[ -d .git ] || die "当前目录不是 git 仓库"

# 工作区必须干净：否则提交时会把无关改动一起卷进去
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动：" >&2
  git status --short >&2
  die "先提交或 stash 掉再发版，避免把无关改动卷进版本里"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" = "$TARGET_BRANCH" ] || die "当前在 $CURRENT_BRANCH 分支，发版要在 $TARGET_BRANCH 上"

# 标签不能已存在（本地和远程都查）
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "本地已有标签 $TAG"
if git ls-remote --tags --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "远程已有标签 $TAG —— 已发布的版本不要覆盖；若要修问题请发新版本号"
fi

# 与远程同步，避免基于旧代码发版
git fetch --quiet origin "$TARGET_BRANCH"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$TARGET_BRANCH")"
[ "$LOCAL_HEAD" = "$REMOTE_HEAD" ] || die "本地 $TARGET_BRANCH 与远程不一致，先 git pull / push"

OLD_VERSION="$(node -p "require('./package.json').version")"
if [ "$OLD_VERSION" = "$VERSION" ]; then
  die "package.json 已经是 $VERSION，换个版本号"
fi

# 发版前先确认当前仓库的版本号本身是自洽的 —— 否则我们会「基于一个已经脱节的
# 状态」往上改，改完还是错的。这一步只读，不改任何东西。
if ! node scripts/check-version.js "$OLD_VERSION"; then
  die "发版前四处版本号就不一致，先修好再来发版"
fi

info "  当前版本 $OLD_VERSION  →  $VERSION"
info "  目标标签 $TAG$([ "$IS_PRERELEASE" = "1" ] && echo '（预发布）')"
info "  工作区干净，分支 $CURRENT_BRANCH，与远程一致 ✓"

# ---------------------------------------------------------------- 改版本号

info ""
info "== 同步版本号 =="

# 把某个文件里「本项目」的版本号替换掉，返回替换处数。
# 只替换前 N 次出现（N=0 表示不限），避免动到依赖包自己的 version 字段：
#   package.json      —— 1 处
#   package-lock.json —— 2 处（顶层 + packages[""]），之后都是依赖的 version
#   docker-compose.yaml —— 4 处，全都要改，所以传 0（仅在钉版本模式下）
replace_versions() {
  local file="$1" limit="$2"
  node -e '
    const fs = require("fs");
    const [file, limitRaw, oldV, newV] = process.argv.slice(1);
    const limit = limitRaw === "0" ? Infinity : Number(limitRaw);
    const esc = oldV.replace(/\./g, "\\.");
    let text = fs.readFileSync(file, "utf8");
    let count = 0;
    // 版本号必须紧跟在明确的上下文之后才算数，避免误伤依赖包自己的 version。
    // 三种上下文：
    //   :vX  → compose 的 image: workcheck:vX，以及注释里举例的 myhost/workcheck:vX
    //   #vX  → compose 的 context: ...git#vX，以及注释里的 #vX
    //   "version": "   → package*.json 的版本字段
    // `#v` 必须作为独立分支列出：早先写成 `:#?v?`（要求前面先有个冒号），
    // 于是 `context: ...git#v1.0.0` 和 `# 想跟... #v1.0.0` 两行都匹配不上 ——
    // compose 只改到 2 处，发版直接中止。
    text = text.replace(
      new RegExp(`(:v?|#v|"version":\\s*")${esc}`, "g"),
      (m, pre) => { if (count < limit) { count++; return pre + newV; } return m; }
    );
    fs.writeFileSync(file, text);
    process.stdout.write(String(count));
  ' "$file" "$limit" "$OLD_VERSION" "$VERSION"
}

if [ "$DRY_RUN" = "0" ]; then
  n1="$(replace_versions package.json 1)"
  n2="$(replace_versions package-lock.json 2)"
  info "  package.json        $n1 处"
  info "  package-lock.json   $n2 处"

  # 替换次数断言：数量对不上说明文件结构变了（有人加了版本号、或正则误伤）
  [ "$n1" = "1" ] || die "package.json 替换了 $n1 处，应为 1 处"
  [ "$n2" = "2" ] || die "package-lock.json 替换了 $n2 处，应为 2 处"

  # compose 有两种形态，处理方式不同：
  #   钉版本（#vX.Y.Z + :vX.Y.Z）—— 跟着一起改，改不到 4 处说明文件结构变了
  #   跟分支（#main   + :main  ）—— 里面没有版本号，跳过。
  #     （跟分支时若硬要替换，check-version 会拿 "main" 去和 package.json 的
  #      版本号比，永远不一致，发版直接中止）
  COMPOSE_MODE="$(node -e '
    const fs = require("fs");
    const t = fs.readFileSync("docker-compose.yaml", "utf8");
    const ctx = t.match(/^\s*context:.*#([\w.\-]+)\s*$/m);
    const re = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
    process.stdout.write(ctx && re.test(ctx[1]) ? "tag" : "branch");
  ')"
  if [ "$COMPOSE_MODE" = "tag" ]; then
    n3="$(replace_versions docker-compose.yaml 0)"
    info "  docker-compose.yaml $n3 处"
    [ "$n3" = "4" ] || die "docker-compose.yaml 替换了 $n3 处，应为 4 处（context / image / 两处注释）"
  else
    info "  docker-compose.yaml 跳过（跟分支模式，文件里没有版本号）"
  fi

  # 替换完再由独立脚本核对一遍：各处是否齐全、是否一致、是否等于目标版本。
  # 逻辑不在这里重写 —— 检查规则（尤其「不能直接 grep，依赖包自己的 version
  # 也可能是 1.0.0」这个坑）只在 check-version.js 里维护一份，避免两处漂移。
  if ! node scripts/check-version.js "$VERSION"; then
    die "版本号同步失败（工作区改动还在，用 git checkout -- . 撤销）"
  fi
else
  info "  [dry-run] 将把 package.json(1) / package-lock.json(2) 改为 $VERSION"
  info "  [dry-run] compose 若处于钉版本模式，还会同步其中的 4 处"
fi

# ---------------------------------------------------------------- 跑测试

info ""
info "== 自检 =="
if [ "$DRY_RUN" = "0" ]; then
  npm run --silent selftest || die "selftest 未通过，已中止（版本号改动还在工作区，用 git checkout -- . 撤销）"
else
  info "  [dry-run] 跳过 selftest"
fi

# ---------------------------------------------------------------- 生成说明

info ""
info "== 生成 Release 说明 =="

# 从上一个标签到现在的提交，按 conventional 前缀归类
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo '')"

classify() {
  local range="$1"
  local feat="" fix="" ui="" docs="" perf="" chore="" other=""
  # 从旧到新列出，每行是 subject（去掉 hash）
  while IFS= read -r subject; do
    [ -n "$subject" ] || continue
    case "$subject" in
      feat:*|feat\(*)     feat="$feat- ${subject#feat: }"$'\n' ;;
      fix:*|fix\(*)       fix="$fix- ${subject#fix: }"$'\n' ;;
      ui:*|ui\(*)         ui="$ui- ${subject#ui: }"$'\n' ;;
      docs:*|docs\(*)     docs="$docs- ${subject#docs: }"$'\n' ;;
      perf:*|perf\(*)     perf="$perf- ${subject#perf: }"$'\n' ;;
      chore:*|chore\(*)   chore="$chore- ${subject#chore: }"$'\n' ;;
      refactor:*|refactor\(*) other="$other- ${subject#refactor: }"$'\n' ;;
      *)                  other="$other- $subject"$'\n' ;;
    esac
  done <<< "$(git log --no-merges --pretty=format:'%s' "$range" 2>/dev/null || true)"

  local out=""
  [ -n "$feat" ] && out="$out"$'\n'"**新功能**"$'\n\n'"$feat"
  [ -n "$fix" ]  && out="$out"$'\n'"**修复**"$'\n\n'"$fix"
  [ -n "$ui" ]   && out="$out"$'\n'"**界面**"$'\n\n'"$ui"
  [ -n "$perf" ] && out="$out"$'\n'"**优化**"$'\n\n'"$perf"
  [ -n "$docs" ] && out="$out"$'\n'"**文档**"$'\n\n'"$docs"
  [ -n "$chore" ] && out="$out"$'\n'"**杂项**"$'\n\n'"$chore"
  [ -n "$other" ] && out="$out"$'\n'"**其他**"$'\n\n'"$other"
  printf '%s' "$out" | sed '/^$/N;/^\n$/D'
}

if [ -n "$PREV_TAG" ]; then
  CHANGELOG="$(classify "$PREV_TAG..HEAD")"
  RANGE_DESC="自 \`$PREV_TAG\` 以来"
else
  CHANGELOG="$(classify "HEAD")"
  RANGE_DESC="首个版本"
fi

if [ -z "$CHANGELOG" ]; then
  CHANGELOG="（本次没有代码提交，仅版本号变更）"
fi

# 临时文件放项目内的 .git 目录旁边，而不是 mktemp 的默认位置。
# 原因：Windows 上 mktemp 给出的是 `C:\Users\...\Temp/tmp.xxx` 这种混合路径，
# 某些环境的 rm 会拒绝（"embedded drive prefix is not allowed"）—— 清理失败会让
# trap 的退出码覆盖脚本本身的退出码，于是「发布成功」被报成「失败」。
# 放项目内、自己拼文件名，两端路径都干净。trap 里加 `|| true` 双保险：
# 清理失败绝不该影响发版结果。
NOTES_FILE="$ROOT/.release-notes.$$.tmp"
cleanup() { rm -f "$NOTES_FILE" 2>/dev/null || true; }
trap cleanup EXIT
node -e '
  const fs = require("fs");
  const [tpl, out, version, range, changelog] = process.argv.slice(1);
  let text = fs.readFileSync(tpl, "utf8");
  if (range) text = text.replace("## 本版变化", `## 本版变化（${range}）`);
  text = text.replace("<!--CHANGELOG-->", changelog.trim());
  text = text.split("__VERSION__").join(version);
  fs.writeFileSync(out, text);
' scripts/release-notes-template.md "$NOTES_FILE" "$VERSION" "$RANGE_DESC" "$CHANGELOG"

info "  依据：$RANGE_DESC"
echo "$CHANGELOG" | sed 's/^/    /'

# ---------------------------------------------------------------- 提交与发布

info ""
info "== 提交 =="
if [ "$DRY_RUN" = "0" ]; then
  git add package.json package-lock.json docker-compose.yaml
  git commit --quiet -m "chore: 发布 $TAG"
  info "  已提交：chore: 发布 $TAG"
  git push --quiet origin "$TARGET_BRANCH"
  info "  已推送 $TARGET_BRANCH"
else
  info "  [dry-run] 将提交 package.json / package-lock.json / docker-compose.yaml"
fi

info ""
info "== 打标签 =="
if [ "$DRY_RUN" = "0" ]; then
  git tag -a "$TAG" -m "$TAG"
  git push --quiet origin "$TAG"
  info "  已推送标签 $TAG"
else
  info "  [dry-run] 将创建并推送标签 $TAG"
fi

info ""
info "== 建 Release =="
if [ "$DRY_RUN" = "0" ]; then
  RELEASE_ARGS=(--title "workcheck $TAG" --notes-file "$NOTES_FILE")
  [ "$IS_PRERELEASE" = "1" ] && RELEASE_ARGS+=(--prerelease)
  gh release create "$TAG" "${RELEASE_ARGS[@]}" >/dev/null
  info "  $TAG 已发布"
else
  info "  [dry-run] 将创建 Release $TAG"
fi

URL="https://github.com/$REPO_SLUG/releases/tag/$TAG"
info ""
if [ "$DRY_RUN" = "1" ]; then
  info "dry-run 结束，未改动任何东西。"
  info "实际发布请去掉 --dry-run。"
else
  info "完成 → $URL"
  info ""
  info "下一步：确认 Release 页面上的 compose 链接可用："
  info "  curl -sI https://raw.githubusercontent.com/$REPO_SLUG/refs/tags/$TAG/docker-compose.yaml | head -1"
fi

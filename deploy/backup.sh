#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OpenChat 热库备份：sqlite3 .backup → 加密 → 异地 → 保留 N 天
#
#   sudo ./deploy/backup.sh            # 立即备份
#   sudo ./deploy/backup.sh --dry-run  # 只校验环境与估算空间，不写任何文件
#
# 策略来源：/etc/openchat/policy.json 的 backup 段
#   { "cron": "30 5 * * *", "dir": "/var/lib/openchat/backup", "keep_days": 14 }
# 环境变量覆盖（便于测试与异地场景）：
#   OPENCHAT_DB              热库路径（默认 /var/lib/openchat/chatd.db）
#   OPENCHAT_BACKUP_DIR      本地备份目录（默认取 policy.backup.dir）
#   OPENCHAT_BACKUP_KEY      加密口令文件（默认 /etc/openchat/backup.key）
#   OPENCHAT_BACKUP_RSYNC    异地 rsync 目标（user@host:/path）
#   OPENCHAT_BACKUP_S3       对象存储 URI（s3://bucket/prefix，用 aws 或 rclone）
#   OPENCHAT_AGE_RECIPIENT   age 公钥（age1...）；设置则优先用 age 加密
#
# 加密：优先 age（收件人公钥，适合异地不可信存储）；否则 openssl
#       AES-256-CBC + PBKDF2(200k) + salt，口令来自 backup.key。
# 失败语义：任何一步失败即非 0 退出（systemd timer 会记录 failed）。
# 日志：只写 stdout → journald。
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

ETC="${OPENCHAT_ETC:-/etc/openchat}"
POLICY="$ETC/policy.json"
DB="${OPENCHAT_DB:-/var/lib/openchat/chatd.db}"
KEY="${OPENCHAT_BACKUP_KEY:-$ETC/backup.key}"
DRY_RUN=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数: $arg（只支持 --dry-run）" ;;
  esac
done

command -v sqlite3 >/dev/null 2>&1 || die "缺少 sqlite3（apk add sqlite / apt install sqlite3）"
[ -f "$DB" ] || die "热库不存在: $DB（检查 hot_db 配置与服务是否启动）"

# policy.json 是策略唯一真源；用极简解析（不引入 jq 依赖）
policy_int() {
  _key="$1"; _default="$2"
  [ -f "$POLICY" ] || { echo "$_default"; return; }
  _v=$(sed -n "s/.*\"$_key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$POLICY" | head -n1 || true)
  echo "${_v:-$_default}"
}
policy_str() {
  _key="$1"; _default="$2"
  [ -f "$POLICY" ] || { echo "$_default"; return; }
  _v=$(sed -n "s/.*\"$_key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$POLICY" | head -n1 || true)
  echo "${_v:-$_default}"
}

KEEP_DAYS=$(policy_int keep_days 14)
BACKUP_DIR="${OPENCHAT_BACKUP_DIR:-$(policy_str dir /var/lib/openchat/backup)}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE="openchat-$STAMP"

log "备份开始 stamp=$STAMP db=$DB dir=$BACKUP_DIR keep_days=$KEEP_DAYS"

# ---------------------------------------------------------------------------
# 0. 预检：依赖、空间
# ---------------------------------------------------------------------------
DB_SIZE=$(wc -c < "$DB" | tr -d ' ')
NEED_KB=$(( DB_SIZE / 1024 * 3 / 2 + 1024 ))   # 明文 + 密文 + 余量

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run：不写任何文件"
  echo "  db_size_bytes    : $DB_SIZE"
  echo "  need_space_kb    : $NEED_KB"
  echo "  backup_dir       : $BACKUP_DIR"
  echo "  keep_days        : $KEEP_DAYS"
  command -v age >/dev/null 2>&1 && echo "  encrypt          : age (可用)" || echo "  encrypt          : openssl (age 未安装)"
  command -v openssl >/dev/null 2>&1 || warn "openssl 不可用，且 age 未必可用"
  [ -f "$KEY" ] && echo "  key              : $KEY（存在）" || warn "密钥文件不存在: $KEY"
  [ -n "${OPENCHAT_BACKUP_RSYNC:-}" ] && echo "  offsite(rsync)   : $OPENCHAT_BACKUP_RSYNC"
  [ -n "${OPENCHAT_BACKUP_S3:-}" ] && echo "  offsite(object)  : $OPENCHAT_BACKUP_S3"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
AVAIL_KB=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}' | tr -dc '0-9')
AVAIL_KB=${AVAIL_KB:-0}
[ "$AVAIL_KB" -ge "$NEED_KB" ] || die "备份盘空间不足：需要 ${NEED_KB}KB，可用 ${AVAIL_KB}KB"

TMP=$(mktemp -d "$BACKUP_DIR/.tmp.XXXXXX")
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 1. sqlite3 在线备份（.backup 使用 SQLite Backup API，与写入并发安全）
# ---------------------------------------------------------------------------
log "1/5 sqlite3 .backup → $TMP/$BASE.db"
sqlite3 "$DB" ".backup '$TMP/$BASE.db'"
[ -s "$TMP/$BASE.db" ] || die "备份文件为空"

CHECK=$(sqlite3 "$TMP/$BASE.db" "PRAGMA integrity_check;" | head -n1)
[ "$CHECK" = "ok" ] || die "备份库完整性校验失败: $CHECK"
log "     integrity_check = ok"

PLAIN_SHA=$(sha256sum "$TMP/$BASE.db" | awk '{print $1}')

# 附带清单：不含任何业务数据，只用于恢复时核对
cat > "$TMP/$BASE.manifest.json" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_db": "$DB",
  "source_bytes": $DB_SIZE,
  "sha256_plain": "$PLAIN_SHA",
  "retention_days": $KEEP_DAYS,
  "host": "$(hostname 2>/dev/null || echo unknown)"
}
EOF

# ---------------------------------------------------------------------------
# 2. 加密
# ---------------------------------------------------------------------------
log "2/5 加密"
# age 收件人：环境变量优先；否则把 backup.key 当作公钥文件（age1...）解读
AGE_RECIPIENT="${OPENCHAT_AGE_RECIPIENT:-}"
if [ -z "$AGE_RECIPIENT" ] && [ -s "$KEY" ] && head -c 4 "$KEY" | grep -q '^age1'; then
  AGE_RECIPIENT=$(tr -d '\n' < "$KEY")
fi
if command -v age >/dev/null 2>&1 && [ -n "$AGE_RECIPIENT" ]; then
  age -r "$AGE_RECIPIENT" -o "$TMP/$BASE.db.age" "$TMP/$BASE.db"
  ENC_FILE="$BASE.db.age"
  log "     age -r $AGE_RECIPIENT"
else
  command -v openssl >/dev/null 2>&1 || die "既无可用 age 收件人，也无 openssl"
  [ -s "$KEY" ] || die "缺少备份口令文件: $KEY（应已由 install.sh 生成）"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$TMP/$BASE.db" -out "$TMP/$BASE.db.enc" -pass "file:$KEY"
  ENC_FILE="$BASE.db.enc"
  log "     openssl aes-256-cbc (pbkdf2, 200k iter)"
fi

[ -s "$TMP/$ENC_FILE" ] || die "加密输出为空"
# 立即删除明文（shred 可用则覆写）
if command -v shred >/dev/null 2>&1; then
  shred -u "$TMP/$BASE.db"
else
  rm -f "$TMP/$BASE.db"
fi

ENC_SHA=$(sha256sum "$TMP/$ENC_FILE" | awk '{print $1}')
printf '%s  %s\n' "$ENC_SHA" "$ENC_FILE" > "$TMP/$ENC_FILE.sha256"

# ---------------------------------------------------------------------------
# 3. 原子落盘（同文件系统 rename）
# ---------------------------------------------------------------------------
log "3/5 落盘 $BACKUP_DIR/$ENC_FILE"
mv "$TMP/$ENC_FILE" "$BACKUP_DIR/$ENC_FILE"
mv "$TMP/$ENC_FILE.sha256" "$BACKUP_DIR/$ENC_FILE.sha256"
mv "$TMP/$BASE.manifest.json" "$BACKUP_DIR/$BASE.manifest.json"
chmod 0600 "$BACKUP_DIR/$ENC_FILE" "$BACKUP_DIR/$BASE.manifest.json"
log "     sha256=$ENC_SHA"

# ---------------------------------------------------------------------------
# 4. 异地（rsync 或对象存储；未配置则只告警，不算失败）
# ---------------------------------------------------------------------------
log "4/5 异地副本"
OFFSITE_DONE=0
if [ -n "${OPENCHAT_BACKUP_RSYNC:-}" ]; then
  command -v rsync >/dev/null 2>&1 || die "配置了 OPENCHAT_BACKUP_RSYNC 但缺少 rsync"
  rsync -az --partial --timeout=300 \
    "$BACKUP_DIR/$ENC_FILE" "$BACKUP_DIR/$ENC_FILE.sha256" \
    "${OPENCHAT_BACKUP_RSYNC%/}/"
  OFFSITE_DONE=1
  log "     rsync → $OPENCHAT_BACKUP_RSYNC"
fi

if [ -n "${OPENCHAT_BACKUP_S3:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "$BACKUP_DIR/$ENC_FILE" "${OPENCHAT_BACKUP_S3%/}/$ENC_FILE" --only-show-errors
    aws s3 cp "$BACKUP_DIR/$ENC_FILE.sha256" "${OPENCHAT_BACKUP_S3%/}/$ENC_FILE.sha256" --only-show-errors
  elif command -v rclone >/dev/null 2>&1; then
    rclone copyto "$BACKUP_DIR/$ENC_FILE" "${OPENCHAT_BACKUP_S3%/}/$ENC_FILE"
    rclone copyto "$BACKUP_DIR/$ENC_FILE.sha256" "${OPENCHAT_BACKUP_S3%/}/$ENC_FILE.sha256"
  else
    die "配置了 OPENCHAT_BACKUP_S3 但既无 aws 也无 rclone"
  fi
  OFFSITE_DONE=1
  log "     object storage → $OPENCHAT_BACKUP_S3"
fi

if [ "$OFFSITE_DONE" -eq 0 ]; then
  warn "未配置异地目标（OPENCHAT_BACKUP_RSYNC / OPENCHAT_BACKUP_S3）：本机故障会同时丢失备份"
fi

# ---------------------------------------------------------------------------
# 5. 保留 N 天（策略来自 policy.json 的 backup.keep_days）
# ---------------------------------------------------------------------------
log "5/5 清理超过 $KEEP_DAYS 天的本地备份"
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openchat-*' -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
log "     删除 $DELETED 个过期文件"
find "$BACKUP_DIR" -maxdepth 1 -type d -name '.tmp.*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true

log "备份完成: $BACKUP_DIR/$ENC_FILE (${DB_SIZE} bytes 源库)"

#!/bin/sh
cd /var/minis/workspace/OpenDiscord || exit 1
export PATH=/usr/bin:/bin
echo "=== 按类型统计 OpenDiscord 引用 ==="
grep -rl "OpenDiscord" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist . 2>/dev/null | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -12
echo "=== go.mod / package.json ==="
grep -n "OpenDiscord" go.mod apps/client/package.json apps/admin/package.json 2>/dev/null
echo "=== 配置与部署 ==="
grep -rln "opendiscord" config/ deploy/ 2>/dev/null | head -8
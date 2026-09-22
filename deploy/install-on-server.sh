#!/usr/bin/env bash
# deploy/install-on-server.sh —— 在腾讯云服务器上安装/更新「知识点复习系统」
#
# 用法（在服务器上，root 或 sudo 执行）：
#   sudo REGISTER_CODE='你的注册口令' bash install-on-server.sh /tmp/random-question
#
# 参数：
#   $1 = 代码上传目录（默认 /tmp/random-question）
# 环境变量：
#   REGISTER_CODE  必填，注册口令
#   PORT           可选，监听端口（默认 8080）
#   APP_DIR        可选，安装目录（默认 /opt/random-question）
#   DATA_DIR       可选，数据目录（默认 /var/lib/random-question）
#   SERVE_PUBLIC   可选，1=直接监听 0.0.0.0（默认），0=仅本机（配合 Nginx 反代）
#   SYSTEMD_DIR    可选，systemd 单元目录（默认 /etc/systemd/system）
#   SKIP_SYSTEMD   可选，1=只写单元文件、不调用 systemctl（用于预演/无 systemd 环境）

set -euo pipefail

SRC_DIR="${1:-/tmp/random-question}"
APP_DIR="${APP_DIR:-/opt/random-question}"
DATA_DIR="${DATA_DIR:-/var/lib/random-question}"
PORT="${PORT:-8080}"
SERVICE="random-question"
SERVE_PUBLIC="${SERVE_PUBLIC:-1}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SKIP_SYSTEMD="${SKIP_SYSTEMD:-0}"

if [ -z "${REGISTER_CODE:-}" ]; then
  echo "错误：必须设置 REGISTER_CODE 环境变量（注册口令）" >&2
  echo "用法：sudo REGISTER_CODE='你的口令' bash install-on-server.sh $SRC_DIR" >&2
  exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
  echo "错误：找不到上传目录 $SRC_DIR" >&2
  exit 1
fi

echo "==> 1/6 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 node。请先安装 Node.js 24：" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs" >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
echo "    node: $(node -v)  ($NODE_BIN)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "错误：Node 版本过低，需要 >= 24（本项目使用内置 node:sqlite）。当前 $(node -v)" >&2
  exit 1
fi
# 确认 node:sqlite 可用
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "错误：当前 Node 不支持 node:sqlite，请升级到 Node 24+" >&2
  exit 1
fi

echo "==> 2/6 创建目录"
mkdir -p "$APP_DIR" "$DATA_DIR"

echo "==> 3/6 同步代码到 $APP_DIR"
# 用 rsync 更稳；没有 rsync 则退回 cp
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'var' --exclude 'node_modules' --exclude '.env' \
    "$SRC_DIR"/ "$APP_DIR"/
else
  rm -rf "$APP_DIR/server" "$APP_DIR/web" "$APP_DIR/data" "$APP_DIR/deploy"
  cp -r "$SRC_DIR"/server "$SRC_DIR"/web "$SRC_DIR"/data "$APP_DIR"/
  [ -d "$SRC_DIR/deploy" ] && cp -r "$SRC_DIR/deploy" "$APP_DIR"/
  cp "$SRC_DIR/package.json" "$APP_DIR/" 2>/dev/null || true
fi

echo "==> 4/6 导入题库到数据库"
cd "$APP_DIR"
DB_PATH="$DATA_DIR/learning.db" node server/seed.mjs

echo "==> 5/6 写入 systemd 服务"
HOST_BIND="0.0.0.0"
if [ "$SERVE_PUBLIC" = "0" ]; then HOST_BIND="127.0.0.1"; fi

mkdir -p "$SYSTEMD_DIR"
UNIT_FILE="${SYSTEMD_DIR}/${SERVICE}.service"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Random Question Review System (知识点复习系统)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=HOST=${HOST_BIND}
Environment=REGISTER_CODE=${REGISTER_CODE}
Environment=DB_PATH=${DATA_DIR}/learning.db
ExecStart=${NODE_BIN} server/server.mjs
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

chmod 600 "$UNIT_FILE"
echo "    已写入: $UNIT_FILE"

if [ "$SKIP_SYSTEMD" = "1" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "    已跳过 systemctl（SKIP_SYSTEMD=$SKIP_SYSTEMD / 未检测到 systemctl）"
  echo "    手动启动命令："
  echo "      cd $APP_DIR && PORT=$PORT HOST=$HOST_BIND DB_PATH=$DATA_DIR/learning.db \\"
  echo "        REGISTER_CODE='<你的口令>' $NODE_BIN server/server.mjs"
else
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"

  echo "==> 6/6 检查运行状态"
  sleep 2
  if systemctl is-active --quiet "$SERVICE"; then
    echo "    服务已启动 ✓"
  else
    echo "    服务未启动，最近日志：" >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    exit 1
  fi

  # 本机自检
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "    健康检查通过 ✓"
  else
    echo "    警告：本机健康检查失败，请查看 journalctl -u ${SERVICE}" >&2
  fi
fi

IP=""
if command -v hostname >/dev/null 2>&1; then
  # 注意：set -e + pipefail 下，hostname -I 不受支持会让赋值返回非零而中断脚本，
  # 故这里显式吞掉错误（末尾 || true），避免"部署其实成功了却报失败"。
  IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
echo
echo "======================================================"
echo " 部署完成"
echo " 访问地址: http://${IP:-<服务器IP>}:${PORT}/"
echo " 注册口令: ${REGISTER_CODE}"
echo " 数据文件: ${DATA_DIR}/learning.db"
echo " 单元文件: $UNIT_FILE"
echo " 服务管理: systemctl {status|restart|stop} ${SERVICE}"
echo " 查看日志: journalctl -u ${SERVICE} -f"
echo "======================================================"
echo
echo "提示：若手机无法访问，请在腾讯云控制台「安全组」放行 ${PORT} 端口。"

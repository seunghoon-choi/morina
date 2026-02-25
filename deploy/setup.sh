#!/bin/bash
# ByeTax VPS 최초 설치 스크립트 (Ubuntu 20.04 / 22.04)
# 사용법: bash setup.sh
set -e

APP_DIR="/var/www/byetax"
REPO_URL="https://github.com/seunghoon-choi/morina.git"
DOMAIN="172.234.89.235"

echo "=== [1/7] 패키지 업데이트 ==="
apt-get update -y
apt-get install -y python3 python3-pip python3-venv nginx git

echo "=== [2/7] 앱 디렉토리 생성 ==="
mkdir -p "$APP_DIR"

echo "=== [3/7] 소스 코드 클론 ==="
# git 소유권 경고 우회 (root로 실행 시 발생)
git config --global --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi
# 클론 후 소유권 설정
chown -R www-data:www-data "$APP_DIR"

echo "=== [4/7] Python 가상환경 및 의존성 설치 ==="
cd "$APP_DIR"
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r backend/requirements.txt

echo "=== [5/7] 환경변수 파일 생성 ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<EOF
KAKAO_CLIENT_ID=
KAKAO_REDIRECT_URI=http://${DOMAIN}/auth/kakao/callback
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
EOF
  echo "  → .env 생성 완료 (KAKAO_CLIENT_ID는 나중에 입력하세요)"
fi

echo "=== [6/7] DB 초기화 ==="
cd "$APP_DIR/backend"
"$APP_DIR/venv/bin/python" db.py

echo "=== [7/7] nginx + systemd 설정 ==="
# nginx 설정
sed "s/YOUR_DOMAIN_OR_IP/$DOMAIN/" "$APP_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/byetax
ln -sf /etc/nginx/sites-available/byetax /etc/nginx/sites-enabled/byetax
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# systemd 서비스
cp "$APP_DIR/deploy/byetax.service" /etc/systemd/system/byetax.service
systemctl daemon-reload
systemctl enable byetax
systemctl restart byetax

echo ""
echo "========================================="
echo " ByeTax 설치 완료!"
echo " 접속 URL: http://${DOMAIN}"
echo " 서비스 상태: systemctl status byetax"
echo " 로그 확인: journalctl -u byetax -f"
echo "========================================="
echo ""
echo "[주의] .env 파일에 KAKAO_CLIENT_ID를 입력 후"
echo "       systemctl restart byetax 실행하세요"

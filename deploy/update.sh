#!/bin/bash
# ByeTax 코드 업데이트 스크립트 (GitHub pull → 서비스 재시작)
# 사용법: bash update.sh
set -e

APP_DIR="/var/www/byetax"

echo "=== 코드 업데이트 ==="
cd "$APP_DIR"
git pull origin main

echo "=== 의존성 업데이트 ==="
./venv/bin/pip install -r backend/requirements.txt --quiet

echo "=== 서비스 재시작 ==="
systemctl restart byetax
sleep 2
systemctl status byetax --no-pager

echo ""
echo "업데이트 완료!"

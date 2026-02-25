"""
카카오 소셜 로그인 + JWT 인증 모듈
"""
import os
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import HTTPException, Request
from jose import JWTError, jwt

from db import get_conn

# ── 설정 (환경변수 우선, 없으면 개발 기본값) ─────────────────────────────────
KAKAO_CLIENT_ID    = os.getenv("KAKAO_CLIENT_ID", "")
KAKAO_REDIRECT_URI = os.getenv("KAKAO_REDIRECT_URI", "http://localhost:8082/auth/kakao/callback")
JWT_SECRET         = os.getenv("JWT_SECRET", "byetax-dev-secret-change-in-production")
JWT_ALGORITHM      = "HS256"
JWT_EXPIRE_DAYS    = 30

KAKAO_AUTH_URL  = "https://kauth.kakao.com/oauth/authorize"
KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"
KAKAO_ME_URL    = "https://kapi.kakao.com/v2/user/me"


# ── JWT ─────────────────────────────────────────────────────────────────────

def create_access_token(user_id: int, nickname: str) -> str:
    payload = {
        "sub": str(user_id),
        "nickname": nickname,
        "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {"user_id": int(payload["sub"]), "nickname": payload.get("nickname", "")}
    except JWTError:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")


# ── FastAPI Depends ──────────────────────────────────────────────────────────

def get_current_user(request: Request) -> dict:
    """Authorization: Bearer {token} 헤더에서 사용자 정보 추출"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    token = auth[len("Bearer "):]
    return verify_token(token)


# ── 카카오 OAuth ─────────────────────────────────────────────────────────────

def get_kakao_login_url() -> str:
    """카카오 인가 URL 생성"""
    return (
        f"{KAKAO_AUTH_URL}"
        f"?client_id={KAKAO_CLIENT_ID}"
        f"&redirect_uri={KAKAO_REDIRECT_URI}"
        f"&response_type=code"
    )


async def get_kakao_token(code: str) -> str:
    """인가 코드 → 카카오 액세스 토큰 교환"""
    async with httpx.AsyncClient() as client:
        res = await client.post(KAKAO_TOKEN_URL, data={
            "grant_type":   "authorization_code",
            "client_id":    KAKAO_CLIENT_ID,
            "redirect_uri": KAKAO_REDIRECT_URI,
            "code":         code,
        })
    if res.status_code != 200:
        raise HTTPException(status_code=400, detail="카카오 토큰 교환 실패")
    return res.json()["access_token"]


async def get_kakao_profile(access_token: str) -> dict:
    """카카오 액세스 토큰 → 사용자 프로필 조회"""
    async with httpx.AsyncClient() as client:
        res = await client.get(
            KAKAO_ME_URL,
            headers={"Authorization": f"Bearer {access_token}"}
        )
    if res.status_code != 200:
        raise HTTPException(status_code=400, detail="카카오 프로필 조회 실패")
    data = res.json()
    profile = data.get("kakao_account", {}).get("profile", {})
    return {
        "kakao_id":      str(data["id"]),
        "nickname":      profile.get("nickname", ""),
        "profile_image": profile.get("profile_image_url", ""),
        "email":         data.get("kakao_account", {}).get("email", ""),
    }


# ── DB 사용자 upsert ─────────────────────────────────────────────────────────

def upsert_user(kakao_id: str, nickname: str, profile_image: str, email: str) -> int:
    """카카오 ID로 사용자 조회/생성 → user.id 반환"""
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM users WHERE kakao_id = ?", (kakao_id,)
    ).fetchone()

    if row:
        conn.execute(
            "UPDATE users SET nickname=?, profile_image=?, email=? WHERE kakao_id=?",
            (nickname, profile_image, email, kakao_id)
        )
        user_id = row["id"]
    else:
        cur = conn.execute(
            "INSERT INTO users (kakao_id, nickname, profile_image, email) VALUES (?,?,?,?)",
            (kakao_id, nickname, profile_image, email)
        )
        user_id = cur.lastrowid

    conn.commit()
    conn.close()
    return user_id


def get_user_by_id(user_id: int) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

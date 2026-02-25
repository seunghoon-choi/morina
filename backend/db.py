"""
SQLite DB 초기화 및 스키마 정의
소득세 신고도움서비스 PDF 기반 설계
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "taxfree.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    # ── 0. 사용자 (카카오 소셜 로그인) ────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            kakao_id      TEXT UNIQUE NOT NULL,
            nickname      TEXT,
            profile_image TEXT,
            email         TEXT,
            created_at    TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # ── 1. 납세자 기본정보 ─────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS taxpayers (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            tax_year                INTEGER NOT NULL,           -- 귀속연도 (예: 2024)
            name                    TEXT,                       -- 성명 (마스킹 포함)
            birth_date              TEXT,                       -- 생년월일 (YY.MM.DD)
            guide_type              TEXT,                       -- 안내유형
            bookkeeping_obligation  TEXT,                       -- 기장의무
            estimated_expense_rate  TEXT,                       -- 추계시 적용경비율
            payment_extension       TEXT,                       -- 납부기한 직권연장 여부
            ars_auth_number         TEXT,                       -- ARS 개별인증번호
            religion_income         TEXT DEFAULT 'X',           -- 종교인기타 소득유무
            uploaded_at             TEXT DEFAULT (datetime('now','localtime')),
            pdf_filename            TEXT,
            user_id                 INTEGER REFERENCES users(id) ON DELETE SET NULL
        )
    """)

    # ── 2. 사업장별 수입금액 ───────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS businesses (
            id                              INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id                     INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            business_reg_no                 TEXT,               -- 사업자등록번호
            business_name                   TEXT,               -- 상호
            income_type_code                TEXT,               -- 수입종류구분코드
            industry_code                   TEXT,               -- 업종코드
            business_type                   TEXT,               -- 사업형태 (단독/공동)
            bookkeeping_obligation          TEXT,               -- 기장의무
            expense_rate_type               TEXT,               -- 경비율 구분 (기준/단순)
            revenue                         INTEGER,            -- 수입금액 (원)
            std_expense_rate_general        REAL,               -- 기준경비율 일반 (%)
            std_expense_rate_own            REAL,               -- 기준경비율 자가 (%)
            simple_expense_rate_general     REAL,               -- 단순경비율 일반/기본 (%)
            simple_expense_rate_own         REAL                -- 단순경비율 자가/초과 (%)
        )
    """)

    # ── 3. 타소득 자료유무 ─────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS other_incomes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id     INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            income_type     TEXT NOT NULL,   -- 이자|배당|근로단일|근로복수|연금|기타
            has_data        TEXT DEFAULT 'X' -- X=없음, O=있음
        )
    """)

    # ── 4. 공제 참고자료 ───────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS deductions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id     INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            category        TEXT NOT NULL,   -- 기납부세액|소득공제|세액공제
            item_name       TEXT NOT NULL,   -- 항목명
            amount          INTEGER          -- 납입액/부담액 (원)
        )
    """)

    # ── 5. 가산세 항목 ─────────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS penalty_taxes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id     INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            penalty_type    TEXT NOT NULL,   -- 가산세 항목명
            detail_type     TEXT,            -- 세부 구분 (미만/이상 등)
            count           INTEGER,         -- 건수
            amount          INTEGER          -- 금액 (원)
        )
    """)

    # ── 6. 최근 3년간 종합소득세 신고상황 ─────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tax_history (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id         INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            attribution_year    INTEGER NOT NULL,   -- 귀속연도 (예: 2021)
            total_income        INTEGER,            -- 종합소득금액 (천원)
            income_deduction    INTEGER,            -- 소득공제 (천원)
            taxable_income      INTEGER,            -- 과세표준 (천원)
            tax_rate            REAL,               -- 세율 (%)
            calculated_tax      INTEGER,            -- 산출세액 (천원)
            deduction_tax       INTEGER,            -- 공제·감면세액 (천원)
            determined_tax      INTEGER,            -- 결정세액 (천원)
            effective_tax_rate  REAL                -- 실효세율 (%)
        )
    """)

    # ── 7. 최근 3년간 신고소득률 ──────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS income_rate_history (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id         INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            business_reg_no     TEXT,
            business_name       TEXT,
            attribution_year    INTEGER NOT NULL,   -- 귀속연도
            revenue             INTEGER,            -- 수입금액 (천원)
            necessary_expenses  INTEGER,            -- 필요경비 (천원)
            income              INTEGER,            -- 소득금액 (천원)
            income_rate         REAL                -- 소득률 (%)
        )
    """)

    # ── 8. 판관비율 분석 ───────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sg_expenses (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id         INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            analysis_year       INTEGER NOT NULL,   -- 분석연도 (예: 2023)
            account_code        TEXT,               -- 계정과목 코드 (예: 4, 18, 19...)
            account_name        TEXT NOT NULL,      -- 계정과목명
            amount              INTEGER,            -- 금액 (천원)
            company_rate        REAL,               -- 당해업체 (%)
            industry_avg_rate   REAL                -- 업종평균 (%)
        )
    """)

    # ── 9. 사업용 신용카드 사용현황 ───────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS credit_card_usage (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            taxpayer_id     INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            usage_year      INTEGER NOT NULL,   -- 사용연도 (예: 2024)
            category        TEXT NOT NULL,      -- 구분 (합계|신변잡화구입|가정용품구입|업무무관업소이용|개인적치료|해외사용액)
            count           INTEGER,            -- 건수
            amount          INTEGER             -- 금액 (원)
        )
    """)

    # ── 10. 공유 링크 토큰 ────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS share_tokens (
            token       TEXT PRIMARY KEY,
            taxpayer_id INTEGER NOT NULL REFERENCES taxpayers(id) ON DELETE CASCADE,
            expires_at  TEXT NOT NULL,
            created_at  TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    conn.commit()

    # ── 마이그레이션: 기존 DB에 user_id 컬럼 추가 ────────────────────────────
    try:
        cur.execute("ALTER TABLE taxpayers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
        conn.commit()
    except Exception:
        pass  # 이미 존재하는 컬럼이면 무시

    conn.close()
    print(f"DB 초기화 완료: {os.path.abspath(DB_PATH)}")


if __name__ == "__main__":
    init_db()

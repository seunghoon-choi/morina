"""
소득세 신고도움서비스 PDF 파서
pdfplumber 기반 텍스트/테이블 추출 후 구조화된 dict 반환
"""
import re
import pdfplumber
from typing import Optional


# ── 유틸 함수 ─────────────────────────────────────────────────────────────────

def clean(s: Optional[str]) -> Optional[str]:
    """None-safe 공백 제거"""
    return s.strip() if s else None


def to_int(s: Optional[str]) -> Optional[int]:
    """숫자 문자열 → int (콤마/원/% 제거)"""
    if not s:
        return None
    s = re.sub(r"[,원\s]", "", str(s))
    s = re.sub(r"%$", "", s)
    try:
        return int(float(s))
    except ValueError:
        return None


def to_float(s: Optional[str]) -> Optional[float]:
    """숫자 문자열 → float"""
    if not s:
        return None
    s = re.sub(r"[,원\s%]", "", str(s))
    try:
        return float(s)
    except ValueError:
        return None


def extract_year_from_title(text: str) -> Optional[int]:
    """PDF 제목에서 귀속연도 추출 (예: '2024년 귀속' → 2024)"""
    m = re.search(r"(\d{4})년\s*귀속", text)
    return int(m.group(1)) if m else None


# ── 페이지별 파서 ─────────────────────────────────────────────────────────────

def parse_page1(page) -> dict:
    """
    Page 1: 신고안내유형/기장의무, 사업장별 수입금액,
            타소득 자료유무, 공제 참고자료
    """
    result = {
        "taxpayer": {},
        "businesses": [],
        "other_incomes": [],
        "deductions": [],
    }

    text = page.extract_text() or ""
    tables = page.extract_tables()

    # ── 귀속연도 ──────────────────────────────────────────────────────────────
    result["taxpayer"]["tax_year"] = extract_year_from_title(text)

    # ── 성명 / 생년월일 ────────────────────────────────────────────────────────
    m = re.search(r"성명\s+(\S+)\s+생년월일\s+(\d{2}\.\d{2}\.\d{2})", text)
    if m:
        result["taxpayer"]["name"] = m.group(1)
        result["taxpayer"]["birth_date"] = m.group(2)

    # ── 안내유형 ──────────────────────────────────────────────────────────────
    m = re.search(r"안내유형\s+(.+?)(?:\n|기장의무)", text, re.DOTALL)
    if m:
        result["taxpayer"]["guide_type"] = clean(m.group(1).replace("\n", " "))

    # ── 기장의무 ──────────────────────────────────────────────────────────────
    m = re.search(r"기장의무\s+(\S+)", text)
    if m:
        result["taxpayer"]["bookkeeping_obligation"] = m.group(1)

    # ── 추계시 적용경비율 ──────────────────────────────────────────────────────
    m = re.search(r"추계시\s*적용경비율\s+(\S+)", text)
    if m:
        result["taxpayer"]["estimated_expense_rate"] = m.group(1)

    # ── 납부기한 직권연장 / ARS 개별인증번호 (테이블 셀에서 추출) ─────────────
    # 테이블 row: ['납부기한직권연장여부', None, ..., '', None, ..., 'ARS개별인증번호', ..., '', ...]
    for table in tables:
        for row in table:
            if not row:
                continue
            row_flat = [clean(str(c)) for c in row if c]
            row_str = " ".join(row_flat)
            if "납부기한" in row_str and "ARS" in row_str:
                # 납부기한 직권연장값: 빈 셀(col 5 위치)
                result["taxpayer"]["payment_extension"] = (
                    clean(str(row[5])) if len(row) > 5 and row[5] and str(row[5]).strip() else None
                )
                # ARS 인증번호값: 빈 셀(col 17 위치)
                result["taxpayer"]["ars_auth_number"] = (
                    clean(str(row[17])) if len(row) > 17 and row[17] and str(row[17]).strip() else None
                )
                break

    # ── 종교인기타 소득유무 ────────────────────────────────────────────────────
    m = re.search(r"종교인기타\s*소득유무\s*[:：]?\s*([OXox])", text)
    if m:
        result["taxpayer"]["religion_income"] = m.group(1).upper()

    # ── 사업장별 수입금액 테이블 파싱 ─────────────────────────────────────────
    # pdfplumber 테이블의 고정 컬럼 위치 매핑 (실제 PDF 구조 기반):
    # col 0: 사업자등록번호, col 2: 상호, col 4: 수입종류구분코드,
    # col 8: 업종코드, col 9: 사업형태, col 10: 기장의무,
    # col 12: 경비율, col 14: 수입금액, col 16: 기준경비율(일반),
    # col 18: 기준경비율(자가), col 19: 단순경비율(일반/기본), col 20: 단순경비율(자가/초과)
    BIZ_COL = {
        "reg_no": 0, "name": 2, "income_type": 4,
        "industry_code": 8, "biz_type": 9, "bookkeeping": 10,
        "expense_type": 12, "revenue": 14,
        "std_general": 16, "std_own": 18,
        "simple_general": 19, "simple_own": 20,
    }
    reg_no_pattern = re.compile(r"^\d{3}-\d{2}-\d{5}$")

    def _cell(row, col):
        if col < len(row) and row[col]:
            return clean(str(row[col]).replace("\n", ""))
        return None

    biz_list = []
    for table in tables:
        for row in table:
            if not row or len(row) <= BIZ_COL["revenue"]:
                continue
            reg_no_val = _cell(row, BIZ_COL["reg_no"])
            if not reg_no_val or not reg_no_pattern.match(reg_no_val):
                continue
            biz_list.append({
                "business_reg_no":             reg_no_val,
                "business_name":               _cell(row, BIZ_COL["name"]),
                "income_type_code":            _cell(row, BIZ_COL["income_type"]),
                "industry_code":               _cell(row, BIZ_COL["industry_code"]),
                "business_type":               _cell(row, BIZ_COL["biz_type"]),
                "bookkeeping_obligation":      _cell(row, BIZ_COL["bookkeeping"]),
                "expense_rate_type":           _cell(row, BIZ_COL["expense_type"]),
                "revenue":                     to_int(_cell(row, BIZ_COL["revenue"])),
                "std_expense_rate_general":    to_float(_cell(row, BIZ_COL["std_general"])),
                "std_expense_rate_own":        to_float(_cell(row, BIZ_COL["std_own"])),
                "simple_expense_rate_general": to_float(_cell(row, BIZ_COL["simple_general"])),
                "simple_expense_rate_own":     to_float(_cell(row, BIZ_COL["simple_own"])),
            })

    result["businesses"] = biz_list

    # ── 타소득 자료유무 ────────────────────────────────────────────────────────
    # "해당여부 X X X X X X" 패턴 파싱
    m = re.search(r"해당여부\s+([OXox\s]+)", text)
    if m:
        vals = re.findall(r"[OXox]", m.group(1))
        types = ["이자", "배당", "근로단일", "근로복수", "연금", "기타"]
        for i, t in enumerate(types):
            result["other_incomes"].append({
                "income_type": t,
                "has_data": vals[i].upper() if i < len(vals) else "X"
            })

    # ── 공제 참고자료 ──────────────────────────────────────────────────────────
    deduction_patterns = [
        # (카테고리, 항목명, 정규식)
        ("기납부세액", "중간예납세액",
         r"중간예납세액\s+([\d,]+)원"),
        ("기납부세액", "원천징수세액(인적용역 사업소득)",
         r"원천징수세액\s*[\(\（]인적용역\s*사업소득[\)\）]\s*([\d,]+)원"),
        ("소득공제", "국민연금보험료",
         r"국민연금보험료\s+([\d,]+)원"),
        ("소득공제", "개인연금저축",
         r"개인연금저축\s+([\d,]+)원"),
        ("소득공제", "소기업소상공인공제부금(노란우산공제)",
         r"소기업소상공인공제부금\s*[\(\（]노란우산공제[\)\）]\s*([\d,]+)원"),
        ("세액공제", "퇴직연금세액공제",
         r"퇴직연금세액공제\s+([\d,]+)원"),
        ("세액공제", "연금계좌세액공제",
         r"연금계좌세액공제\s+([\d,]+)원"),
    ]
    for cat, name, pattern in deduction_patterns:
        m = re.search(pattern, text)
        result["deductions"].append({
            "category":  cat,
            "item_name": name,
            "amount":    to_int(m.group(1)) if m else 0,
        })

    return result


def parse_page2(page, text_all: str) -> list:
    """
    Page 2: 가산세 항목
    반환: penalty_taxes list
    """
    penalties = []
    text = page.extract_text() or ""

    patterns = [
        # (penalty_type, detail_type, regex, has_count)
        ("(세금)계산서관련 보고불성실", "미(지연) 제출금액",
         r"미\(지연\)\s*제출금액\s*([\d,]+)\s*원", False),
        ("현금영수증미발급", "미발급 금액",
         r"미발급\s*금액\s*([\d,]+)\s*원", False),
        ("현금영수증발급거부", "10만원 미만",
         r"현금영수증발급거부\s*10만원\s*미만\s*(\d+)\s*건", True),
        ("현금영수증발급거부", "10만원 이상",
         r"10만원미만\s*\d+\s*건\s*10만원이상\s*([\d,]+)\s*원", False),
        ("신용카드발급거부", "10만원 미만",
         r"신용카드발급거부\s*10만원\s*미만\s*(\d+)\s*건", True),
        ("신용카드발급거부", "10만원 이상",
         r"신용카드발급거부\s*10만원미만\s*\d+\s*건\s*10만원이상\s*([\d,]+)\s*원", False),
        ("사업장현황신고불성실", "무과소신고금액",
         r"무과소신고금액\s*([\d,]+)\s*원", False),
    ]

    for penalty_type, detail_type, pattern, is_count in patterns:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            val = to_int(m.group(1))
            penalties.append({
                "penalty_type": penalty_type,
                "detail_type":  detail_type,
                "count":        val if is_count else None,
                "amount":       None if is_count else val,
            })

    # 건수 없는 항목도 0으로 추가
    no_value_items = [
        ("무신고 또는 무기장가산세", None),
        ("현금영수증미가맹", None),
        ("사업용계좌미신고", None),
    ]
    for penalty_type, detail_type in no_value_items:
        penalties.append({
            "penalty_type": penalty_type,
            "detail_type":  detail_type,
            "count":        None,
            "amount":       None,
        })

    return penalties


def parse_page3(page) -> list:
    """
    Page 3: 최근 3년간 종합소득세 신고상황
    반환: tax_history list
    """
    history = []
    text = page.extract_text() or ""

    # 귀속연도 추출
    years = re.findall(r"(\d{4})귀속", text)

    # 각 항목 행 파싱
    fields = [
        ("total_income",     r"종합소득금액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("income_deduction", r"소득공제\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("taxable_income",   r"과세표준\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("tax_rate",         r"세율\s+([\d.]+)\s*%\s+([\d.]+)\s*%\s+([\d.]+)\s*%"),
        ("calculated_tax",   r"산출세액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("deduction_tax",    r"공제[··]\s*감면세액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("determined_tax",   r"결정세액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("effective_tax_rate", r"실효세율\s+([\d.]+)\s*%\s+([\d.]+)\s*%\s+([\d.]+)\s*%"),
    ]

    rows = {field: None for field, _ in fields}
    for field, pattern in fields:
        m = re.search(pattern, text)
        if m:
            rows[field] = [m.group(1), m.group(2), m.group(3)]

    for i, year in enumerate(years[:3]):
        entry = {"attribution_year": int(year)}
        for field, _ in fields:
            if rows[field] and i < len(rows[field]):
                if field in ("tax_rate", "effective_tax_rate"):
                    entry[field] = to_float(rows[field][i])
                else:
                    entry[field] = to_int(rows[field][i])
            else:
                entry[field] = None
        history.append(entry)

    return history


def parse_page4(page) -> tuple[list, list]:
    """
    Page 4: 최근 3년간 신고소득률 + 판관비율 분석
    반환: (income_rate_history list, sg_expenses list)
    """
    text = page.extract_text() or ""

    # ── 신고소득률 ─────────────────────────────────────────────────────────────
    income_rates = []

    m_biz_no = re.search(r"사업자\s*등\s*록\s*번\s*호\s*(\d{3}-\d{2}-\d{5})", text)
    m_biz_name = re.search(r"상\s*호\s*(.+?)\s+사업자", text)
    biz_no   = m_biz_no.group(1)   if m_biz_no   else None
    biz_name = clean(m_biz_name.group(1)) if m_biz_name else None

    years = re.findall(r"(\d{4})년", text)

    fields_ir = [
        ("revenue",             r"수입금액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("necessary_expenses",  r"필요경비\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("income",              r"소득금액\s+([\-\d,]+)\s+([\-\d,]+)\s+([\-\d,]+)"),
        ("income_rate",         r"소득률\s*\(?당해업체\)?\s*([\-\d.]+)\s*%\s*([\-\d.]+)\s*%\s*([\-\d.]+)\s*%"),
    ]
    rows_ir = {}
    for field, pattern in fields_ir:
        m = re.search(pattern, text)
        rows_ir[field] = [m.group(1), m.group(2), m.group(3)] if m else None

    unique_years = list(dict.fromkeys(years))
    for i, year in enumerate(unique_years[:3]):
        entry = {
            "business_reg_no": biz_no,
            "business_name":   biz_name,
            "attribution_year": int(year),
        }
        for field, _ in fields_ir:
            if rows_ir.get(field) and i < len(rows_ir[field]):
                if field == "income_rate":
                    entry[field] = to_float(rows_ir[field][i])
                else:
                    entry[field] = to_int(rows_ir[field][i])
            else:
                entry[field] = None
        income_rates.append(entry)

    # ── 판관비율 분석 ──────────────────────────────────────────────────────────
    sg_expenses = []

    # 분석연도 추출
    m_year = re.search(r"(\d{4})년\s*매출액\s*대비", text)
    analysis_year = int(m_year.group(1)) if m_year else None

    # 계정과목 행 파싱
    sg_pattern = re.compile(
        r"(\d+)[.\s]*([가-힣]+(?:[가-힣\s]+)?)\s+([\-\d,]+)\s+([\d.]+)\s+([\d.]+)"
    )
    for m in sg_pattern.finditer(text):
        sg_expenses.append({
            "analysis_year":    analysis_year,
            "account_code":     m.group(1),
            "account_name":     clean(m.group(2)),
            "amount":           to_int(m.group(3)),
            "company_rate":     to_float(m.group(4)),
            "industry_avg_rate": to_float(m.group(5)),
        })

    return income_rates, sg_expenses


def parse_page5(page) -> list:
    """
    Page 5: 사업용 신용카드 사용현황
    반환: credit_card_usage list
    """
    text = page.extract_text() or ""

    # 분석연도
    m_year = re.search(r"(\d{4})년\s*사업용\s*신용카드", text)
    usage_year = int(m_year.group(1)) if m_year else None

    categories = ["합계", "신변잡화구입", "가정용품구입", "업무무관업소이용", "개인적치료", "해외사용액"]
    result = []

    # 건수 행
    m_cnt = re.search(r"건수\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)", text)
    counts = [to_int(m_cnt.group(i+1)) for i in range(6)] if m_cnt else [None]*6

    # 금액 행
    m_amt = re.search(r"금액\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)", text)
    amounts = [to_int(m_amt.group(i+1)) for i in range(6)] if m_amt else [None]*6

    for i, cat in enumerate(categories):
        result.append({
            "usage_year": usage_year,
            "category":   cat,
            "count":      counts[i],
            "amount":     amounts[i],
        })

    return result


# ── 메인 파서 ─────────────────────────────────────────────────────────────────

def parse_tax_pdf(pdf_path: str) -> dict:
    """
    PDF 전체 파싱 → 구조화된 dict 반환
    {
        taxpayer: {...},
        businesses: [...],
        other_incomes: [...],
        deductions: [...],
        penalty_taxes: [...],
        tax_history: [...],
        income_rate_history: [...],
        sg_expenses: [...],
        credit_card_usage: [...],
    }
    """
    data = {
        "taxpayer": {},
        "businesses": [],
        "other_incomes": [],
        "deductions": [],
        "penalty_taxes": [],
        "tax_history": [],
        "income_rate_history": [],
        "sg_expenses": [],
        "credit_card_usage": [],
    }

    with pdfplumber.open(pdf_path) as pdf:
        pages = pdf.pages
        full_text = "\n".join(p.extract_text() or "" for p in pages)

        if len(pages) >= 1:
            p1 = parse_page1(pages[0])
            data["taxpayer"]      = p1["taxpayer"]
            data["businesses"]    = p1["businesses"]
            data["other_incomes"] = p1["other_incomes"]
            data["deductions"]    = p1["deductions"]

        if len(pages) >= 2:
            data["penalty_taxes"] = parse_page2(pages[1], full_text)

        if len(pages) >= 3:
            data["tax_history"] = parse_page3(pages[2])

        if len(pages) >= 4:
            ir, sg = parse_page4(pages[3])
            data["income_rate_history"] = ir
            data["sg_expenses"]         = sg

        if len(pages) >= 5:
            data["credit_card_usage"] = parse_page5(pages[4])

    return data

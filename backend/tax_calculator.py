"""
종합소득세 계산 엔진 (2024년 귀속 기준)
8구간 누진세율 적용
"""
from db import get_conn

# ── 2024년 귀속 세율표 (상한, 세율, 누진공제액) ──────────────────────────────
TAX_BRACKETS = [
    (14_000_000,    0.06, 0),
    (50_000_000,    0.15, 1_260_000),
    (88_000_000,    0.24, 5_760_000),
    (150_000_000,   0.35, 15_440_000),
    (300_000_000,   0.38, 19_940_000),
    (500_000_000,   0.40, 25_940_000),
    (1_000_000_000, 0.42, 35_940_000),
    (float('inf'),  0.45, 65_940_000),
]


def _apply_tax_rate(taxable: int) -> tuple[float, int, int]:
    """과세표준 → (세율, 누진공제, 산출세액)"""
    if taxable <= 0:
        return 0.0, 0, 0
    for limit, rate, deduction in TAX_BRACKETS:
        if taxable <= limit:
            calc = int(taxable * rate) - deduction
            return rate, deduction, max(calc, 0)
    rate, deduction = TAX_BRACKETS[-1][1], TAX_BRACKETS[-1][2]
    return rate, deduction, max(int(taxable * rate) - deduction, 0)


def calculate_tax(taxpayer_id: int) -> dict:
    """
    taxpayer_id 기준으로 종합소득세를 계산하여 단계별 결과 반환
    """
    conn = get_conn()

    # ── 1. 납세자 기본정보 ──────────────────────────────────────────────────
    tp = conn.execute(
        "SELECT * FROM taxpayers WHERE id=?", (taxpayer_id,)
    ).fetchone()
    if not tp:
        conn.close()
        return {"error": "납세자 없음"}

    # ── 2. 사업소득금액 계산 ─────────────────────────────────────────────────
    # 주 사업장: 수입금액이 가장 큰 부가가치세 수입 기준
    biz = conn.execute(
        """SELECT * FROM businesses
           WHERE taxpayer_id=? AND income_type_code LIKE '%부가가치세%'
           ORDER BY revenue DESC LIMIT 1""",
        (taxpayer_id,)
    ).fetchone()

    # 부가가치세 행 없으면 수입금액 최대 행
    if not biz:
        biz = conn.execute(
            "SELECT * FROM businesses WHERE taxpayer_id=? ORDER BY revenue DESC LIMIT 1",
            (taxpayer_id,)
        ).fetchone()

    revenue = 0
    expense_rate = 0.0
    business_income = 0
    expense_rate_type = "-"
    if biz:
        revenue = biz["revenue"] or 0
        expense_rate_type = biz["expense_rate_type"] or "기준"
        # 기준경비율 또는 단순경비율 적용
        if expense_rate_type == "단순":
            expense_rate = (biz["simple_expense_rate_general"] or 0) / 100
        else:
            expense_rate = (biz["std_expense_rate_general"] or 0) / 100
        business_income = max(int(revenue * (1 - expense_rate)), 0)

    # ── 3. 소득공제 합산 ─────────────────────────────────────────────────────
    income_deductions = conn.execute(
        "SELECT item_name, amount FROM deductions WHERE taxpayer_id=? AND category='소득공제'",
        (taxpayer_id,)
    ).fetchall()
    income_deduction = sum((r["amount"] or 0) for r in income_deductions)
    income_deduction_detail = [{"name": r["item_name"], "amount": r["amount"] or 0}
                                for r in income_deductions]

    # ── 4. 과세표준 ──────────────────────────────────────────────────────────
    taxable_income = max(business_income - income_deduction, 0)

    # ── 5. 세율 적용 → 산출세액 ──────────────────────────────────────────────
    tax_rate, progressive_deduction, calculated_tax = _apply_tax_rate(taxable_income)

    # ── 6. 세액공제 합산 ─────────────────────────────────────────────────────
    tax_credits = conn.execute(
        "SELECT item_name, amount FROM deductions WHERE taxpayer_id=? AND category='세액공제'",
        (taxpayer_id,)
    ).fetchall()
    tax_credit = sum((r["amount"] or 0) for r in tax_credits)
    tax_credit_detail = [{"name": r["item_name"], "amount": r["amount"] or 0}
                          for r in tax_credits]

    # ── 7. 결정세액 ──────────────────────────────────────────────────────────
    determined_tax = max(calculated_tax - tax_credit, 0)

    # ── 8. 기납부세액 ─────────────────────────────────────────────────────────
    prepaid_rows = conn.execute(
        "SELECT item_name, amount FROM deductions WHERE taxpayer_id=? AND category='기납부세액'",
        (taxpayer_id,)
    ).fetchall()
    prepaid_tax = sum((r["amount"] or 0) for r in prepaid_rows)

    # ── 9. 납부할 세액 ─────────────────────────────────────────────────────────
    final_tax = determined_tax - prepaid_tax

    conn.close()

    return {
        "taxpayer_id": taxpayer_id,
        # 입력값
        "revenue":           revenue,
        "expense_rate_type": expense_rate_type,
        "expense_rate":      round(expense_rate * 100, 1),
        # 계산 단계
        "business_income":   business_income,
        "income_deduction":  income_deduction,
        "income_deduction_detail": income_deduction_detail,
        "taxable_income":    taxable_income,
        "tax_rate":          round(tax_rate * 100, 0),
        "progressive_deduction": progressive_deduction,
        "calculated_tax":    calculated_tax,
        "tax_credit":        tax_credit,
        "tax_credit_detail": tax_credit_detail,
        "determined_tax":    determined_tax,
        "prepaid_tax":       prepaid_tax,
        "final_tax":         final_tax,   # 양수=납부, 음수=환급
        # UI 표시용 단계 목록
        "steps": [
            {"label": "수입금액",          "value": revenue,             "op": ""},
            {"label": f"(-) 필요경비 ({expense_rate_type}경비율 {round(expense_rate*100,1)}%)",
                                           "value": revenue - business_income, "op": "-"},
            {"label": "= 사업소득금액",    "value": business_income,     "op": "=", "bold": True},
            {"label": "(-) 소득공제",      "value": income_deduction,    "op": "-"},
            {"label": "= 과세표준",        "value": taxable_income,      "op": "=", "bold": True},
            {"label": f"× 세율 ({int(tax_rate*100)}%)", "value": None, "op": "×"},
            {"label": "(-) 누진공제",      "value": progressive_deduction,"op": "-"},
            {"label": "= 산출세액",        "value": calculated_tax,      "op": "=", "bold": True},
            {"label": "(-) 세액공제",      "value": tax_credit,          "op": "-"},
            {"label": "= 결정세액",        "value": determined_tax,      "op": "=", "bold": True},
            {"label": "(-) 기납부세액",    "value": prepaid_tax,         "op": "-"},
            {"label": "최종 납부할 세액",   "value": final_tax,           "op": "=", "final": True},
        ],
    }


def generate_ai_analysis(taxpayer_id: int) -> dict:
    """
    DB 데이터 기반 템플릿 분석 코멘트 생성
    (나중에 Claude API 연결 예정)
    """
    conn = get_conn()

    tp = conn.execute("SELECT * FROM taxpayers WHERE id=?", (taxpayer_id,)).fetchone()
    if not tp:
        conn.close()
        return {"error": "납세자 없음"}

    ir_rows = conn.execute(
        "SELECT * FROM income_rate_history WHERE taxpayer_id=? ORDER BY attribution_year DESC",
        (taxpayer_id,)
    ).fetchall()

    cc_rows = conn.execute(
        "SELECT * FROM credit_card_usage WHERE taxpayer_id=?",
        (taxpayer_id,)
    ).fetchall()

    deduction_rows = conn.execute(
        "SELECT * FROM deductions WHERE taxpayer_id=?",
        (taxpayer_id,)
    ).fetchall()

    conn.close()

    comments = []
    risk_score = 0
    INDUSTRY_AVG_RATE = 5.84  # PDF에서 확인된 업종평균 소득률

    # ── 소득률 분석 ────────────────────────────────────────────────────────
    if ir_rows:
        latest = ir_rows[0]
        rate = latest["income_rate"] or 0
        year = latest["attribution_year"]
        if rate < INDUSTRY_AVG_RATE * 0.8:
            risk_score += 2
            comments.append({
                "type": "warning",
                "title": "소득률 저조",
                "body": f"{year}년 신고소득률 {rate:.2f}%로 업종평균({INDUSTRY_AVG_RATE}%) 대비 80% 미만입니다. 사업 관련 없는 지출이 필요경비에 포함되지 않았는지 검토가 필요합니다.",
            })
        elif rate < 0:
            risk_score += 3
            comments.append({
                "type": "danger",
                "title": "소득금액 음수",
                "body": f"{year}년 소득금액이 {rate:.2f}%로 마이너스입니다. 과다 필요경비 신고 가능성이 있어 세무조사 대상이 될 수 있습니다.",
            })
        else:
            comments.append({
                "type": "success",
                "title": "소득률 양호",
                "body": f"{year}년 신고소득률 {rate:.2f}%로 업종평균 수준을 유지하고 있습니다.",
            })

        # 3년 추세 분석
        if len(ir_rows) >= 2:
            rev_change = (ir_rows[0]["revenue"] or 0) - (ir_rows[1]["revenue"] or 0)
            if rev_change > 0:
                comments.append({
                    "type": "info",
                    "title": "매출 증가 추세",
                    "body": f"전년 대비 수입금액이 {rev_change:,}천원 증가했습니다. 수입금액 증가에 따른 세부담 변화를 확인하세요.",
                })

    # ── 신용카드 사용 분석 ──────────────────────────────────────────────────
    cc_dict = {r["category"]: dict(r) for r in cc_rows}
    total_amt = (cc_dict.get("합계", {}).get("amount") or 0) if cc_dict else 0
    unrelated_amt = (cc_dict.get("업무무관업소이용", {}).get("amount") or 0) if cc_dict else 0

    if total_amt > 0:
        unrelated_pct = unrelated_amt / total_amt * 100
        if unrelated_pct > 30:
            risk_score += 2
            comments.append({
                "type": "warning",
                "title": "업무무관 신용카드 사용 多",
                "body": f"사업용 신용카드 중 업무무관 사용 비율이 {unrelated_pct:.1f}%입니다. 해당 금액({unrelated_amt:,}원)은 필요경비로 인정받기 어렵습니다.",
            })
        personal_amt = (cc_dict.get("개인적치료", {}).get("amount") or 0) if cc_dict else 0
        if personal_amt > 0:
            comments.append({
                "type": "info",
                "title": "개인적 치료비 사용",
                "body": f"개인적 치료비 {personal_amt:,}원이 사업용 카드로 결제되었습니다. 의료비 세액공제 항목으로 분류하여 신고하세요.",
            })

    # ── 공제 항목 분석 ──────────────────────────────────────────────────────
    pension = next((r["amount"] for r in deduction_rows
                    if "국민연금" in (r["item_name"] or "")), 0) or 0
    yellow_umbrella = next((r["amount"] for r in deduction_rows
                            if "노란우산" in (r["item_name"] or "") or "소기업" in (r["item_name"] or "")), 0) or 0

    if pension > 0:
        comments.append({
            "type": "success",
            "title": "국민연금 공제 적용",
            "body": f"국민연금 {pension:,}원 전액이 소득공제로 적용됩니다.",
        })
    if yellow_umbrella > 0:
        comments.append({
            "type": "success",
            "title": "노란우산공제 적용",
            "body": f"소기업소상공인공제부금(노란우산공제) {yellow_umbrella:,}원이 소득공제에 반영됩니다. 사업소득 1억원 이하 시 최대 300만원 공제 가능합니다.",
        })

    # ── 위험도 산정 ──────────────────────────────────────────────────────────
    if risk_score == 0:
        risk_level = "low"
        risk_label = "낮음"
    elif risk_score <= 2:
        risk_level = "medium"
        risk_label = "주의"
    else:
        risk_level = "high"
        risk_label = "높음"

    return {
        "taxpayer_id": taxpayer_id,
        "risk_level":  risk_level,
        "risk_label":  risk_label,
        "risk_score":  risk_score,
        "comments":    comments,
        "note":        "현재 템플릿 기반 분석입니다. Claude API 연결 후 더 정밀한 분석을 제공합니다.",
    }

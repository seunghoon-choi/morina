"""
PDF 파싱 로컬 테스트 스크립트
python test_parse.py
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from db import init_db, get_conn
from pdf_parser import parse_tax_pdf

PDF_PATH = r"C:\Users\C2304\OneDrive\문서\카카오톡 받은 파일\소득세 신고도움서비스-샘플01.pdf"


def run():
    print("=" * 60)
    print("1. DB 초기화")
    init_db()

    print("\n2. PDF 파싱")
    data = parse_tax_pdf(PDF_PATH)
    print(json.dumps(data, ensure_ascii=False, indent=2))

    print("\n3. DB INSERT 테스트")
    conn = get_conn()
    cur = conn.cursor()

    tp = data["taxpayer"]
    cur.execute("""
        INSERT INTO taxpayers
          (tax_year, name, birth_date, guide_type, bookkeeping_obligation,
           estimated_expense_rate, payment_extension, ars_auth_number,
           religion_income, pdf_filename)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, (
        tp.get("tax_year"), tp.get("name"), tp.get("birth_date"),
        tp.get("guide_type"), tp.get("bookkeeping_obligation"),
        tp.get("estimated_expense_rate"), tp.get("payment_extension"),
        tp.get("ars_auth_number"), tp.get("religion_income", "X"),
        "샘플01.pdf",
    ))
    taxpayer_id = cur.lastrowid
    print(f"   → taxpayer_id = {taxpayer_id}")

    for b in data["businesses"]:
        cur.execute("""
            INSERT INTO businesses
              (taxpayer_id, business_reg_no, business_name, income_type_code,
               industry_code, business_type, bookkeeping_obligation,
               expense_rate_type, revenue,
               std_expense_rate_general, std_expense_rate_own,
               simple_expense_rate_general, simple_expense_rate_own)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            taxpayer_id,
            b.get("business_reg_no"), b.get("business_name"),
            b.get("income_type_code"), b.get("industry_code"),
            b.get("business_type"), b.get("bookkeeping_obligation"),
            b.get("expense_rate_type"), b.get("revenue"),
            b.get("std_expense_rate_general"), b.get("std_expense_rate_own"),
            b.get("simple_expense_rate_general"), b.get("simple_expense_rate_own"),
        ))
    print(f"   → businesses: {len(data['businesses'])}건 INSERT")

    for h in data["tax_history"]:
        cur.execute("""
            INSERT INTO tax_history
              (taxpayer_id, attribution_year, total_income, income_deduction,
               taxable_income, tax_rate, calculated_tax, deduction_tax,
               determined_tax, effective_tax_rate)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            taxpayer_id,
            h.get("attribution_year"), h.get("total_income"),
            h.get("income_deduction"), h.get("taxable_income"),
            h.get("tax_rate"), h.get("calculated_tax"),
            h.get("deduction_tax"), h.get("determined_tax"),
            h.get("effective_tax_rate"),
        ))
    print(f"   → tax_history: {len(data['tax_history'])}건 INSERT")

    for cc in data["credit_card_usage"]:
        cur.execute("""
            INSERT INTO credit_card_usage
              (taxpayer_id, usage_year, category, count, amount)
            VALUES (?,?,?,?,?)
        """, (
            taxpayer_id,
            cc.get("usage_year"), cc["category"],
            cc.get("count"), cc.get("amount"),
        ))
    print(f"   → credit_card_usage: {len(data['credit_card_usage'])}건 INSERT")

    conn.commit()

    print("\n4. DB 조회 확인")
    row = conn.execute(
        "SELECT * FROM taxpayers WHERE id=?", (taxpayer_id,)
    ).fetchone()
    print(f"   납세자: {dict(row)}")

    biz_rows = conn.execute(
        "SELECT business_reg_no, business_name, revenue FROM businesses WHERE taxpayer_id=?",
        (taxpayer_id,)
    ).fetchall()
    for r in biz_rows:
        print(f"   사업장: {dict(r)}")

    hist_rows = conn.execute(
        "SELECT attribution_year, total_income, taxable_income, determined_tax FROM tax_history WHERE taxpayer_id=?",
        (taxpayer_id,)
    ).fetchall()
    for r in hist_rows:
        print(f"   세금이력: {dict(r)}")

    conn.close()
    print("\n[완료] 테스트 성공!")


if __name__ == "__main__":
    run()

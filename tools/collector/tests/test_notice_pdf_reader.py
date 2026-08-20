# PDF -> 문서 JSON 변환 테스트. JAR 실행이 필요한 것은 COLLECTOR_RUN_PDF_TESTS=1 일 때만 돈다.
import json
import os
from pathlib import Path

import pytest

from collector.notice_pdf_parser import parse_tenant_table_from_cells
from collector.notice_pdf_reader import PdfReadError, pdf_to_document

FIXTURES = Path(__file__).parent / "fixtures"


def test_rejects_input_that_is_not_a_pdf():
    """PDF가 아니면 JAR을 띄우기 전에 막는다.

    법원이 차단 페이지(HTML)를 200으로 돌려준 실측이 있어(WP-11 §4-31) 그것을 PDF로 넘기면
    엉뚱한 실패로 번진다. 앞 4바이트로 먼저 거른다.
    """
    with pytest.raises(PdfReadError, match="PDF가 아니다"):
        pdf_to_document(b"<br>\n<center>The request ... has been blocked.")


def test_reports_missing_java_clearly(monkeypatch):
    """java를 못 찾으면 원인을 로그만 보고 알 수 있게 말한다.

    개발 PC에서 PATH의 java가 Java 8로 잡혀 UnsupportedClassVersionError로 죽은 적이 있다.
    설정값을 메시지에 실어 어디를 고쳐야 하는지 드러낸다.
    """
    monkeypatch.setenv("COLLECTOR_JAVA", "java-that-does-not-exist")

    with pytest.raises(PdfReadError, match="java를 찾을 수 없다"):
        pdf_to_document(b"%PDF-1.4 ...")


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_PDF_TESTS") != "1",
    reason="set COLLECTOR_RUN_PDF_TESTS=1 (Java 11+ 필요) to run the JAR",
)
def test_real_pdf_yields_the_same_cells_as_the_stored_fixture():
    """실제 PDF를 돌린 결과가 보관 픽스처와 같은 임차인을 낸다.

    픽스처는 이 경로로 뜬 것이라, 어긋나면 JAR 버전이 바뀌어 표 인식이 달라졌다는 뜻이다.
    """
    pdf = FIXTURES / "notice_103032_1.pdf"
    if not pdf.exists():
        pytest.skip("PDF 표본이 없다 — 열람 창이 열렸을 때만 받을 수 있다")

    from_pdf = parse_tenant_table_from_cells(pdf_to_document(pdf.read_bytes()))
    from_fixture = parse_tenant_table_from_cells(
        json.loads((FIXTURES / "notice_pdf_cells_103032_1.json").read_text(encoding="utf-8"))
    )

    assert from_pdf.tenants == from_fixture.tenants

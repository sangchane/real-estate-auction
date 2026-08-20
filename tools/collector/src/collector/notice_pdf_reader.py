# 명세서 PDF를 opendataloader-pdf(JAR)로 돌려 표 구조가 담긴 문서 JSON을 얻는다.
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import opendataloader_pdf

JAR = Path(opendataloader_pdf.__file__).parent / "jar" / "opendataloader-pdf-cli.jar"

# JAR은 Java 11+가 필요하다(class file 55). 이 값을 설정으로 빼는 이유: 개발 PC에서 PATH의
# `java`가 Java 8로 잡히는 일이 실제로 있었다(C:\Windows\System32\java.exe). 그러면
# UnsupportedClassVersionError로 죽는데, 원인이 PATH라는 것을 로그만 보고는 알기 어렵다.
_JAVA_ENV = "COLLECTOR_JAVA"


class PdfReadError(RuntimeError):
    """PDF를 문서 JSON으로 바꾸지 못했다 — 호출부는 텍스트 레이어 경로로 폴백한다."""


def pdf_to_document(pdf: bytes, *, timeout_s: int = 180) -> dict[str, Any]:
    """PDF 바이트를 opendataloader 문서 JSON으로 바꾼다.

    JAR은 파일 경로만 받으므로 임시 디렉토리를 거친다. 명세서에는 개인정보가 들어 있어
    임시 파일은 작업이 끝나면 지운다(tempfile.TemporaryDirectory가 보장한다).
    """
    if not pdf.startswith(b"%PDF"):
        raise PdfReadError(f"PDF가 아니다 (앞 8바이트: {pdf[:8]!r})")

    java = os.getenv(_JAVA_ENV, "java")
    with tempfile.TemporaryDirectory(prefix="notice-pdf-") as work:
        source = Path(work) / "notice.pdf"
        source.write_bytes(pdf)
        out = Path(work) / "out"
        try:
            result = subprocess.run(
                [java, "-jar", str(JAR), str(source), "--output-dir", str(out),
                 "--format", "json", "--quiet"],
                capture_output=True,
                timeout=timeout_s,
                check=False,
            )  # fmt: skip
        except FileNotFoundError as exc:
            raise PdfReadError(f"java를 찾을 수 없다 ({_JAVA_ENV}={java})") from exc
        except subprocess.TimeoutExpired as exc:
            raise PdfReadError(f"opendataloader 시간 초과 ({timeout_s}초)") from exc

        if result.returncode != 0:
            tail = result.stderr.decode("utf-8", "replace").strip()[-300:]
            raise PdfReadError(f"opendataloader 실패 (exit {result.returncode}): {tail}")

        produced = sorted(out.glob("*.json"))
        if not produced:
            raise PdfReadError("opendataloader가 JSON을 내지 않았다")
        return json.loads(produced[0].read_text(encoding="utf-8"))

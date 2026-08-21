// 매각물건명세서 원문 보기 팝업 — 파싱 결과를 사용자가 원문과 대조할 수 있게 한다.
//
// 확대·축소는 브라우저 내장 PDF 뷰어가 제공한다. pdf.js 같은 라이브러리를 넣지 않는 이유는
// 필요한 기능(보기·확대·축소·인쇄)이 내장 뷰어에 이미 다 있고, 뷰어 하나 때문에 수 MB짜리
// 의존성과 워커 번들을 더할 이유가 없어서다 (AGENTS.md 규칙 14).
'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './NoticePdfDialog.module.css';

export function NoticePdfDialog({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  // 열기 전에는 iframe을 만들지 않는다 — 안 열어볼 사용자에게 90KB를 받게 하지 않는다
  const [loaded, setLoaded] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // 팝업 뒤 본문이 스크롤되면 어디를 보고 있었는지 잃는다
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setOpen(true);
          setLoaded(true);
        }}
      >
        명세서 원문 보기
      </button>

      {open ? (
        <div
          className={styles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-label="매각물건명세서 원문"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className={styles.panel}>
            <header className={styles.header}>
              <h2 className={styles.title}>매각물건명세서 원문</h2>
              <div className={styles.actions}>
                <a className={styles.link} href={src} target="_blank" rel="noreferrer">
                  새 탭에서 열기
                </a>
                <button
                  type="button"
                  ref={closeRef}
                  className={styles.close}
                  onClick={() => setOpen(false)}
                >
                  닫기
                </button>
              </div>
            </header>
            {loaded ? (
              <iframe className={styles.frame} src={src} title="매각물건명세서 원문" />
            ) : null}
            <p className={styles.hint}>
              확대·축소는 뷰어 안의 버튼이나 Ctrl(⌘)+마우스 휠로 할 수 있어요. 화면에 안 보이면
              새 탭에서 열어 주세요.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

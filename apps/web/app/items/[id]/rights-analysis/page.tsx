// 권리분석 결과 화면 — 매각물건명세서로 계산한 인수 판정을 보여준다.
// 본문은 지도 패널과 공유한다 (components/RightsAnalysisView.tsx) — 두 화면이 갈라지면 안 된다.
// 등기부(CODEF, WP-04)는 아직 연동 전이라 등기 권리 목록과 채권액이 빠져 있고,
// 그래서 인수액이 확정되지 않는 임차인이 생긴다. 그 한계는 본문에서 밝힌다.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchAffordability, fetchAuctionItem, fetchNoticeAnalysis } from '../../api-client';
import { AffordabilityCustomBid } from '../../components/AffordabilityCustomBid';
import { RightsAnalysisView } from '../../components/RightsAnalysisView';
import { decodeItemId } from '../../item-id';
import { noticePdfSrc } from '../../photo';
import { NOINDEX } from '../../../seo';
import styles from './page.module.css';

// 물건별 실데이터를 렌더하지만 등기부가 빠진 중간 상태라 아직 색인시키지 않는다.
// CODEF 연동 후 해제 (WP-10 §1-3)
export const metadata: Metadata = { robots: NOINDEX };

export default async function RightsAnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = decodeItemId(id);
  if (!key) notFound();

  const [item, analysis, affordability] = await Promise.all([
    fetchAuctionItem(key),
    fetchNoticeAnalysis(key),
    fetchAffordability(key),
  ]);
  if (!item) notFound();

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>권리분석 결과</h1>
      <RightsAnalysisView
        analysis={analysis}
        basis={{ minimumSalePrice: item.minimumSalePrice }}
        affordability={affordability}
        noticePdfUrl={noticePdfSrc(key)}
      />
      {/* 직접 입력은 상세에서만 — 시나리오 정의는 API 한 곳에 있다 */}
      {analysis !== null ? (
        <AffordabilityCustomBid
          courtOfficeCode={key.courtOfficeCode}
          caseNo={key.caseNo}
          itemNo={key.itemNo}
        />
      ) : null}
    </main>
  );
}

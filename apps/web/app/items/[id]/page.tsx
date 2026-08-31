// 물건 상세 화면 — apps/api의 실제 수집 데이터를 조회해 가격 헤더 + 물건 개요 표 + 하단 고정 CTA
// "권리분석 보기"를 렌더링한다 (05-blueprint §3a). 권리분석 이후 화면은 아직 예시 데이터로 남아있다.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchAuctionItem, fetchAuctionItemPhotos, fetchDongBuildingAge } from '../api-client';
import { buildingAgeSummary, buildingAgeUnknownNote } from '../building-age';
import { Badge } from '../components/Badge';
import { FavoriteButton } from '../components/FavoriteButton';
import {
  computeMinimumBidRate,
  formatAreaWithKind,
  formatBidDatetime,
  formatWon,
} from '../format';
import { decodeItemId, encodeItemId } from '../item-id';
import { assumedRightsLabel, riskFlagLabels, tenantLabel } from '../notice-labels';
import { photoAlt, photoProxySrc } from '../photo';
import {
  buildBreadcrumbJsonLd,
  buildItemDescription,
  buildItemTitle,
  buildOpenGraph,
  NOINDEX,
  serializeJsonLd,
  SITE_URL,
} from '../../seo';
import styles from './page.module.css';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const key = decodeItemId(id);
  const item = key ? await fetchAuctionItem(key) : null;
  if (!key || !item) {
    // 없는 물건은 색인시키지 않는다 (수집분이 빠지면 404가 색인에 남는다)
    return { title: '물건을 찾을 수 없어요 - 부동산 경매 플랫폼', robots: NOINDEX };
  }

  const canonical = `/items/${encodeItemId(key)}`;
  const title = buildItemTitle(item);
  const description = buildItemDescription(item);
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: buildOpenGraph(canonical, title, description),
  };
}

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = decodeItemId(id);
  if (!key) notFound();

  const item = await fetchAuctionItem(key);
  if (!item) notFound();

  // 사진은 사건 단위라 물건 → 사건 조인으로 조회된다 (008_item_photos.sql)
  const photos = await fetchAuctionItemPhotos(key);
  // 물건이 속한 동의 노후도 사실. null이면 섹션을 그리지 않는다 — 없는 집계를 0%로 그리지 않는다
  const buildingAge = await fetchDongBuildingAge(key);

  const minimumBidRate = computeMinimumBidRate(item.appraisalAmount, item.minimumSalePrice);
  const bidDatetimeLabel = formatBidDatetime(item.bidDatetime);
  // 면적은 평·㎡ 둘 다 보여준다. 건물이면 전용면적, 토지면 토지면적이다.
  // 일괄매각·다층처럼 면적이 여럿이거나 표기가 없으면 생략한다 — 추정하지 않는다.
  const areaText = formatAreaWithKind(item.areaM2, item.areaKind);

  // 아래 화면 빵부스러기와 문구·순서가 정확히 같아야 한다 — 화면에 없는 정보를 구조화 데이터에만
  // 넣지 않는다 (WP-10 §1-5). 마지막 항목(현재 페이지)은 자기 URL을 생략한다
  const usageLabel = item.usageName ?? '물건';

  // 명세서 신호. null(미확인)과 "인수할 권리 없음"을 구분해 표기한다 — 같게 보이면 위험을
  // 없는 것처럼 읽힌다.
  const rightsText = assumedRightsLabel(item.assumedRightsKind);
  const tenantText = tenantLabel(item.tenantCount);
  const flagTexts = riskFlagLabels(item.riskFlags);
  const noticeMissing = rightsText === null && tenantText === null && flagTexts.length === 0;
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(SITE_URL, [
    { name: '경매 물건 목록', path: '/items' },
    { name: usageLabel },
  ]);

  return (
    <main className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbJsonLd) }}
      />
      <p className={styles.breadcrumb}>
        <Link href="/items">경매 물건 목록</Link> &gt; {usageLabel}
      </p>

      <section className={styles.priceHeader}>
        <p className={styles.courtLine}>
          {item.courtName} {item.deptName} · {item.caseNo}
        </p>
        {item.usageName ? <span className={styles.usageBadge}>{item.usageName}</span> : null}
        <h1 className={styles.address}>{item.address ?? '주소 정보 없음'}</h1>

        <div className={styles.priceRow}>
          <span className={styles.minPrice}>
            {item.minimumSalePrice !== null ? formatWon(item.minimumSalePrice) : '가격 정보 없음'}
          </span>
          {minimumBidRate !== null ? <span className={styles.minRate}>최저가율 {minimumBidRate}%</span> : null}
        </div>
        {item.appraisalAmount !== null ? (
          <p className={styles.appraisedLine}>
            감정가 <s>{formatWon(item.appraisalAmount)}</s>
          </p>
        ) : null}

        <div className={styles.metaChips}>
          {item.failedBidCount !== null ? (
            <span className={`${styles.chip} ${styles.chipFailed}`}>{item.failedBidCount}회 유찰</span>
          ) : null}
          {bidDatetimeLabel ? (
            <span className={`${styles.chip} ${styles.chipDate}`}>매각기일 {bidDatetimeLabel}</span>
          ) : null}
        </div>
      </section>

      {photos.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>물건 사진</h2>
          <div className={styles.photoGrid}>
            {photos.map((photo) => (
              // next/image 대신 <img> — 외부 로더 설정 없이 프록시 경로를 그대로 쓰는 게 단순하다
              <img
                key={photo.id}
                className={styles.photo}
                src={photoProxySrc(photo.id)}
                alt={photoAlt(photo)}
                loading="lazy"
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>물건 개요</h2>
        <div className={styles.specsTable}>
          <div className={styles.specsRow}>
            <span className={styles.specsLabel}>사건번호</span>
            <span className={styles.specsValue}>{item.caseNo}</span>
          </div>
          <div className={styles.specsRow}>
            <span className={styles.specsLabel}>물건종류</span>
            <span className={styles.specsValue}>{item.usageName ?? '정보 없음'}</span>
          </div>
          <div className={styles.specsRow}>
            <span className={styles.specsLabel}>면적</span>
            <span className={styles.specsValue}>
              {areaText ?? '정보 없음'}
            </span>
          </div>
          <div className={styles.specsRow}>
            <span className={styles.specsLabel}>담당계</span>
            <span className={styles.specsValue}>{item.deptName ?? '정보 없음'}</span>
          </div>
        </div>
      </section>

      {/* 동네 노후도 — 건축물대장 집계 사실(FR-009). 좋고 나쁨은 말하지 않는다(D-011):
          재개발 기대에는 노후가 유리하게, 실거주에는 불리하게 읽히는 값이라 판단은 보는 사람의 몫이다. */}
      {buildingAge ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>동네 건물 노후도</h2>
          <p className={styles.buildingAgeSummary}>{buildingAgeSummary(buildingAge)}</p>
          {buildingAgeUnknownNote(buildingAge) ? (
            <p className={styles.buildingAgeNote}>{buildingAgeUnknownNote(buildingAge)}</p>
          ) : null}
        </section>
      ) : null}

      {/* 매각물건명세서 — 법원이 공고한 사실이라 물건별 실데이터다(등기부 기반 권리분석은 아직 예시).
          가격·유찰만 보고 놓치기 쉬운 인수 부담이 여기서 처음 드러나므로 CTA 바로 위에 둔다. */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>매각물건명세서</h2>
        {noticeMissing ? (
          <p className={styles.noticeUnknown}>
            아직 명세서를 받지 못한 물건이에요. 인수할 권리가 없다는 뜻이 아니라 확인되지 않았다는
            뜻이에요.
          </p>
        ) : (
          <div className={styles.noticeChips}>
            {tenantText ? <Badge tone="muted">{tenantText}</Badge> : null}
            {rightsText ? <Badge tone="muted">{rightsText}</Badge> : null}
            {flagTexts.map((flag) => (
              <Badge key={flag} tone="muted">
                {flag}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <div className={styles.ctaBar}>
        <div className={styles.ctaRow}>
          <FavoriteButton
            courtOfficeCode={item.courtOfficeCode}
            caseNo={item.caseNo}
            itemNo={item.itemNo}
            currentPath={`/items/${encodeItemId(key)}`}
          />
          <Link href={`/items/${id}/rights-analysis`} className={styles.ctaLink}>
            권리분석 보기
          </Link>
        </div>
      </div>
    </main>
  );
}

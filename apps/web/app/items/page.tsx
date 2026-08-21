// 물건 목록 화면 — WP-02 실제 수집 데이터를 훑어보고 상세로 진입한다.
// 4천 건을 조건 없이 나열하면 훑을 수가 없어 지역·유형·가격 필터와 정렬을 함께 둔다.
// 필터는 주소(query string)로만 동작한다 — 서버 렌더 그대로 쓰이고 링크 공유·뒤로가기가 맞는다.
// 지역을 드릴다운으로 좁히려면 /items/browse.
import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchAuctionItemCount, fetchAuctionItems, fetchRegionCounts } from './api-client';
import { ItemCard } from './components/ItemCard';
import { ItemFilters } from './components/ItemFilters';
import { parseFilters, toApiFilter } from './components/item-filters';
import { Pagination } from './components/Pagination';
import { buildOpenGraph, SITE_NAME } from '../seo';
import styles from './page.module.css';

const TITLE = `경매 물건 목록 | ${SITE_NAME}`;
const DESCRIPTION = '법원 경매 물건을 지역·유형·가격으로 좁혀보고 감정가·최저매각가격·매각기일을 확인해요';
// 물건이 몰려 있는 시/도. 지금 수집 범위가 서울 5개 법원이라 시/군/구가 실질적인 지역 축이다.
const PRIMARY_SIDO = '서울특별시';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/items' },
  openGraph: buildOpenGraph('/items', TITLE, DESCRIPTION),
};

const PAGE_SIZE = 20;

export default async function ItemListPage({
  searchParams,
}: {
  searchParams: Promise<{
    offset?: string;
    sigungu?: string;
    usage?: string;
    price?: string;
    sort?: string;
  }>;
}) {
  const query = await searchParams;
  const offset = Math.max(Number(query.offset) || 0, 0);
  const filters = parseFilters(query);
  const apiFilter = { sido: PRIMARY_SIDO, ...toApiFilter(filters) };

  const [items, total, regions] = await Promise.all([
    fetchAuctionItems(PAGE_SIZE, offset, { ...apiFilter, sort: filters.sort as never }),
    fetchAuctionItemCount(apiFilter),
    fetchRegionCounts(PRIMARY_SIDO),
  ]);

  const prevOffset = Math.max(offset - PAGE_SIZE, 0);
  // 필터가 걸린 주소를 페이지 이동에도 유지한다 — 안 그러면 2쪽에서 조건이 풀린다
  const pageHref = (next: number) => {
    const params = new URLSearchParams();
    if (filters.sigungu) params.set('sigungu', filters.sigungu);
    if (filters.categories.length > 0) params.set('usage', filters.categories.join(','));
    if (filters.priceKey) params.set('price', filters.priceKey);
    if (filters.sort !== 'recent') params.set('sort', filters.sort);
    if (next > 0) params.set('offset', String(next));
    const search = params.toString();
    return search ? `/items?${search}` : '/items';
  };

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>물건 목록</h1>
      <Link href="/items/map" className={styles.mapLink}>
        지도로 보기
      </Link>

      <ItemFilters state={filters} regions={regions} total={total} />

      {items.length === 0 ? (
        <p className={styles.emptyState}>조건에 맞는 물건이 없어요. 조건을 넓혀보세요.</p>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <ItemCard key={`${item.courtOfficeCode}-${item.caseNo}-${item.itemNo}`} item={item} />
          ))}
        </div>
      )}

      <Pagination
        prevHref={pageHref(prevOffset)}
        nextHref={pageHref(offset + PAGE_SIZE)}
        hasPrev={offset > 0}
        hasNext={items.length === PAGE_SIZE}
      />
    </main>
  );
}

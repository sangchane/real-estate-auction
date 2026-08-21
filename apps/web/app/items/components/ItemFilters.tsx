// 목록 필터 UI — 지역·유형·가격 세 축과 정렬. 순수 로직은 item-filters.ts에 있다.
//
// 클라이언트 상태를 두지 않고 **주소(query string)로만** 동작한다. 칩 하나하나가 자기를
// 켜고 끄는 링크다. 그래서 서버 렌더 그대로 쓰이고, 뒤로가기·새로고침·링크 공유가 다 맞는다.
import Link from 'next/link';
import { USAGE_CATEGORY_LABEL } from '../map/usage-category';
import { FILTERABLE_CATEGORIES, PRICE_RANGES, SORTS, type FilterState } from './item-filters';
import styles from './ItemFilters.module.css';

function href(state: FilterState, patch: Partial<FilterState>): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (next.sigungu) params.set('sigungu', next.sigungu);
  if (next.categories.length > 0) params.set('usage', next.categories.join(','));
  if (next.priceKey) params.set('price', next.priceKey);
  if (next.sort !== 'recent') params.set('sort', next.sort);
  const query = params.toString();
  return query ? `/items?${query}` : '/items';
}

function Chip({ active, label, target }: { active: boolean; label: string; target: string }) {
  return (
    <Link
      href={target}
      className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
      aria-pressed={active}
    >
      {label}
    </Link>
  );
}

export function ItemFilters({
  state,
  regions,
  total,
}: {
  state: FilterState;
  /** 시/군/구별 건수 — 고르기 전에 몇 건인지 보여야 헛클릭이 줄어든다 */
  regions: { name: string; count: number }[];
  /** 지금 조건의 전체 건수. null이면 조회 실패라 숫자를 지어내지 않는다 */
  total: number | null;
}) {
  const hasAny =
    state.sigungu !== undefined || state.categories.length > 0 || state.priceKey !== undefined;

  return (
    <div className={styles.root}>
      <div className={styles.summary}>
        <span className={styles.count}>
          {total === null ? '건수를 불러오지 못했어요' : `${total.toLocaleString()}건`}
        </span>
        {hasAny ? (
          <Link href="/items" className={styles.reset}>
            조건 지우기
          </Link>
        ) : null}
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>지역</span>
        <div className={styles.chips}>
          {regions.map((region) => (
            <Chip
              key={region.name}
              label={`${region.name} ${region.count.toLocaleString()}`}
              active={state.sigungu === region.name}
              target={href(state, {
                sigungu: state.sigungu === region.name ? undefined : region.name,
              })}
            />
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>유형</span>
        <div className={styles.chips}>
          {FILTERABLE_CATEGORIES.map((category) => {
            const active = state.categories.includes(category);
            return (
              <Chip
                key={category}
                label={USAGE_CATEGORY_LABEL[category]}
                active={active}
                target={href(state, {
                  categories: active
                    ? state.categories.filter((value) => value !== category)
                    : [...state.categories, category],
                })}
              />
            );
          })}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>최저가</span>
        <div className={styles.chips}>
          {PRICE_RANGES.map((range) => (
            <Chip
              key={range.key}
              label={range.label}
              active={state.priceKey === range.key}
              target={href(state, {
                priceKey: state.priceKey === range.key ? undefined : range.key,
              })}
            />
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>정렬</span>
        <div className={styles.chips}>
          {SORTS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              active={state.sort === option.key}
              target={href(state, { sort: option.key })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

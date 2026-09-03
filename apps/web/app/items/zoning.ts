// 용도지역("몇 종 지역") 사실 문구 — 채색 버킷이 아니라 **원문 명칭**으로 말하고, 출처·기준연월과
// 원천의 "법적 효력 없음" 고지를 함께 낸다 (기획 12 §2.4·§3.3). 지도 범례(map/zoning-layer.ts)와
// 물건 상세가 같은 이름표를 쓰도록 버킷 사전을 여기 한 곳에 둔다.

/** apps/api GET /zones/zoning/:court/:case/:item 응답 한 건 (ItemZoningDistrictDto와 같은 모양) */
export interface ItemZoningDistrict {
  zoningId: number;
  zoningBucket: string | null;
  zoneNameRaw: string | null;
  sclasCl: string | null;
  mlsfcCl: string | null;
  baseYm: string;
}

/**
 * 채색 버킷의 이름표. 범례가 쓰는 이름이지 개별 폴리곤의 이름이 아니다 — 폴리곤은 원문 명칭
 * (`zoneNameRaw`)으로 말한다. 전용주거가 제1·2종을 합친 한 칸인 이유는 서울 전역에 47폴리곤뿐이라
 * 별도 명도 단계의 값어치가 없기 때문이고, 정확한 종은 카드가 원문으로 답한다 (기획 12 §2.4).
 * "그 밖"·미분류는 채색하지 않으므로 이 사전에 없다.
 */
export const ZONING_BUCKET_LABEL: Record<string, string> = {
  RES_EXCLUSIVE: '전용주거',
  RES_GENERAL_1: '제1종일반주거',
  RES_GENERAL_2: '제2종일반주거',
  RES_GENERAL_3: '제3종일반주거',
  RES_SEMI: '준주거',
};

/** 이름을 만드는 데 필요한 최소 속성 — 지도 폴리곤과 물건 상세가 같은 함수를 쓰게 한다 */
export interface ZoningNameSource {
  zoneNameRaw: string | null;
  sclasCl: string | null;
  mlsfcCl: string | null;
}

/**
 * 화면에 낼 한 건의 이름. 원문 명칭이 먼저다 — "(7층이하)" 같은 고시 세부가 원문에만 있고,
 * 버킷 이름표로 바꾸면 그 사실이 사라진다. 명칭이 비면 코드 원문이라도 보인다.
 */
export function zoningDisplayName(district: ZoningNameSource): string {
  if (district.zoneNameRaw !== null) return district.zoneNameRaw;
  const code = district.sclasCl ?? district.mlsfcCl;
  return code === null ? '명칭 정보 없음' : `코드 ${code}`;
}

/**
 * 화면에 낼 값이 같은 건을 한 줄로 접는다.
 *
 * 원천이 같은 자리의 옛 고시·재고시 폴리곤을 함께 담아 물건의 10.6%가 여러 건인데, **그중 대부분은
 * 보여줄 값이 완전히 같다** — 실측(2026-09-03) 다중 매치 528물건 중 399물건이 명칭·코드가 전부
 * 동일하고, 한 물건은 "제2종일반주거지역"만 7줄이었다. 같은 문장을 일곱 번 적는 것은 사실을 더
 * 말하는 게 아니라 읽기를 방해한다.
 *
 * 접는 기준은 **화면에 내는 값**뿐이다(명칭·소분류·중분류). 폴리곤 id는 다르지만 보이는 것이
 * 같으므로 무엇도 감추지 않는다. 값이 실제로 다른 건(실측 129물건)은 그대로 남아 전부 보인다 —
 * 한 건을 고르는 순간 그 선택이 추측이 되기 때문이다.
 */
export function dedupeZoning(districts: readonly ItemZoningDistrict[]): ItemZoningDistrict[] {
  const seen = new Set<string>();
  const kept: ItemZoningDistrict[] = [];
  for (const district of districts) {
    const key = `${district.zoneNameRaw ?? ''}|${district.sclasCl ?? ''}|${district.mlsfcCl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(district);
  }
  return kept;
}

/**
 * 여러 건일 때의 안내. 겹침은 오류가 아니라 원천의 모양이다 — 원천이 같은 자리의 옛 고시·재고시
 * 폴리곤을 함께 담기 때문이다(마이그레이션 022 주석). 접고 나서도 남은 건수를 센다 — 같은 값이
 * 두 폴리곤에 있는 것은 사용자에게 "겹침"이 아니라 그냥 한 가지 사실이다.
 */
export function zoningOverlapNote(districts: readonly ItemZoningDistrict[]): string | null {
  const distinct = dedupeZoning(districts);
  if (distinct.length < 2) return null;
  return `이 자리에는 고시가 다른 용도지역 ${distinct.length}건이 겹쳐 있어요`;
}

/**
 * 출처·기준연월 한 줄. 원천이 스스로 "법적 효력 없는 참고자료"라고 고지하므로 그대로 싣는다
 * (기획 12 §2.2 약점 ②) — 공적 확인은 토지이음·지자체 열람이라는 사실을 숨기지 않는다.
 * 기준연월이 섞여 있으면(폴백 원천 전환기) 모두 적는다 — 하나로 합치면 없는 사실이 된다.
 * 지도 범례와 물건 상세가 같은 문장을 쓰도록 연월만 받는다.
 */
export function zoningSourceNote(baseYms: readonly string[]): string {
  const unique = [...new Set(baseYms)].sort();
  return `서울시(서울 열린데이터광장) ${unique.join('·')} 기준 · 법적 효력이 없는 참고자료예요`;
}

// 구역 표시 이름 — 원천이 이름과 사업 종류를 두 필드에 섞어 써서, 화면에 무엇을 이름으로 낼지 고른다.
//
// 원천(국가공간정보포털 LSMD_CONT_UD602)의 실측 상태:
//   - ALIAS(zone_name)가 776건 중 563건 비어 있다.
//   - 그런데 REMARK(business_kind)에 "남대문 도시정비형 재개발구역"처럼 **구역명이** 들어 있는
//     경우와 "주거환경개선사업"처럼 **사업 종류**만 있는 경우가 섞여 있다.
//
// 그래서 REMARK를 조건부로 이름으로 승격한다. **원본 컬럼은 손대지 않는다** — 승격은 표시
// 단계에서만 하고, 나중에 추진단계 API로 진짜 이름을 받으면 이 함수만 걷어내면 된다.
//
// "구역으로 끝나면 이름"이라는 단순 규칙은 쓰지 않는다. 실측 78개 값 중 "도시환경정비구역"(8건),
// "재건축정비구역"(5건), "재개발구역"(3건)처럼 **일반명사가 구역으로 끝나는 경우**가 많아,
// 그대로 두면 서로 다른 구역 8개가 전부 같은 이름으로 표시된다. 이름이 이름 구실을 못 한다.

/**
 * 사업 유형 어휘만으로 이루어진 값 — 고유명사가 없어 이름이 될 수 없다.
 * 실측(2026-08-31) 78개 distinct 값에서 추린 것이고, 새 값이 나오면 여기에 더한다.
 * 목록에 없으면 이름으로 보므로, 빠뜨리면 일반명사가 이름으로 새는 쪽으로 틀린다.
 */
const GENERIC_KINDS = new Set([
  '재개발구역',
  '정비예정구역',
  '재건축정비구역',
  '재정비촉진구역',
  '주택재개발구역',
  '건축허가제한구역',
  '도시환경정비구역',
  '시장정비사업구역',
  '주거환경개선지구',
  '재건축정비예정구역',
  '주택재건축정비구역',
  '도시환경정비예정구역',
  '주거환경개선사업구역',
  '주택재건축 정비구역',
  '도시정비형 재개발구역',
  '주택재개발 정비예정구역',
  '주택정비형 재개발사업 정비구역',
  '주거환경개선지구 사업완료구역',
]);

/** 구역명은 "구역" 또는 "지구"로 끝난다. 그 밖의 값("주택재개발", "행위제한")은 종류나 상태다. */
const ZONE_SUFFIX = /(구역|지구)$/;

export interface ZoneNaming {
  /** 화면에 이름으로 낼 값. 없으면 null — 그때 화면은 "구역명 정보 없음"으로 적는다 */
  displayName: string | null;
  /** 이름을 business_kind에서 끌어왔는지. 화면이 출처를 밝힐 수 있게 넘긴다 */
  promoted: boolean;
}

/**
 * 원본 두 필드에서 표시할 이름을 고른다.
 *
 * zone_name이 있으면 그대로 쓰고, 없을 때만 business_kind를 본다.
 * business_kind가 "구역/지구"로 끝나면서 일반명사가 아니면 이름으로 승격한다.
 */
export function resolveZoneName(
  zoneName: string | null | undefined,
  businessKind: string | null | undefined,
): ZoneNaming {
  const name = zoneName?.trim();
  if (name) return { displayName: name, promoted: false };

  const kind = businessKind?.trim();
  if (!kind) return { displayName: null, promoted: false };
  if (GENERIC_KINDS.has(kind)) return { displayName: null, promoted: false };
  if (!ZONE_SUFFIX.test(kind)) return { displayName: null, promoted: false };

  return { displayName: kind, promoted: true };
}

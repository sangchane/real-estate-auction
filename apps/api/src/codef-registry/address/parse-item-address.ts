// 경매 물건 주소 문자열을 등기부 조회 파라미터로 쪼갠다 — 법원이 준 한 줄 주소가 유일한 입력이다.
//
// **이 파일의 설계 원칙은 "확신 없으면 비운다"다.** 열람 1건에 700원이 실제로 나가는데,
// 실패 방식이 두 가지고 값이 크게 다르다:
//   - 값을 비워서 후보가 여러 건 → CODEF가 멈춘다 → 돈이 안 나간다 (되돌릴 수 있다)
//   - 값을 잘못 채워서 엉뚱한 부동산 1건과 정확히 매칭 → 700원 쓰고 남의 등기부를 받는다
// 그래서 애매한 자리는 추측해서 채우지 않고 null로 둔다. 덜 채운 요청은 안전하게 실패한다.
import type { RegistryLookupAddress } from '../client/registry-lookup-request';

export type ParsedItemAddress =
  | { ok: true; address: RegistryLookupAddress }
  | { ok: false; reason: string };

/**
 * 자동차 경매 물건이 같은 표에 섞여 들어온다. "사용본거지"는 차량 등록지라 부동산 주소가
 * 아니고, 그대로 조회하면 엉뚱한 건물의 등기부를 받는다.
 */
const VEHICLE_PREFIX = /^\s*사용본거지/;

/** 시군구는 구/시/군으로 끝난다 — 여기서 걸러지면 우리가 모르는 형식이다 */
const SIGUNGU = /(구|시|군)$/;

/**
 * 도로명이냐 지번이냐를 가르는 자리. 둘 다 "로"로 시작할 수 있어 접미사로만 구분된다:
 *   충정로7길 → 도로명 (길로 끝남)      충정로3가 → 법정동 (숫자+가로 끝남)
 *   오금로   → 도로명 (로로 끝남)      영등포동2가 → 법정동
 * 이 구분을 틀리면 roadName 자리에 동 이름이 들어가 검색이 통째로 어긋난다.
 */
const ROAD_NAME = /(로|길)$/;
const LEGAL_DONG = /(동|가)$/;

/** 지번 — 산번지(산1-45)와 부번 없는 번지(182)를 모두 포함한다 */
const LOT_NUMBER = /^산?\d+(-\d+)?$/;
/** 도로명 건물번호 — 지번과 형태가 같아 위치로만 구분한다 */
const BUILDING_NUMBER = /^\d+(-\d+)?$/;

/** 집합건물 동 — 숫자만으로 된 동이다. "상도1동"(행정동)과 섞이면 안 되므로 토큰 전체를 본다 */
const UNIT_DONG = /^(?:제)?(\d+)동$/;
/** 층은 조회에 쓰지 않는다. 호수만 필요하다 */
const FLOOR_ONLY = /^(?:제)?(?:지하|지)?\d*층$/;
/** "제403호", "403호" — 붙어 있는 "3층301호" 형태는 별도로 처리한다 */
const UNIT_HO = /^(?:제)?(\d+)호$/;
/** "3층301호", "제7층제702호", "지하층1호" — 층과 호가 붙어 있는 형태 */
const FLOOR_AND_HO = /^(?:제)?(?:지하|지)?\d*층\s*(?:제)?(\d+)호$/;

export function parseItemAddress(raw: string): ParsedItemAddress {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: '주소가 없어서 등기부를 찾을 수 없어요.' };
  }
  if (VEHICLE_PREFIX.test(trimmed)) {
    return { ok: false, reason: '자동차 경매 물건이라 등기부가 없어요.' };
  }

  // 괄호는 도로명 주소의 보조 정보다: (법정동, 건물명) 또는 (법정동)
  const { body, parenthetical } = splitParenthetical(trimmed);
  const tokens = body.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 3) {
    return { ok: false, reason: '주소가 짧아서 어느 부동산인지 특정할 수 없어요.' };
  }

  const [sido, sigungu, ...rest] = tokens;
  if (sido === undefined || sigungu === undefined || !SIGUNGU.test(sigungu)) {
    return { ok: false, reason: '주소 형식을 읽지 못했어요.' };
  }

  const locality = rest[0];
  const number = rest[1];
  if (locality === undefined || number === undefined) {
    return { ok: false, reason: '동·번지를 읽지 못했어요.' };
  }

  const isRoad = ROAD_NAME.test(locality);
  if (!isRoad && !LEGAL_DONG.test(locality)) {
    return { ok: false, reason: '주소에서 동 이름을 찾지 못했어요.' };
  }
  if (!(isRoad ? BUILDING_NUMBER : LOT_NUMBER).test(number)) {
    return { ok: false, reason: '번지를 읽지 못했어요.' };
  }

  const tail = parseTail(rest.slice(2));

  return {
    ok: true,
    address: {
      sido,
      sigungu,
      // 도로명 주소는 법정동이 괄호 안에 있다. 괄호가 없으면 모르는 채로 둔다 —
      // 도로명+건물번호만으로도 검색되고, 없는 동 이름을 지어내면 검색이 어긋난다.
      administrativeDong: isRoad ? (parenthetical.dong ?? null) : locality,
      lotNumber: isRoad ? null : number,
      roadName: isRoad ? locality : null,
      buildingNumber: isRoad ? number : null,
      buildingName: isRoad ? (parenthetical.buildingName ?? null) : tail.buildingName,
      unitDong: tail.unitDong,
      unitHo: tail.unitHo,
    },
  };
}

interface Parenthetical {
  dong: string | null;
  buildingName: string | null;
}

/** 끝의 괄호를 떼어낸다 — "(가산동, 금강노블레스)", "(면목동,헤렌하우스)", "(면목동)" */
function splitParenthetical(value: string): { body: string; parenthetical: Parenthetical } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(value);
  if (!match) return { body: value, parenthetical: { dong: null, buildingName: null } };

  const [, body = value, inner = ''] = match;
  const parts = inner.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  return {
    body,
    parenthetical: {
      dong: parts[0] ?? null,
      // 건물명이 쉼표로 더 쪼개져 있으면(드물다) 합치지 않고 첫 조각만 쓴다 —
      // 잘못 합치면 존재하지 않는 건물명이 되어 검색이 0건이 된다.
      buildingName: parts[1] ?? null,
    },
  };
}

interface AddressTail {
  buildingName: string | null;
  unitDong: string | null;
  unitHo: string | null;
}

/**
 * 번지 뒤에 남은 토큰들에서 건물명·동·호를 뽑는다.
 * 층은 버린다 — 조회 파라미터에 없고, 호수만으로 특정된다.
 */
function parseTail(tokens: readonly string[]): AddressTail {
  const nameParts: string[] = [];
  let unitDong: string | null = null;
  let unitHo: string | null = null;
  // 동·층·호가 시작되면 그 뒤는 건물명이 아니다. 이 경계를 넘고 나서 나온 한글 토큰은
  // 우리가 모르는 형식이므로 건물명에 섞지 않는다.
  let inUnitPart = false;

  for (const token of tokens) {
    const dongMatch = UNIT_DONG.exec(token);
    if (dongMatch?.[1] !== undefined) {
      unitDong = `${dongMatch[1]}동`;
      inUnitPart = true;
      continue;
    }

    const floorHo = FLOOR_AND_HO.exec(token);
    if (floorHo?.[1] !== undefined) {
      unitHo = `${floorHo[1]}호`;
      inUnitPart = true;
      continue;
    }

    const ho = UNIT_HO.exec(token);
    if (ho?.[1] !== undefined) {
      unitHo = `${ho[1]}호`;
      inUnitPart = true;
      continue;
    }

    if (FLOOR_ONLY.test(token)) {
      inUnitPart = true;
      continue;
    }

    if (!inUnitPart) {
      nameParts.push(token);
    }
    // inUnitPart 이후의 정체불명 토큰(예: "101-2802호")은 조용히 버린다. 호수로 추측해서
    // 채우면 다른 호실의 등기부를 700원 주고 받게 된다 — 비우면 CODEF가 후보를 돌려주고 멈춘다.
  }

  return {
    buildingName: nameParts.length > 0 ? nameParts.join(' ') : null,
    unitDong,
    unitHo,
  };
}

// 물건이 속한 법정동의 노후도 사실 문구 — 비율만 쓰지 않고 분자·분모·기준연월을 함께 낸다 (기획 12 §1.4)

/** apps/api GET /zones/building-age 응답. 비율은 API 한 곳에서 계산해 내려온다 */
export interface DongBuildingAge {
  bjdCode: string;
  dongName: string | null;
  baseYm: string;
  totalCount: number;
  unknownAprCount: number;
  over20Count: number;
  over30Count: number;
  over20RatioPct: number | null;
  over30RatioPct: number | null;
}

function count(n: number): string {
  return `${n.toLocaleString('ko-KR')}동`;
}

function pct(ratio: number | null): string {
  // API가 소수점 1자리로 반올림한 값이다. 40도 "40.0%"로 적는다 — 자릿수가 들쭉날쭉하면
  // 두 비율(30년/20년)을 나란히 읽을 수 없다.
  return ratio === null ? '' : `(${ratio.toFixed(1)}%)`;
}

/**
 * 본문 한 문장. 30년·20년 두 값을 병기한다(기획 12 §1.4 — DA-07 원칙) — 법정 노후 기준이
 * 20~30년 범위라 하나만 말하면 그 자체가 판단이 된다. 좋고 나쁨은 쓰지 않는다(D-011).
 */
export function buildingAgeSummary(age: DongBuildingAge): string {
  const dong = age.dongName ?? '이 동';
  if (age.totalCount === 0) {
    // 0%로 쓰면 "노후 건물 없음"이라는 허위 사실이 된다 (엣지 C-2)
    return `${dong}은 집계할 건물이 없어요 · 건축물대장 ${age.baseYm} 기준`;
  }
  return (
    `${dong} 건물 ${count(age.totalCount)} 중 지은 지 30년 넘은 건물은 ` +
    `${count(age.over30Count)}${pct(age.over30RatioPct)} · 20년 넘은 건물은 ` +
    `${count(age.over20Count)}${pct(age.over20RatioPct)} · 건축물대장 ${age.baseYm} 기준`
  );
}

/** 결측 병기. 분모에서 뺀 수를 숨기지 않는다 (엣지 C-3, 기획 12 §1.3) */
export function buildingAgeUnknownNote(age: DongBuildingAge): string | null {
  if (age.unknownAprCount === 0) return null;
  return `사용승인일 미상 ${count(age.unknownAprCount)}은 계산에서 뺐어요`;
}

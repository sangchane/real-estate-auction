import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assumedDepositCardLabel,
  ASSUMED_RIGHTS_LABEL,
  BURDEN_STATUS_LABEL,
  NOTICE_ASSUMPTION_LABEL,
  NOTICE_ASSUMPTION_REASON,
  REGISTERED_BURDEN_NOTE,
  REGISTERED_BURDEN_RULES,
  RISK_FLAG_LABEL,
  assumedRightsLabel,
  noticeAssumptionLabel,
  noticeAssumptionReason,
  riskFlagLabels,
  shortUsageName,
  tenantLabel,
} from './notice-labels';
import { GLOSSARY } from './glossary';

test('assumedRightsLabel은 명세서 코드를 한국어 라벨로 바꾼다', () => {
  assert.equal(assumedRightsLabel('LEASEHOLD_REGISTRATION'), '주택임차권등기');
  assert.equal(assumedRightsLabel('NONE'), '인수할 권리 없음');
});

test('assumedRightsLabel은 명세서가 없으면 null — "인수할 권리 없음"과 다르다', () => {
  // 이 둘을 같게 표기하면 "확인 못 함"이 "위험 없음"으로 보인다
  assert.equal(assumedRightsLabel(null), null);
  assert.notEqual(assumedRightsLabel('NONE'), null);
});

test('assumedRightsLabel은 모르는 코드를 숨기지 않고 그대로 노출한다', () => {
  // 조용히 사라지면 새 코드가 생겼을 때 위험 신호를 놓친다
  assert.equal(assumedRightsLabel('NEW_KIND'), 'NEW_KIND');
});

test('riskFlagLabels는 코드 배열을 라벨 배열로 바꾼다', () => {
  assert.deepEqual(riskFlagLabels(['HUG_PRIORITY_WAIVER', 'LIEN_CLAIM']), [
    'HUG 대항력포기 확약',
    '유치권 신고',
  ]);
  assert.deepEqual(riskFlagLabels([]), []);
  assert.deepEqual(riskFlagLabels(['UNKNOWN_FLAG']), ['UNKNOWN_FLAG']);
});

test('shortUsageName은 법원이 콤마로 묶어 보낸 용도에서 대표값만 남긴다', () => {
  // 실측: 이 두 묶음이 각각 126건·127건으로 가장 많다
  assert.equal(shortUsageName('연립주택,다세대,빌라'), '연립주택');
  assert.equal(shortUsageName('상가,오피스텔,근린시설'), '상가');
  assert.equal(shortUsageName('다세대'), '다세대');
});

test('shortUsageName은 값이 없거나 비면 null', () => {
  assert.equal(shortUsageName(null), null);
  assert.equal(shortUsageName(''), null);
  assert.equal(shortUsageName('  '), null);
});

test('tenantLabel은 없음·있음·미확인을 구분하고 사람 수를 세지 않는다', () => {
  // 0명 = 법원이 조사했는데 없더라 / null = 명세서를 못 받아 말할 수 없다
  assert.equal(tenantLabel(0), '점유자 없음');
  // HUG 보증보험에 들면 같은 세입자가 등기·권리신고 두 줄이 된다 — 세면 "2명"이 나온다
  assert.equal(tenantLabel(1), '점유자 있음');
  assert.equal(tenantLabel(2), '점유자 있음');
  assert.equal(tenantLabel(null), null);
});

// 같은 라벨 맵을 apps/mobile에도 두고 있다(RN에 @auction/shared를 붙이면 Metro 해석 문제를
// 다시 겪어서 format.ts 선례를 따랐다). 한쪽만 고치면 다른 쪽 사용자에게 코드 원문이 노출되므로
// 여기서 두 파일을 직접 비교해 어긋남을 막는다. RN tsconfig에는 Node 타입이 없어 웹에 둔다.
function parseLabels(source: string, mapName: string): Record<string, string> {
  const body = source.split(`export const ${mapName}: Record<string, string> = {`)[1]?.split('};')[0];
  if (body === undefined) throw new Error(`${mapName}을 찾지 못했다`);
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s*([A-Z_]+):\s*'(.*)',\s*$/.exec(line);
    if (match) out[match[1] as string] = match[2] as string;
  }
  return out;
}

const mobileSource = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'mobile', 'src', 'lib', 'notice-labels.ts'),
  'utf-8',
);

// 테스트는 dist-test/app/items 에서 돌아 __dirname 이 소스 폴더가 아니다 — 위 mobileSource 와 같은
// 방식으로 apps/web 까지 올라가서 원본을 읽는다.
const webSource = readFileSync(
  join(__dirname, '..', '..', '..', 'app', 'items', 'notice-labels.ts'),
  'utf-8',
);

test('인수권리 라벨이 모바일 사본과 같다', () => {
  assert.deepEqual(parseLabels(mobileSource, 'ASSUMED_RIGHTS_LABEL'), ASSUMED_RIGHTS_LABEL);
});

test('위험 플래그 라벨이 모바일 사본과 같다', () => {
  assert.deepEqual(parseLabels(mobileSource, 'RISK_FLAG_LABEL'), RISK_FLAG_LABEL);
});

test('noticeAssumptionLabel은 인수 판정을 화면 문구로 바꾼다', () => {
  assert.equal(noticeAssumptionLabel('NOT_ASSUMED'), '인수 안 함');
  assert.equal(noticeAssumptionLabel('ASSUMED_FULL'), '보증금 전액 인수');
  assert.equal(noticeAssumptionLabel('ASSUMED_AMOUNT_UNKNOWN'), '금액 미확정');
});

test('noticeAssumptionLabel은 모르는 코드를 숨기지 않고 그대로 노출한다', () => {
  assert.equal(noticeAssumptionLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.equal(noticeAssumptionReason('SOMETHING_NEW'), null);
});

test('판정 문구에 판단·권유 표현을 쓰지 않는다 (D-011)', () => {
  const banned = ['추천', '안전', '유리', '기회', '괜찮', '좋은'];
  const texts = [
    ...Object.values(NOTICE_ASSUMPTION_LABEL),
    ...Object.values(NOTICE_ASSUMPTION_REASON),
    ...Object.values(BURDEN_STATUS_LABEL),
    ...REGISTERED_BURDEN_RULES.flatMap((rule) => [rule.subject, rule.detail]),
    REGISTERED_BURDEN_NOTE,
    // 용어 뜻풀이도 화면에 그대로 나가는 문구다 — 같은 검사를 받아야 한다
    ...Object.values(GLOSSARY),
  ];
  for (const text of texts) {
    for (const word of banned) {
      assert.ok(!text.includes(word), `"${text}"에 금지 표현 "${word}"이 있다`);
    }
  }
});

test('근저당·압류 계열은 인수하지 않는다고 표기한다', () => {
  // 사용자가 화면만 보고 "근저당도 내가 계산해야 하나"를 판단할 수 있어야 한다.
  // apps/api right-classification.ts의 ALWAYS_EXTINGUISHED_ON_SALE와 같은 규칙이다.
  const rule = REGISTERED_BURDEN_RULES.find((item) => item.subject.includes('근저당'));
  assert.ok(rule !== undefined, '근저당 항목이 없다');
  assert.equal(rule.status, 'NOT_ASSUMED');
  assert.equal(BURDEN_STATUS_LABEL[rule.status], '인수 안 함');
  // 말소기준보다 앞선 근저당도 소멸한다는 것이 이 화면의 핵심 정보다
  assert.ok(rule.detail.includes('말소기준보다 앞서도'));
  assert.ok(rule.detail.includes('경매개시 전'));
});

test('용익물권 계열은 확인 필요로 남긴다 — "인수 안 함"으로 단정하지 않는다', () => {
  const rule = REGISTERED_BURDEN_RULES.find((item) => item.subject.includes('전세권'));
  assert.ok(rule !== undefined, '전세권 항목이 없다');
  assert.equal(rule.status, 'NEEDS_REVIEW');
});

test('부담 구분이 등기부를 본 결과가 아니라는 고지를 담는다', () => {
  // 이 고지가 없으면 "등기 권리가 하나도 없는 물건"으로 읽힌다
  assert.ok(REGISTERED_BURDEN_NOTE.includes('권리 종류에 따른 규칙'));
  assert.ok(REGISTERED_BURDEN_NOTE.includes('등기부를 확인한 결과가 아니에요'));
  assert.ok(REGISTERED_BURDEN_NOTE.includes('RIGHT_CLASSIFICATION v1'));
});

test('카드 라벨은 인수 확정 금액·미상·0원·명세서 미확인을 모두 다르게 말한다', () => {
  // 이 넷이 하나라도 같은 문구로 합쳐지면 사용자가 "부담 없음"으로 오독한다
  const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
  assert.equal(assumedDepositCardLabel({ amount: 50_000_000, isLowerBound: false }, won), '보증금 인수 50,000,000원');
  assert.equal(assumedDepositCardLabel({ amount: 50_000_000, isLowerBound: true }, won), '보증금 인수 50,000,000원 이상');
  assert.equal(assumedDepositCardLabel({ amount: 0, isLowerBound: true }, won), '금액 미확정');
  assert.equal(assumedDepositCardLabel({ amount: 0, isLowerBound: false }, won), '보증금 인수 없음');
  // null(명세서 미확인)은 문구를 만들지 않는다 — 호출부가 "명세서 미확인"으로 따로 적는다
  assert.equal(assumedDepositCardLabel(null, won), null);
});

test('카드 라벨은 필드가 빠진 응답에서도 죽지 않는다', () => {
  // 배포 스큐로 옛 API가 이 필드를 안 주면 목록 화면이 통째로 깨진다
  assert.equal(assumedDepositCardLabel(undefined, (v) => String(v)), null);
});

/**
 * 부담 구분 블록은 배열·유니온 타입이라 parseLabels로 못 읽는다 — 소스 원문을 비교한다.
 *
 * 공백을 **전부** 지우고 비교한다. 두 앱의 프리티어 printWidth가 달라 같은 코드가 다르게
 * 줄바꿈되기 때문이다(공백 하나로 접으면 `${` 뒤 줄바꿈이 차이로 남는다). 문구 자체가 갈라지는
 * 것은 각 앱의 값 단위 테스트가 잡고, 여기서는 "한쪽만 고쳤다"를 잡는다.
 */
function burdenBlock(source: string): string {
  const start = source.indexOf('export type BurdenStatus');
  const end = source.indexOf('export function noticeAssumptionLabel');
  if (start === -1 || end === -1 || end < start) throw new Error('부담 구분 블록을 찾지 못했다');
  return source.slice(start, end).replace(/\s+/g, '');
}

test('매수인 부담 구분 문구가 모바일 사본과 같다', () => {
  assert.equal(burdenBlock(mobileSource), burdenBlock(webSource));
});

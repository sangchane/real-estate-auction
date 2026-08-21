// 명세서 라벨 단위 테스트.
// 웹 사본과 어긋나지 않는지 검사하는 쪽은 apps/web(노드 기반 테스트 러너)에 있다 —
// RN tsconfig에는 Node 타입이 없어 여기서 파일을 읽을 수 없다.
import {
  assumedDepositCardLabel,
  assumedRightsLabel,
  BURDEN_STATUS_LABEL,
  REGISTERED_BURDEN_NOTE,
  REGISTERED_BURDEN_RULES,
  riskFlagLabels,
  shortUsageName,
  tenantLabel,
} from './notice-labels';

describe('assumedRightsLabel', () => {
  it('명세서 코드를 한국어 라벨로 바꾼다', () => {
    expect(assumedRightsLabel('LEASEHOLD_REGISTRATION')).toBe('주택임차권등기');
    expect(assumedRightsLabel('NONE')).toBe('인수할 권리 없음');
  });

  it('명세서가 없으면 null — "인수할 권리 없음"과 다르다', () => {
    // 이 둘을 같게 표기하면 "확인 못 함"이 "위험 없음"으로 읽힌다
    expect(assumedRightsLabel(null)).toBeNull();
    expect(assumedRightsLabel('NONE')).not.toBeNull();
  });

  it('모르는 코드는 숨기지 않고 그대로 노출한다', () => {
    expect(assumedRightsLabel('NEW_KIND')).toBe('NEW_KIND');
  });
});

describe('riskFlagLabels', () => {
  it('코드 배열을 라벨 배열로 바꾼다', () => {
    expect(riskFlagLabels(['HUG_PRIORITY_WAIVER', 'LIEN_CLAIM'])).toEqual([
      'HUG 대항력포기 확약',
      '유치권 신고',
    ]);
    expect(riskFlagLabels([])).toEqual([]);
    expect(riskFlagLabels(['UNKNOWN_FLAG'])).toEqual(['UNKNOWN_FLAG']);
  });
});

describe('shortUsageName', () => {
  it('법원이 콤마로 묶어 보낸 용도에서 대표값만 남긴다', () => {
    expect(shortUsageName('연립주택,다세대,빌라')).toBe('연립주택');
    expect(shortUsageName('상가,오피스텔,근린시설')).toBe('상가');
    expect(shortUsageName('다세대')).toBe('다세대');
  });

  it('값이 없거나 비면 null', () => {
    expect(shortUsageName(null)).toBeNull();
    expect(shortUsageName('  ')).toBeNull();
  });
});

describe('tenantLabel', () => {
  it('없음·있음·미확인을 구분하고 사람 수를 세지 않는다', () => {
    expect(tenantLabel(0)).toBe('점유자 없음');
    expect(tenantLabel(1)).toBe('점유자 있음');
    expect(tenantLabel(2)).toBe('점유자 있음');
    expect(tenantLabel(null)).toBeNull();
  });
});

describe('매수인 부담 구분', () => {
  it('근저당·압류 계열은 인수하지 않는다고 표기한다', () => {
    // 사용자가 화면만 보고 "근저당도 내가 계산해야 하나"를 판단할 수 있어야 한다
    const rule = REGISTERED_BURDEN_RULES.find(item =>
      item.subject.includes('근저당'),
    );
    expect(rule?.status).toBe('NOT_ASSUMED');
    expect(BURDEN_STATUS_LABEL.NOT_ASSUMED).toBe('인수 안 함');
    expect(rule?.detail).toContain('말소기준보다 앞서도');
    expect(rule?.detail).toContain('경매개시 전');
  });

  it('용익물권 계열은 확인 필요로 남긴다', () => {
    const rule = REGISTERED_BURDEN_RULES.find(item =>
      item.subject.includes('전세권'),
    );
    expect(rule?.status).toBe('NEEDS_REVIEW');
  });

  it('등기부를 본 결과가 아니라는 고지를 담는다', () => {
    expect(REGISTERED_BURDEN_NOTE).toContain('권리 종류에 따른 규칙');
    expect(REGISTERED_BURDEN_NOTE).toContain('등기부를 확인한 결과가 아니에요');
    expect(REGISTERED_BURDEN_NOTE).toContain('RIGHT_CLASSIFICATION v1');
  });
});

describe('assumedDepositCardLabel', () => {
  const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;

  it('인수 확정 금액·미상·0원·명세서 미확인을 모두 다르게 말한다', () => {
    // 이 넷이 하나라도 같은 문구로 합쳐지면 사용자가 "부담 없음"으로 오독한다
    expect(
      assumedDepositCardLabel({ amount: 50_000_000, isLowerBound: false }, won),
    ).toBe('보증금 인수 50,000,000원');
    expect(
      assumedDepositCardLabel({ amount: 50_000_000, isLowerBound: true }, won),
    ).toBe('보증금 인수 50,000,000원 이상');
    expect(
      assumedDepositCardLabel({ amount: 0, isLowerBound: true }, won),
    ).toBe('인수 금액 확인 필요');
    expect(
      assumedDepositCardLabel({ amount: 0, isLowerBound: false }, won),
    ).toBe('보증금 인수 없음');
    expect(assumedDepositCardLabel(null, won)).toBeNull();
  });

  it('필드가 빠진 응답에서도 죽지 않는다', () => {
    expect(assumedDepositCardLabel(undefined, won)).toBeNull();
  });
});

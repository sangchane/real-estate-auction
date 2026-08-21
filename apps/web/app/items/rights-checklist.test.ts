// 권리분석 4항목 체크리스트 — 순서, 사실 서술, 그리고 "빈 값이 안전으로 읽히지 않는지"
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rightsChecklist } from './rights-checklist';
import type { AnalyzedTenant, NoticeAnalysis } from './notice-analysis';

function tenant(over: Partial<AnalyzedTenant> & Pick<AnalyzedTenant, 'tenantSeq'>): AnalyzedTenant {
  return {
    sourceKinds: ['권리신고'],
    occupiedPart: '202호',
    possessionBasis: '주거 임차인',
    moveInDate: '2020-07-29',
    fixedDate: '2023-12-20',
    depositAmount: 50_000_000,
    demandedDistribution: true,
    demandedDistributionDate: '2024-10-25',
    possessionRightDate: '2020-07-30',
    hasPriority: false,
    distributionDemandEffective: true,
    assumption: 'NOT_ASSUMED',
    assumedAmount: null,
    ...over,
  };
}

function analysis(over: Partial<NoticeAnalysis> = {}): NoticeAnalysis {
  return {
    documentDate: '2026-08-11',
    baselineRaw: '2019.04.29. 근저당권',
    baselineDate: '2019-04-29',
    distributionDemandDeadline: '2026-02-19',
    assumedRightsKind: 'NONE',
    riskFlags: [],
    noTenantRecorded: false,
    tenants: [],
    source: 'NOTICE_ONLY',
    ...over,
  } as NoticeAnalysis;
}

test('네 항목이 확인 순서대로 나온다 — 뒤 항목은 앞 항목이 정해져야 답이 나온다', () => {
  const items = rightsChecklist(analysis());

  assert.deepEqual(items.map((item) => item.key), [
    'baseline',
    'priority',
    'assumedRights',
    'possession',
  ]);
});

test('기준일이 없으면 대항력을 판단할 수 없다고 밝힌다', () => {
  const [baseline] = rightsChecklist(analysis({ baselineDate: null, baselineRaw: null }));

  assert.equal(baseline?.status, 'UNKNOWN');
  assert.match(baseline?.limit ?? '', /판단할 수 없어요/);
});

test('기준일보다 앞선 임차인이 있으면 확인 항목으로 올린다', () => {
  const items = rightsChecklist(
    analysis({
      tenants: [tenant({ tenantSeq: 1, hasPriority: true, assumption: 'ASSUMED_AMOUNT_UNKNOWN' })],
    }),
  );
  const priority = items.find((item) => item.key === 'priority');

  assert.equal(priority?.status, 'ATTENTION');
  assert.match(priority?.summary ?? '', /1명/);
  // 인수액이 확정되지 않는 이유를 반드시 밝힌다 — 안 밝히면 "0원"으로 읽힌다
  assert.match(priority?.limit ?? '', /등기부/);
});

test('임차인 표를 못 읽었으면 "없음"이 아니라 "확인 못 함"이다', () => {
  // 빈 값이 "안전"으로 읽히면 안 된다 (§4-7의 버린 행 구분)
  const items = rightsChecklist(analysis({ tenants: [], noTenantRecorded: null }));
  const priority = items.find((item) => item.key === 'priority');

  assert.equal(priority?.status, 'UNKNOWN');
  assert.match(priority?.limit ?? '', /없다는 뜻이 아니에요/);
});

test('법원이 임차인 없다고 적었으면 확인된 사실로 둔다', () => {
  const items = rightsChecklist(analysis({ tenants: [], noTenantRecorded: true }));
  const priority = items.find((item) => item.key === 'priority');

  assert.equal(priority?.status, 'CONFIRMED');
  assert.equal(priority?.limit, null);
});

test('인수되는 권리는 등기부 한계를 항상 밝힌다 — "없음"도 확정이 아니다', () => {
  const none = rightsChecklist(analysis({ assumedRightsKind: 'NONE' }));
  const item = none.find((entry) => entry.key === 'assumedRights');

  assert.equal(item?.status, 'CONFIRMED');
  assert.match(item?.limit ?? '', /등기부를 아직 연동하지 않아/);
});

test('임차권등기가 있으면 인수 사실을 적는다', () => {
  const items = rightsChecklist(analysis({ assumedRightsKind: 'LEASEHOLD_REGISTRATION' }));
  const item = items.find((entry) => entry.key === 'assumedRights');

  assert.equal(item?.status, 'ATTENTION');
  assert.match(item?.summary ?? '', /인수돼요/);
});

test('점유자가 없다고 소유자가 산다고 말하지 않는다', () => {
  const items = rightsChecklist(analysis({ tenants: [], noTenantRecorded: true }));
  const item = items.find((entry) => entry.key === 'possession');

  assert.doesNotMatch(item?.summary ?? '', /소유자/);
  assert.match(item?.limit ?? '', /현장 확인/);
});

test('점유 권원은 명세서 원문을 그대로 보여준다 — 우리가 요약하지 않는다', () => {
  const items = rightsChecklist(
    analysis({
      tenants: [
        tenant({ tenantSeq: 1, possessionBasis: '주거 임차인' }),
        tenant({ tenantSeq: 2, possessionBasis: '점포 전세권자' }),
      ],
    }),
  );
  const item = items.find((entry) => entry.key === 'possession');

  assert.deepEqual(item?.facts, ['주거 임차인', '점포 전세권자']);
});

test('판단·권유 어휘를 쓰지 않는다 (변호사법 §109 — D-011)', () => {
  // 저장소 선례(seo.test.ts·notice-labels.test.ts)와 같은 형식의 금칙어 검사
  const forbidden = ['추천', '안전', '유망', '유리', '기회', '수익', '투자하', '괜찮', '좋은', '패스', '권장'];
  const cases = [
    analysis(),
    analysis({ tenants: [tenant({ tenantSeq: 1, hasPriority: true, assumption: 'ASSUMED_FULL' })] }),
    analysis({ tenants: [], noTenantRecorded: null }),
    analysis({ baselineDate: null, assumedRightsKind: 'LEASEHOLD_REGISTRATION' }),
  ];

  for (const input of cases) {
    for (const item of rightsChecklist(input)) {
      const text = [item.title, item.summary, item.limit ?? '', ...item.facts].join(' ');
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `금칙어 "${word}"가 들어갔다: ${text}`);
      }
    }
  }
});

test('받침에 맞는 조사를 고른다 — "주택임차권등기이"로 나오면 안 된다', () => {
  const noBatchim = rightsChecklist(analysis({ assumedRightsKind: 'LEASEHOLD_REGISTRATION' }));
  assert.match(
    noBatchim.find((item) => item.key === 'assumedRights')?.summary ?? '',
    /주택임차권등기가 매수인에게/,
  );

  const withBatchim = rightsChecklist(analysis({ assumedRightsKind: 'SUPERFICIES' }));
  assert.match(
    withBatchim.find((item) => item.key === 'assumedRights')?.summary ?? '',
    /지상권이 매수인에게/,
  );
});

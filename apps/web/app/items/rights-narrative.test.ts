// 권리분석 문장 생성기 — "무슨 돈인지"가 늘 말해지는지, 그리고 판단하지 않는지
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Affordability } from './affordability';
import type { AnalyzedTenant, NoticeAnalysis } from './notice-analysis';
import type { RegistryState } from './registry';
import {
  costSection,
  debtsSection,
  evidenceLine,
  occupantsSection,
  rightsConclusion,
  unknownItems,
} from './rights-narrative';

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
    assumedAmount: 0,
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

const FETCHED: RegistryState = {
  status: 'FETCHED',
  registeredRights: [
    { id: '1', type: 'MORTGAGE', receivedDate: '2019-04-29', amount: 300_000_000 },
    { id: '2', type: 'PROVISIONAL_SEIZURE', receivedDate: '2023-05-23' },
  ],
  fetchedAt: '2026-08-13T02:00:00.000Z',
  lookupPreview: null,
  reason: null,
};

test('금액이 나올 때 그게 무슨 돈인지 같은 카드에서 말한다', () => {
  const result = rightsConclusion(
    analysis({
      tenants: [tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: 65_000_000 })],
    }),
  );

  assert.match(result.headline, /6,500만/);
  // 숫자만 있고 뜻이 없으면 "무슨 말인지 모르겠다"가 된다
  assert.match(result.body.join(' '), /매수인이 세입자에게 돌려줘야/);
});

test('하한이라는 사실을 각주가 아니라 카드 본문에 넣는다', () => {
  const result = rightsConclusion(
    analysis({
      tenants: [
        tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: 65_000_000 }),
        tenant({ tenantSeq: 2, assumption: 'ASSUMED_AMOUNT_UNKNOWN', assumedAmount: null }),
      ],
    }),
  );

  assert.match(result.body.join(' '), /이 금액보다 클 수 있어요/);
});

test('계산 못 하는 경우 "0원이 아니다"를 본문에서 못박는다', () => {
  // 이 화면에서 가장 큰 오독 위험이다 — 빈 값이 "부담 없음"으로 읽히면 안 된다
  const result = rightsConclusion(
    analysis({
      tenants: [tenant({ tenantSeq: 1, assumption: 'ASSUMED_AMOUNT_UNKNOWN', assumedAmount: null })],
    }),
  );

  assert.equal(result.headline, '아직 계산할 수 없어요');
  assert.match(result.body.join(' '), /0원이라는 뜻이 아니에요/);
});

test('0원이 사실일 때도 명세서 기준이라고 밝힌다', () => {
  const result = rightsConclusion(analysis({ tenants: [tenant({ tenantSeq: 1 })] }));

  assert.match(result.headline, /0원/);
  assert.match(result.body.join(' '), /등기부의 권리까지 확인한 것은 아니에요/);
});

test('명세서를 못 받았으면 0원이라고 말하지 않는다', () => {
  const result = rightsConclusion(null);

  assert.doesNotMatch(result.headline, /0원/);
  assert.match(result.body.join(' '), /아직 받지 못했어요/);
});

test('대항력은 용어 대신 결과로 말하고, 뜻은 ? 뒤에 둔다', () => {
  const section = occupantsSection(
    analysis({ tenants: [tenant({ tenantSeq: 1, hasPriority: true })] }),
  );

  // 요약은 결과만 말한다 — 뜻풀이를 문장에 넣으면 한 줄이 세 줄이 된다
  assert.match(section.summary.join(' '), /집을 비워주지 않아도 돼요/);
  assert.ok(section.terms.includes('대항력'));
});

test('세입자가 다 기준일 이후여도 집을 비우는 일이 남는다고 말한다', () => {
  const section = occupantsSection(analysis({ tenants: [tenant({ tenantSeq: 1 })] }));

  assert.match(section.summary.join(' '), /떠안지 않아요/);
  assert.match(section.summary.join(' '), /집을 비우는 일은 낙찰 후에 남아요/);
  assert.ok(section.terms.includes('명도'));
});

test('세입자를 사람 수로 세지 않는다 — 명세서 행은 사람이 아니라 기록이다', () => {
  // HUG 전세보증보험에 들면 같은 세입자가 등기·권리신고로 두 줄이 된다.
  // 점유부분도 "601호"와 "전유부분전부"처럼 같은 곳을 다르게 적어 실측 1,504건이
  // 두 세대처럼 보였다. 한 물건은 대개 한 세대다.
  const section = occupantsSection(
    analysis({
      tenants: [
        tenant({ tenantSeq: 1, hasPriority: true }),
        tenant({ tenantSeq: 2, hasPriority: true }),
      ],
    }),
  );

  assert.doesNotMatch(section.summary.join(' '), /\d+명/);
});

test('세입자 없음과 못 읽음을 다르게 말한다', () => {
  const recorded = occupantsSection(analysis({ tenants: [], noTenantRecorded: true }));
  const unread = occupantsSection(analysis({ tenants: [], noTenantRecorded: null }));

  assert.match(recorded.summary.join(' '), /빈집이라는 뜻은 아니에요/);
  assert.match(unread.summary.join(' '), /없다는 뜻이 아니에요/);
  assert.equal(unread.state, '미확인');
});

test('근저당을 내가 갚는지에 늘 답한다 — 등기부가 없어도 확정된 규칙이다', () => {
  const section = debtsSection(analysis(), null);

  assert.match(section.summary.join(' '), /매수인이 대신 갚지 않아요/);
});

test('등기부를 받기 전에는 미확인이라고 표시한다', () => {
  assert.equal(debtsSection(analysis(), null).state, '미확인');
  assert.equal(debtsSection(analysis(), FETCHED).state, '확인됨');
});

test('등기부를 받으면 받은 날짜와 건수를 말한다', () => {
  const section = debtsSection(analysis(), FETCHED);

  assert.match(section.summary.join(' '), /2026-08-13에 받은 등기부/);
  assert.match(section.summary.join(' '), /2건/);
});

test('기준 날짜가 없으면 판정할 수 없다고 밝힌다', () => {
  const section = debtsSection(analysis({ baselineDate: null }), null);

  assert.match(section.summary.join(' '), /판정할 수 없어요/);
});

test('총비용을 한 문장으로 말한다', () => {
  const affordability = {
    appraisalAmount: 400_000_000,
    minimumSalePrice: 294_000_000,
    bulkSale: false,
    usageName: '다세대',
    assumedTotal: 0,
    assumedIsLowerBound: false,
    comparableSales: { count: 0, rateP25: null, rateMedian: null, rateP75: null },
    scenarios: [
      {
        kind: 'MINIMUM_PRICE',
        bidPrice: 294_000_000,
        totalBurden: 300_000_000,
        totalWithExtras: { min: 310_000_000, max: 320_000_000 },
        appraisalRatio: null,
        extras: [],
        unknownItems: [],
      },
    ],
    referencePrice: 'APPRAISAL',
    source: 'NOTICE_ONLY',
  } as unknown as Affordability;

  const section = costSection(affordability);

  assert.match(section?.summary.join(' ') ?? '', /낙찰가 \+ 돌려줄 보증금 \+ 세금·비용/);
});

test('확인 목록은 해소되면 항목이 빠진다', () => {
  const before = unknownItems(analysis({ tenants: [tenant({ tenantSeq: 1 })] }), null);
  const after = unknownItems(analysis({ tenants: [tenant({ tenantSeq: 1 })] }), FETCHED);

  assert.ok(before.some((item) => item.title === '등기부'));
  assert.ok(!after.some((item) => item.title === '등기부'));
});

test('근거 줄이 등기부 열람 여부를 밝힌다', () => {
  assert.match(evidenceLine(null), /등기부 미확인/);
  assert.match(evidenceLine(FETCHED), /2026-08-13 열람 등기부/);
});

test('판단·권유 어휘를 쓰지 않는다 (변호사법 §109 — D-011)', () => {
  const forbidden = ['추천', '안전', '위험', '유망', '유리', '기회', '수익', '투자하', '괜찮', '좋은', '권장'];
  const cases: (NoticeAnalysis | null)[] = [
    null,
    analysis(),
    analysis({ tenants: [tenant({ tenantSeq: 1, hasPriority: true, assumption: 'ASSUMED_FULL' })] }),
    analysis({ tenants: [], noTenantRecorded: null }),
    analysis({ baselineDate: null, assumedRightsKind: 'LEASEHOLD_REGISTRATION' }),
  ];

  for (const input of cases) {
    for (const registry of [null, FETCHED]) {
      const text = [
        ...rightsConclusion(input).body,
        rightsConclusion(input).headline,
        ...occupantsSection(input).summary,
        ...debtsSection(input, registry).summary,
        ...unknownItems(input, registry).map((item) => `${item.title} ${item.detail}`),
        evidenceLine(registry),
      ].join(' ');

      for (const word of forbidden) {
        assert.ok(!text.includes(word), `금칙어 "${word}"가 들어갔다: ${text}`);
      }
    }
  }
});

test('화면 문구에 마크다운 기호를 넣지 않는다', () => {
  // 화면은 문자열을 그대로 그린다 — "**0원이라는 뜻이 아니에요.**"가 별표째 보였다
  const cases: (NoticeAnalysis | null)[] = [
    null,
    analysis(),
    analysis({ tenants: [tenant({ tenantSeq: 1, assumption: 'ASSUMED_AMOUNT_UNKNOWN', assumedAmount: null })] }),
    analysis({ tenants: [tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: 1000 })] }),
  ];

  for (const input of cases) {
    const text = [
      ...rightsConclusion(input).body,
      rightsConclusion(input).headline,
      ...occupantsSection(input).summary,
      ...debtsSection(input, null).summary,
    ].join(' ');

    assert.ok(!text.includes('**'), `마크다운 강조가 들어갔다: ${text}`);
    assert.ok(!text.includes('__'), `마크다운 강조가 들어갔다: ${text}`);
  }
});

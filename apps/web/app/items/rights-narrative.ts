// 권리분석을 "문장"으로 만든다 — 숫자만 있고 문장이 없어서 "무슨 말인지 모르겠다"가 나왔다.
//
// 설계 근거는 `docs/design/rights-analysis-ux.md`다. 요지는 세 가지다.
//
// 1. **숫자에 뜻을 붙인다.** "6,500만 원"만으로는 그게 내가 더 내야 할 돈인지 알 수 없다.
//    금액과 그 금액이 무슨 돈인지를 같은 카드 안에서 말한다 — 각주로 떨어뜨리면 안 읽는다.
// 2. **용어는 처음 나올 때 한 번 풀어 쓴다.** 대항력·인수·말소기준을 설명 없이 쓰면
//    화면 전체가 읽히지 않는다.
// 3. **판단하지 않는다** (변호사법 §109 — D-011). "추천·안전·위험"을 쓸 수 없으므로
//    "그래서 뭐?"에는 ① 법적 효과를 지갑 단위로 번역하고 ② 불확실성의 방향을 밝히고
//    ③ 직접 확인할 것을 사실로 제시해서 답한다.
import type { Affordability } from './affordability';
import { formatWonRangeCompact, summaryScenario } from './affordability';
import { formatWonCompact } from './format';
import { assumedHeadline, assumedTotal, type NoticeAnalysis } from './notice-analysis';
import { assumedRightsLabel } from './notice-labels';
import type { GlossaryKey } from './glossary';
import type { RegistryState } from './registry';

/** 결론 카드 — 큰 숫자 하나와, 그 숫자가 무슨 돈인지 말하는 문장들 */
export interface RightsConclusion {
  label: string;
  /** 큰 자리에 들어갈 값. 금액이 없으면 문장이 들어간다 ("아직 계산할 수 없어요") */
  headline: string;
  /** 헤드라인이 금액인지 — 문장은 금액용 display 폰트에 넣으면 여러 줄로 깨진다 */
  isAmount: boolean;
  /** 헤드라인 바로 아래 문단. 첫 문장이 "이게 무슨 돈인지"다 */
  body: string[];
}

const LABEL = '낙찰가와 별도로 돌려줘야 하는 보증금';

export function rightsConclusion(analysis: NoticeAnalysis | null): RightsConclusion {
  if (analysis === null) {
    return {
      label: LABEL,
      headline: '아직 알 수 없어요',
      isAmount: false,
      body: [
        '이 물건의 매각물건명세서를 아직 받지 못했어요.',
        '명세서는 입찰기일 1주 전부터 열람할 수 있어요.',
      ],
    };
  }

  const headline = assumedHeadline(assumedTotal(analysis.tenants));

  if (headline.kind === 'AMOUNT') {
    return {
      label: LABEL,
      headline: formatWonCompact(headline.amount),
      isAmount: true,
      body: [
        '먼저 살던 세입자의 보증금이에요. 낙찰가와 별도로 매수인이 세입자에게 돌려줘야 해요.',
        // 하한이라는 사실은 각주가 아니라 카드 안에 둔다 — 숫자만 읽고 지나가면 과소평가한다
        ...(headline.isLowerBound
          ? ['금액이 확정되지 않은 세입자가 더 있어, 실제로는 이 금액보다 클 수 있어요.']
          : []),
      ],
    };
  }

  if (headline.kind === 'UNCONFIRMED') {
    return {
      label: LABEL,
      headline: '아직 계산할 수 없어요',
      isAmount: false,
      body: [
        // "0원"으로 읽히는 것을 막는 문장이다. 이 화면에서 가장 큰 오독 위험이라 본문에 둔다.
        '돌려줘야 할 수 있는 보증금이 있어요. 0원이라는 뜻이 아니에요.',
        '세입자가 배당에서 얼마를 돌려받는지는 등기부의 빚 목록이 있어야 계산할 수 있어요.',
      ],
    };
  }

  return {
    label: LABEL,
    headline: '0원 — 명세서 기준',
    isAmount: false,
    body: [
      '명세서에서는 떠안는 보증금이 확인되지 않았어요.',
      '다만 명세서만 본 결과라 등기부의 권리까지 확인한 것은 아니에요.',
    ],
  };
}

export type SectionKey = 'occupants' | 'debts' | 'cost';

export interface RightsSection {
  key: SectionKey;
  /** 질문형 제목 — 도메인 용어가 아니라 사용자의 질문을 그대로 쓴다 */
  title: string;
  /**
   * 접기 전에도 항상 보이는 요약. **요점만 쓴다** — 용어 설명을 문장에 끼워 넣으면
   * 한 문장이 세 줄이 되어 요약이 요약이 아니게 된다. 설명은 terms로 빼서 ? 뒤에 둔다.
   */
  summary: string[];
  /** 이 섹션에서 쓴 용어들 — 제목 옆 ? 버튼이 보여준다 */
  terms: GlossaryKey[];
  /** 접었을 때 제목 옆에 붙는 상태. 없으면 붙이지 않는다 */
  state: '확인됨' | '미확인' | null;
}

/** 섹션 1 — 지금 이 집에 누가 살고 있고, 낙찰 후에 나와 무슨 일이 남나 */
export function occupantsSection(analysis: NoticeAnalysis | null): RightsSection {
  if (analysis === null) {
    return {
      key: 'occupants',
      title: '지금 살고 있는 사람',
      summary: ['명세서를 아직 받지 못해서 세입자 정보를 알 수 없어요.'],
      terms: [],
      state: '미확인',
    };
  }

  const tenants = analysis.tenants;
  if (tenants.length === 0) {
    const recorded = analysis.noTenantRecorded === true;
    return {
      key: 'occupants',
      title: '지금 살고 있는 사람',
      summary: recorded
        ? ['법원 조사에서 세입자가 확인되지 않았어요. 빈집이라는 뜻은 아니에요.']
        : ['세입자 정보를 읽지 못했어요. 없다는 뜻이 아니에요.'],
      terms: [],
      state: recorded ? '확인됨' : '미확인',
    };
  }

  // **사람 수를 세지 않는다.** 명세서의 행은 "사람"이 아니라 "그 집에 대한 기록"이다 —
  // 전세보증보험(HUG)에 들면 같은 세입자가 등기·권리신고로 두 줄이 되고, 점유부분도
  // "601호"와 "전유부분전부"처럼 같은 곳을 다르게 적어 실측 1,504건이 두 세대처럼 보였다.
  // 한 물건은 대개 한 세대이므로, 세는 대신 그 집이 어떤 상태인지를 말한다.
  const priority = tenants.filter((tenant) => tenant.hasPriority === true).length;
  if (priority === 0) {
    return {
      key: 'occupants',
      title: '지금 살고 있는 사람',
      summary: [
        '확인된 세입자는 기준 날짜보다 늦게 전입했어요. 보증금은 낙찰대금에서 해결되고 매수인이 떠안지 않아요.',
        '다만 집을 비우는 일은 낙찰 후에 남아요.',
      ],
      terms: ['명도', '매수인'],
      state: '확인됨',
    };
  }

  return {
    key: 'occupants',
    title: '지금 살고 있는 사람',
    summary: [
      '기준 날짜보다 먼저 전입한 세입자가 있어요. 보증금을 돌려받을 때까지 집을 비워주지 않아도 돼요.',
    ],
    terms: ['대항력', '말소기준', '매수인'],
    state: '확인됨',
  };
}

/** 섹션 2 — 집에 걸린 빚을 내가 떠안나 */
export function debtsSection(
  analysis: NoticeAnalysis | null,
  registry: RegistryState | null,
): RightsSection {
  const summary: string[] = [];

  if (analysis?.baselineDate != null) {
    summary.push(`${analysis.baselineDate}에 설정된 권리가 기준이에요.`);
  } else {
    summary.push('명세서에 기준 날짜가 적혀 있지 않아, 어느 권리가 지워지는지 판정할 수 없어요.');
  }

  // 규칙은 등기부 없이도 확정된 사실이라 늘 말할 수 있다 — "근저당도 내가 갚나"에 대한 답이다
  summary.push('은행 빚·압류·가압류는 낙찰되면 지워져요. 매수인이 대신 갚지 않아요.');

  if (analysis !== null) {
    const label = assumedRightsLabel(analysis.assumedRightsKind);
    if (analysis.assumedRightsKind === 'NONE') {
      summary.push('법원은 인수되는 권리를 "해당사항없음"으로 적었어요.');
    } else if (label !== null) {
      summary.push(`다만 법원이 "${label}는 매수인이 인수한다"고 적었어요.`);
    } else {
      summary.push('명세서의 인수권리 란이 비어 있어요 — 없다는 뜻인지 확인해야 해요.');
    }
  }

  if (registry?.status === 'FETCHED' && registry.registeredRights) {
    summary.push(describeRegistry(registry));
  } else {
    summary.push('이 집 등기부는 아직 받지 않았어요. 받으면 실제로 걸려 있는 권리를 볼 수 있어요.');
  }

  return {
    key: 'debts',
    title: '집에 걸려 있는 빚과 권리',
    summary,
    terms: ['말소기준', '인수', '소멸', '근저당'],
    // 등기부를 받아야 "확인됨"이다. 명세서만으로는 등기 목록을 알 수 없다.
    state: registry?.status === 'FETCHED' ? '확인됨' : '미확인',
  };
}

function describeRegistry(registry: RegistryState): string {
  const rights = registry.registeredRights ?? [];
  const when = registry.fetchedAt !== null ? `${registry.fetchedAt.slice(0, 10)}에 받은` : '받아 둔';
  if (rights.length === 0) return `${when} 등기부에는 걸려 있는 권리가 없어요.`;
  return `${when} 등기부에는 권리가 ${rights.length}건 있어요.`;
}

/** 섹션 3 — 다 합치면 얼마 드나 */
export function costSection(affordability: Affordability | null): RightsSection | null {
  if (affordability === null) return null;

  if (affordability.bulkSale) {
    return {
      key: 'cost',
      title: '결국 얼마가 드나',
      summary: ['일괄매각 물건이라 최저가가 묶음 전체 값이에요. 하나 기준으로는 계산하지 않아요.'],
      terms: [],
      state: '미확인',
    };
  }

  const scenario = summaryScenario(affordability);
  if (scenario === null) {
    return {
      key: 'cost',
      title: '결국 얼마가 드나',
      summary: ['시나리오를 만들 가격 정보가 부족해요.'],
      terms: [],
      state: '미확인',
    };
  }

  // 범위 포맷은 이미 affordability에 있다 — 여기서 다시 만들면 두 화면의 표기가 갈린다
  const total = formatWonRangeCompact(scenario.totalWithExtras);
  return {
    key: 'cost',
    title: '결국 얼마가 드나',
    summary: [
      `${formatWonCompact(scenario.bidPrice)}에 낙찰되면 총 ${total}이 들어요.`,
      '낙찰가 + 돌려줄 보증금 + 세금·비용이에요.',
    ],
    terms: ['감정가'],
    state: '확인됨',
  };
}

export interface UnknownItem {
  title: string;
  detail: string;
}

/**
 * "이 화면이 대신 못 하는 것" — 각 섹션에 흩어져 있던 한계를 한 곳에 모은다.
 *
 * D-011 안에서 "그래서 나는 뭘 하면 되나"에 답하는 유일한 방법이다. 입찰을 권하는 게
 * 아니라 확인 절차를 사실로 알려준다. 전부 해소되면 빈 배열을 돌려주고 블록을 그리지 않는다.
 */
export function unknownItems(
  analysis: NoticeAnalysis | null,
  registry: RegistryState | null,
): UnknownItem[] {
  const items: UnknownItem[] = [];

  if (registry?.status !== 'FETCHED') {
    items.push({
      title: '등기부',
      detail: '빚 목록이 있어야 돌려줄 보증금 금액이 확정돼요.',
    });
  }

  items.push({
    title: '체납 관리비',
    detail: '공용부분 체납액은 매수인이 낼 수 있는데, 금액은 관리사무소만 알아요.',
  });

  if (analysis === null || analysis.tenants.length === 0) {
    items.push({
      title: '현장',
      detail: '누가 살고 있는지는 서류만으로 알 수 없어요.',
    });
  }

  return items;
}

/** 화면 맨 위 한 줄 — 무엇을 근거로 계산했는지 */
export function evidenceLine(registry: RegistryState | null): string {
  if (registry?.status === 'FETCHED' && registry.fetchedAt !== null) {
    return `근거: 매각물건명세서 · ${registry.fetchedAt.slice(0, 10)} 열람 등기부`;
  }
  return '근거: 매각물건명세서 · 등기부 미확인';
}

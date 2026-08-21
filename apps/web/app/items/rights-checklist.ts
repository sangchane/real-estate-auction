// 권리분석 4항목 체크리스트 — 경매에서 실제로 확인해야 하는 순서대로 사실을 정리한다.
//
// 왜 4항목인가: 지금까지는 명세서에서 읽은 값을 순서 없이 나열해 무엇이 중요한지 드러나지
// 않았다. 경매 권리분석은 순서가 정해져 있다 — 기준선을 정하고, 그 기준선보다 앞선 권리를
// 찾고, 남는 것을 확인하고, 집을 비울 수 있는지 본다. 뒤 항목은 앞 항목이 정해져야 답이 나온다.
//
//   ① 말소기준권리   무엇이 언제인가            — 모든 판단의 기준선
//   ② 임차인 대항력   기준선보다 앞선 임차인이 있나 — 있으면 보증금을 인수할 수 있다
//   ③ 인수되는 권리   소멸되지 않고 남는 등기가 있나
//   ④ 점유·명도       누가 살고 있고 비울 수 있나
//
// **판단·권유 문구를 넣지 않는다** (변호사법 §109 — D-011). 각 항목은 "무엇이 확인됐다 /
// 확인되지 않았다"까지만 말하고, 확인되지 않은 이유를 밝힌다. 빈 값이 "문제 없음"으로 읽히면
// 안 된다.
import type { NoticeAnalysis, AnalyzedTenant } from './notice-analysis';
import { assumedRightsLabel } from './notice-labels';

export type ChecklistStatus =
  /** 명세서로 사실이 확인됐다 */
  | 'CONFIRMED'
  /** 확인해야 할 것이 있다 — 인수 가능성이 있는 사실이 잡혔다 */
  | 'ATTENTION'
  /** 지금 가진 자료로는 알 수 없다. 없다는 뜻이 아니다 */
  | 'UNKNOWN';

export interface ChecklistItem {
  key: 'baseline' | 'priority' | 'assumedRights' | 'possession';
  /** 화면에 그대로 쓰는 제목 */
  title: string;
  status: ChecklistStatus;
  /** 한 줄 요약 — 사실 서술만 */
  summary: string;
  /** 근거가 되는 값들 (날짜·금액 등 명세서 원문에서 온 것) */
  facts: string[];
  /** 이 항목에서 지금 알 수 없는 것과 그 이유 */
  limit: string | null;
}

/** 대항력이 있으면서 인수액이 확정되지 않았거나 전액 인수인 임차인 */
function assumedTenants(tenants: readonly AnalyzedTenant[]): AnalyzedTenant[] {
  return tenants.filter(
    (tenant) => tenant.assumption === 'ASSUMED_FULL' || tenant.assumption === 'ASSUMED_AMOUNT_UNKNOWN',
  );
}

/**
 * 한글 받침에 따라 주격 조사를 고른다 — "주택임차권등기이"처럼 쓰면 문장이 어색해진다.
 * 한글 음절은 0xAC00부터 28칸 주기로 종성이 돌아, 나머지가 0이면 받침이 없다.
 */
function subjectParticle(word: string): '이' | '가' {
  const last = word.codePointAt(word.length - 1);
  if (last === undefined || last < 0xac00 || last > 0xd7a3) return '가';
  return (last - 0xac00) % 28 === 0 ? '가' : '이';
}

function baselineItem(analysis: NoticeAnalysis): ChecklistItem {
  if (analysis.baselineDate === null) {
    return {
      key: 'baseline',
      title: '말소기준권리',
      status: 'UNKNOWN',
      summary: '명세서에 최선순위 설정이 적혀 있지 않아요.',
      facts: analysis.baselineRaw ? [analysis.baselineRaw] : [],
      limit: '기준일을 모르면 임차인이 그보다 앞서는지 판단할 수 없어요.',
    };
  }
  return {
    key: 'baseline',
    title: '말소기준권리',
    status: 'CONFIRMED',
    summary: `${analysis.baselineDate}에 설정된 권리가 기준이에요.`,
    facts: [analysis.baselineRaw ?? `${analysis.baselineDate} 설정`],
    // 명세서의 "최선순위 설정"은 법원이 적어준 값이라 그대로 신뢰한다. 다만 등기부의 전체
    // 권리 순위는 볼 수 없어, 이 기준선 뒤에 무엇이 붙어 있는지는 ③에서 다시 밝힌다.
    limit: null,
  };
}

function priorityItem(analysis: NoticeAnalysis): ChecklistItem {
  const assumed = assumedTenants(analysis.tenants);
  const withPriority = analysis.tenants.filter((tenant) => tenant.hasPriority === true);

  if (analysis.tenants.length === 0) {
    return {
      key: 'priority',
      title: '대항력 있는 임차인',
      status: analysis.noTenantRecorded === true ? 'CONFIRMED' : 'UNKNOWN',
      summary:
        analysis.noTenantRecorded === true
          ? '법원이 조사한 임차인이 없어요.'
          : '임차인 정보를 확인하지 못했어요.',
      facts: [],
      limit:
        analysis.noTenantRecorded === true
          ? null
          : '명세서의 점유자 표를 읽지 못했어요. 임차인이 없다는 뜻이 아니에요.',
    };
  }

  if (withPriority.length === 0) {
    return {
      key: 'priority',
      title: '대항력 있는 임차인',
      status: 'CONFIRMED',
      summary: '기준일보다 앞선 임차인은 확인되지 않았어요.',
      facts: [`임차인 ${analysis.tenants.length}명`],
      limit: null,
    };
  }

  return {
    key: 'priority',
    title: '대항력 있는 임차인',
    status: 'ATTENTION',
    summary: `기준일보다 앞선 임차인이 ${withPriority.length}명 있어요.`,
    facts: [
      `임차인 ${analysis.tenants.length}명 중 ${withPriority.length}명`,
      ...(assumed.length > 0 ? [`인수 가능성이 있는 보증금 ${assumed.length}건`] : []),
    ],
    limit:
      assumed.some((tenant) => tenant.assumption === 'ASSUMED_AMOUNT_UNKNOWN')
        ? '배당으로 얼마를 돌려받을지는 등기부가 있어야 알 수 있어, 인수액이 확정되지 않아요.'
        : null,
  };
}

function assumedRightsItem(analysis: NoticeAnalysis): ChecklistItem {
  const label = assumedRightsLabel(analysis.assumedRightsKind);
  const isNone = analysis.assumedRightsKind === 'NONE';

  return {
    key: 'assumedRights',
    title: '인수되는 권리',
    // 명세서의 인수권리 란만 본 결과다. 등기부 전체를 못 보므로 "없음"도 확정이 아니다.
    status: isNone ? 'CONFIRMED' : label !== null ? 'ATTENTION' : 'UNKNOWN',
    summary: isNone
      ? '법원이 "해당사항없음"으로 적었어요.'
      : label !== null
        ? `${label}${subjectParticle(label)} 매수인에게 인수돼요.`
        : '명세서의 인수권리 란이 비어 있어요.',
    facts: label !== null && !isNone ? [label] : [],
    // 이 한계는 항상 밝힌다 — 등기부가 없으면 소멸·인수 목록을 만들 수 없다
    limit:
      '등기부를 아직 연동하지 않아 소멸되는 권리와 인수되는 권리의 전체 목록은 만들 수 없어요. ' +
      '여기 나오는 것은 명세서의 인수권리 란에 적힌 내용이에요.',
  };
}

function possessionItem(analysis: NoticeAnalysis): ChecklistItem {
  if (analysis.tenants.length === 0) {
    const recorded = analysis.noTenantRecorded === true;
    return {
      key: 'possession',
      title: '점유·명도',
      status: recorded ? 'CONFIRMED' : 'UNKNOWN',
      summary: recorded
        ? '명세서에 기재된 점유자가 없어요.'
        : '점유자 정보를 확인하지 못했어요.',
      facts: [],
      // 임차인 행이 없다고 소유자가 산다는 뜻이 아니다 — 공실이거나 조사가 안 됐을 수도 있다
      limit: recorded
        ? '누가 살고 있는지는 명세서만으로 알 수 없어요. 현장 확인이 필요해요.'
        : '명세서의 점유자 표를 읽지 못했어요.',
    };
  }

  const bases = [
    ...new Set(
      analysis.tenants
        .map((tenant) => tenant.possessionBasis)
        .filter((value): value is string => value !== null && value.length > 0),
    ),
  ];
  const withPriority = analysis.tenants.filter((tenant) => tenant.hasPriority === true).length;

  return {
    key: 'possession',
    title: '점유·명도',
    status: withPriority > 0 ? 'ATTENTION' : 'CONFIRMED',
    summary:
      withPriority > 0
        ? `점유자 ${analysis.tenants.length}명 중 ${withPriority}명이 기준일보다 앞서요.`
        : `점유자 ${analysis.tenants.length}명이 확인됐어요.`,
    facts: bases,
    limit:
      withPriority > 0
        ? '기준일보다 앞선 임차인은 매수인에게 임대차를 주장할 수 있어, 남은 기간과 보증금을 함께 확인해야 해요.'
        : null,
  };
}

/** 명세서 분석을 4항목 체크리스트로 정리한다. 순서가 곧 확인 순서다. */
export function rightsChecklist(analysis: NoticeAnalysis): ChecklistItem[] {
  return [
    baselineItem(analysis),
    priorityItem(analysis),
    assumedRightsItem(analysis),
    possessionItem(analysis),
  ];
}

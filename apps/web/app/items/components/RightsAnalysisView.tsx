// 권리분석 본문 — 상세 페이지(/items/[id]/rights-analysis)와 지도 패널이 함께 쓴다.
// 같은 물건이 두 화면에서 다르게 읽히면 안 되므로 마크업을 한 곳에만 둔다.
//
// 등기부(CODEF, WP-04) 연동 전이라 **매각물건명세서만으로** 계산한 결과를 보여준다.
// 명세서에 없는 것은 등기 권리 목록과 채권액이라, 배당표를 만들 수 없고 그래서 인수액이
// 확정되지 않는 임차인이 생긴다. 그 한계를 화면에 반드시 적는다 — 빈 값이 "위험 없음"으로
// 읽히면 안 된다. 판단·권유 문구는 넣지 않는다 (D-011).
'use client';

import { useState, type ReactNode } from 'react';
import { Badge, type BadgeTone } from './Badge';
import { GLOSSARY, type GlossaryKey } from '../glossary';
import {
  formatRatioRange,
  formatWonRangeCompact,
  SCENARIO_LABELS,
  type Affordability,
} from '../affordability';
import { formatWon, formatWonCompact } from '../format';
import type { AnalyzedTenant, NoticeAnalysis, NoticeAssumption } from '../notice-analysis';
import {
  BURDEN_STATUS_LABEL,
  noticeAssumptionLabel,
  noticeAssumptionReason,
  REGISTERED_BURDEN_NOTE,
  REGISTERED_BURDEN_RULES,
  riskFlagLabels,
  type BurdenStatus,
} from '../notice-labels';
import {
  costSection,
  debtsSection,
  evidenceLine,
  occupantsSection,
  rightsConclusion,
  unknownItems,
  type RightsSection,
} from '../rights-narrative';
import { NoticePdfDialog } from './NoticePdfDialog';
import { RegistrySection } from './RegistrySection';
import type { ItemKey } from '../item-id';
import type { RegistryState } from '../registry';
import styles from './RightsAnalysisView.module.css';

const ASSUMPTION_TONE: Record<NoticeAssumption, BadgeTone> = {
  NOT_ASSUMED: 'muted',
  ASSUMED_FULL: 'warning',
  ASSUMED_AMOUNT_UNKNOWN: 'critical',
  UNKNOWN: 'critical',
};

const BURDEN_TONE: Record<BurdenStatus, BadgeTone> = {
  ASSUMED: 'warning',
  NOT_ASSUMED: 'muted',
  NEEDS_REVIEW: 'critical',
};

/**
 * 용어 설명 — 문장에서 뺀 뜻풀이를 ? 뒤에 둔다.
 *
 * 설명을 문장 안에 괄호로 넣으면 요약 한 줄이 세 줄이 된다. 용어를 아는 사람에게는 소음이고
 * 모르는 사람에게는 문장이 안 읽힌다. 필요한 사람만 펼쳐 보게 한다.
 */
function TermHelp({ terms }: { terms: GlossaryKey[] }) {
  const [open, setOpen] = useState(false);

  return (
    <span className={styles.termWrap}>
      <button
        type="button"
        className={styles.termButton}
        aria-expanded={open}
        aria-label="용어 설명 보기"
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open ? (
        <span className={styles.termPopover} role="note">
          {terms.map((term) => (
            <span className={styles.termRow} key={term}>
              <b className={styles.termName}>{term}</b> {GLOSSARY[term]}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 접이식 섹션 — 요약은 늘 보이고 근거는 접는다.
 *
 * 길이 문제의 핵심 장치다. 전에는 13개 블록이 전부 펼쳐져 있어 스크롤이 길고, 무엇이 답이고
 * 무엇이 근거인지 구분이 없었다. 요약 문장만 읽어도 뜻이 통해야 하므로 접힌 상태가 기본이다.
 */
function Section({
  section,
  defaultOpen,
  children,
}: {
  section: RightsSection;
  defaultOpen: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = children !== null && children !== undefined && children !== false;

  return (
    <section className={styles.qSection}>
      <div className={styles.qHead}>
        <h3 className={styles.qTitle}>{section.title}</h3>
        {section.terms.length > 0 ? <TermHelp terms={section.terms} /> : null}
        <span className={styles.qSpacer} />
        {section.state ? (
          <Badge tone={section.state === '확인됨' ? 'muted' : 'critical'}>{section.state}</Badge>
        ) : null}
      </div>
      {section.summary.map((line) => (
        <p className={styles.qSummary} key={line}>
          {line}
        </p>
      ))}
      {hasDetail ? (
        <>
          <button type="button" className={styles.qToggle} onClick={() => setOpen(!open)}>
            {open ? '접기' : '자세히 보기'}
          </button>
          {open ? <div className={styles.qDetail}>{children}</div> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * 위 인수 금액에 무엇이 들어가고 무엇이 빠지는지 — "근저당도 내가 계산해야 하나"에 화면에서
 * 답한다. 등기부 없이도 권리 종류만으로 확정되는 사실이라 지금 말할 수 있다.
 */
function BurdenScopeSection() {
  return (
    <section className={styles.groupBlock}>
      <h3 className={styles.groupTitle}>이 금액에 무엇이 들어갔나</h3>
      <div className={styles.table}>
        <div className={styles.row}>
          <span className={styles.rowKind}>임차인</span>
          <div className={styles.rowMain}>
            <div className={styles.rowLabelLine}>
              <span className={styles.rowLabel}>대항력 있는 임차인 보증금</span>
            </div>
            <p className={styles.rowDetail}>
              위 인수 금액에 들어가 있어요. 대항력이 말소기준보다 빠른 임차인만 해당돼요.
            </p>
          </div>
          <Badge tone={BURDEN_TONE.ASSUMED}>{BURDEN_STATUS_LABEL.ASSUMED}</Badge>
        </div>
        {REGISTERED_BURDEN_RULES.map((rule) => (
          <div className={styles.row} key={rule.subject}>
            <span className={styles.rowKind}>등기 권리</span>
            <div className={styles.rowMain}>
              <div className={styles.rowLabelLine}>
                <span className={styles.rowLabel}>{rule.subject}</span>
              </div>
              <p className={styles.rowDetail}>{rule.detail}</p>
            </div>
            <Badge tone={BURDEN_TONE[rule.status]}>{BURDEN_STATUS_LABEL[rule.status]}</Badge>
          </div>
        ))}
      </div>
      <p className={styles.footnote}>{REGISTERED_BURDEN_NOTE}</p>
    </section>
  );
}

function tenantTitle(tenant: AnalyzedTenant): string {
  // 성명은 API가 내려주지 않는다 — 점유부분이 사람을 가리키는 유일한 값이다
  return tenant.occupiedPart ?? `점유자 ${tenant.tenantSeq}`;
}

function TenantRow({ tenant }: { tenant: AnalyzedTenant }) {
  const reason = noticeAssumptionReason(tenant.assumption);
  const facts = [
    tenant.moveInDate ? `전입 ${tenant.moveInDate}` : null,
    tenant.fixedDate ? `확정일자 ${tenant.fixedDate}` : null,
    tenant.demandedDistributionDate ? `배당요구 ${tenant.demandedDistributionDate}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className={styles.row}>
      <span className={styles.rowKind}>{tenantTitle(tenant)}</span>
      <div className={styles.rowMain}>
        <div className={styles.rowLabelLine}>
          <span className={styles.rowLabel}>
            {tenant.depositAmount !== null ? `보증금 ${formatWon(tenant.depositAmount)}` : '보증금 미상'}
          </span>
        </div>
        <p className={styles.rowDetail}>{facts.join(' · ') || '명세서에 적힌 값이 없어요'}</p>
        {reason ? <p className={styles.rowDetail}>{reason}</p> : null}
      </div>
      <Badge tone={ASSUMPTION_TONE[tenant.assumption]}>
        {noticeAssumptionLabel(tenant.assumption)}
      </Badge>
    </div>
  );
}

/**
 * 실부담 시나리오 — "결국 얼마 들고, 감정가 대비 몇 %인가". 감정가는 시세가 아니므로
 * 기준을 화면에 밝힌다 (실거래가 연동 전 한계).
 */
function AffordabilitySection({ affordability }: { affordability: Affordability }) {
  const stats = affordability.comparableSales;

  return (
    <section className={styles.groupBlock}>
      <h3 className={styles.groupTitle}>결국 얼마가 드나</h3>
      {affordability.bulkSale ? (
        <p className={styles.groupEmpty}>
          일괄매각 물건이라 최저가가 묶음 전체 값이에요. 목적물 하나 기준의 시나리오를 만들면
          숫자가 틀리게 나와서 계산하지 않아요.
        </p>
      ) : affordability.scenarios.length === 0 ? (
        <p className={styles.groupEmpty}>시나리오를 만들 가격 정보가 부족해요.</p>
      ) : (
        <div className={styles.table}>
          {affordability.scenarios.map((scenario) => (
            <div className={styles.row} key={scenario.kind}>
              <span className={styles.rowKind}>{formatWonCompact(scenario.bidPrice)}</span>
              <div className={styles.rowMain}>
                <div className={styles.rowLabelLine}>
                  <span className={styles.rowLabel}>
                    총 {formatWonRangeCompact(scenario.totalWithExtras)}
                    {affordability.assumedIsLowerBound ? ' 이상' : ''}
                  </span>
                </div>
                <p className={styles.rowDetail}>
                  {SCENARIO_LABELS[scenario.kind]} · 인수·취득세·등기·명도비 포함
                  {scenario.appraisalRatio
                    ? ` · 감정가의 ${formatRatioRange(scenario.appraisalRatio)}`
                    : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className={styles.footnote}>
        비교 기준은 감정가예요 — 감정가는 시세가 아니라서 실거래 시세 연동 전까지는 참고
        기준이에요. 취득세는 매수인 사정(주택 수·면적)에 따라 달라 구간으로 계산했고, 등기·명도
        비용은 추정치예요. 체납 관리비(공용부분)는 금액을 알 수 없어 합산에 없어요.
        {stats.sampleCount > 0
          ? ` 유사 가격대는 같은 용도(${stats.usage ?? '미상'}) 낙찰 ${stats.sampleCount}건의 실측 분포예요.`
          : ''}
      </p>
    </section>
  );
}

export function RightsAnalysisView({
  analysis,
  affordability,
  noticePdfUrl,
  itemKey,
  registry,
}: {
  /** null이면 명세서를 아직 못 받은 물건이다 — "인수할 권리 없음"과 다르다 */
  analysis: NoticeAnalysis | null;
  /** 실부담 시나리오 — 없으면(미로딩·조회 실패) 섹션을 그리지 않는다 */
  affordability?: Affordability | null;
  /**
   * 명세서 PDF 원문 주소. 없으면 원문 보기 버튼을 감춘다 — 텍스트 레이어로 읽었거나
   * PDF 보관(019) 이전에 수집한 명세서는 원문이 없다.
   */
  noticePdfUrl?: string;
  /** 등기부 블록을 그리려면 필요하다 — 없으면 블록 자체를 그리지 않는다 */
  itemKey?: ItemKey;
  /** 등기부 보관본 상태. 서버에서 미리 읽어 넘긴다 (GET은 발급하지 않으므로 무료다) */
  registry?: RegistryState | null;
}) {
  if (analysis === null) {
    return (
      <div className={styles.root}>
        <p className={styles.groupEmpty}>
          아직 매각물건명세서를 받지 못했어요. 인수할 권리가 없다는 뜻이 아니라 확인되지 않았다는
          뜻이에요. 명세서는 매각기일 1주일 전부터 열람할 수 있어요.
        </p>
      </div>
    );
  }

  // API가 이미 사람 단위로 합쳐서 준다 (notice-tenant-merge.ts)
  const tenants = analysis.tenants;
  const conclusion = rightsConclusion(analysis);
  const flags = riskFlagLabels(analysis.riskFlags);
  const cost = costSection(affordability ?? null);
  const gaps = unknownItems(analysis, registry ?? null);

  return (
    <div className={styles.root}>
      {/* 근거는 한 줄이면 된다 — 예전엔 고지 3줄이 화면 첫머리를 차지해 답보다 먼저 읽혔다 */}
      <div className={styles.evidence}>
        <span className={styles.evidenceText}>{evidenceLine(registry ?? null)}</span>
        {noticePdfUrl ? <NoticePdfDialog src={noticePdfUrl} /> : null}
      </div>

      {/* 결론 카드 — 숫자와 "그게 무슨 돈인지"를 같은 카드 안에 둔다 */}
      <section className={styles.summaryCard}>
        <p className={styles.summaryLabel}>{conclusion.label}</p>
        <p className={conclusion.isAmount ? styles.summaryTotal : styles.summaryStatement}>
          {conclusion.headline}
        </p>
        {conclusion.body.map((line) => (
          <p className={styles.summaryBody} key={line}>
            {line}
          </p>
        ))}
      </section>

      {/* 질문 3개. 요약만 늘 보이고 근거는 접는다 — 닫힌 상태로 약 2화면이다 */}
      <Section section={occupantsSection(analysis)} defaultOpen={false}>
        {tenants.length > 0 ? (
          <div className={styles.table}>
            {tenants.map((tenant) => (
              <TenantRow key={tenant.tenantSeq} tenant={tenant} />
            ))}
          </div>
        ) : null}
      </Section>

      <Section section={debtsSection(analysis, registry ?? null)} defaultOpen={false}>
        {itemKey && registry ? <RegistrySection itemKey={itemKey} initial={registry} /> : null}
        <BurdenScopeSection />
        {flags.length > 0 ? (
          <p className={styles.rowDetail}>명세서 특이사항: {flags.join(' · ')}</p>
        ) : null}
        {analysis.distributionDemandDeadline ? (
          <p className={styles.rowDetail}>
            배당요구 마감일 {analysis.distributionDemandDeadline}
          </p>
        ) : null}
      </Section>

      {cost && affordability ? (
        <Section section={cost} defaultOpen={false}>
          <AffordabilitySection affordability={affordability} />
        </Section>
      ) : null}

      {/* 각 섹션에 흩어져 있던 한계를 한 곳에 모은다 — D-011 안에서 "그래서 뭘 하나"의 답이다 */}
      {gaps.length > 0 ? (
        <section className={styles.gaps}>
          <h3 className={styles.gapsTitle}>이 화면이 대신 못 하는 것</h3>
          <ul className={styles.gapsList}>
            {gaps.map((gap) => (
              <li className={styles.gapsItem} key={gap.title}>
                <span className={styles.gapsItemTitle}>{gap.title}</span> — {gap.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className={styles.disclaimer}>
        명세서에 적힌 사실을 규칙대로 정리한 참고 정보예요. 실제 입찰 전 등기사항전부증명서와
        명세서 원문을 꼭 확인해주세요.
      </p>
    </div>
  );
}

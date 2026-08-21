// 매각물건명세서 기반 권리분석 응답 — 등기부 없이 계산한 결과 (WP-04 CODEF 연동 전).
//
// **점유자 성명은 절대 담지 않는다.** 법원이 공개한 제3자 개인정보이고, 우리는 존재 여부와
// 권리 관계만 쓴다 (개인정보처리방침 §1-3: 성명은 데이터베이스에만 존재한다).
// 줄을 구분하는 값은 점유부분(호수)과 순번이다.
import type { NoticeAssumption } from '../../rights-analysis/domain/notice-assumption';

export interface AnalyzedTenantDto {
  /** 명세서가 정보출처별로 나눠 적은 행을 사람 단위로 합친 것 */
  tenantSeq: number;
  /** 이 사람의 정보가 어느 출처에서 왔는지 (현황조사 / 권리신고 / 등기사항전부증명서) */
  sourceKinds: string[];
  occupiedPart: string | null;
  /**
   * 점유의 권원 — 명세서 원문 그대로 (예: "주거 임차인", "점포 전세권자", "주택임차권자").
   * 명도(집을 비우는 일)를 가늠하는 사실이라 화면이 그대로 보여준다. 우리가 요약하지 않는다.
   */
  possessionBasis: string | null;
  moveInDate: string | null;
  fixedDate: string | null;
  depositAmount: number | null;
  demandedDistribution: boolean | null;
  demandedDistributionDate: string | null;
  possessionRightDate: string | null;
  hasPriority: boolean | null;
  distributionDemandEffective: boolean | null;
  assumption: NoticeAssumption;
  assumedAmount: number | null;
}

export interface NoticeAnalysisDto {
  documentDate: string | null;
  /** 명세서에 적힌 최선순위 설정 원문 (예: "2024.02.19. 압류") */
  baselineRaw: string | null;
  baselineDate: string | null;
  distributionDemandDeadline: string | null;
  assumedRightsKind: string | null;
  riskFlags: string[];
  tenants: AnalyzedTenantDto[];
  /**
   * 법원이 "조사된 임차내역 없음"으로 적었는지. 표가 비었다는 것과 다르다 —
   * 못 읽어서 빈 것일 수 있어(tenantRowsRejected>0) 그때는 null 이다.
   *
   * **"소유자가 산다"는 뜻이 아니다.** 공실이거나 조사가 안 됐을 수도 있다. 화면은
   * "명세서에 기재된 점유자가 없다"는 사실까지만 말한다.
   */
  noTenantRecorded: boolean | null;
  /**
   * 이 분석이 등기부 없이 명세서만으로 이뤄졌다는 사실. 화면이 한계를 반드시 밝혀야 한다 —
   * 등기 권리 목록과 채권액이 없어 배당표를 만들 수 없고, 그래서 인수액이 확정되지 않는
   * 임차인이 생긴다.
   */
  source: 'NOTICE_ONLY';
}

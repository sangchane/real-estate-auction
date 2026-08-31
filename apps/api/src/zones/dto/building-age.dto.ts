// 물건이 속한 법정동의 노후도 사실 DTO — 비율만 내리지 않고 분자·분모·기준연월을 함께 내린다 (기획 12 §1.4)
export interface DongBuildingAgeDto {
  bjdCode: string;
  dongName: string | null;
  /** 원천 파일 기준연월(YYYY-MM). 20년/30년은 "지금"이 아니라 이 연월 대비다 — 화면이 반드시 병기한다 */
  baseYm: string;
  /** 사용승인일이 있는 건물 수(분모). 0이면 화면은 비율을 내지 않는다 — 0%는 "노후 없음"으로 읽힌다 */
  totalCount: number;
  /** 사용승인일 결측 건물 수. 분모에서 뺀 값이라 화면이 따로 병기한다 (엣지 C-3) */
  unknownAprCount: number;
  over20Count: number;
  over30Count: number;
  /** 소수점 1자리 %(05 반올림 정책 — 계산은 API 한 곳). totalCount 0이면 null */
  over20RatioPct: number | null;
  over30RatioPct: number | null;
}

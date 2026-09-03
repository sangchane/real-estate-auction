// 용도지역 레이어·물건 용도지역 응답 DTO — 채색 키(버킷)와 원문 명칭·코드를 항상 함께 내린다 (기획 12 §2.4).
// 화면이 색을 고르는 데는 버킷을 쓰고, 카드에 보여주는 데는 원문을 쓴다 — 버킷이 원문을 대체하면
// 미분류·불일치 행(실측 259건)의 사실이 사라진다.
import type { ZoneGeometryDto } from './zone-feature.dto';

/**
 * 채색 버킷과 원문. 버킷 코드는 적재기(zoning_district_loader)가 확정한 값 그대로다:
 * RES_EXCLUSIVE·RES_GENERAL_1·2·3·RES_SEMI·OTHER. 값의 순서 = 국토계획법 시행령의 법정 세분
 * 순서(명도 사다리의 근거)이며, 어느 종이 좋다/나쁘다는 신호가 아니다 (D-011).
 */
export interface ZoningFeaturePropertiesDto {
  zoningId: number;
  /**
   * null = 미분류. 사전에 없는 코드·코드-명칭 불일치를 가까운 버킷에 추측 배정하면 허위 사실이
   * 된다 — 화면은 중립(채움 없음)으로 그리고 원문 명칭으로 말한다 (기획 12 §2.4).
   * 유니온으로 못 박지 않는 이유: DB 컬럼은 TEXT고, 적재기가 버킷을 늘리는 날 타입이 거짓말이 된다.
   */
  zoningBucket: string | null;
  /** DGM_NM 원문. 클릭 카드가 이 값을 그대로 보여준다 — "(7층이하)" 같은 고시 세부 포함 */
  zoneNameRaw: string | null;
  /** 소분류 코드 원문(UQA121 등). 공란 허용 — 원천이 그렇다 */
  sclasCl: string | null;
  /** 중분류 코드 원문. 소분류 공란 행(실측 25%)에서는 이 값이 매핑 키였다 */
  mlsfcCl: string | null;
}

export interface ZoningFeatureDto {
  type: 'Feature';
  geometry: ZoneGeometryDto;
  properties: ZoningFeaturePropertiesDto;
}

export interface ZoningFeatureCollectionDto {
  type: 'FeatureCollection';
  /** 피처 상한에 걸려 잘렸는지. 숨기면 화면이 "용도지역 없음"과 구분하지 못한다 (EP-1과 같은 규약) */
  truncated: boolean;
  /**
   * 원천 파일 기준연월(YYYY-MM). 범례의 출처 표기("서울시 YYYY-MM 기준")가 쓴다.
   * 피처마다 싣지 않는 이유: 전량 교체 적재라 한 응답 안에서 항상 같고, z14 응답은 피처가
   * 1,900개를 넘어(실측) 중복 속성 한 줄이 수십 KB다. 피처가 없으면 null.
   */
  baseYm: string | null;
  features: ZoningFeatureDto[];
}

/**
 * 물건이 속한 용도지역 한 건. 여러 건이 정상이다 — 원천이 같은 자리의 옛 고시·재고시 폴리곤을
 * 함께 담아(실측: 물건의 10.6%가 다중 매치, 마이그레이션 022 주석) 한 장을 고르는 것 자체가
 * 추측 배정이 된다. 화면은 전부를 사실로 보여준다.
 */
export interface ItemZoningDistrictDto {
  zoningId: number;
  zoningBucket: string | null;
  zoneNameRaw: string | null;
  sclasCl: string | null;
  mlsfcCl: string | null;
  /** 원천 파일 기준연월(YYYY-MM) — 카드가 "서울시 YYYY-MM 기준"을 병기한다 */
  baseYm: string;
}

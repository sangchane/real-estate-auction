// 색상 토큰 — DESIGN-meta.md 원문 값을 그대로 코드화한 단일 소스. 도메인 적용 규칙은
// docs/design/design-adaptation.md 참고 (컬러 팔레트는 §4에 따라 전체 계승, 치환 없음).
export const colors = {
  primary: '#0064e0',
  primaryDeep: '#0457cb',
  primarySoft: '#0091ff',
  onPrimary: '#ffffff',
  inkButton: '#000000',
  onInkButton: '#ffffff',
  fbBlue: '#1876f2',
  metaLink: '#385898',
  oculusPurple: '#a121ce',
  success: '#31a24c',
  successBg: '#24e400',
  attention: '#f2a918',
  warning: '#f7b928',
  warningBg: '#ffe200',
  critical: '#e41e3f',
  criticalStrong: '#f0284a',
  canvas: '#ffffff',
  surfaceSoft: '#f1f4f7',
  inkDeep: '#0a1317',
  ink: '#1c1e21',
  charcoal: '#444950',
  slate: '#4b4c4f',
  steel: '#5d6c7b',
  stone: '#8595a4',
  hairline: '#ced0d4',
  hairlineSoft: '#dee3e9',
  disabledText: '#bcc0c4',
  // 지도 정비구역 폴리곤의 윤곽선. 팔레트에 색을 더하는 게 아니라 oculus-purple에 역할 이름만
  // 붙인 별칭이다(design-adaptation §4 "컬러 팔레트 전체 계승, 치환 없음") — 값 일치는 colors.test.ts가 지킨다.
  //
  // 별칭을 따로 두는 이유는 지도 위에서 쓸 수 있는 색이 이미 다 팔렸기 때문이다. primary 계열은
  // 전환 CTA 전용(design-adaptation §3)이고, success/warning/critical 계열은 구역을 좋고 나쁨으로
  // 읽히게 해서 못 쓴다(D-011). 남는 무채색은 지적편집도가 그리는 회색 필지선과 섞여 구역 경계가
  // 사라진다 — 두 레이어를 같이 켜는 것이 실제 사용 흐름이라 그게 가장 큰 제약이다.
  // 다세대 마커 아이콘과 같은 색조지만, 흰 알약 안의 12px 아이콘과 바탕지도 위의 2px 선은 서로
  // 자리를 다투지 않는다. 혼동이 실제로 관측되면 바꿀 곳은 이 한 줄이다.
  mapZoneOutline: '#a121ce',
  // 지도 면(채움) 레이어의 순차 램프 5단 — 용도지역(1단 전용주거 → 5단 준주거)과 노후도(1단 낮은
  // 비율 → 5단 높은 비율)가 **하나의 램프를 공유**한다 (기획 12 §4.2). 면 레이어는 배타(동시에 하나)라
  // 한 화면에서 같은 색이 두 뜻을 갖지 않는다.
  //
  // 틸(청록)인 이유는 이 화면에서 비어 있는 유일한 색 가족이기 때문이다 — 마커 7색과 구역 slate가
  // 나머지를 다 가져갔다. 적색(critical·warning·attention)과 녹색(success) 계열은 "진할수록 위험/
  // 옅을수록 양호"로 읽혀 못 쓴다(D-011) — 진하기는 크기·순서의 인코딩일 뿐 좋고 나쁨이 아니다.
  //
  // 명도가 단조 하강해야 색각이상에서도 순서가 읽힌다(순차 램프의 합격 기준) — colors.test.ts가
  // 지킨다. 가장 밝은 두 단은 대비가 얇으므로 색만으로 판독하게 두지 않고 범례의 명칭·경계값과
  // 폴리곤 윤곽선으로 2차 인코딩한다. 1~3단은 넓은 면 채움 전용이다(흰 배경 대비 3:1 미만).
  mapSeq1: '#e4f2f3',
  mapSeq2: '#a5d6da',
  mapSeq3: '#63b4bc',
  mapSeq4: '#2f8f9a',
  mapSeq5: '#0a6a77',
} as const;

export type ColorToken = keyof typeof colors;

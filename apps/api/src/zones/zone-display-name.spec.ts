import { resolveZoneName } from './zone-display-name';

describe('resolveZoneName', () => {
  it('zone_name이 있으면 그대로 쓰고 승격하지 않는다', () => {
    expect(resolveZoneName('구산역세권(역촌동)', '주거환경개선사업')).toEqual({
      displayName: '구산역세권(역촌동)',
      promoted: false,
    });
  });

  it('둘 다 없으면 이름이 없다 — 화면이 "정보 없음"으로 적는다', () => {
    expect(resolveZoneName(null, null).displayName).toBeNull();
    expect(resolveZoneName('', '   ').displayName).toBeNull();
  });

  describe('business_kind 승격', () => {
    // 실측 원천에서 그대로 가져온 값들이다 (2026-08-31, 78개 distinct 중)
    it.each([
      '남대문 도시정비형 재개발구역',
      '마포로1구역 도시정비형 재개발구역',
      '신촌지역(마포) 4-9지구 도시정비형 재개발구역',
      '한강맨션아파트 주택재건축정비구역',
      '긴등마을주택재건축정비구역',
      '개화산역세권 장기전세주택 도시환경정비구역',
      '청량리미주아파트 재건축정비사업 지구단위계획구역',
      '창신2구역',
      '금호14구역',
      '수송구역',
    ])('고유명사가 있으면 이름으로 올린다: %s', (kind) => {
      expect(resolveZoneName(null, kind)).toEqual({ displayName: kind, promoted: true });
    });

    it.each([
      '도시환경정비구역',
      '재건축정비구역',
      '재개발구역',
      '주택재건축정비구역',
      '정비예정구역',
      '재정비촉진구역',
      '주거환경개선지구 사업완료구역',
      '도시정비형 재개발구역',
      '주택정비형 재개발사업 정비구역',
    ])('사업 유형 어휘뿐이면 올리지 않는다: %s', (kind) => {
      // 이걸 올리면 서로 다른 구역 여러 개가 전부 같은 이름이 되어 이름 구실을 못 한다
      expect(resolveZoneName(null, kind).displayName).toBeNull();
    });

    it.each([
      '주택재개발',
      '도시환경정비사업',
      '주거환경개선사업',
      '행위제한',
      '입안',
      '정비예정구역, 건축물의 건축 등 행위제한',
    ])('구역·지구로 끝나지 않으면 종류나 상태다: %s', (kind) => {
      expect(resolveZoneName(null, kind).displayName).toBeNull();
    });
  });

  it('앞뒤 공백을 다듬는다', () => {
    expect(resolveZoneName('  창신1구역  ', null).displayName).toBe('창신1구역');
    expect(resolveZoneName(null, ' 남대문 도시정비형 재개발구역 ').displayName).toBe(
      '남대문 도시정비형 재개발구역',
    );
  });
});

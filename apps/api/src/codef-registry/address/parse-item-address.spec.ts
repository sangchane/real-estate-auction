import { parseItemAddress } from './parse-item-address';

function ok(raw: string) {
  const result = parseItemAddress(raw);
  if (!result.ok) throw new Error(`파싱 실패: ${raw} — ${result.reason}`);
  return result.address;
}

describe('parseItemAddress — 지번 주소', () => {
  it('동·번지·건물명·호수를 나눈다', () => {
    expect(ok('서울특별시 은평구 구산동 177-8 트라움하임구산 1층101호')).toEqual({
      sido: '서울특별시',
      sigungu: '은평구',
      administrativeDong: '구산동',
      lotNumber: '177-8',
      roadName: null,
      buildingNumber: null,
      buildingName: '트라움하임구산',
      unitDong: null,
      unitHo: '101호',
    });
  });

  it('"제N층 제N호" 형태를 읽는다', () => {
    const address = ok('서울특별시 금천구 가산동 550-7 케이엠타워 제18층 제1806호');
    expect(address.buildingName).toBe('케이엠타워');
    expect(address.unitHo).toBe('1806호');
  });

  it('건물명이 없어도 호수를 읽는다', () => {
    const address = ok('서울특별시 강서구 화곡동 56-109 제2층 제202호');
    expect(address.buildingName).toBeNull();
    expect(address.unitHo).toBe('202호');
  });

  it('건물명이 두 단어면 붙여서 읽는다', () => {
    const address = ok('서울특별시 서대문구 대현동 144 신촌럭키아파트 이룸타워 2층224호');
    expect(address.buildingName).toBe('신촌럭키아파트 이룸타워');
    expect(address.unitHo).toBe('224호');
  });

  it('집합건물 동을 읽는다', () => {
    const address = ok('서울특별시 강동구 천호동 227-11 가우디캐슬 102동 3층301호');
    expect(address.unitDong).toBe('102동');
    expect(address.unitHo).toBe('301호');
    expect(address.buildingName).toBe('가우디캐슬');
  });

  it('행정동 이름 안의 숫자를 집합건물 동으로 착각하지 않는다', () => {
    // "상도1동"은 행정동이다. 여기서 1동을 뽑으면 있지도 않은 동을 조회하게 된다.
    const address = ok('서울특별시 동작구 상도1동 519-1 더포레스트 8층804호');
    expect(address.administrativeDong).toBe('상도1동');
    expect(address.unitDong).toBeNull();
    expect(address.unitHo).toBe('804호');
  });

  it('"동N가" 법정동을 읽는다', () => {
    const address = ok('서울특별시 영등포구 영등포동2가 28-152 라움빌 제4층 제403호');
    expect(address.administrativeDong).toBe('영등포동2가');
    expect(address.lotNumber).toBe('28-152');
  });

  it('"로N가" 법정동을 도로명으로 착각하지 않는다', () => {
    // 충정로3가는 법정동, 충정로7길은 도로명이다 — 접미사로만 갈린다
    const address = ok('서울특별시 서대문구 충정로3가 179-1');
    expect(address.administrativeDong).toBe('충정로3가');
    expect(address.roadName).toBeNull();
    expect(address.lotNumber).toBe('179-1');
  });

  it('산번지를 읽는다', () => {
    expect(ok('서울특별시 구로구 궁동 산1-45').lotNumber).toBe('산1-45');
    expect(ok('서울특별시 강북구 우이동 산80').lotNumber).toBe('산80');
  });

  it('호수가 없는 토지·단독은 호수를 비운다', () => {
    const address = ok('서울특별시 중구 신당동 217-1');
    expect(address.unitHo).toBeNull();
    expect(address.lotNumber).toBe('217-1');
  });
});

describe('parseItemAddress — 도로명 주소', () => {
  it('괄호에서 법정동과 건물명을 꺼낸다', () => {
    expect(ok('서울특별시 금천구 두산로11길 63 제101동 제7층 제701호 (가산동, 금강노블레스)')).toEqual({
      sido: '서울특별시',
      sigungu: '금천구',
      administrativeDong: '가산동',
      lotNumber: null,
      roadName: '두산로11길',
      buildingNumber: '63',
      buildingName: '금강노블레스',
      unitDong: '101동',
      unitHo: '701호',
    });
  });

  it('쉼표 뒤에 공백이 없어도 읽는다', () => {
    const address = ok('서울특별시 중랑구 면목로84길 47 2층201호 (면목동,헤렌하우스)');
    expect(address.administrativeDong).toBe('면목동');
    expect(address.buildingName).toBe('헤렌하우스');
    expect(address.unitHo).toBe('201호');
  });

  it('"로"로 끝나는 도로명을 읽는다', () => {
    const address = ok('서울특별시 송파구 오금로 463');
    expect(address.roadName).toBe('오금로');
    expect(address.buildingNumber).toBe('463');
    expect(address.administrativeDong).toBeNull();
  });

  it('괄호가 없으면 법정동을 지어내지 않는다', () => {
    const address = ok('서울특별시 중랑구 상봉로20길 26 3층301호');
    expect(address.administrativeDong).toBeNull();
    expect(address.roadName).toBe('상봉로20길');
    expect(address.unitHo).toBe('301호');
  });

  it('지하층 호수를 읽는다', () => {
    expect(ok('서울특별시 은평구 은평로3가길 22-7 지하층1호').unitHo).toBe('1호');
  });
});

describe('parseItemAddress — 거절해야 하는 입력', () => {
  it('자동차 경매는 거절한다 — 부동산이 아니다', () => {
    const result = parseItemAddress('사용본거지 : 서울 중랑구 겸재로15길 62 (면목동)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('자동차');
  });

  it('괄호가 붙은 자동차 물건도 거절한다', () => {
    const result = parseItemAddress(
      '사용본거지 : 서울특별시 강동구 천호대로 1240 3동 1406호 (둔촌동, 프라자아파트)',
    );
    expect(result.ok).toBe(false);
  });

  it('빈 주소를 거절한다', () => {
    expect(parseItemAddress('   ').ok).toBe(false);
  });

  it('시군구를 못 읽으면 거절한다', () => {
    expect(parseItemAddress('어딘가 이상한 주소').ok).toBe(false);
  });

  it('번지를 못 읽으면 거절한다 — 없는 번지로 조회하면 700원을 헛쓴다', () => {
    expect(parseItemAddress('서울특별시 은평구 구산동 없는번지').ok).toBe(false);
  });
});

describe('parseItemAddress — 지어내지 않는다', () => {
  it('호수 형식이 애매하면 비운다', () => {
    // "101-2802호"는 동101/호2802인지 호 자체가 101-2802인지 알 수 없다.
    // 추측해서 채우면 다른 호실의 등기부를 700원 주고 받는다.
    const address = ok('서울특별시 강북구 우이동 46-73 코아루스타클래스 28동 101-2802호');
    expect(address.unitDong).toBe('28동');
    expect(address.unitHo).toBeNull();
  });

  it('동·호 뒤에 나온 토큰을 건물명에 섞지 않는다', () => {
    const address = ok('서울특별시 강동구 천호동 227-11 가우디캐슬 102동 3층301호');
    expect(address.buildingName).toBe('가우디캐슬');
  });
});

// 실제 수집 주소 표본. 형태별 대표만 남긴다 — 300건 전량을 커밋하면 물건 주소가 리포에
// 그대로 들어가고, 회귀 검사에 필요한 것은 "형태"지 건수가 아니다.
const SAMPLES: readonly string[] = [
  '서울특별시 은평구 구산동 177-8 트라움하임구산 1층101호',
  '서울특별시 금천구 가산동 550-7 케이엠타워 제18층 제1806호',
  '서울특별시 강서구 화곡동 56-109 제2층 제202호',
  '서울특별시 서대문구 대현동 144 신촌럭키아파트 이룸타워 2층224호',
  '서울특별시 강동구 천호동 227-11 가우디캐슬 102동 3층301호',
  '서울특별시 동작구 상도1동 519-1 더포레스트 8층804호',
  '서울특별시 영등포구 영등포동2가 28-152 라움빌 제4층 제403호',
  '서울특별시 서대문구 충정로3가 179-1',
  '서울특별시 구로구 궁동 산1-45',
  '서울특별시 강북구 우이동 산80',
  '서울특별시 중구 신당동 217-1',
  '서울특별시 금천구 두산로11길 63 제101동 제7층 제701호 (가산동, 금강노블레스)',
  '서울특별시 중랑구 면목로84길 47 2층201호 (면목동,헤렌하우스)',
  '서울특별시 송파구 오금로 463',
  '서울특별시 중랑구 상봉로20길 26 3층301호',
  '서울특별시 은평구 은평로3가길 22-7 지하층1호',
  '서울특별시 강북구 우이동 46-73 코아루스타클래스 28동 101-2802호',
  // 아래 3건은 파싱하지 못하는 형태다 — 전부 "발급하지 않고 멈추는" 안전한 실패다
  '서울특별시 관악구 남부순환로 1466(신림동) 4층406호 (신림동,몽삐에뜨골드)',
  '서울특별시 도봉구 쌍문동 734외 4필지 청구아파트 제109동 제1층 제106호',
  '사용본거지 : 서울특별시 강동구 천호대로 1240 3동 1406호 (둔촌동, 프라자아파트)',
];

describe('parseItemAddress — 실제 수집 데이터 형태', () => {
  const samples = SAMPLES;

  it('어떤 입력에도 예외를 던지지 않는다', () => {
    for (const sample of samples) {
      expect(() => parseItemAddress(sample)).not.toThrow();
    }
  });

  it('성공한 건은 시도·시군구가 항상 채워진다', () => {
    for (const sample of samples) {
      const result = parseItemAddress(sample);
      if (result.ok) {
        expect(result.address.sido.length).toBeGreaterThan(0);
        expect(result.address.sigungu.length).toBeGreaterThan(0);
      }
    }
  });

  it('성공한 건은 지번과 도로명 중 정확히 하나만 채운다', () => {
    // 둘 다 채우면 CODEF가 어느 쪽으로 검색할지 모르고, 둘 다 비면 검색이 안 된다
    for (const sample of samples) {
      const result = parseItemAddress(sample);
      if (result.ok) {
        const hasLot = result.address.lotNumber !== null;
        const hasRoad = result.address.roadName !== null;
        expect(hasLot !== hasRoad).toBe(true);
      }
    }
  });

  it('읽지 못하는 형태는 거절한다 — 추측해서 발급하지 않는다', () => {
    // 수집 주소 300건 실측: 297건 성공(99%). 실패 3건이 아래 형태이고, 전부 발급 전에
    // 멈추므로 과금되지 않는다. 이 목록이 늘어나면 파서가 퇴행한 것이다.
    const failures = samples.filter((sample) => !parseItemAddress(sample).ok);

    expect(failures).toEqual([
      '서울특별시 관악구 남부순환로 1466(신림동) 4층406호 (신림동,몽삐에뜨골드)',
      '서울특별시 도봉구 쌍문동 734외 4필지 청구아파트 제109동 제1층 제106호',
      '사용본거지 : 서울특별시 강동구 천호대로 1240 3동 1406호 (둔촌동, 프라자아파트)',
    ]);
  });
});

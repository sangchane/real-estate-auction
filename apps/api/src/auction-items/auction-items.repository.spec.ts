import { AuctionItemsRepository, toIsoDate } from './auction-items.repository';

function createMockPool(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

/** 쿼리 호출 순서대로 다른 결과를 돌려준다 — 인수 보증금은 물건 조회 뒤 점유자 조회가 한 번 더 간다 */
function createMockPoolSequence(...results: unknown[][]) {
  const query = jest.fn();
  for (const rows of results) query.mockResolvedValueOnce({ rows });
  query.mockResolvedValue({ rows: [] });
  return { query };
}

describe('AuctionItemsRepository', () => {
  it('단건 조회 시 BIGINT 문자열 컬럼을 숫자로, 날짜를 ISO 문자열로 변환한다', async () => {
    const pool = createMockPool([
      {
        courtOfficeCode: 'B000210',
        caseNo: '2025타경755',
        itemNo: '1',
        courtName: '서울중앙지방법원',
        deptName: '경매7계',
        usageName: '상가',
        areaKind: '집합건물',
      areaM2: '47.52',
      bulkSale: false,
        address: '서울특별시 종로구 인의동 48-2',
        appraisalAmount: '259000000',
        minimumSalePrice: '84869000',
        failedBidCount: 6,
        bidDatetime: new Date('2026-07-16T10:00:00Z'),
        assumedRightsKind: 'LEASEHOLD_REGISTRATION',
        riskFlags: ['HUG_PRIORITY_WAIVER'],
        tenantCount: '2',
      },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '2025타경755', '1');

    expect(result).toEqual({
      courtOfficeCode: 'B000210',
      caseNo: '2025타경755',
      itemNo: '1',
      courtName: '서울중앙지방법원',
      deptName: '경매7계',
      usageName: '상가',
      areaKind: 'AGGREGATE',
      areaM2: 47.52,
      bulkSale: false,
      address: '서울특별시 종로구 인의동 48-2',
      appraisalAmount: 259_000_000,
      minimumSalePrice: 84_869_000,
      failedBidCount: 6,
      bidDatetime: '2026-07-16T10:00:00.000Z',
      assumedRightsKind: 'LEASEHOLD_REGISTRATION',
      riskFlags: ['HUG_PRIORITY_WAIVER'],
      tenantCount: 2,
      // 명세서 키가 없는 행이라 "확인 못 함" — 인수 0원 확정과 구분한다
      assumedDeposit: null,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE ac.court_office_code = $1'), [
      'B000210',
      '2025타경755',
      '1',
    ]);
  });

  it('명세서를 못 받은 물건은 인수권리가 null이고 위험 플래그는 빈 배열이다', async () => {
    // "인수할 권리가 없다"와 "아직 확인하지 못했다"는 다르다 — 화면이 구분해 표기할 수 있어야 한다.
    // tenantCount는 컬럼이 없어도 NaN이 되면 안 된다(LEFT JOIN 미스 방어).
    const pool = createMockPool([
      {
        courtOfficeCode: 'B000210',
        caseNo: '2025타경900',
        itemNo: '1',
        courtName: '서울중앙지방법원',
        deptName: null,
        usageName: null,
        address: null,
        appraisalAmount: null,
        minimumSalePrice: null,
        failedBidCount: null,
        bidDatetime: null,
        assumedRightsKind: null,
        riskFlags: null,
        tenantCount: null,
      },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '2025타경900', '1');

    expect(result?.assumedRightsKind).toBeNull();
    expect(result?.riskFlags).toEqual([]);
    expect(result?.tenantCount).toBeNull();
    // 명세서가 없으면 인수 보증금도 "확인 못 함"이다 — 0원으로 내리면 "부담 없음"으로 읽힌다
    expect(result?.assumedDeposit).toBeNull();
  });

  it('대항력이 있는데 배당요구가 없으면 목록에도 인수 보증금을 확정 금액으로 내려보낸다', async () => {
    // 목록·지도 카드가 상세 화면과 같은 숫자를 말해야 한다 (같은 도메인 함수를 쓰는지 확인)
    const pool = createMockPoolSequence(
      [
        {
          courtOfficeCode: 'B000210',
          caseNo: '2025타경755',
          itemNo: '1',
          bidDatetime: null,
          riskFlags: [],
          tenantCount: '1',
          noticeId: '77',
          noticeBaselineDate: '2024-05-01',
          noticeDistributionDemandDeadline: '2024-08-01',
        },
      ],
      [
        {
          noticeId: '77',
          tenantSeq: 1,
          sourceKind: null,
          occupiedPart: '202호',
          moveInDate: '2020-03-02',
          fixedDate: '2020-03-02',
          depositAmount: '50000000',
          demandedDistribution: false,
          demandedDistributionDate: null,
        },
      ],
    );
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '2025타경755', '1');

    // 전입이 말소기준보다 빠르고 배당요구가 없다 → 보증금 전액 인수 확정
    expect(result?.assumedDeposit).toEqual({ amount: 50_000_000, isLowerBound: false });
    // 내부 계산용 컬럼이 응답으로 새어나가지 않는다
    expect(result).not.toHaveProperty('noticeId');
    expect(result).not.toHaveProperty('noticeBaselineDate');
  });

  it('금액을 모르는 임차인이 섞이면 하한으로 표시한다', async () => {
    // 배당요구가 유효하면 배당 회수액을 등기부 없이 모른다 — 0원으로 확정하면 안 된다
    const pool = createMockPoolSequence(
      [
        {
          courtOfficeCode: 'B000210',
          caseNo: '2025타경755',
          itemNo: '1',
          bidDatetime: null,
          riskFlags: [],
          tenantCount: '2',
          noticeId: '78',
          noticeBaselineDate: '2024-05-01',
          noticeDistributionDemandDeadline: '2024-08-01',
        },
      ],
      [
        {
          noticeId: '78',
          tenantSeq: 1,
          sourceKind: null,
          occupiedPart: '201호',
          moveInDate: '2020-03-02',
          fixedDate: null,
          depositAmount: '30000000',
          demandedDistribution: false,
          demandedDistributionDate: null,
        },
        {
          noticeId: '78',
          tenantSeq: 2,
          sourceKind: null,
          occupiedPart: '202호',
          moveInDate: '2020-04-02',
          fixedDate: '2020-04-02',
          depositAmount: '40000000',
          demandedDistribution: true,
          demandedDistributionDate: '2024-06-01',
        },
      ],
    );
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '2025타경755', '1');

    expect(result?.assumedDeposit).toEqual({ amount: 30_000_000, isLowerBound: true });
  });

  it('점유자 조회는 물건 수와 무관하게 한 번만 돈다 (N+1 방지)', async () => {
    const notice = (id: string) => ({
      courtOfficeCode: 'B000210',
      caseNo: `2025타경${id}`,
      itemNo: '1',
      bidDatetime: null,
      riskFlags: [],
      tenantCount: '0',
      noticeId: id,
      noticeBaselineDate: '2024-05-01',
      noticeDistributionDemandDeadline: '2024-08-01',
    });
    const pool = createMockPoolSequence([notice('1'), notice('2'), notice('3')], []);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 0);

    // 목록 쿼리 1 + 점유자 쿼리 1
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('일치하는 물건이 없으면 null을 반환한다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '없는사건', '1');

    expect(result).toBeNull();
  });

  it('목록 조회는 limit·offset을 바인딩 파라미터로 전달한다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 40);

    // 필터 자리는 지역·유형·가격 5개다 — 안 쓰면 전부 null 이고 조건이 통과된다
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $1 OFFSET $2'), [
      20,
      40,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('목록 조회는 sido·sigungu 필터를 바인딩 파라미터로 전달한다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 0, { sido: '서울특별시', sigungu: '종로구' });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("hjguSido' = $3"), [
      20,
      0,
      '서울특별시',
      '종로구',
      null,
      null,
      null,
    ]);
  });

  it('countBySido는 시/도별 건수를 집계한다', async () => {
    const pool = createMockPool([
      { region: '서울특별시', count: '42' },
      { region: '경기도', count: '3' },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.countBySido();

    expect(result).toEqual([
      { name: '서울특별시', count: 42 },
      { name: '경기도', count: 3 },
    ]);
  });

  it('countBySigungu는 주어진 시/도 안에서 시/군/구별 건수를 집계한다', async () => {
    const pool = createMockPool([{ region: '종로구', count: '8' }]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.countBySigungu('서울특별시');

    expect(result).toEqual([{ name: '종로구', count: 8 }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("hjguSido' = $1"), ['서울특별시']);
  });

  it('findItemsInBbox는 ST_MakeEnvelope 좌표와 limit을 바인딩 파라미터로 전달한다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findItemsInBbox({ minLng: 126.9, minLat: 37.4, maxLng: 127.1, maxLat: 37.6 }, 500);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('ST_MakeEnvelope($1, $2, $3, $4, 4326)'), [
      126.9,
      37.4,
      127.1,
      37.6,
      500,
    ]);
  });

  it('findPhotos는 물건 → 사건 조인 후 사진 메타를 ITEM 우선·seq 순으로 조회하고 id를 숫자로 변환한다', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ caseId: '7' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: '93',
              source: 'ITEM',
              seq: 1,
              categoryName: '전경도',
              caption: '건물 전경',
              contentType: 'image/jpeg',
              byteSize: 289045,
            },
          ],
        }),
    };
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findPhotos('B000210', '2022타경101244', '1');

    expect(result).toEqual([
      {
        id: 93,
        source: 'ITEM',
        seq: 1,
        categoryName: '전경도',
        caption: '건물 전경',
        contentType: 'image/jpeg',
        byteSize: 289045,
      },
    ]);
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE ac.court_office_code = $1'), [
      'B000210',
      '2022타경101244',
      '1',
    ]);
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ORDER BY CASE WHEN source = 'ITEM' THEN 0 ELSE 1 END, seq"),
      ['7'],
    );
  });

  it('findPhotos는 물건이 없으면 사진 조회 없이 null을 반환한다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findPhotos('B000210', '없는사건', '1');

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('findPhotos는 물건은 있는데 사진이 없으면 빈 배열을 반환한다', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ caseId: '7' }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findPhotos('B000210', '2022타경101244', '1');

    expect(result).toEqual([]);
  });

  it('findPhotoBytes는 content_type과 바이트를 돌려주고, 없으면 null이다', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const pool = createMockPool([{ contentType: 'image/jpeg', bytes }]);
    const repository = new AuctionItemsRepository(pool as never);

    expect(await repository.findPhotoBytes('93')).toEqual({ contentType: 'image/jpeg', bytes });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM auction_case_photo WHERE id = $1'), [
      '93',
    ]);

    const emptyPool = createMockPool([]);
    const emptyRepository = new AuctionItemsRepository(emptyPool as never);
    expect(await emptyRepository.findPhotoBytes('999999')).toBeNull();
  });

  it('단건 조회 결과의 좌표(lng/lat)는 그대로 통과시킨다', async () => {
    const pool = createMockPool([
      {
        courtOfficeCode: 'B000210',
        caseNo: '2025타경755',
        itemNo: '1',
        courtName: '서울중앙지방법원',
        deptName: '경매7계',
        usageName: '상가',
        address: '서울특별시 종로구 인의동 48-2',
        appraisalAmount: '259000000',
        minimumSalePrice: '84869000',
        failedBidCount: 6,
        bidDatetime: null,
        lng: 126.998,
        lat: 37.571,
      },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findOne('B000210', '2025타경755', '1');

    expect(result).toMatchObject({ lng: 126.998, lat: 37.571 });
  });
});

describe('findNoticeAnalysis — 명세서만으로 하는 권리분석 (등기부 없음)', () => {
  function createNoticePool(notice: unknown, tenants: unknown[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: notice === null ? [] : [notice] })
      .mockResolvedValueOnce({ rows: tenants });
    return { query };
  }

  const notice = {
    id: '398',
    documentDate: new Date(2026, 5, 17), // 로컬 자정 — pg가 date 컬럼을 이렇게 준다
    baselineRaw: '2024.02.19. 압류',
    baselineDate: new Date(2024, 1, 19),
    distributionDemandDeadline: new Date(2025, 0, 22),
    assumedRightsKind: 'LEASEHOLD_REGISTRATION',
    riskFlags: [],
  };

  it('date 컬럼을 하루 밀리지 않게 변환한다 — 대항력은 하루 차이로 뒤집힌다', async () => {
    // toISOString()을 쓰면 KST(UTC+9)에서 전날이 된다: 2020-07-29 → 2020-07-28
    const pool = createNoticePool(notice, [
      {
        tenantSeq: 1,
        sourceKind: '권리신고',
        occupiedPart: '202호',
        moveInDate: new Date(2020, 6, 29),
        fixedDate: new Date(2023, 11, 20),
        depositAmount: '50000000',
        demandedDistribution: true,
        demandedDistributionDate: new Date(2024, 9, 25),
      },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findNoticeAnalysis('B000211', '2024타경63301', '1');

    expect(result?.baselineDate).toBe('2024-02-19');
    expect(result?.distributionDemandDeadline).toBe('2025-01-22');
    expect(result?.tenants[0]).toMatchObject({
      moveInDate: '2020-07-29',
      fixedDate: '2023-12-20',
      demandedDistributionDate: '2024-10-25',
      possessionRightDate: '2020-07-30',
      hasPriority: true,
      distributionDemandEffective: true,
      assumption: 'ASSUMED_AMOUNT_UNKNOWN',
      depositAmount: 50_000_000,
    });
  });

  it('점유자 성명을 응답에 담지 않는다 — 법원이 공개한 제3자 개인정보다', async () => {
    const pool = createNoticePool(notice, [
      {
        tenantSeq: 1,
        isGuarantor: false,
        sourceKind: '현황조사',
        occupiedPart: '202호',
        moveInDate: new Date(2020, 6, 29),
        fixedDate: null,
        depositAmount: null,
        demandedDistribution: null,
        demandedDistributionDate: null,
      },
    ]);
    const repository = new AuctionItemsRepository(pool as never);

    const result = await repository.findNoticeAnalysis('B000211', '2024타경63301', '1');

    expect(JSON.stringify(result)).not.toContain('tenantName');
    // 성명을 **값으로 SELECT하지 않아야** 한다 — 응답에 섞일 경로를 만들지 않는다.
    // 보증기관 대위 판정(isGuarantor)은 SQL 안에서 불리언으로만 바꿔 내보내므로,
    // 성명 문자열 자체는 API 프로세스에 들어오지 않는다. 그래서 컬럼 언급이 아니라
    // "결과 집합에 별칭으로 실리는지"를 본다.
    const tenantSql = (pool.query.mock.calls[1]?.[0] ?? '') as string;
    expect(tenantSql).not.toMatch(/tenant_name\s+AS/i);
    expect(tenantSql).not.toMatch(/^\s*tenant_name\s*,/m);
  });

  it('명세서를 못 받았으면 null — 빈 결과는 "인수할 권리 없음"으로 읽힌다', async () => {
    const pool = createNoticePool(null, []);
    const repository = new AuctionItemsRepository(pool as never);

    expect(await repository.findNoticeAnalysis('B000211', '2024타경63301', '1')).toBeNull();
  });
});

describe('AuctionItemsRepository 목록 필터 (지역·유형·가격)', () => {
  it('용도는 첫 조각으로 비교한다 — 법원이 콤마로 묶어 보내기 때문이다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 0, { usages: ['아파트', '다세대'] });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("split_part(raw.payload->>'dspslUsgNm', ',', 1) = ANY($5)"),
      [20, 0, null, null, ['아파트', '다세대'], null, null],
    );
  });

  it('가격 범위를 최저매각가격에 건다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 0, { minPrice: 1_000, maxPrice: 2_000 });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ai.minimum_sale_price >= $6'),
      [20, 0, null, null, null, 1_000, 2_000],
    );
  });

  it('기일 임박순은 지난 기일을 뒤로 보낸다 — 지난 물건이 맨 위면 목록이 쓸모없다', async () => {
    const pool = createMockPool([]);
    const repository = new AuctionItemsRepository(pool as never);

    await repository.findMany(20, 0, { sort: 'bidDate' });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('(sch.bid_datetime < now()), sch.bid_datetime ASC NULLS LAST'),
      expect.anything(),
    );
  });

  it('건수는 목록과 같은 조건을 쓴다 — 다른 조건이면 "전체 N건"이 목록과 어긋난다', async () => {
    const pool = createMockPool([{ count: '7' }]);
    const repository = new AuctionItemsRepository(pool as never);

    const count = await repository.countMany({ sido: '서울특별시', usages: ['아파트'] });

    expect(count).toBe(7);
    // 건수 쿼리는 limit·offset이 없어 필터가 $1부터다
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("hjguSido' = $1"),
      ['서울특별시', null, ['아파트'], null, null],
    );
  });
});

/** Date.UTC(22, ...)는 22년이 아니라 1922년이다 — pg처럼 setUTCFullYear로 세 자리 이하 연도를 만든다. */
function dateWithYear(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

describe('toIsoDate', () => {
  it('연도가 네 자리가 아닌 날짜도 YYYY-MM-DD로 채운다', () => {
    // 법원 원문의 두 자리 연도("22.07.20")가 서기 22년으로 적재된 행이 실제로 있다. 연도를 채우지
    // 않으면 "22-07-20"이 되고, 이 문자열을 받은 addOneDay가 Invalid Date로 터져 그 물건이 든
    // 뷰포트 전체가 500이 된다 — 한 행의 오염이 지도 한 구역의 마커를 통째로 지운다.
    expect(toIsoDate(dateWithYear(22, 7, 20))).toBe('0022-07-20');
    expect(toIsoDate(dateWithYear(217, 4, 24))).toBe('0217-04-24');
  });

  it('네 자리 연도는 그대로 둔다', () => {
    expect(toIsoDate(dateWithYear(2022, 7, 20))).toBe('2022-07-20');
  });
});

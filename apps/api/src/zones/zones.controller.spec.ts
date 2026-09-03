import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ZonesController, ZONE_FEATURE_LIMIT, ZONING_FEATURE_LIMIT } from './zones.controller';

const emptyCollection = { type: 'FeatureCollection' as const, truncated: false, features: [] };

function createController() {
  const repository = { findZonesInBbox: jest.fn().mockResolvedValue(emptyCollection) };
  return { repository, controller: new ZonesController(repository as never) };
}

describe('ZonesController', () => {
  it('bbox 네 값을 숫자로 파싱해 리포지토리에 넘긴다', async () => {
    const { repository, controller } = createController();

    const result = await controller.zones('126.97,37.55,127.01,37.58');

    expect(repository.findZonesInBbox).toHaveBeenCalledWith(
      { minLng: 126.97, minLat: 37.55, maxLng: 127.01, maxLat: 37.58 },
      ZONE_FEATURE_LIMIT,
    );
    expect(result).toBe(emptyCollection);
  });

  it('공백이 섞인 bbox도 받는다 — 지도 클라이언트가 만드는 흔한 형태다', async () => {
    const { repository, controller } = createController();

    await controller.zones('126.97, 37.55, 127.01, 37.58');

    expect(repository.findZonesInBbox).toHaveBeenCalledWith(
      { minLng: 126.97, minLat: 37.55, maxLng: 127.01, maxLat: 37.58 },
      ZONE_FEATURE_LIMIT,
    );
  });

  it('bbox가 없으면 400', async () => {
    const { repository, controller } = createController();

    await expect(controller.zones(undefined)).rejects.toThrow(BadRequestException);
    expect(repository.findZonesInBbox).not.toHaveBeenCalled();
  });

  it('값이 4개가 아니면 400', async () => {
    const { controller } = createController();

    await expect(controller.zones('126.97,37.55,127.01')).rejects.toThrow(BadRequestException);
    await expect(controller.zones('126.97,37.55,127.01,37.58,1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.zones('')).rejects.toThrow(BadRequestException);
  });

  it('숫자가 아닌 값이 섞이면 400', async () => {
    const { controller } = createController();

    await expect(controller.zones('126.97,abc,127.01,37.58')).rejects.toThrow(BadRequestException);
    // 빈 조각은 Number()가 0으로 바꾼다 — 조용히 0,0 좌표로 조회되면 안 된다
    await expect(controller.zones('126.97,,127.01,37.58')).rejects.toThrow(BadRequestException);
    await expect(controller.zones('126.97,Infinity,127.01,37.58')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('경도·위도 범위가 뒤집히면 400', async () => {
    const { controller } = createController();

    await expect(controller.zones('127.01,37.55,126.97,37.58')).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.zones('126.97,37.58,127.01,37.55')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('폭이나 높이가 0인 bbox도 400 — 빈 결과를 "구역 없음"으로 오해하게 만든다', async () => {
    const { controller } = createController();

    await expect(controller.zones('126.97,37.55,126.97,37.58')).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.zones('126.97,37.55,127.01,37.55')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('ZonesController 용도지역 bbox', () => {
  const emptyZoning = {
    type: 'FeatureCollection' as const,
    truncated: false,
    baseYm: null,
    features: [],
  };

  function createZoningController() {
    const repository = { findZoningInBbox: jest.fn().mockResolvedValue(emptyZoning) };
    return { repository, controller: new ZonesController(repository as never) };
  }

  it('bbox를 파싱해 용도지역 상한과 함께 리포지토리에 넘긴다', async () => {
    const { repository, controller } = createZoningController();

    const result = await controller.zoning('126.97,37.55,127.01,37.58');

    expect(repository.findZoningInBbox).toHaveBeenCalledWith(
      { minLng: 126.97, minLat: 37.55, maxLng: 127.01, maxLat: 37.58 },
      ZONING_FEATURE_LIMIT,
    );
    expect(result).toBe(emptyZoning);
  });

  it('잘못된 bbox는 정비구역과 같은 검증으로 400이다', async () => {
    const { repository, controller } = createZoningController();

    await expect(controller.zoning(undefined)).rejects.toThrow(BadRequestException);
    await expect(controller.zoning('126.97,abc,127.01,37.58')).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.zoning('127.01,37.55,126.97,37.58')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.findZoningInBbox).not.toHaveBeenCalled();
  });
});

describe('ZonesController 물건 용도지역', () => {
  const districts = [
    {
      zoningId: 812,
      zoningBucket: 'RES_GENERAL_2',
      zoneNameRaw: '제2종일반주거지역(7층이하)',
      sclasCl: 'UQA124',
      mlsfcCl: null,
      baseYm: '2026-02',
    },
    {
      zoningId: 4102,
      zoningBucket: 'RES_GENERAL_2',
      zoneNameRaw: '제2종일반주거지역',
      sclasCl: 'UQA122',
      mlsfcCl: null,
      baseYm: '2026-02',
    },
  ];

  function createItemZoningController(result: typeof districts | []) {
    const repository = { findZoningForItem: jest.fn().mockResolvedValue(result) };
    return { repository, controller: new ZonesController(repository as never) };
  }

  it('물건키를 그대로 넘기고 여러 건도 전부 돌려준다 — 재고시 겹침은 사실이다', async () => {
    const { repository, controller } = createItemZoningController(districts);

    const result = await controller.itemZoning('B000210', '2024타경1234', '1');

    expect(repository.findZoningForItem).toHaveBeenCalledWith('B000210', '2024타경1234', '1');
    expect(result).toBe(districts);
  });

  it('매칭이 없으면 404 — 화면은 섹션을 그리지 않는 것으로 응답한다', async () => {
    const { controller } = createItemZoningController([]);

    await expect(controller.itemZoning('B000210', '2024타경1234', '1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ZonesController 노후도', () => {
  const ageDto = {
    bjdCode: '11110101',
    dongName: '청운동',
    baseYm: '2026-08',
    totalCount: 314,
    unknownAprCount: 43,
    over20Count: 237,
    over30Count: 177,
    over20RatioPct: 75.5,
    over30RatioPct: 56.4,
  };

  function createAgeController(dto: typeof ageDto | null) {
    const repository = {
      findZonesInBbox: jest.fn(),
      findBuildingAgeForItem: jest.fn().mockResolvedValue(dto),
    };
    return { repository, controller: new ZonesController(repository as never) };
  }

  it('물건키를 그대로 리포지토리에 넘기고 집계를 돌려준다', async () => {
    const { repository, controller } = createAgeController(ageDto);

    const result = await controller.buildingAge('B000210', '2024타경1234', '1');

    expect(repository.findBuildingAgeForItem).toHaveBeenCalledWith('B000210', '2024타경1234', '1');
    expect(result).toBe(ageDto);
  });

  it('집계가 없으면 404 — 화면은 섹션을 그리지 않는 것으로 응답한다', async () => {
    const { controller } = createAgeController(null);

    await expect(controller.buildingAge('B000210', '2024타경1234', '1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

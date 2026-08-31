// 지도 탐색 화면의 클라이언트 로직 — 네이버 Web Dynamic Map 스크립트 로드, 카메라 idle마다 bbox 재조회,
// 줌에 따라 클러스터 버블/개별 마커(가격 캡션) 전환, 마커 클릭 시 물건 상세로 이동한다 (모바일 F-01과 동일 문법).
// 지적편집도·정비구역은 같은 idle 리듬에 얹은 선택 레이어다.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { colors } from '@auction/design-tokens';
import { formatDropRate, formatWonCompact } from '../format';
import { isBulkLot } from './bulk-lot';
import { clusterPoints, type ClusterInput } from './cluster';
import { ItemDetailPanel } from './ItemDetailPanel';
import { ItemHoverCard } from './ItemHoverCard';
import {
  usageCategory,
  USAGE_CATEGORY_ICON,
  USAGE_CATEGORY_LABEL,
  type UsageCategory,
} from './usage-category';
import {
  parseZoneCollection,
  ZONE_MIN_ZOOM,
  type ZoneFeature,
  type ZoneProperties,
} from './zone-layer';
import styles from './page.module.css';

const NCP_MAPS_CLIENT_ID = process.env.NEXT_PUBLIC_NCP_MAPS_CLIENT_ID;
const MAP_SCRIPT_SRC = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NCP_MAPS_CLIENT_ID ?? ''}`;
// API bbox 조회 상한 (apps/api auction-items.controller.ts BBOX_LIMIT과 동일 값) — 도달 시 "N건+"로 표시
const BBOX_LIMIT = 500;

// 초기 카메라: 서울시청 (WP-07 §1-9)
const SEOUL_CENTER = { lat: 37.5665, lng: 126.978 };
const INITIAL_ZOOM = 12;
// 이 줌 이상에서는 클러스터 대신 개별 마커 + 가격 캡션을 보여준다 (모바일 CAPTION_ZOOM과 동일, §1-6)
const CAPTION_ZOOM = 15;
const IDLE_DEBOUNCE_MS = 300;
// 호버 카드 크기 — 컨테이너 밖으로 잘리지 않게 위치를 보정하는 데 쓴다.
// width는 ItemHoverCard.module.css의 .card와 같은 값이고, height는 칩이 가장 많은 경우의 실측 상한이다
// (칩 3줄 + 가격 + 감정가). 정확히 알 수 없어 넉넉히 잡는다 — 남으면 카드가 조금 위로 붙을 뿐이다.
const HOVER_CARD_WIDTH = 236;
const HOVER_CARD_MAX_HEIGHT = 168;
const HOVER_CARD_MARGIN = 8;

// 정비구역은 **채움 없이 윤곽선만** 그린다 (기획 12). 면을 칠하면 지적편집도·마커와 색이 겹쳐 섞이고,
// 겹친 구역끼리도 서로를 덮어 아무것도 읽히지 않는다.
const ZONE_FILL_OPACITY = 0;
// 1px은 바탕지도의 도로선과 구분되지 않고, 3px이면 작은 구역이 선에 먹힌다.
const ZONE_STROKE_WEIGHT = 2;
const ZONE_STROKE_OPACITY = 0.9;

// 레이어를 켰는데 화면이 비어 있을 때 그 이유를 적는다. 이유가 없으면 "이 동네에 구역이 없다"로 읽힌다.
type ZoneNotice = 'none' | 'zoomIn' | 'truncated' | 'error';

const ZONE_NOTICE_TEXT: Record<Exclude<ZoneNotice, 'none'>, string> = {
  zoomIn: '정비구역은 지도를 조금 더 확대하면 보여요.',
  truncated: '이 범위에 정비구역이 많아 일부만 그렸어요.',
  error: '정비구역을 불러오지 못했어요.',
};

/** 재사용하는 폴리곤 한 칸. 담긴 구역이 바뀌므로 클릭 시점에 feature를 읽어야 한다. */
interface ZonePolygonSlot {
  polygon: naver.maps.Polygon;
  feature: ZoneFeature | null;
  /**
   * 지금 지도에 붙어 있는지. SDK의 setMap은 같은 지도를 다시 넘겨도 그냥 넘어가지 않고 매번
   * 오버레이를 다시 단다 — 실측에서 이미 붙은 폴리곤 100개에 setMap(map)을 다시 부르는 데만
   * 92ms가 들었다. 붙은 칸을 건너뛰려고 붙임 상태를 우리가 들고 있는다.
   */
  attached: boolean;
}

interface AuctionItemPin {
  courtOfficeCode: string;
  caseNo: string;
  itemNo: string;
  courtName: string | null;
  deptName: string | null;
  address: string | null;
  usageName: string | null;
  areaKind: string | null;
  areaM2: number | null;
  /** true면 단가를 계산하지 않는다 — 면적과 가격의 단위가 어긋난다. */
  bulkSale: boolean;
  appraisalAmount: number | null;
  minimumSalePrice: number | null;
  failedBidCount: number | null;
  bidDatetime: string | null;
  assumedRightsKind: string | null;
  riskFlags: string[];
  tenantCount: number | null;
  /** 명세서 기반 인수 보증금. null은 "명세서 미확인"이지 "인수 없음"이 아니다. */
  assumedDeposit: { amount: number; isLowerBound: boolean } | null;
  lng: number | null;
  lat: number | null;
}

type ScriptState = 'loading' | 'ready' | 'error';
type FetchState = 'loading' | 'idle' | 'error';

function itemKey(item: { courtOfficeCode: string; caseNo: string; itemNo: string }): string {
  return `${item.courtOfficeCode}_${item.caseNo}_${item.itemNo}`;
}

/**
 * 마커 하나의 내용. 묶음이면 하락률 대신 건수를 붙인다 —
 * 하락률은 물건마다 달라서 묶음을 대표할 값이 없다.
 */
const USAGE_CATEGORY_CLASS: Record<UsageCategory, string> = {
  APARTMENT: styles.usageApartment ?? '',
  MULTI_HOUSE: styles.usageMultiHouse ?? '',
  OFFICETEL: styles.usageOfficetel ?? '',
  DETACHED: styles.usageDetached ?? '',
  RETAIL: styles.usageRetail ?? '',
  LAND: styles.usageLand ?? '',
  OTHER: styles.usageOther ?? '',
};

/** 건물 유형 아이콘. 모양과 색으로 유형을 말한다 — 예전 6px 점은 유형을 구분하지 못했다. */
function usageIconHtml(category: UsageCategory): string {
  return `<svg class="${styles.markerIcon} ${USAGE_CATEGORY_CLASS[category]}" viewBox="0 0 12 12" aria-label="${USAGE_CATEGORY_LABEL[category]}" role="img" fill="currentColor">${USAGE_CATEGORY_ICON[category]}</svg>`;
}

function markerHtml(
  priceLabel: string | null,
  drop: string | null,
  count: number,
  bulkLot: boolean,
  category: UsageCategory,
): string {
  // 일괄매각은 가격이 묶음 전체 값이라 건수만 붙이면 "한 채에 421억"으로 읽힌다 —
  // 묶음이라는 사실을 뱃지에 적는다.
  const tail =
    count > 1
      ? `<span class="${styles.markerCount}">${bulkLot ? `일괄 ${count}` : `${count}건`}</span>`
      : drop
        ? `<span class="${styles.markerDrop}">${drop}</span>`
        : '';
  return `<div class="${styles.marker}">${usageIconHtml(category)}${
    priceLabel ? `<span class="${styles.markerPrice}">${priceLabel}</span>` : ''
  }${tail}</div>`;
}

interface PinGroup {
  lat: number;
  lng: number;
  items: AuctionItemPin[];
}

/**
 * 좌표가 같은 물건을 한 마커로 묶는다.
 *
 * 같은 지번의 다세대·오피스텔은 좌표가 완전히 같아서 마커를 따로 찍으면 서로 가려진다
 * (실측 2026-08: 물건 2,004건이 좌표 1,131개에 몰려 있고 한 지점에 362건).
 * 예전에는 겹친 마커를 위도로 6.7m씩 밀어냈는데, 362번째는 실제 건물에서 2.4km 떨어져
 * 엉뚱한 곳을 가리켰다. 밀어내지 않고 묶는다.
 */
function groupByCoord(items: (AuctionItemPin & { lng: number; lat: number })[]): PinGroup[] {
  const groups = new Map<string, PinGroup>();
  for (const item of items) {
    const key = `${item.lng},${item.lat}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { lat: item.lat, lng: item.lng, items: [item] });
  }
  // 묶음 안은 최저가 오름차순 — 마커에 쓰는 대표 가격과 패널 목록의 첫 줄을 맞춘다.
  for (const group of groups.values()) {
    group.items.sort((a, b) => (a.minimumSalePrice ?? Infinity) - (b.minimumSalePrice ?? Infinity));
  }
  return [...groups.values()];
}

function clusterHtml(count: number): string {
  return `<div class="${styles.clusterBubble}"><span class="${styles.clusterCount}">${count}</span></div>`;
}

export function MapView() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<naver.maps.Map | null>(null);
  // 지적편집도(필지 경계·지번·지목). 지도 SDK가 타일로 그려주므로 우리가 적재할 데이터가 없다.
  // 용도지역("몇 종 지역")은 이 레이어에 없다 — 그건 별도 원천(OA-21136)이 필요하다 (기획 12).
  const cadastralRef = useRef<naver.maps.CadastralLayer | null>(null);
  const [cadastralOn, setCadastralOn] = useState(false);
  // 정비구역 폴리곤. 뷰포트를 옮길 때마다 인스턴스를 새로 만들면 수백 개가 생겼다 버려지므로
  // 칸을 만들어 두고 좌표만 갈아 끼운다. 남는 칸은 지우지 않고 지도에서만 뗀다.
  const zoneSlotsRef = useRef<ZonePolygonSlot[]>([]);
  const [zonesOn, setZonesOn] = useState(false);
  // idle 리스너는 지도를 만들 때 한 번만 걸리므로 그 클로저는 토글의 최신 값을 볼 수 없다 —
  // 호버 좌표와 같은 이유로 state가 아니라 ref로도 들고 있는다.
  const zonesOnRef = useRef(false);
  const zoneRequestIdRef = useRef(0);
  const [zoneNotice, setZoneNotice] = useState<ZoneNotice>('none');
  const [selectedZone, setSelectedZone] = useState<ZoneProperties | null>(null);
  const idleListenerRef = useRef<naver.maps.MapEventListener | null>(null);
  const boundsListenerRef = useRef<naver.maps.MapEventListener | null>(null);
  const markersRef = useRef<naver.maps.Marker[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0); // bbox 요청이 역전 응답되어도 최신 결과만 반영하기 위한 순번

  const [scriptState, setScriptState] = useState<ScriptState>('loading');
  const [scriptRetryKey, setScriptRetryKey] = useState(0);
  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [items, setItems] = useState<AuctionItemPin[]>([]);
  // 마커를 누르면 페이지를 떠나지 않고 패널을 연다 — 지도 탐색의 맥락(줌·위치·주변 물건)을 지킨다.
  // 한 마커가 좌표가 같은 물건 여럿을 담으므로 배열로 넘긴다.
  const [selected, setSelected] = useState<AuctionItemPin[] | null>(null);
  const [hovered, setHovered] = useState<{
    items: AuctionItemPin[];
    left: number;
    top: number;
  } | null>(null);
  // 호버 중인 마커의 지도 좌표. 카메라가 움직이는 동안 카드를 따라오게 하려면 화면 좌표가 아니라
  // 원본 좌표를 들고 있어야 한다 — 화면 좌표는 이동하는 순간 낡는다. 리스너가 최신 값을 읽어야
  // 하므로 state가 아니라 ref다(등록 시점 클로저에 갇히지 않게).
  const hoveredCoordRef = useRef<naver.maps.LatLng | null>(null);

  /**
   * 마커 좌표를 지도 컨테이너 기준 카드 위치로 바꾼다.
   *
   * 카드가 컨테이너를 넘지 않게 여기서 보정한다 — ItemHoverCard는 "호출부가 보정해 넘긴다"를
   * 전제로 만들어져 있는데 실제로는 아무도 보정하지 않아, 오른쪽·아래 끝 마커에서 카드가 잘렸다.
   * 카드 높이는 내용(칩 개수)에 따라 달라 정확히 알 수 없으므로 가장 높은 경우를 기준으로 민다.
   */
  const hoverPositionOf = useCallback(
    (map: naver.maps.Map, coord: naver.maps.LatLng): { left: number; top: number } => {
      const offset = map.getProjection().fromCoordToOffset(coord);
      const container = mapElementRef.current;
      if (container === null) return { left: offset.x, top: offset.y };
      const maxLeft = container.clientWidth - HOVER_CARD_WIDTH - HOVER_CARD_MARGIN;
      const maxTop = container.clientHeight - HOVER_CARD_MAX_HEIGHT - HOVER_CARD_MARGIN;
      return {
        left: Math.max(HOVER_CARD_MARGIN, Math.min(offset.x, maxLeft)),
        top: Math.max(HOVER_CARD_MARGIN, Math.min(offset.y, maxTop)),
      };
    },
    [],
  );

  const loadBbox = useCallback(async (bounds: naver.maps.LatLngBounds) => {
    const requestId = ++requestIdRef.current;
    setFetchState('loading');
    const params = new URLSearchParams({
      minLng: String(bounds.getSW().lng()),
      minLat: String(bounds.getSW().lat()),
      maxLng: String(bounds.getNE().lng()),
      maxLat: String(bounds.getNE().lat()),
    });
    try {
      const response = await fetch(`/api/auction-items/bbox?${params.toString()}`);
      if (!response.ok) throw new Error(`bbox 조회 실패: ${response.status}`);
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('bbox 응답이 배열이 아님');
      if (requestIdRef.current !== requestId) return; // 그 사이 더 최신 요청이 시작됐으면 이 응답은 버린다
      setItems(data as AuctionItemPin[]);
      setFetchState('idle');
    } catch {
      if (requestIdRef.current !== requestId) return;
      // 실패 시 이전 범위·줌 기준으로 그린 마커가 잔존하지 않게 지운다 (§1-10: 에러 배너 + 빈 지도).
      setItems([]);
      setFetchState('error');
    }
  }, []);

  /** 폴리곤을 지도에서 뗀다. 인스턴스는 남겨 다음 조회에서 다시 쓴다. */
  const hideZones = useCallback(() => {
    for (const slot of zoneSlotsRef.current) {
      if (!slot.attached) continue;
      slot.polygon.setMap(null);
      slot.attached = false;
      slot.feature = null;
    }
  }, []);

  const drawZones = useCallback((map: naver.maps.Map, features: ZoneFeature[]) => {
    const naverMaps = window.naver?.maps;
    if (!naverMaps) return;
    const slots = zoneSlotsRef.current;

    features.forEach((feature, index) => {
      const paths = feature.rings.map((ring) =>
        ring.map(([lng, lat]) => new naverMaps.LatLng(lat, lng)),
      );
      const slot = slots[index];
      if (slot === undefined) {
        const created: ZonePolygonSlot = {
          polygon: new naverMaps.Polygon({
            map,
            paths,
            fillOpacity: ZONE_FILL_OPACITY,
            strokeColor: colors.mapZoneOutline,
            strokeOpacity: ZONE_STROKE_OPACITY,
            strokeWeight: ZONE_STROKE_WEIGHT,
            clickable: true,
          }),
          feature,
          attached: true,
        };
        // 리스너는 인스턴스마다 한 번만 건다. 칸이 재사용되며 담긴 구역이 바뀌므로 생성 시점의
        // feature를 클로저에 가두면 클릭했을 때 옛 구역이 열린다 — 칸을 통해 지금 값을 읽는다.
        naverMaps.Event.addListener(created.polygon, 'click', () => {
          if (created.feature !== null) setSelectedZone(created.feature.properties);
        });
        slots.push(created);
        return;
      }
      slot.feature = feature;
      slot.polygon.setPaths(paths);
      // 이미 붙어 있으면 다시 달지 않는다 — 패닝마다 전 폴리곤을 재부착하면 그만큼 화면이 멎는다.
      if (!slot.attached) {
        slot.polygon.setMap(map);
        slot.attached = true;
      }
    });

    for (let index = features.length; index < slots.length; index += 1) {
      const spare = slots[index];
      if (spare === undefined || !spare.attached) continue;
      spare.polygon.setMap(null);
      spare.attached = false;
      spare.feature = null;
    }
  }, []);

  /**
   * 지금 뷰포트의 정비구역을 맞춘다 — 물건 조회(loadBbox)와 같은 idle 리듬을 탄다.
   *
   * 줌이 낮으면 조회조차 하지 않는다. 그 범위는 서울 전체가 한 화면에 들어와 구역이 수백 개인데,
   * 화면에서는 점으로 뭉개져 그릴 값도 없다 (근거는 zone-layer.ts ZONE_MIN_ZOOM).
   */
  const syncZones = useCallback(
    async (map: naver.maps.Map) => {
      // 끄거나 줌을 벗어나는 경우에도 번호를 올린다 — 그래야 이미 날아간 응답이 뒤늦게 그리지 못한다.
      const requestId = ++zoneRequestIdRef.current;
      if (!zonesOnRef.current) {
        hideZones();
        setZoneNotice('none');
        return;
      }
      if (map.getZoom() < ZONE_MIN_ZOOM) {
        hideZones();
        setZoneNotice('zoomIn');
        return;
      }
      const bounds = map.getBounds();
      const bbox = [
        bounds.getSW().lng(),
        bounds.getSW().lat(),
        bounds.getNE().lng(),
        bounds.getNE().lat(),
      ].join(',');
      try {
        const response = await fetch(`/api/zones?bbox=${bbox}`);
        if (!response.ok) throw new Error(`zones 조회 실패: ${response.status}`);
        const collection = parseZoneCollection(await response.json());
        if (zoneRequestIdRef.current !== requestId) return;
        drawZones(map, collection.features);
        setZoneNotice(collection.truncated ? 'truncated' : 'none');
      } catch {
        if (zoneRequestIdRef.current !== requestId) return;
        // 실패하면 이전 범위의 폴리곤이 남지 않게 지운다 (loadBbox와 같은 규칙).
        hideZones();
        setZoneNotice('error');
      }
    },
    [drawZones, hideZones],
  );

  /**
   * 카메라가 움직이는 **동안** 카드를 마커에 붙여 둔다.
   *
   * 예전에는 idle에서만 카드를 닫았는데, idle은 카메라가 멈춘 뒤에 뜨기 때문에 드래그·줌 중에는
   * 카드가 옛 화면 좌표에 그대로 남아 엉뚱한 곳을 가리켰다(사용자 신고: "스크롤하면 위치가 어긋난다").
   * bounds_changed는 이동 중 계속 발생하므로 여기서 다시 계산한다.
   */
  const handleBoundsChanged = useCallback(
    (map: naver.maps.Map) => {
      const coord = hoveredCoordRef.current;
      if (coord === null) return;
      const next = hoverPositionOf(map, coord);
      setHovered((prev) => (prev === null ? prev : { ...prev, ...next }));
    },
    [hoverPositionOf],
  );

  const handleIdle = useCallback(
    (map: naver.maps.Map) => {
      // 마커를 다시 그리면 호버 중이던 마커 객체가 사라지므로(아래 items 이펙트) 여기서 닫는다.
      // 위치 어긋남은 bounds_changed가 따라오며 해결한다 — 닫는 이유가 아니다.
      hoveredCoordRef.current = null;
      setHovered(null);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        loadBbox(map.getBounds());
        void syncZones(map);
      }, IDLE_DEBOUNCE_MS);
    },
    [loadBbox, syncZones],
  );

  const handleScriptReady = useCallback(() => {
    if (mapRef.current) return; // React strict mode 등으로 onReady가 중복 호출돼도 지도를 두 번 만들지 않는다
    const element = mapElementRef.current;
    if (!element || typeof window === 'undefined' || !window.naver?.maps) {
      setScriptState('error');
      return;
    }
    const map = new window.naver.maps.Map(element, {
      center: new window.naver.maps.LatLng(SEOUL_CENTER.lat, SEOUL_CENTER.lng),
      zoom: INITIAL_ZOOM,
    });
    mapRef.current = map;
    setScriptState('ready');
    idleListenerRef.current = window.naver.maps.Event.addListener(map, 'idle', () => handleIdle(map));
    boundsListenerRef.current = window.naver.maps.Event.addListener(map, 'bounds_changed', () =>
      handleBoundsChanged(map),
    );
    handleIdle(map); // 최초 화면도 idle과 동일한 흐름으로 조회한다

    // 브라우저 검증(WP-07 §2-d, map.panBy 호출)용 — 프로덕션 번들에는 포함하지 않는다.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __auctionMapDebug?: naver.maps.Map }).__auctionMapDebug = map;
    }
  }, [handleIdle, handleBoundsChanged]);

  // 네이버 지도 인증 실패(서비스 URL 미등록 등, WP-07 §0)는 스크립트 로드 자체는 성공하고 이 전역
  // 콜백으로만 통지된다 — next/script의 onError로는 잡히지 않아 별도로 등록해야 한다.
  useEffect(() => {
    window.navermap_authFailure = () => setScriptState('error');
    return () => {
      delete window.navermap_authFailure;
    };
  }, []);

  // 지도 인스턴스·리스너·마커를 정리한다 — 언마운트 시와 재시도로 지도를 다시 만들기 직전 둘 다에서 쓴다.
  const cleanupMap = useCallback(() => {
    // 대기 중인 debounce 타이머가 파괴된 map의 getBounds()를 호출하지 않게 먼저 정리한다.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    if (idleListenerRef.current && window.naver?.maps) {
      window.naver.maps.Event.removeListener(idleListenerRef.current);
    }
    idleListenerRef.current = null;
    if (boundsListenerRef.current && window.naver?.maps) {
      window.naver.maps.Event.removeListener(boundsListenerRef.current);
    }
    boundsListenerRef.current = null;
    hoveredCoordRef.current = null;
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];
    // 파괴될 지도에 붙은 오버레이를 그대로 들고 있으면, 다음 지도에서 재사용될 때 옛 지도를 가리킨다.
    cadastralRef.current?.setMap(null);
    cadastralRef.current = null;
    zoneSlotsRef.current.forEach((slot) => slot.polygon.setMap(null));
    zoneSlotsRef.current = [];
    mapRef.current?.destroy();
    mapRef.current = null;
  }, []);

  useEffect(() => () => cleanupMap(), [cleanupMap]);

  // 지적편집도는 SDK가 타일로 그려주므로 붙였다 떼기만 한다. 인스턴스는 한 번만 만든다 —
  // 껐다 켤 때마다 새로 만들면 지도 안에 오버레이가 쌓인다.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !window.naver?.maps) return;
    if (!cadastralOn) {
      cadastralRef.current?.setMap(null);
      return;
    }
    cadastralRef.current ??= new window.naver.maps.CadastralLayer();
    cadastralRef.current.setMap(map);
  }, [cadastralOn]);

  // 토글은 idle을 기다리지 않고 그 자리에서 반영한다 — 눌렀는데 지도를 움직여야 나타나면 고장으로 보인다.
  useEffect(() => {
    zonesOnRef.current = zonesOn;
    if (!zonesOn) setSelectedZone(null); // 레이어를 끄면 열려 있던 구역 카드도 함께 닫는다
    const map = mapRef.current;
    if (map === null) return;
    void syncZones(map);
  }, [zonesOn, syncZones]);

  // 물건 목록이 바뀔 때마다 기존 마커를 지우고 현재 줌에 맞춰 클러스터 버블 또는 개별 마커를 다시 그린다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof window === 'undefined' || !window.naver?.maps) return;
    const naverMaps = window.naver.maps;

    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];
    // 마커를 다시 그리면 호버 중이던 마커 객체가 사라진다 — 카드가 유령으로 남지 않게 닫는다.
    setHovered(null);

    const withCoords = items.filter(
      (item): item is AuctionItemPin & { lng: number; lat: number } => item.lng !== null && item.lat !== null,
    );
    const zoom = map.getZoom();

    if (zoom >= CAPTION_ZOOM) {
      for (const group of groupByCoord(withCoords)) {
        // 대표는 가장 싼 물건 — 지도에서 가격을 훑는 흐름과 맞다.
        const lead = group.items[0];
        if (lead === undefined) continue;
        const priceLabel =
          lead.minimumSalePrice !== null ? formatWonCompact(lead.minimumSalePrice) : null;
        const position = new naverMaps.LatLng(group.lat, group.lng);
        const marker = new naverMaps.Marker({
          position,
          map,
          icon: {
            content: markerHtml(
              priceLabel,
              formatDropRate(lead.appraisalAmount, lead.minimumSalePrice),
              group.items.length,
              isBulkLot(group.items),
              // 묶음은 대표 물건(가장 싼 것)의 유형을 쓴다 — 패널 목록 첫 줄과 같은 물건이다
              usageCategory(lead.usageName),
            ),
            anchor: new naverMaps.Point(28, 12),
          },
        });
        naverMaps.Event.addListener(marker, 'click', () => {
          setSelected(group.items);
          setHovered(null); // 패널이 열리면 호버 카드는 중복이다
        });
        // 호버 카드는 마커 기준 화면 좌표에 띄운다. 좌표는 hoverPositionOf가 컨테이너 기준으로
        // 바꾸고 화면 밖으로 나가지 않게 보정한다. 카메라가 움직이면 bounds_changed가 다시 계산한다.
        naverMaps.Event.addListener(marker, 'mouseover', () => {
          hoveredCoordRef.current = position;
          setHovered({ items: group.items, ...hoverPositionOf(map, position) });
        });
        naverMaps.Event.addListener(marker, 'mouseout', () => {
          hoveredCoordRef.current = null;
          setHovered(null);
        });
        markersRef.current.push(marker);
      }
      return;
    }

    const points: ClusterInput<AuctionItemPin>[] = withCoords.map((item) => ({
      id: itemKey(item),
      lng: item.lng,
      lat: item.lat,
      data: item,
    }));
    const projection = map.getProjection();
    const features = clusterPoints(points, (lng, lat) => projection.fromCoordToOffset(new naverMaps.LatLng(lat, lng)));

    for (const feature of features) {
      const marker = new naverMaps.Marker({
        position: new naverMaps.LatLng(feature.lat, feature.lng),
        map,
        icon: { content: clusterHtml(feature.count), anchor: new naverMaps.Point(20, 20) },
      });
      naverMaps.Event.addListener(marker, 'click', () => map.setZoom(map.getZoom() + 1, true));
      markersRef.current.push(marker);
    }
  }, [items]);

  const handleRetry = useCallback(() => {
    cleanupMap();
    // 오버레이는 cleanupMap이 버렸으므로 토글도 꺼진 상태로 되돌린다 — 켜진 버튼과 빈 지도가 어긋난다.
    setCadastralOn(false);
    setZonesOn(false);
    setZoneNotice('none');
    setSelectedZone(null);
    setScriptState('loading');
    setScriptRetryKey((key) => key + 1);
  }, [cleanupMap]);

  // 원천 데이터에 구역명과 사업 종류가 같은 문자열로 들어온 행이 있다(실측 2026-08: 종로 일대 323건 중
  // zone_name과 business_kind가 같은 값 129건). 같은 값을 두 줄로 반복하지 않는다 —
  // 둘 다 비어 있는 경우는 "이름도 종류도 확인되지 않았다"는 서로 다른 사실이라 줄을 남긴다.
  const repeatsZoneName =
    selectedZone !== null &&
    selectedZone.businessKind !== null &&
    selectedZone.businessKind === selectedZone.zoneName;

  const badgeLabel =
    fetchState === 'loading'
      ? '조회 중...'
      : fetchState === 'error'
        ? '불러오기 실패'
        : `이 지역 ${items.length}건${items.length >= BBOX_LIMIT ? '+' : ''}`;

  // next/script는 src 기준으로 로드 프라미스를 모듈 레벨에 캐시하고 실패도 fulfilled로 삼키므로,
  // key 재마운트만으로는 재요청이 일어나지 않는다(onReady/onError 재호출 없음 — 재시도 영구 고착).
  // 재시도마다 src를 바꿔 캐시를 우회하고 스크립트를 실제로 다시 로드·실행시킨다(인증 실패 복구 포함).
  const mapScriptSrc = scriptRetryKey === 0 ? MAP_SCRIPT_SRC : `${MAP_SCRIPT_SRC}&retry=${scriptRetryKey}`;

  return (
    <main className={styles.page}>
      <Script
        key={scriptRetryKey}
        src={mapScriptSrc}
        strategy="afterInteractive"
        onReady={handleScriptReady}
        onError={() => setScriptState('error')}
      />

      <div ref={mapElementRef} className={styles.map} />

      {selected ? (
        <ItemDetailPanel items={selected} onClose={() => setSelected(null)} />
      ) : null}

      {hovered ? (
        <ItemHoverCard items={hovered.items} left={hovered.left} top={hovered.top} />
      ) : null}

      {scriptState === 'ready' ? (
        <div className={styles.layerPanel}>
          <div className={styles.layerToggles}>
            <button
              type="button"
              className={cadastralOn ? `${styles.layerToggle} ${styles.layerToggleOn}` : styles.layerToggle}
              aria-pressed={cadastralOn}
              onClick={() => setCadastralOn((on) => !on)}
            >
              지적편집도
            </button>
            <button
              type="button"
              className={zonesOn ? `${styles.layerToggle} ${styles.layerToggleOn}` : styles.layerToggle}
              aria-pressed={zonesOn}
              onClick={() => setZonesOn((on) => !on)}
            >
              정비구역
            </button>
          </div>

          {zonesOn && zoneNotice !== 'none' ? (
            <p className={styles.layerNote}>{ZONE_NOTICE_TEXT[zoneNotice]}</p>
          ) : null}

          {selectedZone ? (
            <div className={styles.zoneCard}>
              <div className={styles.zoneCardHead}>
                <p className={styles.zoneName}>{selectedZone.zoneName ?? '구역명 정보 없음'}</p>
                <button
                  type="button"
                  className={styles.zoneClose}
                  onClick={() => setSelectedZone(null)}
                  aria-label="구역 정보 닫기"
                >
                  ✕
                </button>
              </div>
              <div className={styles.zoneSpecs}>
                {repeatsZoneName ? null : (
                  <>
                    <span className={styles.zoneSpecsLabel}>사업 종류</span>
                    <span className={styles.zoneSpecsValue}>{selectedZone.businessKind ?? '정보 없음'}</span>
                  </>
                )}
                <span className={styles.zoneSpecsLabel}>겹치는 물건</span>
                <span className={styles.zoneSpecsValue}>{selectedZone.itemCount}건</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {scriptState === 'ready' ? (
        <p className={`${styles.badge} ${fetchState === 'error' ? styles.badgeError : ''}`}>{badgeLabel}</p>
      ) : null}

      {scriptState === 'error' ? (
        <div className={styles.scriptError}>
          <p className={styles.scriptErrorText}>지도를 불러오지 못했어요.</p>
          <button type="button" className={styles.retryButton} onClick={handleRetry}>
            다시 시도
          </button>
        </div>
      ) : null}
    </main>
  );
}

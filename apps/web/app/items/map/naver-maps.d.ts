// 네이버 Web Dynamic Map(JS v3)에서 이 화면이 실제로 쓰는 API만 담은 최소 타입 선언.
// @types/navermaps는 구 ncpClientId 시대 기준이라 이 프로젝트가 쓰는 신 콘솔 키(ncpKeyId) 로드 방식과
// 버전이 맞는지 검증되지 않아 배제하고, 전역 any 금지(ESLint no-explicit-any) 규칙을 지키기 위해
// 실사용 API 표면만 최소로 선언한다 (WP-07 §3-4).
declare namespace naver.maps {
  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  class LatLngBounds {
    getSW(): LatLng;
    getNE(): LatLng;
  }

  class Point {
    constructor(x: number, y: number);
    x: number;
    y: number;
  }

  interface MarkerIcon {
    content: string;
    anchor?: Point;
  }

  interface MapOptions {
    center: LatLng;
    zoom: number;
  }

  class Map {
    constructor(element: HTMLElement, options: MapOptions);
    getBounds(): LatLngBounds;
    getZoom(): number;
    setZoom(zoom: number, effect?: boolean): void;
    getProjection(): Projection;
    panBy(offset: Point): void;
    destroy(): void;
  }

  interface MarkerOptions {
    position: LatLng;
    map?: Map;
    icon?: MarkerIcon;
  }

  class Marker {
    constructor(options: MarkerOptions);
    setMap(map: Map | null): void;
  }

  class Projection {
    fromCoordToOffset(coord: LatLng): Point;
  }

  // 지적편집도(필지 경계·지번·지목) 오버레이. SDK가 타일로 그리므로 우리가 넘길 데이터가 없고,
  // 지도에 붙였다 떼는 것이 API 표면의 전부다.
  class CadastralLayer {
    setMap(map: Map | null): void;
  }

  interface PolygonOptions {
    map?: Map;
    /** 링 목록. 첫 링이 바깥 경계이고 나머지는 구멍이다. */
    paths: LatLng[][];
    fillOpacity?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    clickable?: boolean;
  }

  class Polygon {
    constructor(options: PolygonOptions);
    /** 인스턴스를 재사용해 다른 구역을 그릴 때 쓴다 — 새로 만들지 않고 좌표만 갈아 끼운다. */
    setPaths(paths: LatLng[][]): void;
    setMap(map: Map | null): void;
  }

  // addListener가 반환하는 핸들 — 내부 구조는 몰라도 removeListener에 되돌려주면 해제된다
  type MapEventListener = object;

  namespace Event {
    function addListener(
      target: Map | Marker | Polygon,
      eventName: string,
      listener: (...args: unknown[]) => void,
    ): MapEventListener;
    function removeListener(listener: MapEventListener): void;
  }
}

interface Window {
  naver?: typeof naver;
  // 네이버 지도 인증 실패(미등록 서비스 URL 등) 시 SDK가 호출하는 전역 콜백 — 스크립트 로드 자체는
  // 성공(200)하고 이 콜백으로만 신호를 주기 때문에 Script의 onError로는 감지되지 않는다.
  navermap_authFailure?: () => void;
}

// 지도 폴리곤 인스턴스 재사용 풀 — 정비구역·용도지역 두 면 레이어가 같은 기계를 쓴다.
// 뷰포트를 옮길 때마다 폴리곤을 새로 만들면 수백~수천 개가 생겼다 버려지므로, 칸을 만들어 두고
// 좌표와 색만 갈아 끼운다. 남는 칸은 지우지 않고 지도에서만 뗀다.

/** 재사용하는 폴리곤 한 칸. 담긴 대상이 바뀌므로 클릭 시점에 feature를 읽어야 한다. */
export interface PolygonSlot<F> {
  polygon: naver.maps.Polygon;
  feature: F | null;
  /**
   * 지금 지도에 붙어 있는지. SDK의 setMap은 같은 지도를 다시 넘겨도 그냥 넘어가지 않고 매번
   * 오버레이를 다시 단다 — 실측에서 이미 붙은 폴리곤 100개에 setMap(map)을 다시 부르는 데만
   * 92ms가 들었다. 붙은 칸을 건너뛰려고 붙임 상태를 우리가 들고 있는다.
   */
  attached: boolean;
}

/** 폴리곤을 지도에서 뗀다. 인스턴스는 남겨 다음 조회에서 다시 쓴다. */
export function detachPolygons<F>(slots: PolygonSlot<F>[]): void {
  for (const slot of slots) {
    if (!slot.attached) continue;
    slot.polygon.setMap(null);
    slot.attached = false;
    slot.feature = null;
  }
}

export interface PolygonPoolSpec<F> {
  map: naver.maps.Map;
  naverMaps: typeof naver.maps;
  /** 호출자가 들고 있는 칸 목록. 이 함수가 늘리고 줄인다 */
  slots: PolygonSlot<F>[];
  features: readonly F[];
  ringsOf: (feature: F) => [number, number][][];
  /** 대상마다 다른 시각 속성. 칸을 재사용할 때도 다시 적용한다 — 안 하면 앞 대상의 색이 남는다 */
  styleOf: (feature: F) => naver.maps.PolygonStyleOptions;
  /** 겹칠 때 위에 오는 순서 (기획 12 §3.5 — 구역 > 면) */
  zIndex: number;
  /** coord는 누른 지점. 겹친 아래 레이어의 사실을 같이 말하는 데 쓴다 — SDK가 안 주면 null */
  onClick: (feature: F, coord: { lng: number; lat: number } | null) => void;
}

/**
 * 클릭 이벤트에서 누른 좌표를 꺼낸다.
 *
 * SDK 타입 선언은 리스너 인자를 unknown으로 두고 있어(전역 any 금지, naver-maps.d.ts) 여기서
 * 좁힌다. 모양이 다르면 null이다 — 좌표를 못 읽는 것은 클릭을 못 받는 것과 다른 일이라,
 * 카드는 열리고 병기 한 줄만 빠진다.
 */
function clickCoord(args: unknown[]): { lng: number; lat: number } | null {
  const event = args[0];
  if (typeof event !== 'object' || event === null || !('coord' in event)) return null;
  const coord: unknown = event.coord;
  if (typeof coord !== 'object' || coord === null) return null;
  if (!('lat' in coord) || !('lng' in coord)) return null;
  const { lat, lng } = coord;
  if (typeof lat !== 'function' || typeof lng !== 'function') return null;
  const latValue: unknown = lat.call(coord);
  const lngValue: unknown = lng.call(coord);
  if (typeof latValue !== 'number' || typeof lngValue !== 'number') return null;
  return { lng: lngValue, lat: latValue };
}

/** 지금 그릴 대상들로 칸을 맞춘다. 모자라면 만들고, 남으면 지도에서 뗀다. */
export function syncPolygons<F>(spec: PolygonPoolSpec<F>): void {
  const { map, naverMaps, slots, features, ringsOf, styleOf, zIndex, onClick } = spec;

  features.forEach((feature, index) => {
    const paths = ringsOf(feature).map((ring) =>
      ring.map(([lng, lat]) => new naverMaps.LatLng(lat, lng)),
    );
    const slot = slots[index];
    if (slot === undefined) {
      const created: PolygonSlot<F> = {
        polygon: new naverMaps.Polygon({
          map,
          paths,
          ...styleOf(feature),
          zIndex,
          clickable: true,
        }),
        feature,
        attached: true,
      };
      // 리스너는 인스턴스마다 한 번만 건다. 칸이 재사용되며 담긴 대상이 바뀌므로 생성 시점의
      // feature를 클로저에 가두면 클릭했을 때 옛 대상이 열린다 — 칸을 통해 지금 값을 읽는다.
      naverMaps.Event.addListener(created.polygon, 'click', (...args: unknown[]) => {
        if (created.feature !== null) onClick(created.feature, clickCoord(args));
      });
      slots.push(created);
      return;
    }
    slot.feature = feature;
    slot.polygon.setPaths(paths);
    slot.polygon.setOptions(styleOf(feature));
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
}

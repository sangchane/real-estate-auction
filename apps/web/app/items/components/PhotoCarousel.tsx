'use client';

// 물건 사진 — 패널 본문에서 좌우로 넘겨 보고, 누르면 화면 중앙에 크게 펼친다.
//
// 격자(2열 썸네일)였을 때는 한 장이 너무 작아 무엇을 찍은 사진인지 알아볼 수 없었다.
// 경매에서 사진은 "이 집이 어떤 상태인가"를 보는 거의 유일한 수단이라 크게 봐야 한다.
//
// PC 기준으로 만든다: 드래그(마우스 끌기)와 화살표 버튼을 둘 다 둔다. 터치 스와이프는
// 브라우저 기본 스크롤이 처리하므로 따로 구현하지 않는다 — 같은 동작을 두 번 만들면
// 두 경로가 갈라진다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { photoAlt, photoProxySrc, type AuctionItemPhoto } from '../photo';
import styles from './PhotoCarousel.module.css';

/** 이만큼 넘게 움직여야 "끌었다"로 본다 — 클릭할 때 손이 조금 떨리는 것까지 드래그로 보면 안 된다 */
const DRAG_THRESHOLD_PX = 6;

export function PhotoCarousel({ photos }: { photos: AuctionItemPhoto[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragHandlers = useDragToScroll(trackRef);

  if (photos.length === 0) {
    return <p className={styles.empty}>아직 사진을 받지 못했어요.</p>;
  }

  function scrollByPage(direction: 1 | -1) {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * track.clientWidth, behavior: 'smooth' });
  }

  return (
    <>
      <div className={styles.root}>
        <div className={styles.track} ref={trackRef} {...dragHandlers}>
          {photos.map((photo, index) => (
            <button
              type="button"
              className={styles.slide}
              key={photo.id}
              onClick={() => setLightboxIndex(index)}
              aria-label={`${photoAlt(photo)} 크게 보기`}
            >
              {/* next/image 대신 <img> — 상세 화면과 같은 프록시 경로를 그대로 쓴다 */}
              <img
                className={styles.image}
                src={photoProxySrc(photo.id)}
                alt={photoAlt(photo)}
                loading="lazy"
                draggable={false}
              />
            </button>
          ))}
        </div>

        {photos.length > 1 ? (
          <>
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowPrev}`}
              onClick={() => scrollByPage(-1)}
              aria-label="이전 사진"
            >
              ‹
            </button>
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowNext}`}
              onClick={() => scrollByPage(1)}
              aria-label="다음 사진"
            >
              ›
            </button>
          </>
        ) : null}
      </div>

      <p className={styles.hint}>사진 {photos.length}장 · 누르면 크게 볼 수 있어요</p>

      {lightboxIndex !== null ? (
        <Lightbox
          photos={photos}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </>
  );
}

/**
 * 마우스로 끌어서 넘기기. PC에는 스와이프가 없어 화살표만 두면 사진마다 클릭해야 한다.
 * 끌고 나서 발생하는 click은 막는다 — 안 막으면 넘길 때마다 라이트박스가 열린다.
 *
 * 드래그 상태를 ref에 둔다. 지역 변수로 두면 렌더마다 핸들러가 새로 만들어져 눌렀던
 * 위치(startX)가 0으로 되돌아가고, 그러면 **평범한 클릭도 드래그로 오인해 막아버린다.**
 *
 * 포인터 캡처는 **실제로 끌기 시작한 뒤에만** 건다. 누르자마자 걸면 이어지는 click이
 * 버튼이 아니라 트랙으로 전달돼서, 사진을 눌러도 크게 열리지 않는다.
 */
function useDragToScroll(ref: React.RefObject<HTMLDivElement | null>) {
  const drag = useRef({ startX: 0, startScroll: 0, moved: 0, dragging: false });

  return {
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      const track = ref.current;
      if (!track) return;
      drag.current = {
        startX: event.clientX,
        startScroll: track.scrollLeft,
        moved: 0,
        dragging: true,
      };
    },
    onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      const track = ref.current;
      if (!track || !drag.current.dragging) return;
      const delta = event.clientX - drag.current.startX;
      if (drag.current.moved <= DRAG_THRESHOLD_PX && Math.abs(delta) > DRAG_THRESHOLD_PX) {
        // 이제부터는 끌기다 — 포인터가 트랙 밖으로 나가도 계속 따라오게 캡처한다
        track.setPointerCapture(event.pointerId);
      }
      drag.current.moved = Math.abs(delta);
      track.scrollLeft = drag.current.startScroll - delta;
    },
    onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
      drag.current.dragging = false;
      if (ref.current?.hasPointerCapture(event.pointerId)) {
        ref.current.releasePointerCapture(event.pointerId);
      }
    },
    onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
      if (drag.current.moved > DRAG_THRESHOLD_PX) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

/** 화면 중앙에 크게 펼친다. 좌우 화살표와 키보드로 넘긴다. */
function Lightbox({
  photos,
  index,
  onIndexChange,
  onClose,
}: {
  photos: AuctionItemPhoto[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const move = useCallback(
    (direction: 1 | -1) => {
      // 끝에서 반대편으로 넘어간다 — 마지막 장에서 화살표가 죽어 있으면 멈춘 줄 안다
      onIndexChange((index + direction + photos.length) % photos.length);
    },
    [index, photos.length, onIndexChange],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') move(1);
      if (event.key === 'ArrowLeft') move(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, onClose]);

  const photo = photos[index];
  if (!photo) return null;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.stage} onClick={(event) => event.stopPropagation()}>
        <img className={styles.stageImage} src={photoProxySrc(photo.id)} alt={photoAlt(photo)} />
        <p className={styles.stageCaption}>
          {photoAlt(photo)} · {index + 1}/{photos.length}
        </p>
      </div>

      <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
        ✕
      </button>
      {photos.length > 1 ? (
        <>
          <button
            type="button"
            className={`${styles.stageArrow} ${styles.stageArrowPrev}`}
            onClick={(event) => {
              event.stopPropagation();
              move(-1);
            }}
            aria-label="이전 사진"
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.stageArrow} ${styles.stageArrowNext}`}
            onClick={(event) => {
              event.stopPropagation();
              move(1);
            }}
            aria-label="다음 사진"
          >
            ›
          </button>
        </>
      ) : null}
    </div>
  );
}

'use client';

// 등기부 열람 — **누를 때만 돈이 나가는 버튼**이라 확인 단계를 반드시 거친다.
//
// 열람 1건에 700원이 실제로 사용자 계정에서 빠진다 (D-008). 그래서 두 가지를 지킨다:
//   1) 상태 조회(GET)는 발급하지 않는다. 화면을 여러 번 열어도 무료다.
//   2) 발급 전에 "이 주소로 조회한다"를 보여주고 한 번 더 확인받는다. 주소 파싱이 틀리면
//      700원을 쓰고 남의 등기부를 받게 되므로, 사용자가 눈으로 볼 기회를 준다.
import { useState } from 'react';
import { fetchRegistryOnDemand } from '../registry-client';
import type { RegistryState } from '../registry';
import { REGISTERED_RIGHT_LABEL } from '../notice-labels';
import { formatWon } from '../format';
import type { ItemKey } from '../item-id';
import { Badge } from './Badge';
import styles from './RegistrySection.module.css';

type Phase = 'IDLE' | 'CONFIRMING' | 'FETCHING';

export function RegistrySection({
  itemKey,
  initial,
}: {
  itemKey: ItemKey;
  initial: RegistryState | null;
}) {
  const [state, setState] = useState<RegistryState | null>(initial);
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [error, setError] = useState<string | null>(null);

  if (!state) return null;

  async function confirmFetch() {
    setPhase('FETCHING');
    setError(null);
    try {
      setState(await fetchRegistryOnDemand(itemKey));
      setPhase('IDLE');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '등기부를 받지 못했어요.');
      setPhase('IDLE');
    }
  }

  return (
    <section className={styles.root}>
      <h3 className={styles.title}>등기부</h3>

      {state.status === 'FETCHED' && state.registeredRights ? (
        <RightsTable rights={state.registeredRights} fetchedAt={state.fetchedAt} />
      ) : null}

      {state.status === 'UNAVAILABLE' ? (
        <p className={styles.note}>{state.reason ?? '지금은 등기부를 받을 수 없어요.'}</p>
      ) : null}

      {state.status === 'NOT_FETCHED' ? (
        <div className={styles.fetchBlock}>
          <p className={styles.note}>
            등기부를 받으면 소멸되는 권리와 인수되는 권리를 구분할 수 있어요. 열람 수수료
            700원이 들어요.
          </p>

          {phase === 'CONFIRMING' ? (
            <div className={styles.confirm}>
              {/* 파싱한 주소를 그대로 보여준다 — 틀렸으면 여기서 멈출 수 있어야 한다 */}
              <p className={styles.confirmLabel}>이 주소로 조회해요</p>
              <p className={styles.confirmAddress}>{state.lookupPreview}</p>
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={confirmFetch}>
                  700원 쓰고 받기
                </button>
                <button type="button" className={styles.secondary} onClick={() => setPhase('IDLE')}>
                  안 받을래요
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={phase === 'FETCHING'}
              onClick={() => setPhase('CONFIRMING')}
            >
              {phase === 'FETCHING' ? '받는 중이에요…' : '등기부 불러오기'}
            </button>
          )}

          {error ? <p className={styles.error}>{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function RightsTable({
  rights,
  fetchedAt,
}: {
  rights: RegistryState['registeredRights'];
  fetchedAt: string | null;
}) {
  if (!rights || rights.length === 0) {
    return <p className={styles.note}>등기된 권리가 없어요.</p>;
  }

  return (
    <>
      <div className={styles.table}>
        {rights.map((right) => (
          <div className={styles.row} key={right.id}>
            <span className={styles.rowDate}>{right.receivedDate}</span>
            <div className={styles.rowMain}>
              <span className={styles.rowLabel}>
                {REGISTERED_RIGHT_LABEL[right.type] ?? right.type}
              </span>
              {right.amount !== undefined ? (
                <p className={styles.rowDetail}>{formatWon(right.amount)}</p>
              ) : null}
            </div>
            <Badge tone="muted">등기</Badge>
          </div>
        ))}
      </div>
      {/* 등기부는 시점 스냅샷이다 — 언제 받은 것인지 밝히지 않으면 최신으로 읽힌다 */}
      {fetchedAt ? (
        <p className={styles.note}>{fetchedAt.slice(0, 10)}에 받은 등기부예요.</p>
      ) : null}
    </>
  );
}

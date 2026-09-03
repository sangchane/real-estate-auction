import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colors } from './colors';

test('모든 색상 토큰은 유효한 hex 값이다', () => {
  for (const [name, value] of Object.entries(colors)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `${name} = ${value}`);
  }
});

test('mapZoneOutline은 새 색이 아니라 oculusPurple에 역할 이름만 붙인 별칭이다', () => {
  // 팔레트는 DESIGN-meta.md에서 전체 계승하고 치환하지 않는다(design-adaptation §4).
  // 값이 갈라지면 팔레트에 없는 색이 하나 늘어난 것이므로 여기서 막는다.
  assert.equal(colors.mapZoneOutline, colors.oculusPurple);
});

test('면 레이어 순차 램프는 명도가 단조 하강한다', () => {
  // 순차 램프는 색상이 아니라 **명도**로 순서를 말한다 — 단조가 깨지면 색각이상에서 순서가
  // 뒤집혀 읽히고(기획 12 §4.4), 값의 크기를 색으로 읽는다는 전제 자체가 무너진다.
  // 값을 손보는 사람이 여기서 걸리게 둔다.
  const ramp = [colors.mapSeq1, colors.mapSeq2, colors.mapSeq3, colors.mapSeq4, colors.mapSeq5];
  const luminance = ramp.map((hex) => {
    // 상대휘도(WCAG 정의)를 쓰면 명도 비교에 그대로 쓸 수 있다.
    const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
    const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  });
  for (let i = 1; i < luminance.length; i += 1) {
    assert.ok(
      (luminance[i] ?? 0) < (luminance[i - 1] ?? 0),
      `${i + 1}단이 ${i}단보다 밝다: ${ramp[i - 1]} → ${ramp[i]}`,
    );
  }
});

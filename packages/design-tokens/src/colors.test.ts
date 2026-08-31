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

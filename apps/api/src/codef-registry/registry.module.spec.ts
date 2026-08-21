import { buildRegistryConfig } from './registry.module';

// 다른 모듈이 요구하는 필수 환경변수 — 이 테스트의 관심사가 아니라 최소값만 채운다
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'x'.repeat(32),
  OAUTH_STATE_SECRET: 'x'.repeat(32),
  KAKAO_OAUTH_CLIENT_ID: 'k',
  KAKAO_OAUTH_CLIENT_SECRET: 'k',
  NAVER_OAUTH_CLIENT_ID: 'n',
  NAVER_OAUTH_CLIENT_SECRET: 'n',
};

const CREDENTIALS = {
  CODEF_CLIENT_ID: 'id',
  CODEF_CLIENT_SECRET: 'secret',
  CODEF_PUBLIC_KEY: 'key',
  IROS_PHONE_NO: '01012345678',
  IROS_EPREPAY_NO: '123456789012',
  IROS_EPREPAY_PASS: '12345678',
};

describe('buildRegistryConfig', () => {
  it('자격증명이 없어도 기동은 성공한다 — 등기부 없이도 API는 떠야 한다', () => {
    const config = buildRegistryConfig({ ...BASE } as NodeJS.ProcessEnv);

    expect(config.credentials).toBeNull();
  });

  it('자격증명이 하나라도 비면 전체를 쓰지 않는다 — 반쯤 채운 설정으로 호출하지 않는다', () => {
    const partial = { ...BASE, ...CREDENTIALS, IROS_EPREPAY_PASS: undefined };

    const config = buildRegistryConfig(partial as unknown as NodeJS.ProcessEnv);

    expect(config.credentials).toBeNull();
  });

  it('전부 채워지면 자격증명을 구성한다', () => {
    const config = buildRegistryConfig({ ...BASE, ...CREDENTIALS } as NodeJS.ProcessEnv);

    expect(config.credentials).toEqual({
      phoneNo: '01012345678',
      ePrepayNo: '123456789012',
      ePrepayPass: '12345678',
      publicKey: 'key',
    });
  });

  it('기본값은 데모다 — 설정을 잊었다고 700원이 나가면 안 된다', () => {
    const config = buildRegistryConfig({ ...BASE, ...CREDENTIALS } as NodeJS.ProcessEnv);

    expect(config.isDemo).toBe(true);
  });

  it('운영 엔드포인트를 가리키면 데모가 아니다 — 이때부터 1건에 700원이다', () => {
    const config = buildRegistryConfig({
      ...BASE,
      ...CREDENTIALS,
      CODEF_API_BASE: 'https://api.codef.io',
    } as NodeJS.ProcessEnv);

    expect(config.isDemo).toBe(false);
  });
});

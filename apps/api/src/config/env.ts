// 환경 변수 로딩·검증 — 외부 입력은 런타임 스키마로 검증하고 실패 시 기동을 중단한다 (AGENTS.md 규칙 21)
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .startsWith('postgresql://', { message: 'postgresql:// 형식이어야 합니다' }),
  // --- 인증 (WP-08 — 카카오·네이버 소셜 로그인, D-015) ---
  JWT_ACCESS_SECRET: z.string().min(32, 'HS256 서명 키는 최소 32자 이상이어야 합니다'),
  JWT_REFRESH_SECRET: z.string().min(32, 'HS256 서명 키는 최소 32자 이상이어야 합니다'),
  // OAuth state·모바일 교환 코드 서명 전용 (WP-08b §0-1 — JWT 시크릿과 분리, RFC 8725 §3.5)
  OAUTH_STATE_SECRET: z.string().min(32, 'HS256 서명 키는 최소 32자 이상이어야 합니다'),
  KAKAO_OAUTH_CLIENT_ID: z.string().min(1),
  KAKAO_OAUTH_CLIENT_SECRET: z.string().min(1),
  NAVER_OAUTH_CLIENT_ID: z.string().min(1),
  NAVER_OAUTH_CLIENT_SECRET: z.string().min(1),
  AUTH_WEB_ORIGIN: z.string().url({ message: 'URL 형식이어야 합니다' }).default('http://localhost:3000'),
  // --- 푸시 알림 (WP-09 §0-2) ---
  // API 서버는 발송하지 않으므로 선택값이다. 발송 CLI(notify)가 없으면 명시적으로 중단한다.
  FCM_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),
  // --- 등기부 열람 (WP-04 — CODEF 중계, D-008) ---
  // **전부 선택값이다.** 등기부 없이도 API는 정상 기동해야 한다 — 명세서 기반 권리분석은
  // 등기부와 무관하게 동작하고, 자격증명이 없으면 열람 엔드포인트만 명시적으로 거절한다.
  // 열람 1건에 700원이 나가므로 기본값은 데모(무료) 엔드포인트다.
  CODEF_API_BASE: z.string().url().default('https://development.codef.io'),
  CODEF_OAUTH_BASE: z.string().url().default('https://oauth.codef.io'),
  CODEF_CLIENT_ID: z.string().min(1).optional(),
  CODEF_CLIENT_SECRET: z.string().min(1).optional(),
  CODEF_PUBLIC_KEY: z.string().min(1).optional(),
  IROS_PHONE_NO: z.string().min(1).optional(),
  IROS_EPREPAY_NO: z.string().min(1).optional(),
  IROS_EPREPAY_PASS: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`환경 변수 검증 실패 — 기동을 중단합니다: ${detail}`);
  }
  return result.data;
}

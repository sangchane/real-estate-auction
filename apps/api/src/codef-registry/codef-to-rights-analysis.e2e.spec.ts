// WP-04 완료 기준 "등기부 1건 → WP-03 입력 DTO 변환 E2E" — CODEF 토큰 발급부터 등기부 조회, 매핑,
// 권리분석 서비스 입력까지 전체 파이프라인을 검증한다.
//
// 등기부 응답은 2026-07-08 실제 데모 API 실호출로 캡처한 fixture다(서울중앙지방법원 중부등기소,
// 강제경매 사건 — WP-02가 수집한 실제 경매물건 주소로 조회) — 소유자명·채권자명·주민등록번호는
// 익명화했고 구조·등기 내역은 실제 그대로다. CODEF의 실제 응답 인코딩(전체 form-urlencoded,
// text/plain)도 그대로 재현해 percent-decoding 경로까지 함께 검증한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodefTokenClient } from './auth/codef-token.client';
import { RegistryRequestCache } from './cache/registry-request-cache';
import { CodefRegistryClient } from './client/codef-registry.client';
import { mapRegistryResponseToRegisteredRights } from './mapper/registry-response.mapper';
import { CodefRegistryService } from './service/codef-registry.service';
import { RightsAnalysisService } from '../rights-analysis/service/rights-analysis.service';

const FIXTURE_PATH = join(__dirname, '..', '..', 'test', 'fixtures', 'codef-registry-real-response.json');
const REGISTRY_RESPONSE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** CODEF 실제 응답 형식 재현 — 본문 전체가 application/x-www-form-urlencoded로 인코딩돼 있다 */
function formEncodedResponse(body: unknown): Response {
  const encoded = encodeURIComponent(JSON.stringify(body)).replace(/%20/g, '+');
  return new Response(encoded, { status: 200, headers: { 'Content-Type': 'text/plain;charset=ISO-8859-1' } });
}

describe('CODEF 등기부 조회 → WP-03 권리분석 E2E', () => {
  it('토큰 발급부터 매핑, 권리분석까지 전체 파이프라인이 실제 캡처 응답으로 동작한다', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'token-1', token_type: 'bearer', expires_in: 3600, scope: 'read' }),
      )
      .mockResolvedValueOnce(formEncodedResponse(REGISTRY_RESPONSE));

    const tokenClient = new CodefTokenClient(
      { oauthBaseUrl: 'https://oauth.codef.io', clientId: 'id', clientSecret: 'secret' },
      fetchFn as unknown as typeof fetch,
    );
    const registryClient = new CodefRegistryClient(
      { apiBaseUrl: 'https://development.codef.io' },
      tokenClient,
      fetchFn as unknown as typeof fetch,
    );
    const registryService = new CodefRegistryService(
      new RegistryRequestCache(),
      registryClient,
      mapRegistryResponseToRegisteredRights,
      // 보관본은 이 시나리오의 관심사가 아니다 — 매번 새로 발급하는 경로를 확인한다
      { find: async () => null, save: async () => 1 },
    );

    const { registeredRights } = await registryService.getRegisteredRights('req-1', {
      item: { courtOfficeCode: 'B000210', caseNo: '2023타경4722', itemNo: '1' },
      request: { organization: '0002' },
    });

    expect(registeredRights).toEqual([
      { id: '3', type: 'PROVISIONAL_SEIZURE', receivedDate: '2022-10-18', amount: 393_374_335 },
      { id: '4', type: 'PROVISIONAL_SEIZURE', receivedDate: '2023-05-23', amount: 726_313_737 },
      { id: '5', type: 'PROVISIONAL_SEIZURE', receivedDate: '2023-07-28', amount: 425_906_717 },
      { id: '6', type: 'AUCTION_COMMENCEMENT', receivedDate: '2023-09-21' },
    ]);

    const rightsAnalysisService = new RightsAnalysisService();
    const analysis = rightsAnalysisService.analyze({
      registeredRights,
      tenants: [],
      region: 'SEOUL',
      distributionDemandDeadline: '2023-12-01',
    });

    // 접수일 최선순위(2022-10-18)인 첫 가압류가 말소기준권리가 되고, 담보물권·압류 계열은 항상 말소된다
    expect(analysis.baselineRight.rightId).toBe('3');
    expect(analysis.registeredRightClassifications).toEqual([
      { rightId: '3', status: 'EXTINGUISHED', ruleId: 'RIGHT_CLASSIFICATION', ruleVersion: 1 },
      { rightId: '4', status: 'EXTINGUISHED', ruleId: 'RIGHT_CLASSIFICATION', ruleVersion: 1 },
      { rightId: '5', status: 'EXTINGUISHED', ruleId: 'RIGHT_CLASSIFICATION', ruleVersion: 1 },
      { rightId: '6', status: 'EXTINGUISHED', ruleId: 'RIGHT_CLASSIFICATION', ruleVersion: 1 },
    ]);
  });
});

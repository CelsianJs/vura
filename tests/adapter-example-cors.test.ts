import { expect, it } from 'vitest';
import { hasConfiguredCorsOrigins } from '../examples/adapter-test/cors-template.mjs';

const expected = ['https://example.com'];
const template = (origin: string) => `  ThenHttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      CorsConfiguration:
        AllowOrigins:
          - "${origin}"
        AllowMethods:
          - "GET"
`;

it('requires exact configured CORS origins rather than URL substrings', () => {
  expect(hasConfiguredCorsOrigins(template(expected[0]), expected)).toBe(true);
  for (const origin of ['https://example.com.evil', 'https://evil.test/?next=https://example.com', '*']) {
    expect(hasConfiguredCorsOrigins(template(origin), expected), origin).toBe(false);
  }
  expect(hasConfiguredCorsOrigins('Description: https://example.com\n', expected)).toBe(false);
  expect(hasConfiguredCorsOrigins(template(expected[0]) + template(expected[0]), expected)).toBe(false);
  expect(hasConfiguredCorsOrigins(template(expected[0]).replace('"https://example.com"', 'https://example.com'), expected)).toBe(false);
  expect(hasConfiguredCorsOrigins(template(expected[0]), [])).toBe(false);
  expect(hasConfiguredCorsOrigins(template(expected[0]), ['https://example.com', 'https://extra.test'])).toBe(false);
});

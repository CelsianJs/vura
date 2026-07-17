import type { ThenRequest } from '@celsian/vura-core';

export type ProbeRuntimeIntent = 'function' | 'hot' | 'portable';

export interface ProbePayload {
  ok: boolean;
  handlerVersion: 1;
  runtimeIntent: ProbeRuntimeIntent;
  route: string;
  method: string;
  correlationId: string;
  bootId: string;
  bootAgeMs: number;
  requestOrdinal: number;
  startedAt: string;
  completedAt: string;
  handlerMs: number;
}

const startedAtMs = Date.now();
const bootId = createId();
let requestOrdinal = 0;

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function handleProbe(req: ThenRequest, runtimeIntent: ProbeRuntimeIntent): Response {
  const handlerStartedAt = Date.now();
  const url = new URL(req.url);
  const correlationId = req.headers.get('x-lab-correlation-id') || createId();
  const shouldFail = url.searchParams.get('fail') === '1';
  requestOrdinal += 1;

  const payload: ProbePayload = {
    ok: !shouldFail,
    handlerVersion: 1,
    runtimeIntent,
    route: url.pathname,
    method: req.method,
    correlationId,
    bootId,
    bootAgeMs: Date.now() - startedAtMs,
    requestOrdinal,
    startedAt: new Date(handlerStartedAt).toISOString(),
    completedAt: new Date().toISOString(),
    handlerMs: Date.now() - handlerStartedAt,
  };

  const event = {
    event: 'vura_runtime_lab_probe',
    level: shouldFail ? 'error' : 'info',
    message: shouldFail ? 'intentional dogfood failure' : 'probe completed',
    ...payload,
  };

  if (shouldFail) console.error(JSON.stringify(event));
  else console.log(JSON.stringify(event));

  return new Response(JSON.stringify(payload), {
    status: shouldFail ? 503 : 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'server-timing': `handler;dur=${payload.handlerMs}`,
      'x-lab-correlation-id': correlationId,
      'x-lab-handler-version': '1',
    },
  });
}

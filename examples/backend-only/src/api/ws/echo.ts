/**
 * WebSocket echo endpoint — runs on the hot server.
 * GET /api/ws/echo — describes the WebSocket echo capability.
 *
 * In production, the hot server would upgrade this connection to a
 * WebSocket and echo back any messages received. This route serves
 * as a discovery/info endpoint over HTTP.
 */
export const route = { kind: 'hot' };

export function GET(req: any, reply: any) {
  return reply.json({
    endpoint: '/api/ws/echo',
    protocol: 'websocket',
    description: 'WebSocket echo server. Connect via ws:// and send messages to receive them back.',
    supportedEvents: ['message', 'ping', 'close'],
    example: {
      connect: 'ws://localhost:3000/api/ws/echo',
      send: '{"type": "message", "data": "hello"}',
      receive: '{"type": "echo", "data": "hello", "timestamp": 1234567890}',
    },
  });
}

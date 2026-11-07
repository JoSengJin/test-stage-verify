// 로컬 대역 Stage 백엔드. 실제 배포된 Stage 서버가 없을 때 연계 흐름을 확인하기 위한 것이다.
// 인증(Bearer), 멱등성 키, 후속 조회를 지원한다. 상태는 프로세스 메모리에만 있다.
import http from 'node:http';

const port = Number(process.env.STAGE_SERVER_PORT ?? 4500);
const token = process.env.ORDER_API_TOKEN;
if (!token) {
  console.error('ORDER_API_TOKEN 환경 변수가 필요합니다 (.env.stage 참고).');
  process.exit(1);
}

const orders = new Map();
const byIdempotencyKey = new Map();
let seq = 1000;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'unauthorized' });
  const delay = Number(process.env.STAGE_SERVER_DELAY_MS ?? 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));

  if (req.method === 'POST' && url.pathname === '/orders') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { message: 'invalid json' }); }
    if (typeof body.sku !== 'string' || !Number.isInteger(body.quantity)) return send(res, 422, { message: 'invalid order' });
    if (body.sku.startsWith('OUT-')) return send(res, 409, { message: 'out of stock' });
    const key = req.headers['idempotency-key'];
    if (key && byIdempotencyKey.has(key)) return send(res, 200, orders.get(byIdempotencyKey.get(key)));
    const order = { id: `ord-${++seq}`, sku: body.sku, quantity: body.quantity, status: 'created' };
    orders.set(order.id, order);
    if (key) byIdempotencyKey.set(key, order.id);
    return send(res, 201, order);
  }
  const m = /^\/orders\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && m) {
    const order = orders.get(decodeURIComponent(m[1]));
    return order ? send(res, 200, order) : send(res, 404, { message: 'not found' });
  }
  send(res, 404, { message: 'no route' });
});

server.listen(port, '127.0.0.1', () => console.log(`order stage stand-in listening on http://127.0.0.1:${server.address().port}`));

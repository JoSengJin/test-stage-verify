import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ScenarioNetwork } from './scenario-adapters.ts';

interface Target {
  runId: string;
  server: http.Server;
  streams: Set<http.ServerResponse>;
  requests: { method: string; path: string; body: string }[];
  events: string[];
  timer?: NodeJS.Timeout;
}

/** Actual loopback HTTP/SSE services, configured from the parsed scenario's test data. */
export class ScenarioTargets {
  private targets = new Map<string, Target>();

  async create(runId: string, scenario: ScenarioNetwork, origin: string) {
    if (scenario.kind === 'http' && !scenario.failure && scenario.response === undefined) throw new Error('테스트에서 서버 응답 데이터를 읽지 못했습니다. 실제 서버 주소를 지정하세요.');
    const id = randomUUID();
    const target: Target = { runId, server: http.createServer(), streams: new Set(), requests: [], events: [] };
    target.server.on('request', async (req, res) => {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || 'content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      let body = '';
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000_000) { res.writeHead(413); res.end(); return; }
        }
      } catch { res.destroy(); return; }
      target.requests.push({ method: req.method || 'GET', path: req.url || '/', body });
      if (scenario.kind === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        target.streams.add(res);
        res.on('close', () => target.streams.delete(res));
      } else if (scenario.failure) req.socket.destroy();
      else {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        if ((scenario.method && req.method !== scenario.method) || (scenario.path && path !== scenario.path)) { res.writeHead(404); res.end('시나리오에 없는 요청'); return; }
        res.setHeader('content-type', 'application/json');
        const response = (scenario.envelope || []).reduceRight((body, key) => ({ [key]: body }), scenario.response);
        res.end(JSON.stringify(response));
      }
    });
    await new Promise<void>((resolve, reject) => { target.server.once('error', reject); target.server.listen(0, '127.0.0.1', resolve); });
    this.targets.set(id, target);
    target.timer = setTimeout(() => this.close(runId, id), 60_000);
    target.timer.unref();
    const port = (target.server.address() as { port: number }).port;
    return { id, url: `http://127.0.0.1:${port}${scenario.kind === 'sse' ? '/stream' : ''}` };
  }

  emit(runId: string, id: string, data: string) {
    const target = this.targets.get(id);
    if (!target || target.runId !== runId || !target.streams.size) throw new Error('연결된 실제 SSE 수신자가 없습니다.');
    const frame = data.split(/\r?\n/).map(line => `data: ${line}`).join('\n') + '\n\n';
    for (const stream of target.streams) stream.write(frame);
    target.events.push(data);
  }

  close(runId: string, id: string) {
    const target = this.targets.get(id);
    if (!target || target.runId !== runId) throw new Error('실제 검증 서버 세션이 없습니다.');
    clearTimeout(target.timer);
    for (const stream of target.streams) stream.end();
    target.server.close(); target.server.closeAllConnections(); this.targets.delete(id);
    return { requests: target.requests, events: target.events };
  }

  dispose() { for (const [id, target] of this.targets) this.close(target.runId, id); }
}

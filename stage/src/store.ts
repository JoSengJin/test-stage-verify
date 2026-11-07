// 결과 저장: 파일 시스템 JSON(기본 API만 사용). 실행 상태의 원본은 서버이며 브라우저는 표시용 사본만 가진다.
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult } from './model.ts';
import type { Run } from './exec/runs.ts';
import { defaultProfileDoc, normalizeProfileDoc, type ProfileDoc } from './profiles.ts';

export class Store {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
    for (const d of ['runs', 'analyses', 'drops']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  private write(file: string, data: unknown) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  private readAll<T>(sub: string): T[] {
    const d = path.join(this.dir, sub);
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try { return [JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as T]; } catch { return []; }
    });
  }
  saveRun(run: Run) { this.write(path.join(this.dir, 'runs', `${run.id}.json`), run); }
  loadRuns(): Run[] { return this.readAll<Run>('runs').sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  saveAnalysis(a: AnalysisResult) { this.write(path.join(this.dir, 'analyses', `${a.id}.json`), a); }
  loadAnalyses(): AnalysisResult[] { return this.readAll<AnalysisResult>('analyses'); }
  loadProjects(): string[] {
    try { const v = JSON.parse(fs.readFileSync(path.join(this.dir, 'projects.json'), 'utf8')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
  }
  saveProjects(list: string[]) { this.write(path.join(this.dir, 'projects.json'), list); }
  /** 프로젝트(절대 경로)별 연결 프로필. 비밀 값은 담지 않는다(환경변수 이름만). */
  loadProfileDoc(root: string): ProfileDoc {
    try {
      const all = JSON.parse(fs.readFileSync(path.join(this.dir, 'profiles.json'), 'utf8'));
      return normalizeProfileDoc(all?.[root]);
    } catch { return defaultProfileDoc(); }
  }
  saveProfileDoc(root: string, doc: ProfileDoc) {
    const file = path.join(this.dir, 'profiles.json');
    let all: Record<string, ProfileDoc> = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* 새 파일 */ }
    all[root] = doc;
    this.write(file, all);
  }
  runDir(id: string) { const d = path.join(this.dir, 'runs', id); fs.mkdirSync(d, { recursive: true }); return d; }
  dropFile(sha: string, name: string) {
    const d = path.join(this.dir, 'drops', sha.slice(0, 16));
    fs.mkdirSync(d, { recursive: true });
    return path.join(d, path.basename(name));
  }
}

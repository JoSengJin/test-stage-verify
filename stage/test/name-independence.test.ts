import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectedScenarios } from '../src/exec/connected-scenarios.ts';
import { responseEnvelope } from '../src/exec/scenario-adapters.ts';
import { executeConnectedScenario } from '../src/exec/scenario-runtime.js';
import { collaboratorChoices } from '../src/exec/connected-console.js';
import { usesMock } from '../src/exec/real-env.ts';
import { wireModuleContracts } from '../src/exec/module-contracts.ts';
import { generateHookSource, isPlayable } from '../src/playground/source.ts';
import type { WiringCall } from '../src/model.ts';

it('응답 경로는 파서·변수·파일 이름과 무관하게 JSON.parse 반환 경로에서 읽는다', () => {
  const source = `function unrelated(settings) { return settings.wrong.path; }
const renamed = (raw, keep) => { const unpacked = JSON.parse(raw); const alias = unpacked; return keep ? alias : alias.payload.content; };`;
  assert.deepEqual(responseEnvelope(source, 'anything-renamed.js')?.path, ['payload', 'content']);
  assert.deepEqual(responseEnvelope(`const arbitrary = text => JSON.parse(text)['data']['result'];`, 'another-file.js')?.path, ['data', 'result']);
  assert.equal(responseEnvelope(`function f(s){const p=JSON.parse(s);return flag?p.a:p.b;}`, 'ambiguous.js'), undefined);
  assert.equal(responseEnvelope(`function f(s){const p=JSON.parse(s);return {wrap:p.a};}`, 'wrapped.js'), undefined);
  assert.equal(responseEnvelope(`function f(s){const p=JSON.parse(s);return p.a[dynamic].b;}`, 'dynamic.js'), undefined);
});

it('이름을 바꾸고 재export한 Hook과 test·mock·assert 별칭을 실제 import로 판별한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamed-hook-'));
  try {
    fs.writeFileSync(path.join(root, 'implementation.js'), `import {useEffect as commit,useRef as cell} from 'react'; export const paint = props => { const ref=cell(); commit(()=>{ref.current=props.route;},[props.route]); }; export function usePretend(input){return input;}`);
    fs.writeFileSync(path.join(root, 'entry.js'), `export {paint as screen, usePretend} from './implementation.js';`);
    const file = path.join(root, 'arbitrary.test.mjs');
    fs.writeFileSync(file, `import {test as example,mock as doubles} from 'node:test';import verify from 'node:assert/strict';import {screen as display,usePretend} from './entry.js';
const prepare = () => ({useEffect:doubles.fn(),useRef:doubles.fn()});
example('렌더',()=>{const runtime=prepare();usePretend({x:1});display({route:'/a'});display({route:'/b'});verify.equal(runtime.useEffect.mock.callCount(),2);});`);
    const definition = connectedScenarios(file, root);
    assert.equal(definition.scenarios.length, 1);
    assert.equal(usesMock(file), true);
    const code = definition.scenarios[0].code;
    assert.match(code, /const verify = assert;/);
    assert.match(code, /mountHook\(props => display\(props\)/);
    assert.match(code, /__hook.rerender\(\{route:'\/b'\}\)/);
    assert.match(code, /usePretend\(\{x:1\}\)/);
    assert.doesNotMatch(code, /mountHook\(props => usePretend|doubles\.fn/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('스키마 생성 함수와 설정 속성 이름은 실제 export·선언 타입에서 읽는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamed-schema-'));
  try {
    fs.writeFileSync(path.join(root, 'rules.js'), `import {z as v} from 'zod';
export const numeric = options => v.coerce.number(options);
export function aggregate(entries) { return v.object({}); }
export function interpret(validator,data,fallback){const result=validator.safeParse(data);return result.success?result.data:fallback;}
export function complex() { return v.object({quantity:v.number()}); }
export function notASchema(data) { v.number(); return true; }`);
    fs.writeFileSync(path.join(root, 'rules.d.ts'), `import type {ZodType as Rule,ZodObject} from 'zod';
type Kind = 'number' | 'text'; interface Entry { key:string; rule:Kind; }
export declare const numeric:(options?:{})=>Rule<number>;
export declare function aggregate(entries:readonly Entry[]):ZodObject<any>;
export declare function interpret(validator:Rule<any>,data:unknown,fallback:unknown):unknown;
export declare function complex():Rule<{quantity:number}>;
export declare function notASchema(data:unknown):boolean;`);
    fs.writeFileSync(path.join(root, 'renamed-entry.js'), `export {numeric as quantity, aggregate as recordRules, interpret as decode, complex, notASchema} from './rules.js';`);
    const file = path.join(root, 'case.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test';import {decode as convert} from './renamed-entry.js';test('schema',()=>{const schema={safeParse:mock.fn()};const result=convert(schema,{id:1},99);assert.equal(result,0);});`);
    const scenario = connectedScenarios(file, root).scenarios[0];
    assert.equal(scenario.presentation.parsing?.functionName, 'convert');
    assert.deepEqual(scenario.factories.map(factory => factory.name), ['quantity', 'recordRules', 'complex']);
    assert.equal(scenario.factories.find(factory => factory.name === 'complex')?.schema?.kind, 'object');
    const choices = collaboratorChoices({}, scenario, 'schema');
    const numeric = choices.find(choice => choice.label.includes('quantity'));
    const fields = choices.find(choice => choice.label.includes('recordRules'));
    assert.equal(numeric.expression, 'modules[0]["quantity"]()');
    assert.deepEqual(fields.fieldContract, { nameKey: 'key', typeKey: 'rule', types: ['number', 'text'] });
    assert.deepEqual(fields.fields, [{ name: 'id', type: 'number' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('여러 URL 중 실제 호출에 쓰인 주소를 선택하고 관련 없는 상수를 유지한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-binding-'));
  try {
    const file = path.join(root, 'case.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test';import {Remote} from './client.js';const UNUSED='https://wrong.test';const TARGET='https://right.test';
test('HTTP',async()=>{const client=new Remote(TARGET);const observation=mock.method(client.channel,'request',async()=>({status:200,data:{ok:true}}));await client.get('/items');assert.equal(observation.mock.callCount(),1);});`);
    const scenario = connectedScenarios(file, root).scenarios[0];
    assert.equal(scenario.network?.valueKey, 'TARGET');
    assert.deepEqual(scenario.values, { TARGET: '' });
    assert.match(scenario.code, /const UNUSED='https:\/\/wrong.test'/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('기대값 변수 이름과 선언 순서에 관계없이 실제 난수와 비교한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamed-expected-'));
  try {
    const file = path.join(root, 'case.mjs');
    fs.writeFileSync(file, `import {test as example,mock as doubles} from 'node:test';import verify from 'node:assert/strict';import {readValue} from './subject.js';
example('random',()=>{const wanted='v-'+0.5;const delegate=doubles.method(Math,'random',()=>0.5);const result=readValue();verify.equal(result,wanted);verify.equal(delegate.mock.callCount(),1);});`);
    const definition = connectedScenarios(file, root);
    const scenario = definition.scenarios[0];
    assert.match(scenario.code, /const wanted='v-'\+0.5/);
    const result = await executeConnectedScenario({ code: scenario.code, connections: { Math: 'Math' }, values: {}, seed: {} }, [{ readValue: () => 'v-' + Math.random() }], definition.symbols);
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.checks[0].actual, result.checks[0].expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('가상 화면의 SDK 패키지와 클라이언트 생성기도 프로젝트 공개 export에서 선택한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamed-sdk-'));
  try {
    const client = path.join(root, 'transport.js');
    fs.writeFileSync(client, `export function buildGateway(options={}) { return {get(){},post(){}}; }`);
    fs.writeFileSync(client.replace('.js', '.d.ts'), `interface Port {get(path:string):Promise<unknown>;post(path:string,data:unknown):Promise<unknown>;}interface Settings {baseUrl?:string;defaultHeaders?:Record<string,string>;}export declare function buildGateway(options?:Settings):Port;`);
    const hook = path.join(root, 'screen.js');
    fs.writeFileSync(hook, `import {useEffect as commit} from 'react'; export function display(path,options) {commit(()=>{},[path]);return {};}`);
    const call: WiringCall = { id: 'call', sut: 'display', specifier: '@custom/kit/hooks', options: [], collaborators: [], loc: { file: 'test', line: 1, column: 1 } };
    wireModuleContracts({ root, publicEntries: [{ subpath: './transport', specifier: '@custom/kit', distFile: client, evidence: 'fixture' }, { subpath: './hooks', specifier: '@custom/kit/hooks', distFile: hook, evidence: 'fixture' }] }, path.join(root, 'test.mjs'), [call]);
    assert.equal(isPlayable(call), true);
    assert.deepEqual(call.clientFactory, { specifier: '@custom/kit', exportName: 'buildGateway' });
    const source = generateHookSource({ call, testTitle: 'custom SDK', sessionId: 'session' });
    assert.match(source, /import \{ buildGateway as createStageClient \} from "@custom\/kit"/);
    assert.doesNotMatch(source, /base-framework|createApiClient/);
    assert.throws(() => generateHookSource({ call: { ...call, clientFactory: undefined }, testTitle: 'unknown', sessionId: 'session' }), /생성기/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('와일드카드 공개 경로도 패키지 이름과 디렉터리에 관계없이 연결한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-sdk-'));
  try {
    fs.mkdirSync(path.join(root, 'files/transport/hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@custom/kit', exports: { './*': { default: './files/*/entry.js' } } }));
    fs.writeFileSync(path.join(root, 'files/transport/entry.js'), 'export function gateway(options={}) {return {get(){},post(){}};}');
    fs.writeFileSync(path.join(root, 'files/transport/entry.d.ts'), 'interface Port {get(path:string):Promise<unknown>;post(path:string,data:unknown):Promise<unknown>;}interface Settings {baseUrl?:string;defaultHeaders?:Record<string,string>;}export declare function gateway(options?:Settings):Port;');
    fs.writeFileSync(path.join(root, 'files/transport/hooks/entry.js'), "import {useEffect} from 'react';export function display(){useEffect(()=>{},[]);}");
    const call: WiringCall = { id: 'call', sut: 'display', specifier: '@custom/kit/transport/hooks', options: [], collaborators: [], loc: { file: 'test', line: 1, column: 1 } };
    wireModuleContracts({ root, name: '@custom/kit', publicEntries: [] }, path.join(root, 'test.mjs'), [call]);
    assert.equal(call.hook, true);
    assert.deepEqual(call.clientFactory, { specifier: '@custom/kit/transport', exportName: 'gateway' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  createEvaluator, createOperatorRegistry, defaultOperatorRegistry, evaluate,
  OperationValidationError, prepareOperationGraph, prepareScene, validateBundle,
  validateOperationGraph,
} from '../src/index.ts';
import type {
  Bundle, Diagnostic, InputRef, Operation, OperationGraph, OperatorDefinition,
  SocketType, SourceSpan, SpaceRef,
} from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/operations/sample-curve.json', import.meta.url), 'utf8'));
const scene: SpaceRef = {kind: 'scene'};
const local = (node: string): SpaceRef => ({kind: 'local', node});
const span: SourceSpan = {file: 'lesson.tex', start: {line: 4, column: 2}, end: {line: 5, column: 8}};
const copy = <T>(value: T): T => structuredClone(value);
const bundle = (): Bundle => copy(fixture);
const graph = (): OperationGraph => copy(fixture.operationGraph);
const output = (operation: string, socket = 'position'): InputRef => ({kind: 'output', ref: {operation, socket}});
const scalar = (value: number): InputRef => ({kind: 'literal', value: {type: 'scalar', value}});
function invalid(value: unknown, b = bundle(), pattern?: RegExp): Diagnostic[] {
  const diagnostics = validateOperationGraph(value, b);
  assert.ok(diagnostics.some(d => d.severity === 'error'), 'invalid graph must produce an error');
  for (const diagnostic of diagnostics) {
    assert.ok(diagnostic.code.length > 0);
    assert.ok(diagnostic.message.length > 0);
    assert.ok(diagnostic.path, 'diagnostics identify the invalid field');
  }
  if (pattern) assert.ok(diagnostics.some(d => pattern.test(`${d.code} ${d.message} ${d.path}`)), JSON.stringify(diagnostics));
  assert.throws(() => prepareOperationGraph(value, b), OperationValidationError);
  return diagnostics;
}
function metadata(name: string, outputType: SocketType, spaces: string[] = []): OperatorDefinition {
  return {name, version: 1, spaces, inputs: {}, outputs: {value: outputType}, pure: true, deterministic: true};
}
function emitGraph(definition: OperatorDefinition, spaces: Record<string, SpaceRef>, target: string, property: string): OperationGraph {
  return {version: 1, operations: [{id: 'emit', operator: definition.name, version: 1, spaces, inputs: {}}],
    bindings: [{target, property, value: {operation: 'emit', socket: 'value'}}]};
}

test('portable fixture shares sampled position and tangent with dependency-first preparation', () => {
  const b = bundle(), original = copy(b);
  assert.deepEqual(validateBundle(b), []);
  assert.deepEqual(validateOperationGraph(b.operationGraph, b), []);
  const prepared = prepareOperationGraph(b.operationGraph, b);
  assert.equal(prepared.contract, 'texloom-operations/1');
  assert.deepEqual(prepared.order, ['sample', 'tip']);
  assert.deepEqual(b, original);
  assert.equal(prepared.graph.bindings.length, 3);
});

test('default inputs are resolved into a frozen snapshot without changing authored input', () => {
  const g = graph(), before = copy(g);
  delete g.operations[0].inputs.distance;
  delete before.operations[0].inputs.distance;
  delete g.operations[1].inputs.parameter;
  delete before.operations[1].inputs.parameter;
  const prepared = prepareOperationGraph(g, bundle());
  const sample = prepared.graph.operations.find(op => op.id === 'sample')!;
  const tip = prepared.graph.operations.find(op => op.id === 'tip')!;
  assert.deepEqual(sample.inputs.tolerance, scalar(0.25));
  assert.deepEqual(sample.inputs.parameter, scalar(0));
  assert.deepEqual(tip.inputs.distance, scalar(1));
  assert.deepEqual(g, before);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.graph.operations));
  assert.ok(Object.isFrozen(sample.inputs.curve));
  assert.ok(Object.isFrozen(prepared.definitions[0].outputs));
  g.operations[1].id = 'changed';
  assert.equal(sample.id, 'sample');
  assert.throws(() => { (sample.inputs as any).tolerance = scalar(9); }, TypeError);
});

test('independent operations use lexical IDs regardless of authored array order', () => {
  const g = graph();
  g.bindings = [];
  const sample = copy(g.operations[1]);
  g.operations = [{...copy(sample), id: 'z'}, {...copy(sample), id: 'a'}, {...copy(sample), id: 'm'}];
  assert.deepEqual(prepareOperationGraph(g, bundle()).order, ['a', 'm', 'z']);
  g.operations.reverse();
  assert.deepEqual(prepareOperationGraph(g, bundle()).order, ['a', 'm', 'z']);
});

test('the default registry is immutable and caller definitions cannot mutate a registry', () => {
  const definition = metadata('constant', {type: 'scalar'});
  const registry = createOperatorRegistry([definition]);
  definition.outputs.value = {type: 'vec2', role: 'point', space: 'missing'};
  assert.deepEqual(registry.get('constant', 1)?.outputs.value, {type: 'scalar'});
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.list()));
  assert.ok(Object.isFrozen(registry.get('constant', 1)?.outputs.value));
  assert.equal(registry.get('constant', 2), undefined);
  assert.equal(defaultOperatorRegistry.get('sampleCurve', 1)?.pure, true);
  assert.equal(defaultOperatorRegistry.get('sampleCurve', 1)?.deterministic, true);
});

test('registry rejects duplicate versions, invalid socket contracts and executable metadata', () => {
  const definition = metadata('constant', {type: 'scalar'});
  for (const definitions of [
    [definition, copy(definition)],
    [{...definition, version: 0}],
    [{...definition, outputs: {}}],
    [{...definition, outputs: {value: {type: 'vec2', role: 'point', space: 'missing'}}}],
    [{...definition, inputs: {value: {value: {type: 'scalar'}, required: true, default: {type: 'scalar', value: 0}}}}],
    [{...definition, execute: () => 0}],
  ]) assert.throws(() => createOperatorRegistry(definitions as any), OperationValidationError);
});

test('graph and operator version are exact contracts with no silent fallback', () => {
  invalid({...graph(), version: 2}, bundle(), /version/i);
  const g = graph(); g.operations[1].version = 2;
  invalid(g, bundle(), /version|operator/i);
  g.operations[1].version = 1; g.operations[1].operator = 'unknownOperator';
  invalid(g, bundle(), /operator/i);
});

test('duplicate IDs, absent upstream operations and absent output sockets are rejected', () => {
  const duplicates = graph(); duplicates.operations.push(copy(duplicates.operations[1]));
  invalid(duplicates, bundle(), /duplicate/i);
  const absent = graph(); absent.operations[0].inputs.origin = output('absent');
  invalid(absent, bundle(), /absent|reference/i);
  const socket = graph(); socket.operations[0].inputs.origin = output('sample', 'absent');
  invalid(socket, bundle(), /socket|absent/i);
});

test('cycles are rejected even when every socket is individually well typed', () => {
  const g = graph();
  const first = g.operations[0];
  first.inputs.origin = output('other');
  const second: Operation = {...copy(first), id: 'other', inputs: {...copy(first.inputs), origin: output('tip')}};
  g.operations.push(second);
  invalid(g, bundle(), /cycle|cyclic/i);
  const self = graph(); self.operations[0].inputs.origin = output('tip');
  invalid(self, bundle(), /cycle|cyclic/i);
});

test('required inputs and unexpected inputs are diagnosed independently', () => {
  const missing = graph(); delete missing.operations[1].inputs.curve;
  invalid(missing, bundle(), /curve|required/i);
  const unknown = graph(); unknown.operations[1].inputs.misspelledParameter = scalar(0.5);
  invalid(unknown, bundle(), /misspelledParameter|unknown/i);
});

test('value types and point/vector roles cannot be interchanged', () => {
  const wrongType = graph(); wrongType.operations[1].inputs.parameter = output('sample', 'tangent');
  invalid(wrongType, bundle(), /type|scalar/i);
  const wrongRole = graph(); wrongRole.operations[0].inputs.direction = output('sample', 'position');
  invalid(wrongRole, bundle(), /role|vector/i);
  const badLiteral = graph(); badLiteral.operations[0].inputs.direction = {
    kind: 'literal', value: {type: 'vec2', role: 'point', space: scene, value: [1, 0]},
  };
  invalid(badLiteral, bundle(), /role|vector/i);
});

test('scene and node-local spaces stay distinct, including identity transforms', () => {
  const g = graph(); g.operations[0].spaces.space = local('dot');
  invalid(g, bundle(), /space/i);
  const literal = graph();
  (literal.operations[1].inputs.curve as any).value.space = local('curve');
  invalid(literal, bundle(), /space/i);
  const missingNode = graph(); missingNode.operations[1].spaces.curve = local('missing');
  invalid(missingNode, bundle(), /missing|node/i);
  const missingSpace = graph(); delete missingSpace.operations[1].spaces.curve;
  invalid(missingSpace, bundle(), /space|curve/i);
  const extraSpace = graph(); extraSpace.operations[1].spaces.unknown = scene;
  invalid(extraSpace, bundle(), /space|unknown/i);
});

test('literal payloads must be finite, typed and valid path geometry', () => {
  const nonfinite = graph(); nonfinite.operations[1].inputs.parameter = scalar(Infinity);
  invalid(nonfinite, bundle(), /finite|json|literal/i);
  const badPath = graph();
  (badPath.operations[1].inputs.curve as any).value.value.contours[0].segments[0].c1 = [0];
  invalid(badPath, bundle(), /path|c1|geometry/i);
  const duplicateSegment = graph();
  const segments = (duplicateSegment.operations[1].inputs.curve as any).value.value.contours[0].segments;
  segments.push(copy(segments[0]));
  invalid(duplicateSegment, bundle(), /path|unique|geometry/i);
});

test('non-JSON values, cycles and unexpected graph properties are rejected', () => {
  const executable: any = graph(); executable.execute = () => {};
  invalid(executable, bundle(), /json|property/i);
  const cyclic: any = graph(); cyclic.recursive = cyclic;
  invalid(cyclic, bundle(), /cycle|json/i);
  invalid({...graph(), ignoredTypo: true}, bundle(), /property|ignoredTypo/i);
});

test('input diagnostics retain authored source spans', () => {
  const g = graph(); g.operations[0].sourceSpan = copy(span);
  g.operations[0].inputs.origin = output('missing');
  const diagnostics = invalid(g);
  assert.ok(diagnostics.some(d => d.path?.includes('inputs.origin') && JSON.stringify(d.sourceSpan) === JSON.stringify(span)));
  const malformed = graph(); malformed.operations[0].sourceSpan = {...copy(span), end: {line: 1, column: 1}};
  invalid(malformed, bundle(), /span|end|order/i);
});

test('bindings require existing targets and outputs, supported properties and compatible roles', () => {
  for (const change of [
    {target: 'missing'}, {property: 'unknown'}, {value: {operation: 'absent', socket: 'position'}},
    {value: {operation: 'sample', socket: 'missing'}}, {value: {operation: 'sample', socket: 'tangent'}},
  ]) {
    const g = graph(); g.bindings[0] = {...g.bindings[0], ...change};
    invalid(g);
  }
  const g = graph(); g.bindings[0].sourceSpan = copy(span); g.bindings[0].target = 'missing';
  assert.ok(invalid(g).some(d => d.path?.includes('bindings') && JSON.stringify(d.sourceSpan) === JSON.stringify(span)));
});

test('semantic position/start/end bindings all consume scene-space points', () => {
  const g = graph(), b = bundle();
  b.nodes.push({id: 'ellipse', kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5});
  b.nodes.push({id: 'math', kind: 'tex', resourceId: 'label', x: 0, y: 0});
  b.resources.label = {kind: 'vector', items: [{kind: 'path', d: 'M0 0L1 1'}],
    metrics: {width: 1, height: 1, depth: 0}, inkBounds: [0, 0, 1, 1]};
  g.bindings.push({target: 'ellipse', property: 'position', value: {operation: 'sample', socket: 'position'}},
    {target: 'math', property: 'position', value: {operation: 'sample', socket: 'position'}});
  assert.deepEqual(validateOperationGraph(g, b), []);
});

test('geometry and control bindings require target-local values and existing control slots', () => {
  const point = metadata('point', {type: 'vec2', role: 'point', space: 'space'}, ['space']);
  const registry = createOperatorRegistry([point]);
  for (const property of ['geometry.c.start', 'geometry.c.s.c1', 'geometry.c.s.to']) {
    const g = emitGraph(point, {space: local('curve')}, 'curve', property);
    assert.deepEqual(validateOperationGraph(g, bundle(), registry), []);
    g.operations[0].spaces.space = scene;
    assert.ok(validateOperationGraph(g, bundle(), registry).some(d => d.severity === 'error'));
  }
  const absent = emitGraph(point, {space: local('curve')}, 'curve', 'geometry.c.absent.c1');
  assert.ok(validateOperationGraph(absent, bundle(), registry).some(d => d.severity === 'error'));
  const path = metadata('path', {type: 'path2d', space: 'space'}, ['space']);
  assert.deepEqual(validateOperationGraph(emitGraph(path, {space: local('curve')}, 'curve', 'geometry'), bundle(), createOperatorRegistry([path])), []);
});

test('transform bindings enforce from/to spaces and vector roles for translate/scale', () => {
  const b = bundle();
  b.nodes.push({id: 'parent', kind: 'group'});
  b.nodes.find(n => n.id === 'dot')!.parent = 'parent';
  const transform = metadata('matrix', {type: 'transform2d', from: 'from', to: 'to'}, ['from', 'to']);
  const registry = createOperatorRegistry([transform]);
  const g = emitGraph(transform, {from: local('dot'), to: local('parent')}, 'dot', 'transform');
  assert.deepEqual(validateOperationGraph(g, b, registry), []);
  g.operations[0].spaces.to = scene;
  assert.ok(validateOperationGraph(g, b, registry).some(d => d.severity === 'error'));
  const vector = metadata('vector', {type: 'vec2', role: 'vector', space: 'space'}, ['space']);
  const vectors = createOperatorRegistry([vector]);
  for (const [property, space] of [['transform.translate', local('parent')], ['transform.scale', local('dot')]] as const) {
    assert.deepEqual(validateOperationGraph(emitGraph(vector, {space}, 'dot', property), b, vectors), []);
    assert.ok(validateOperationGraph(emitGraph(vector, {space: scene}, 'dot', property), b, vectors).some(d => d.severity === 'error'));
  }
});

test('transformPoint requires matching affine source and destination spaces', () => {
  const g: OperationGraph = {version: 1, operations: [{id: 'convert', operator: 'transformPoint', version: 1,
    spaces: {from: local('curve'), to: scene}, inputs: {
      point: {kind: 'literal', value: {type: 'vec2', role: 'point', space: local('curve'), value: [2, 3]}},
      transform: {kind: 'literal', value: {type: 'transform2d', from: local('curve'), to: scene, value: [1, 0, 0, 1, 10, 20]}},
    }}], bindings: [{target: 'dot', property: 'position', value: {operation: 'convert', socket: 'position'}}]};
  assert.deepEqual(validateOperationGraph(g, bundle()), []);
  (g.operations[0].inputs.transform as any).value.from = scene;
  invalid(g, bundle(), /space|transform|type/i);
});

test('scene-position aliases require invertible target and ancestor transforms across the timeline', () => {
  const staticTarget = bundle();
  staticTarget.nodes.find(n => n.id === 'dot')!.transform = {scale: [0, 1]};
  assert.ok(invalid(graph(), staticTarget).some(d => d.code === 'OPERATION_SINGULAR_SPACE'));
  const animated = bundle();
  animated.nodes.push({id: 'parent', kind: 'group', transform: {scale: [0, 1]}});
  animated.nodes.find(n => n.id === 'dot')!.parent = 'parent';
  assert.ok(invalid(graph(), animated).some(d => d.code === 'OPERATION_SINGULAR_SPACE'));
  animated.nodes.find(n => n.id === 'parent')!.transform = {scale: [1, 1]};
  animated.tracks.push({target: 'parent', property: 'transform.scale', keys: [[0, [1, 1]], [2, [-1, 1]]], interpolation: 'linear'});
  assert.ok(invalid(graph(), animated).some(d => d.code === 'OPERATION_SINGULAR_SPACE'));
  animated.tracks[0].interpolation = 'step';
  assert.deepEqual(validateOperationGraph(graph(), animated), []);
});

test('scalar outputs bind existing scalar properties including camera without widening the property set', () => {
  const value = metadata('number', {type: 'scalar'}), registry = createOperatorRegistry([value]);
  for (const [target, property] of [['dot', 'r'], ['dot', 'x'], ['dot', 'style.opacity'], ['$camera', 'zoom']]) {
    assert.deepEqual(validateOperationGraph(emitGraph(value, {}, target, property), bundle(), registry), []);
  }
  for (const [target, property] of [['dot', 'position'], ['curve', 'd'], ['$camera', 'transform']]) {
    assert.ok(validateOperationGraph(emitGraph(value, {}, target, property), bundle(), registry).some(d => d.severity === 'error'));
  }
});

test('graph writer diagnostics name both authored sources for overlapping aliases', () => {
  const g = graph(); g.bindings[0].sourceSpan = copy(span);
  const duplicate = {...copy(g.bindings[0]), sourceSpan: {...copy(span), file: 'other.tex'}};
  g.bindings.push(duplicate);
  const conflict = invalid(g).find(d => d.code === 'OPERATION_WRITER_CONFLICT')!;
  assert.equal(conflict.sourceSpan?.file, 'other.tex');
  assert.equal(conflict.related?.[0].sourceSpan?.file, 'lesson.tex');
  assert.equal(conflict.related?.[0].path, '$.operationGraph.bindings[0]');
});

test('aliases conflict with concrete scalar writers while independent writers remain valid', () => {
  const g = graph(), b = bundle();
  b.tracks.push({target: 'dot', property: 'x', keys: [[0, 0], [2, 10]]});
  invalid(g, b, /writer|conflict/i);
  b.tracks[0].property = 'r';
  assert.deepEqual(validateOperationGraph(g, b), []);
  const duplicate = graph(); duplicate.bindings.push(copy(duplicate.bindings[0]));
  invalid(duplicate, bundle(), /writer|conflict/i);
  const relation = bundle(); relation.relations.push({type: 'pointOnPath', target: 'dot', source: 'curve'});
  invalid(graph(), relation, /writer|conflict/i);
  const line = bundle(); line.tracks.push({target: 'tangent', property: 'x2', keys: [[0, 0], [2, 10]]});
  invalid(graph(), line, /writer|conflict/i);
});

test('whole transform and geometry writers conflict with their component tracks', () => {
  const matrix = metadata('matrix', {type: 'transform2d', from: 'from', to: 'to'}, ['from', 'to']);
  const matrixGraph = emitGraph(matrix, {from: local('dot'), to: scene}, 'dot', 'transform');
  const b = bundle(); b.tracks.push({target: 'dot', property: 'transform.rotate', keys: [[0, 0], [2, 90]]});
  assert.ok(validateOperationGraph(matrixGraph, b, createOperatorRegistry([matrix])).some(d => /writer|conflict/i.test(`${d.code} ${d.message}`)));
  const path = metadata('path', {type: 'path2d', space: 'space'}, ['space']);
  const pathGraph = emitGraph(path, {space: local('curve')}, 'curve', 'geometry');
  const pathBundle = bundle(); pathBundle.tracks.push({target: 'curve', property: 'geometry.c.s.c1', keys: [[0, [40, 0]], [2, [20, 10]]]});
  assert.ok(validateOperationGraph(pathGraph, pathBundle, createOperatorRegistry([path])).some(d => /writer|conflict/i.test(`${d.code} ${d.message}`)));
});

test('bundle validation includes graph errors while empty graphs preserve legacy execution', () => {
  const invalidBundle = bundle(); invalidBundle.operationGraph!.operations[0].inputs.origin = output('missing');
  assert.ok(validateBundle(invalidBundle).some(d => d.path?.includes('operationGraph')));
  const legacy = bundle(); delete legacy.operationGraph;
  const empty = {...copy(legacy), operationGraph: {version: 1 as const, operations: [], bindings: []}};
  assert.deepEqual(validateBundle(empty), []);
  assert.deepEqual(evaluate(empty, 1), evaluate(legacy, 1));
  assert.deepEqual(prepareScene(empty).sample(1), createEvaluator(legacy)(1));
});

test('every runtime entry executes the authored graph and preserves shared output bindings', () => {
  const b = bundle();
  for (const invoke of [() => evaluate(b, 0), () => createEvaluator(b)(0), () => prepareScene(b).sample(0)]) {
    const frame = invoke();
    const dot = frame.nodes.find(n => n.id === 'dot');
    const tangent = frame.nodes.find(n => n.id === 'tangent');
    assert.ok(dot?.kind === 'point' && tangent?.kind === 'line');
    assert.deepEqual([dot.x, dot.y], [71.25, 17.5]);
    assert.deepEqual([tangent.x1, tangent.y1, tangent.x2, tangent.y2], [71.25, 17.5, 96.25, 17.5]);
  }
  b.operationGraph!.bindings = [];
  assert.doesNotThrow(() => createEvaluator(b)(0));
  b.operationGraph!.operations[0].operator = 'unknownExecutable';
  assert.throws(() => createEvaluator(b), /OPERATION_UNKNOWN_OPERATOR/);
});

test('standalone graph APIs enforce the same bundle version boundary as validateBundle', () => {
  for (const version of ['0.1', '0.2'] as const) {
    // Keep the base scene compatible with those versions so the operation boundary is tested.
    const b = bundle(); b.version = version;
    b.nodes = b.nodes.filter(n => n.kind !== 'path');
    assert.ok(validateBundle(b).some(d => d.code === 'OPERATION_BUNDLE_VERSION'));
    assert.ok(validateOperationGraph(b.operationGraph, b).some(d => d.code === 'OPERATION_BUNDLE_VERSION'));
    assert.throws(() => prepareOperationGraph(b.operationGraph, b), OperationValidationError);
  }
});

test('graph validation does not duplicate warnings already carried by the bundle', () => {
  const b = bundle();
  b.diagnostics = [{severity: 'warning', code: 'SOURCE_NOTE', message: 'Authored source note.', path: '$.source'}];
  assert.deepEqual(validateBundle(b), b.diagnostics);
  const prepared = prepareOperationGraph(b.operationGraph, b);
  assert.deepEqual(prepared.order, ['sample', 'tip']);
});

const cliPath = fileURLToPath(new URL('../tools/validate-bundle.mjs', import.meta.url));
function invokeCli(...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {encoding: 'utf8', timeout: 15000});
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function temporaryJson(t: {after(fn: () => void): void}, text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'texloom-operations-'));
  const file = join(directory, 'bundle.json');
  writeFileSync(file, text, 'utf8');
  t.after(() => { unlinkSync(file); rmdirSync(directory); });
  return file;
}

test('CLI validates and prepares a real file without rewriting authored JSON', t => {
  const authored = JSON.stringify(bundle());
  const file = temporaryJson(t, authored);
  const validation = invokeCli(file);
  assert.equal(validation.status, 0, validation.stderr);
  assert.deepEqual(JSON.parse(validation.stdout), []);
  const preparation = invokeCli(file, '--prepare-operations');
  assert.equal(preparation.status, 0, preparation.stderr);
  const prepared = JSON.parse(preparation.stdout);
  assert.equal(prepared.contract, 'texloom-operations/1');
  assert.deepEqual(prepared.order, ['sample', 'tip']);
  assert.deepEqual(prepared.graph.operations.find((op: Operation) => op.id === 'sample').inputs.tolerance, scalar(0.25));
  assert.equal(readFileSync(file, 'utf8'), authored);
});

test('CLI returns structured errors for invalid graphs and absent graphs in prepare mode', t => {
  const b = bundle(); b.operationGraph!.operations[0].inputs.origin = output('missing');
  const file = temporaryJson(t, JSON.stringify(b));
  for (const args of [[file], [file, '--prepare-operations']]) {
    const result = invokeCli(...args);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).some((d: Diagnostic) => d.code === 'OPERATION_MISSING_REFERENCE'));
  }
  delete b.operationGraph;
  writeFileSync(file, JSON.stringify(b), 'utf8');
  const absent = invokeCli(file, '--prepare-operations');
  assert.equal(absent.status, 1);
  assert.equal(JSON.parse(absent.stdout)[0].code, 'OPERATION_GRAPH_REQUIRED');
});

test('CLI distinguishes JSON/read failures from usage errors', t => {
  const file = temporaryJson(t, '{bad JSON');
  for (const path of [file, resolve(file, '..', 'absent.json')]) {
    const result = invokeCli(path);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout)[0].code, 'BUNDLE_READ');
  }
  for (const args of [[], [file, '--unknown']]) {
    const result = invokeCli(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});

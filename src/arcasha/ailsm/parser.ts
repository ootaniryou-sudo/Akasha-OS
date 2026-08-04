/**
 * AILSM Parser — Stage 1: NormalizedInput → SSA風ID付き意味グラフ
 *
 * タスク/オブジェクト/値のノードを生成し、ID参照（uses / input）で接続する。
 */

import { AilsmBuilder } from './ailsm.js';
import { objectType } from './types.js';
import type { NormalizedInput } from './normalizer.js';

export function parse(norm: NormalizedInput): AilsmBuilder {
  const b = new AilsmBuilder();

  const taskAttrs: Record<string, string | number | boolean | string[]> = {
    domain: norm.domain,
    intent: norm.intent,
  };
  if (norm.actions.length > 0) taskAttrs.actions = norm.actions;
  if (norm.output) taskAttrs.output = norm.output;

  const taskId = b.addNode('task', norm.intent === 'unknown' ? 'process' : norm.intent, 'unknown', taskAttrs);

  if (norm.inputText && (norm.intent === 'summarize' || norm.intent === 'search')) {
    const n = b.addNode('value', 'input', 'string', { text: norm.inputText });
    b.connect(taskId, n, 'input');
  }

  for (const obj of norm.objects) {
    const id = b.addNode('object', obj, objectType(obj));
    b.connect(taskId, id, 'uses');
  }

  for (const a of norm.attributes) {
    const id = b.addNode('value', a.name, a.value !== '' ? 'number' : 'string', { [a.name]: a.value });
    b.connect(taskId, id, 'uses');
  }

  for (const expr of norm.rawMath) {
    const id = b.addNode('object', 'equation', 'equation', { expr });
    b.connect(taskId, id, 'uses');
  }

  for (const v of norm.variables) {
    const id = b.addNode('value', 'variable', 'unknown', { name: v });
    b.connect(taskId, id, 'uses');
  }

  return b;
}

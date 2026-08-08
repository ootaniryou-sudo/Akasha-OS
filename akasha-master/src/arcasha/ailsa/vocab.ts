/**
 * AILSA Vocabulary — 閉じた語彙のコンパイル済み版（高速化用）
 *
 * 唯一の権威は registry.json（Intel Manual）。ここに定義する enum は
 * そのミラーであり、codec 初期化時に assertRegistryIntegrity() で
 * 完全一致を強制する（絶対に壊れない土台）。
 *
 * ロード: 実行時は fs で registry.json を読み込む（tsx / dist / cwd を探索）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opcode } from './opcode.js';

/** タスク動詞（0x01–0x0F） */
export enum Task {
  SOLVE = 0x04,
  VERIFY = 0x05,
  PLAN = 0x06,
  SEARCH = 0x07,
  PATCH = 0x08,
  TRANSLATE = 0x09,
  SUMMARIZE = 0x0a,
}

/** ドメイン（0x10–0x1F） */
export enum Domain {
  MATH = 0x12,
  CODE = 0x13,
  SEARCH = 0x14,
  REASONING = 0x15,
}

/** スロット（0x20–0x2F）— 値を持つフィールド */
export enum Slot {
  GOAL = 0x20,
  INPUT = 0x21,
  OUTPUT = 0x22,
  CONF = 0x23,
  NEXT = 0x24,
  CONSTRAINT = 0x25,
  CONTEXT = 0x26,
  DEPENDENCY = 0x27,
  DOMAIN = 0x28,
  EXPERT = 0x29,
  TASK_ID = 0x2a,
  REASON = 0x2b,
  KEY = 0x2c,
  VALUE = 0x2d,
  STRATEGY = 0x2e,
  TRACE = 0x2f,
}

export type DialectId = 'base' | 'math' | 'code' | 'search' | 'reasoning';
export type Category =
  | 'task' | 'domain' | 'slot' | 'control'
  | 'math' | 'code' | 'search' | 'reasoning' | 'syscall';
export type ValueType = 'string' | 'number' | 'boolean';

export interface RegistryEntry {
  name: string;
  opcode: number;
  category: Category;
  dialect: DialectId;
  description?: string;
  terminal?: boolean;
  valueType?: ValueType;
}

export interface AILSARegistry {
  version: string;
  description?: string;
  dialects: DialectId[];
  instructions: RegistryEntry[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGISTRY_CANDIDATES = [
  path.resolve(__dirname, 'registry.json'),
  path.resolve(__dirname, '../../../src/arcasha/ailsa/registry.json'),
  path.resolve(process.cwd(), 'src/arcasha/ailsa/registry.json'),
];

let cached: AILSARegistry | null = null;

/** registry.json を読み込む。明示パスが無ければ候補を順に探索する。 */
export function loadRegistry(explicitPath?: string): AILSARegistry {
  const candidates = explicitPath ? [path.resolve(explicitPath)] : REGISTRY_CANDIDATES;
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as AILSARegistry;
    } catch {
      /* 次の候補へ */
    }
  }
  throw new Error(
    `AILSA Registry が見つかりません。候補: ${REGISTRY_CANDIDATES.join(', ')}`,
  );
}

/** 唯一の権威（遅延ロード + キャッシュ） */
export function registry(): AILSARegistry {
  if (!cached) cached = loadRegistry();
  return cached;
}

let nameIndex: Map<string, RegistryEntry> | null = null;
let opIndex: Map<number, RegistryEntry> | null = null;

function ensureIndex(): void {
  if (nameIndex) return;
  nameIndex = new Map();
  opIndex = new Map();
  for (const e of registry().instructions) {
    nameIndex.set(e.name, e);
    opIndex.set(e.opcode, e);
  }
}

export function entryOfName(name: string): RegistryEntry | undefined {
  ensureIndex();
  return nameIndex!.get(name);
}

export function entryOfOpcode(opcode: number): RegistryEntry | undefined {
  ensureIndex();
  return opIndex!.get(opcode);
}

export function isRegistered(opcode: number): boolean {
  return entryOfOpcode(opcode) !== undefined;
}

export function isSlot(opcode: number): boolean {
  return entryOfOpcode(opcode)?.category === 'slot';
}

export function isTerminal(opcode: number): boolean {
  return entryOfOpcode(opcode)?.terminal === true;
}

export function categoryOf(opcode: number): Category | undefined {
  return entryOfOpcode(opcode)?.category;
}

export function dialectOf(opcode: number): DialectId | undefined {
  return entryOfOpcode(opcode)?.dialect;
}

export function valueTypeOf(opcode: number): ValueType | undefined {
  return entryOfOpcode(opcode)?.valueType;
}

export function nameOf(opcode: number): string {
  return entryOfOpcode(opcode)?.name ?? `UNKNOWN_0x${opcode.toString(16).padStart(2, '0')}`;
}

/**
 * 唯一の権威 registry.json とミラー（enum）の完全一致を強制する。
 * 1つでも矛盾があれば例外を投げる（= 土台を壊さない）。
 */
export function assertRegistryIntegrity(r: AILSARegistry): void {
  const seenNames = new Set<string>();
  const seenOps = new Set<number>();
  const validCategories = new Set<Category>([
    'task', 'domain', 'slot', 'control', 'math', 'code', 'search', 'reasoning', 'syscall',
  ]);
  const validDialects = new Set<DialectId>(r.dialects);

  for (const e of r.instructions) {
    if (seenNames.has(e.name)) throw new Error(`Registry 重複 name: ${e.name}`);
    if (seenOps.has(e.opcode)) throw new Error(`Registry 重複 opcode: ${e.name}=0x${e.opcode.toString(16)}`);
    if (e.opcode < 1 || e.opcode > 0xff) throw new Error(`opcode 範囲外: ${e.name}=0x${e.opcode.toString(16)}`);
    if (!validCategories.has(e.category)) throw new Error(`不正 category: ${e.name}=${e.category}`);
    if (!validDialects.has(e.dialect)) throw new Error(`未定義 dialect: ${e.name}=${e.dialect}`);
    if (e.category === 'slot' && e.valueType === undefined) {
      throw new Error(`スロットに valueType が無い: ${e.name}`);
    }
    seenNames.add(e.name);
    seenOps.add(e.opcode);
  }

  assertEnumMatches('Task', Task, 'TASK_');
  assertEnumMatches('Domain', Domain, 'DOMAIN_');
  assertEnumMatches('Slot', Slot, 'SLOT_');
  assertEnumMatches('Opcode', Opcode, '');
}

function assertEnumMatches(label: string, enumObj: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(enumObj)) {
    if (!Number.isNaN(Number(key))) continue; // 数値 enum の逆引きキーを除外
    const value = Number(enumObj[key]);
    const ent = entryOfOpcode(value);
    if (!ent) throw new Error(`${label}.${key} (0x${value.toString(16)}) が Registry に無い`);
    const expected = prefix + key;
    if (ent.name !== expected) {
      throw new Error(
        `${label}.${key}=0x${value.toString(16)} は Registry の ${ent.name} と不一致（期待: ${expected}）`,
      );
    }
  }
}


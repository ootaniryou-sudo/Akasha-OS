#!/usr/bin/env npx tsx
/**
 * EXP-0002E.2 — Pareto Routing
 *
 * Pure calculation (no inference).
 * Computes multi-axis Pareto dominance over nodes,
 * finds the Pareto Frontier, and compares with weighted-sum (0002E).
 *
 * Axes: Capability (higher better), Latency (lower better), Stability (higher better)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002E.2/run_pareto.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// Node definitions
// ═══════════════════════════════════════════════════════════════════════════════

interface Node {
  id: string;
  capability: number;  // higher = better
  latencyMs: number;   // lower = better
  stability: number;   // higher = better
  backend: string;
}

const nodes: Node[] = [
  { id: 'node-a', capability: 0.70, latencyMs: 10,  stability: 0.90, backend: 'cpu-fp32' },
  { id: 'node-b', capability: 0.85, latencyMs: 40,  stability: 0.99, backend: 'mps-fp16' },
  { id: 'node-c', capability: 0.95, latencyMs: 80,  stability: 0.99, backend: 'mps-fp32' },
  { id: 'node-d', capability: 0.90, latencyMs: 60,  stability: 0.79, backend: 'mps-bf16' },
  { id: 'node-e', capability: 0.60, latencyMs: 5,   stability: 0.85, backend: 'relay' },
  { id: 'node-f', capability: 0.88, latencyMs: 35,  stability: 0.95, backend: 'onnx-fp16' },
  { id: 'node-g', capability: 0.98, latencyMs: 200, stability: 0.98, backend: 'remote-gpu' },
  // Dominated node: worse than node-b on ALL axes
  { id: 'node-h', capability: 0.80, latencyMs: 70,  stability: 0.80, backend: 'mps-fp16-old' },
  // Dominated node: worse than node-a on all axes
  { id: 'node-i', capability: 0.65, latencyMs: 15,  stability: 0.82, backend: 'cpu-fp16' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Pareto Dominance
// ═══════════════════════════════════════════════════════════════════════════════

// Higher is better on all axes (convert latency to negative or use reciprocal)
function dominates(a: Node, b: Node): boolean {
  const aBetter =
    a.capability >= b.capability &&
    a.latencyMs <= b.latencyMs &&
    a.stability >= b.stability;
  const strictlyBetter =
    a.capability > b.capability ||
    a.latencyMs < b.latencyMs ||
    a.stability > b.stability;
  return aBetter && strictlyBetter;
}

function computeFrontier(nodes: Node[]): Node[] {
  return nodes.filter(a => !nodes.some(b => b.id !== a.id && dominates(b, a)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Weighted-sum (0002E) for comparison
// ═══════════════════════════════════════════════════════════════════════════════

const WEIGHTS = { capability: 0.40, latency: 0.15, stability: 0.30, confidence: 0.15 };

function weightedSum(node: Node): number {
  const maxLat = Math.max(...nodes.map(n => n.latencyMs));
  const latScore = 1 - node.latencyMs / maxLat;
  return (
    WEIGHTS.capability * node.capability +
    WEIGHTS.latency * latScore +
    WEIGHTS.stability * node.stability +
    WEIGHTS.confidence * 1.0  // assume full confidence for comparison
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Visualization
// ═══════════════════════════════════════════════════════════════════════════════

function render2D(title: string, nodes: Node[], frontier: Set<string>, x: 'capability' | 'latencyMs', y: 'stability' | 'capability') {
  const xKey = x, yKey = y;
  const xVals = nodes.map(n => n[xKey] as number);
  const yVals = nodes.map(n => n[yKey] as number);
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  const yMin = Math.min(...yVals), yMax = Math.max(...yVals);
  const W = 40, H = 16;

  console.log(`\n  ${title}:`);
  console.log('  ┌' + '─'.repeat(W) + '┐');

  for (let row = 0; row < H; row++) {
    let line = '  │';
    for (let col = 0; col < W; col++) {
      const x = xMin + (xMax - xMin) * (col / (W - 1));
      const y = yMax - (yMax - yMin) * (row / (H - 1));
      const hit = nodes.find(n => {
        const nx = n[xKey] as number;
        const ny = n[yKey] as number;
        const xNear = Math.abs((nx - xMin) / (xMax - xMin || 1) - col / (W - 1)) < 0.02;
        const yNear = Math.abs((yMax - ny) / (yMax - yMin || 1) - row / (H - 1)) < 0.04;
        return xNear && yNear;
      });
      if (hit) {
        line += frontier.has(hit.id) ? '●' : '○';
      } else {
        line += '·';
      }
    }
    line += '│';
    console.log(line);
  }
  console.log('  └' + '─'.repeat(W) + '┘');
  console.log(`     ● = Pareto frontier  ○ = dominated`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

function main() {
  console.log('═'.repeat(70));
  console.log('EXP-0002E.2 — Pareto Routing');
  console.log('═'.repeat(70));
  console.log('\n  Node Set:');
  console.log('  ┌──────────┬────────────┬─────────┬──────────┬──────────┐');
  console.log('  │ Node     │ Capability │ Latency │ Stability│ Backend  │');
  console.log('  ├──────────┼────────────┼─────────┼──────────┼──────────┤');
  for (const n of nodes) {
    console.log(`  │ ${n.id.padEnd(8)} │ ${String(n.capability).padEnd(10)} │ ${String(n.latencyMs + 'ms').padEnd(7)} │ ${String(n.stability).padEnd(8)} │ ${n.backend.padEnd(8)} │`);
  }
  console.log('  └──────────┴────────────┴─────────┴──────────┴──────────┘');

  // ── Pareto dominance matrix ─────────────────────────────────────────────
  console.log('\n── Pareto Dominance Matrix ──');
  console.log('  (row dominates column)');
  console.log('  ┌──────────┬' + '─'.repeat(7 * nodes.length + 1) + '┐');
  const header = '  │          │ ' + nodes.map(n => n.id.padStart(6)).join(' ') + ' │';
  console.log(header);
  console.log('  ├──────────┼' + '─'.repeat(7 * nodes.length + 1) + '┤');
  for (const a of nodes) {
    let row = `  │ ${a.id.padEnd(8)} │ `;
    for (const b of nodes) {
      if (a.id === b.id) { row += '  ·   '; continue; }
      row += dominates(a, b) ? '  ✅  ' : '      ';
    }
    row += ' │';
    console.log(row);
  }
  console.log('  └──────────┴' + '─'.repeat(7 * nodes.length + 1) + '┘');

  // ── Frontier ────────────────────────────────────────────────────────────
  const frontier = computeFrontier(nodes);
  const frontierSet = new Set(frontier.map(n => n.id));

  console.log('\n── Pareto Frontier ──');
  console.log(`  Frontier (${frontier.length}/${nodes.length}): ${frontier.map(n => n.id).join(', ')}`);
  console.log(`  Dominated: ${nodes.filter(n => !frontierSet.has(n.id)).map(n => n.id).join(', ') || '(none)'}`);

  for (const f of frontier) {
    const dominators = nodes.filter(b => b.id !== f.id && dominates(b, f));
    console.log(`    ${f.id}: ${dominators.length === 0 ? 'non-dominated ✓' : `dominated by ${dominators.map(d => d.id).join(',')}`}`);
  }

  // ── 2D visualization ────────────────────────────────────────────────────
  render2D('Capability vs Latency (lower latency = better, right = lower)', nodes, frontierSet, 'latencyMs', 'capability');
  render2D('Capability vs Stability', nodes, frontierSet, 'capability', 'stability');

  // ── Comparison: Pareto vs Weighted-sum (0002E) ──────────────────────────
  console.log('\n── Comparison: Pareto vs Weighted-Sum (0002E) ──');
  console.log('  ┌──────────┬──────────┬──────────┬──────────────────────┐');
  console.log('  │ Node     │ Frontier │ WtdSum   │ Weighted-sum rank    │');
  console.log('  ├──────────┼──────────┼──────────┼──────────────────────┤');

  const scored = nodes.map(n => ({ node: n, score: weightedSum(n) }));
  scored.sort((a, b) => b.score - a.score);

  for (const { node, score } of scored) {
    const fr = frontierSet.has(node.id) ? '✅' : '❌';
    const rank = scored.findIndex(s => s.node.id === node.id) + 1;
    console.log(`  │ ${node.id.padEnd(8)} │    ${fr}    │ ${score.toFixed(3).padStart(6)} │ rank #${rank}${rank === 1 ? ' ← best' : ''}${!frontierSet.has(node.id) && rank <= 3 ? ' (chosen but dominated!)' : ''} │`);
  }
  console.log('  └──────────┴──────────┴──────────┴──────────────────────┘');

  const wsBest = scored[0].node;
  const wsBestOnFrontier = frontierSet.has(wsBest.id);
  const dominatedChosen = scored.slice(0, 3).filter(s => !frontierSet.has(s.node.id));

  // ── Key findings ────────────────────────────────────────────────────────
  console.log('\n── Key Findings ──');
  console.log(`
  1. Weighted-sum best (${wsBest.id}) is ${wsBestOnFrontier ? 'ON' : 'NOT ON'} the Pareto frontier.
     ${wsBestOnFrontier
       ? '→ Weighted-sum and Pareto agree on the top choice.'
       : '→ Weighted-sum can choose a dominated node that Pareto would exclude!'}
  ${dominatedChosen.length > 0 ? `  2. Dominated-but-highly-ranked by weighted-sum: ${dominatedChosen.map(s => s.node.id).join(', ')}` : ''}

  3. Pareto Frontier preserves trade-offs:
     ${frontier.map(n => `${n.id}(cap=${n.capability}, lat=${n.latencyMs}ms, stab=${n.stability})`).join('\n     ')}

  4. Router strategy:
     - Pareto-first: restrict to frontier, then apply secondary criteria
     - Weighted-sum: single scalar, may hide trade-offs
  `);

  // Save
  const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002E.2/output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    experiment: 'EXP-0002E.2',
    description: 'Pareto Routing (multi-axis frontier)',
    timestamp: '2026-08-01',
    nodes: nodes,
    dominance_matrix: nodes.map(a => ({
      node: a.id,
      dominates: nodes.filter(b => b.id !== a.id && dominates(a, b)).map(b => b.id),
    })),
    frontier: frontier.map(n => n.id),
    weighted_sum_rank: scored.map((s, i) => ({ rank: i + 1, node: s.node.id, score: Math.round(s.score * 1000) / 1000 })),
    key_findings: [
      `Weighted-sum best (${wsBest.id}) ${wsBestOnFrontier ? 'is on' : 'is NOT on'} Pareto frontier`,
      dominatedChosen.length > 0 ? `Dominated but chosen: ${dominatedChosen.map(s => s.node.id).join(', ')}` : 'Weighted-sum and Pareto agree',
      'Pareto preserves trade-offs; weighted-sum hides them in a scalar',
    ],
  }, null, 2));
  console.log(`\n  📁 ${outDir}/summary.json`);
}

main();

#!/usr/bin/env npx tsx
/**
 * EXP-0002E.1 — Weight Sensitivity Analysis
 *
 * Pure calculation (no WebSocket, no inference).
 * Varies weight(stability) and measures when Composite Score routing flips.
 *
 * Two scenarios:
 *   A: Equal capability (EXP-0002E actual) — stability is the only differentiator
 *   B: BF16 has HIGHER capability — the genuinely interesting trade-off
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002E.1/run_sensitivity.ts
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Stability (from EXP-0001)
// ═══════════════════════════════════════════════════════════════════════════════

const STABILITY = { fp16: 0.992, bf16: 0.791 };

// ═══════════════════════════════════════════════════════════════════════════════
// Scenarios
// ═══════════════════════════════════════════════════════════════════════════════

interface Scenario {
  name: string;
  nodes: { id: string; stability: number; capability: number }[];
  weights: { capability: number; confidence: number; latency: number; stability: number };
}

const BASE_WEIGHTS = { capability: 0.40, confidence: 0.15, latency: 0.15, stability: 0.30 };

const scenarios: Scenario[] = [
  {
    // EXP-0002E actual: equal capability → stability decides
    name: 'A: Equal capability (EXP-0002E)',
    nodes: [
      { id: 'node-fp16', stability: STABILITY.fp16, capability: 0.95 },
      { id: 'node-bf16', stability: STABILITY.bf16, capability: 0.95 },
    ],
    weights: { ...BASE_WEIGHTS },
  },
  {
    // Interesting case: BF16 has higher capability but worse stability
    name: 'B: BF16 higher capability (0.98) vs FP16 stable (0.90)',
    nodes: [
      { id: 'node-fp16', stability: STABILITY.fp16, capability: 0.90 },
      { id: 'node-bf16', stability: STABILITY.bf16, capability: 0.98 },
    ],
    weights: { ...BASE_WEIGHTS },
  },
  {
    // Extreme: BF16 much higher capability
    name: 'C: BF16 much higher (0.99) vs FP16 (0.80)',
    nodes: [
      { id: 'node-fp16', stability: STABILITY.fp16, capability: 0.80 },
      { id: 'node-bf16', stability: STABILITY.bf16, capability: 0.99 },
    ],
    weights: { ...BASE_WEIGHTS },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Composite Score
// ═══════════════════════════════════════════════════════════════════════════════

function composite(node: { stability: number; capability: number }, w: Scenario['weights'], latScore: number): number {
  // Assume measured capability with full confidence (n large)
  // so effective = capability × 1.0
  return (
    w.capability * node.capability +
    w.confidence * 1.0 +   // full confidence
    w.latency * latScore +
    w.stability * node.stability
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Weight Sweep
// ═══════════════════════════════════════════════════════════════════════════════

const STAB_WEIGHTS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Rebalance weights while sweeping stability:
 * Keep capability/latency/confidence in fixed proportion of the non-stability budget.
 */
function reweight(sweepStab: number, base: Scenario['weights']): Scenario['weights'] {
  const other = 1 - sweepStab;
  const totalBase = base.capability + base.confidence + base.latency;
  return {
    capability: other * (base.capability / totalBase),
    confidence: other * (base.confidence / totalBase),
    latency: other * (base.latency / totalBase),
    stability: sweepStab,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Binary search for critical point
// ═══════════════════════════════════════════════════════════════════════════════

function findCriticalPoint(
  nodeA: { stability: number; capability: number },
  nodeB: { stability: number; capability: number },
  baseWeights: Scenario['weights'],
  latA: number, latB: number,
): number | null {
  // Does A win at w=0?
  const w0 = reweight(0, baseWeights);
  const a0 = composite(nodeA, w0, latA);
  const b0 = composite(nodeB, w0, latB);

  // Does B win at w=1?
  const w1 = reweight(1, baseWeights);
  const a1 = composite(nodeA, w1, latA);
  const b1 = composite(nodeB, w1, latB);

  const aWinsAt0 = a0 > b0;
  const aWinsAt1 = a1 > b1;

  if (aWinsAt0 === aWinsAt1) return null; // no flip in range

  // Binary search
  let lo = 0, hi = 1;
  for (let iter = 0; iter < 50; iter++) {
    const mid = (lo + hi) / 2;
    const wm = reweight(mid, baseWeights);
    const am = composite(nodeA, wm, latA);
    const bm = composite(nodeB, wm, latB);
    const aWins = am > bm;
    if (aWins === aWinsAt0) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2 * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

function main() {
  console.log('═'.repeat(70));
  console.log('EXP-0002E.1 — Weight Sensitivity Analysis');
  console.log('═'.repeat(70));
  console.log(`  Stability: FP16=${STABILITY.fp16}, BF16=${STABILITY.bf16} (from EXP-0001)`);
  console.log(`  Sweep: weight(stability) = ${STAB_WEIGHTS.join(', ')}`);
  console.log(`  Latency: both 3ms localhost → latScore identical\n`);

  for (const scenario of scenarios) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`SCENARIO ${scenario.name}`);
    console.log(`${'─'.repeat(70)}`);

    const [nodeA, nodeB] = scenario.nodes;
    // Same latency for both (localhost)
    const latScore = 0.5;

    console.log(`\n  node-fp16: capability=${nodeA.capability}, stability=${nodeA.stability}`);
    console.log(`  node-bf16: capability=${nodeB.capability}, stability=${nodeB.stability}`);
    console.log(`  base weights: C=${scenario.weights.capability} Conf=${scenario.weights.confidence} L=${scenario.weights.latency} S=${scenario.weights.stability}\n`);

    // Sweep table
    console.log('  ┌─────────┬──────────┬──────────┬──────────┬──────────────────────┐');
    console.log('  │ w_stab  │ FP16     │ BF16     │ Winner   │ Note                 │');
    console.log('  ├─────────┼──────────┼──────────┼──────────┼──────────────────────┤');

    let winnerHistory: string[] = [];
    for (const sw of STAB_WEIGHTS) {
      const w = reweight(sw, scenario.weights);
      const f = composite(nodeA, w, latScore);
      const b = composite(nodeB, w, latScore);
      const winner = f > b ? 'FP16' : (b > f ? 'BF16' : 'TIE');
      winnerHistory.push(winner);

      const note = (winner === 'FP16' && sw === 0) ? 'stability=0 yet FP16' :
        (winner === 'BF16' && sw > 0.5) ? 'BF16 survives high stability' : '';
      const ws = String(sw).padStart(5);
      const fs = String(f.toFixed(3)).padStart(8);
      const bs = String(b.toFixed(3)).padStart(8);
      const wn = winner.padEnd(8);
      console.log(`  │ ${ws}  │ ${fs}  │ ${bs}  │ ${wn} │ ${note.padEnd(18)} │`);
    }
    console.log('  └─────────┴──────────┴──────────┴──────────┴──────────────────────┘');

    // Critical point
    const critical = findCriticalPoint(nodeA, nodeB, scenario.weights, latScore, latScore);
    const aWinsDefault = composite(nodeA, reweight(0.3, scenario.weights), latScore) >
      composite(nodeB, reweight(0.3, scenario.weights), latScore);

    console.log(`\n  Critical point (routing flips): w_stab = ${critical === null ? 'no flip (one node always wins)' : critical}`);
    console.log(`  Default w_stab=0.3 → ${aWinsDefault ? 'FP16' : 'BF16'} selected`);
    console.log(`  Winner history: ${winnerHistory.join(' → ')}`);

    // ASCII curve
    console.log('\n  Sensitivity curve (winner at each w_stab):');
    const label = '      0  0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0';
    const winners = winnerHistory.map(h => h === 'FP16' ? 'F' : (h === 'BF16' ? 'B' : '-')).join('  ');
    console.log(`  ${label}`);
    console.log(`  winner: ${winners}`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Interpretation
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(70));
  console.log('INTERPRETATION');
  console.log('═'.repeat(70));
  console.log(`
  1. Scenario A (equal capability):
     Stability is the ONLY differentiator.
     → FP16 wins for any w_stab > 0. Trivially robust.

  2. Scenario B (BF16 slightly higher capability):
     The stability weight must exceed a critical threshold to prefer FP16.
     → Measures the 'cost of instability' in routing terms.

  3. Scenario C (BF16 much higher capability):
     Requires a large stability weight to overcome capability gap.
     → Quantifies when an unstable-but-strong node is worth routing to.

  Research value:
  - Sensitivity analysis quantifies stability's influence range
  - Determines appropriate weight settings for the target deployment
  - Shows Composite Score's robustness / fragility`);
}

main();


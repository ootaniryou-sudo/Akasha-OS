# EXP-0003 — Two-Expert Cooperative Inference

> **「モデル群を束ねる」— 複数 Expert の出力を合成する第一歩。**

## Objective

2つの Expert が同じプロンプトに独立に回答し、Master が合成する。

```
Prompt
  ↓
Heart of Wisdom
  ↓
Eye of Wisdom
  ↓
┌─────────┬─────────┐
Expert A  │ Expert B
(general) │ (math)
  ↓       │   ↓
  └───────┴───→ Synthesis → Final Answer
```

## Success Criteria

- [ ] 2 Experts generate independent responses
- [ ] Master receives both responses
- [ ] Synthesis produces a merged answer
- [ ] Synthesis quality > single expert (qualitative)
- [ ] Latency measured for parallel vs sequential

## Synthesis Strategies (to compare)

1. **Concatenation**: "Expert A says: ... Expert B says: ..."
2. **Voting**: Compare token sequences, pick majority
3. **LLM Synthesis**: Feed both outputs to a synthesis prompt
4. **Verifier**: Expert B checks Expert A's output

## Metrics

```
expert_a_tokens, expert_b_tokens
expert_a_time, expert_b_time
synthesis_time
total_time
parallel_efficiency = max(a_time, b_time) / total_time
```

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0003/run_cooperative.ts \
  --experts general,math \
  --synthesis llm
```

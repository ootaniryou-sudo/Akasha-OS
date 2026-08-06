/**
 * Team Learning — Caravan がチーム編成を学習する（Team Archive / Policy Archive）
 *
 * 1000 回仕事をすると、成功率の高いチーム編成（例: Vision→Physics→Coding 95%）
 * を自然に優先する。これは「モデルを再学習しない」OS レベルの運用知識。
 */

export interface TeamLearningRecord {
  teamKey: string; // 例: "planning>vision>physics>coding"
  successRate: number;
  samples: number;
  avgQuality: number;
}

export class TeamLearner {
  private stats = new Map<string, { wins: number; total: number; qualitySum: number }>();

  /** 実行結果を記録（EMA ではなく蓄積で成功率を更新） */
  record(teamKey: string, success: boolean, quality: number): void {
    const s = this.stats.get(teamKey) ?? { wins: 0, total: 0, qualitySum: 0 };
    s.total++;
    if (success) s.wins++;
    s.qualitySum += quality;
    this.stats.set(teamKey, s);
  }

  successRate(teamKey: string): number {
    const s = this.stats.get(teamKey);
    return s ? Math.round((s.wins / s.total) * 100) / 100 : 0.5; // 未観測は 0.5
  }

  samples(teamKey: string): number {
    return this.stats.get(teamKey)?.total ?? 0;
  }

  /** 複数のチーム候補から成功率が最も高いものを推奨（決定論） */
  recommend(candidates: string[]): string {
    let best = candidates[0];
    for (const c of candidates) {
      if (this.successRate(c) > this.successRate(best)) best = c;
    }
    return best;
  }

  /** 学習済みチームの一覧（成功率順） */
  all(): TeamLearningRecord[] {
    return [...this.stats.entries()]
      .map(([teamKey, s]) => ({
        teamKey,
        successRate: Math.round((s.wins / s.total) * 100) / 100,
        samples: s.total,
        avgQuality: Math.round((s.qualitySum / s.total) * 100) / 100,
      }))
      .sort((a, b) => b.successRate - a.successRate);
  }
}

/** Team Learning の表示 */
export function renderTeamLearning(l: TeamLearner): string {
  const rows = l.all();
  if (rows.length === 0) return '（まだチーム学習がありません）';
  return rows
    .map((r) => `  ${r.teamKey.padEnd(32)} success ${(r.successRate * 100).toFixed(0)}% · n=${r.samples} · q=${r.avgQuality.toFixed(2)}`)
    .join('\n');
}

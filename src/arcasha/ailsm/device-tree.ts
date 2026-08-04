/**
 * AI Device Tree（Phase 0.19）— 実行ノードの情報を記述する（Linux の Device Tree 相当）
 *
 * GPU / CPU / RAM / Battery / Network / Language / Cost をノード情報として保持。
 * ODAR はこれをルーティングの特徴量に使える。
 *
 *   例（PC）:  gpu=RTX4090, fp16, 24GB, latency=8ms, battery=∞
 *   例（スマホ）: cpu=A18, battery=75%, wifi=true, memory=8GB
 */

export interface DeviceInfo {
  id: string;
  arch: string;
  cpu: string;
  gpu?: string;
  ramMB: number;
  battery?: number; // %（未指定 = 外部電源）
  network?: boolean;
  language?: string;
  cost: number;
  features?: Record<string, string | number | boolean>;
}

export class DeviceTree {
  private readonly nodes = new Map<string, DeviceInfo>();

  registerNode(d: DeviceInfo): void {
    if (this.nodes.has(d.id)) throw new Error(`DeviceTree: 重複ノード ${d.id}`);
    this.nodes.set(d.id, d);
  }

  node(id: string): DeviceInfo | undefined {
    return this.nodes.get(id);
  }

  list(): DeviceInfo[] {
    return [...this.nodes.values()];
  }

  describe(): string {
    return this.list()
      .map((d) => {
        const parts = [
          `node=${d.id}`,
          `arch=${d.arch}`,
          `cpu=${d.cpu}`,
          d.gpu ? `gpu=${d.gpu}` : '',
          `ram=${d.ramMB}MB`,
          d.battery !== undefined ? `battery=${d.battery}%` : 'battery=∞',
          d.network === true ? 'wifi=true' : '',
          d.language ? `lang=${d.language}` : '',
          `cost=${d.cost}`,
        ].filter(Boolean);
        return `[${parts.join(' ')}]`;
      })
      .join('\n');
  }
}

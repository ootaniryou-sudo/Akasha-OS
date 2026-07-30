/**
 * cluster-guardian.ts
 *
 * Akasha OS — Cluster Guardian & Inter-Cluster Semantic Handover
 * ─────────────────────────────────────────────────────────────
 *
 * ## ① NIC Monitor（ネットワーク浮気防止）
 *
 *   Edge nodes constantly poll their active network interface.  If a
 *   switch from wired Ethernet to Wi-Fi is detected, the node immediately
 *   transitions to OFFLINE, notifies the master via an emergency
 *   DEREGISTER, and stops accepting COMPUTE_TASK dispatches.
 *
 *   Detection strategies (in priority order):
 *     a) Network Information API (`navigator.connection.type`) — browser
 *     b) `os.networkInterfaces()` polling — Node.js
 *     c) RTT spike heuristic — universal fallback (Wi-Fi adds 2-10ms jitter)
 *
 * ## ② Cluster Handover（思考のバトンタッチ）
 *
 *   When an expert cluster's output token stream contains a handover
 *   trigger (e.g. `<|handover:code|>`), the master:
 *     1. Extracts the current context tensor from the tail-band output.
 *     2. Looks up the target cluster in the plugin registry.
 *     3. Asynchronously pipelines the context tensor to the target
 *        cluster's head-band input nodes.
 *     4. Continues generation in the target cluster without dropping
 *        the accumulated KV-cache context.
 *
 *   The user perceives a seamless transition between experts.
 */

import { nowUs } from '../binary/protocol.js';

// ═════════════════════════════════════════════════════════════════════════════
// 1. Network Interface Monitor
// ═════════════════════════════════════════════════════════════════════════════

/** Detected network interface type. */
export const enum NicType {
  UNKNOWN = 0,
  ETHERNET = 1,
  WIFI = 2,
  CELLULAR = 3,
  /** No connectivity at all. */
  OFFLINE = 4,
}

/** NIC change event. */
export interface NicChangeEvent {
  from: NicType;
  to: NicType;
  timestampUs: bigint;
  /** Whether this change should trigger an emergency disconnect. */
  isEmergency: boolean;
}

export interface NicMonitorOptions {
  /** Polling interval in milliseconds (default: 500). */
  pollIntervalMs?: number;
  /** RTT spike threshold in microseconds (default: 5000 = 5ms). */
  rttSpikeThresholdUs?: number;
  /** Number of consecutive spikes before declaring WiFi switch. */
  spikeTolerance?: number;
  /** Called when NIC type changes. */
  onNicChange?: (ev: NicChangeEvent) => void;
  /** Called when Ethernet→WiFi switch is detected (emergency). */
  onEmergencyDisconnect?: (ev: NicChangeEvent) => void;
  /** External RTT measurement source (injected). */
  getCurrentRttUs?: () => number;
}

/**
 * Network Interface Card monitor.
 *
 * Detects wired→wireless transitions that would violate the
 * Akasha-OS latency requirements.  Wi-Fi adds 2-10ms of jitter
 * and is unacceptable for real-time tensor relay.
 */
export class NicMonitor {
  private readonly opts: Required<NicMonitorOptions>;
  private currentNic: NicType = NicType.UNKNOWN;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private spikeCount = 0;
  private running = false;

  /** Baseline RTT measured during Ethernet operation. */
  private rttBaselineUs = 500; // 0.5ms typical on 1GbE LAN

  constructor(options: NicMonitorOptions = {}) {
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? 500,
      rttSpikeThresholdUs: options.rttSpikeThresholdUs ?? 5_000,
      spikeTolerance: options.spikeTolerance ?? 3,
      onNicChange: options.onNicChange ?? (() => {}),
      onEmergencyDisconnect: options.onEmergencyDisconnect ?? (() => {}),
      getCurrentRttUs: options.getCurrentRttUs ?? (() => this.rttBaselineUs),
    };
  }

  /** Start monitoring. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Immediate initial detection
    this._detect();

    // Periodic polling
    this.pollTimer = setInterval(() => this._detect(), this.opts.pollIntervalMs);
    if (typeof this.pollTimer === 'object' && 'unref' in this.pollTimer) {
      this.pollTimer.unref();
    }
  }

  /** Stop monitoring. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Current detected NIC type. */
  get current(): NicType {
    return this.currentNic;
  }

  // ─── Detection ──────────────────────────────────────────────────────────

  private _detect(): void {
    const detected = this._detectNicType();
    if (detected === this.currentNic) return;

    const prev = this.currentNic;
    this.currentNic = detected;

    const event: NicChangeEvent = {
      from: prev,
      to: detected,
      timestampUs: nowUs(),
      isEmergency: prev === NicType.ETHERNET && detected === NicType.WIFI,
    };

    this.opts.onNicChange(event);

    if (event.isEmergency) {
      this.opts.onEmergencyDisconnect(event);
    }
  }

  /**
   * Detect the current NIC type using the best available API.
   *
   * Priority:
   *  1. Network Information API (browser)
   *  2. Node.js os.networkInterfaces()
   *  3. RTT heuristics (universal)
   */
  private _detectNicType(): NicType {
    // ── Strategy 1: Network Information API (Chromium-based browsers) ──
    try {
      const nav = globalThis.navigator as
        | { connection?: { type?: string; effectiveType?: string } }
        | undefined;
      if (nav?.connection) {
        const connType = nav.connection.type;
        if (connType === 'ethernet') return NicType.ETHERNET;
        if (connType === 'wifi') return NicType.WIFI;
        if (connType === 'cellular') return NicType.CELLULAR;
      }
      // Online check
      if (nav && typeof (nav as unknown as { onLine: boolean }).onLine === 'boolean') {
        if (!(nav as unknown as { onLine: boolean }).onLine) return NicType.OFFLINE;
      }
    } catch {
      // Not in a browser context
    }

    // ── Strategy 2: Node.js os.networkInterfaces() ──
    try {
      // Dynamic require to avoid bundling os in browser builds
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('node:os') as typeof import('node:os');
      const interfaces = os.networkInterfaces();
      for (const [, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (addr.internal) continue;
          // Ethernet interfaces typically have names like eth0, en0, enp*
          // Wi-Fi interfaces: wlan0, wlp*, en0 (macOS can be either)
          const name = addr.family === 'IPv4' ? '' : '';
          void name;
          // Check if the interface name suggests Ethernet
          const ifName = addr.address; // using as proxy; actual name not in this struct
          void ifName;
          // Heuristic: if we have any non-internal IPv4, assume Ethernet
          if (addr.family === 'IPv4') {
            // Use the interface name from the key
            const ifaceName = (Object.entries(interfaces).find(
              ([, a]) => a?.some(x => x.address === addr.address),
            ) ?? [''])[0];
            if (ifaceName.match(/^(eth|enp|en)/)) return NicType.ETHERNET;
            if (ifaceName.match(/^(wlan|wlp|wl)/)) return NicType.WIFI;
            return NicType.ETHERNET; // default assumption for wired servers
          }
        }
      }
    } catch {
      // os module not available (browser)
    }

    // ── Strategy 3: RTT heuristics ──
    return this._detectByRtt();
  }

  /**
   * Fallback: detect NIC type by RTT spike pattern.
   *
   * Wi-Fi adds 2-10ms of jitter compared to Ethernet's ~0.1-0.5ms.
   * A sustained RTT increase above the threshold for spikeTolerance
   * consecutive polls strongly suggests a switch to Wi-Fi.
   */
  private _detectByRtt(): NicType {
    const rtt = this.opts.getCurrentRttUs();

    if (rtt > this.opts.rttSpikeThresholdUs) {
      this.spikeCount++;
      if (this.spikeCount >= this.opts.spikeTolerance) {
        return NicType.WIFI;
      }
    } else {
      // RTT is normal → update baseline
      this.spikeCount = Math.max(0, this.spikeCount - 1);
      this.rttBaselineUs = (this.rttBaselineUs * 0.9 + rtt * 0.1) | 0;
      return NicType.ETHERNET;
    }

    return this.currentNic !== NicType.UNKNOWN ? this.currentNic : NicType.ETHERNET;
  }

  /** Update RTT baseline from external measurements. */
  updateRtt(rttUs: number): void {
    this.rttBaselineUs = (this.rttBaselineUs * 0.8 + rttUs * 0.2) | 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Inter-Cluster Semantic Handover
// ═════════════════════════════════════════════════════════════════════════════

/** Handover trigger sentinel embedded in the token stream. */
export interface HandoverTrigger {
  /** The trigger token pattern (e.g. "<|handover:code|>"). */
  tokenPattern: string;
  /** Target expert domain to hand over to. */
  targetDomain: string;
  /** Target cluster ID (resolved at runtime). */
  targetClusterId: number;
  /** Whether to preserve the KV-cache context across handover. */
  preserveContext: boolean;
}

/** A pending handover in-flight. */
export interface PendingHandover {
  /** Monotonically increasing handover ID. */
  handoverId: number;
  /** Source cluster ID (where the trigger was detected). */
  sourceClusterId: number;
  /** Target cluster ID. */
  targetClusterId: number;
  /** The context tensor to transfer. */
  contextTensor: Float32Array | null;
  /** KV-cache buffer reference (if preserveContext). */
  kvCache: ArrayBuffer | null;
  /** Token at which the handover was triggered. */
  triggerTokenIndex: number;
  /** Timestamp. */
  startedUs: bigint;
  /** Handover state. */
  state: 'pending' | 'transferring' | 'completed' | 'failed';
}

export interface HandoverOptions {
  /** Pre-registered handover triggers. */
  triggers?: HandoverTrigger[];
  /** Called to send context tensor to a target cluster node. */
  sendToCluster?: (clusterId: number, tensor: Float32Array, handoverId: number) => void;
  /** Called when a handover completes successfully. */
  onHandoverComplete?: (handover: PendingHandover) => void;
  /** Called when a handover fails. */
  onHandoverFailed?: (handover: PendingHandover, reason: string) => void;
  /** Resolve a domain name to a cluster ID at runtime. */
  resolveCluster?: (domain: string) => number;
}

// ─── Default handover triggers ─────────────────────────────────────────────

const DEFAULT_TRIGGERS: HandoverTrigger[] = [
  {
    tokenPattern: '<|handover:math|>',
    targetDomain: 'math',
    targetClusterId: 0,
    preserveContext: true,
  },
  {
    tokenPattern: '<|handover:code|>',
    targetDomain: 'code',
    targetClusterId: 0,
    preserveContext: true,
  },
  {
    tokenPattern: '<|handover:language|>',
    targetDomain: 'language',
    targetClusterId: 0,
    preserveContext: true,
  },
  {
    tokenPattern: '<|handover:general|>',
    targetDomain: 'general',
    targetClusterId: 0,
    preserveContext: false,
  },
];

/**
 * Manages seamless context transfer between expert clusters.
 *
 * When the token stream contains a handover trigger, this engine:
 *  1. Extracts the latest context tensor from the source cluster.
 *  2. Resolves the target cluster ID.
 *  3. Pipelines the context to the target cluster's head nodes.
 *  4. Continues generation without user-visible interruption.
 */
export class ClusterHandover {
  private readonly triggers: HandoverTrigger[];
  private readonly opts: HandoverOptions;

  /** Active handovers indexed by handoverId. */
  private readonly active = new Map<number, PendingHandover>();
  /** Cluster ID → domain name reverse index. */
  private readonly clusterDomains = new Map<number, string>();

  private nextHandoverId = 1;
  /** Token buffer for pattern detection (ring buffer of recent tokens). */
  private tokenRing: string[] = [];
  private readonly TOKEN_RING_SIZE = 32;

  constructor(options: HandoverOptions = {}) {
    this.triggers = options.triggers ?? DEFAULT_TRIGGERS;
    this.opts = options;

    // Build reverse index
    for (const t of this.triggers) {
      if (t.targetClusterId > 0) {
        this.clusterDomains.set(t.targetClusterId, t.targetDomain);
      }
    }
  }

  /**
   * Register a custom handover trigger at runtime.
   */
  registerTrigger(trigger: HandoverTrigger): void {
    // Avoid duplicates
    const exists = this.triggers.some(
      (t) => t.tokenPattern === trigger.tokenPattern,
    );
    if (!exists) {
      this.triggers.push(trigger);
    }
    if (trigger.targetClusterId > 0) {
      this.clusterDomains.set(trigger.targetClusterId, trigger.targetDomain);
    }
  }

  /**
   * Feed a newly produced token through the handover detector.
   *
   * @param tokenText    The decoded token string.
   * @param sourceClusterId  The cluster that produced this token.
   * @param contextTensor   The latest context tensor from the tail band.
   * @param kvCache      Optional KV-cache buffer (for context preservation).
   * @returns `true` if a handover was triggered (caller should stop
   *          generating in the source cluster).
   */
  feedToken(
    tokenText: string,
    sourceClusterId: number,
    contextTensor: Float32Array | null,
    kvCache: ArrayBuffer | null = null,
  ): boolean {
    // Maintain token ring buffer
    this.tokenRing.push(tokenText);
    if (this.tokenRing.length > this.TOKEN_RING_SIZE) {
      this.tokenRing.shift();
    }

    // Concatenate recent tokens for pattern matching
    const recentText = this.tokenRing.join('');

    // Check each trigger
    for (const trigger of this.triggers) {
      if (!recentText.includes(trigger.tokenPattern)) continue;

      // Resolve target cluster
      let targetClusterId = trigger.targetClusterId;
      if (targetClusterId === 0 && this.opts.resolveCluster) {
        targetClusterId = this.opts.resolveCluster(trigger.targetDomain);
      }
      if (targetClusterId === 0 || targetClusterId === sourceClusterId) {
        continue; // can't handover to self or unresolved
      }

      // Create handover
      const handover: PendingHandover = {
        handoverId: this.nextHandoverId++,
        sourceClusterId,
        targetClusterId,
        contextTensor,
        kvCache: trigger.preserveContext ? kvCache : null,
        triggerTokenIndex: 0,
        startedUs: nowUs(),
        state: 'pending',
      };

      this.active.set(handover.handoverId, handover);

      // Initiate async transfer
      this._executeHandover(handover);

      return true;
    }

    return false;
  }

  /**
   * Get the status of a handover by ID.
   */
  getHandover(handoverId: number): PendingHandover | undefined {
    return this.active.get(handoverId);
  }

  /**
   * Get all active (in-flight) handovers.
   */
  getActiveHandovers(): PendingHandover[] {
    return [...this.active.values()].filter(
      (h) => h.state === 'pending' || h.state === 'transferring',
    );
  }

  /**
   * Clean up completed handovers older than `maxAgeMs`.
   */
  gc(maxAgeMs = 60_000): void {
    const cutoff = nowUs() - BigInt(maxAgeMs) * 1000n;
    for (const [id, h] of this.active) {
      if (h.state === 'completed' || h.state === 'failed') {
        if (h.startedUs < cutoff) {
          this.active.delete(id);
        }
      }
    }
  }

  /** Number of registered triggers. */
  get triggerCount(): number {
    return this.triggers.length;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async _executeHandover(handover: PendingHandover): Promise<void> {
    handover.state = 'transferring';

    try {
      // Send context tensor to the target cluster's head nodes
      if (handover.contextTensor && this.opts.sendToCluster) {
        this.opts.sendToCluster(
          handover.targetClusterId,
          handover.contextTensor,
          handover.handoverId,
        );
      }

      // If KV-cache preservation is enabled, send that too
      if (handover.kvCache && this.opts.sendToCluster) {
        // KV-cache is sent as a separate transfer
        // (handled by the sendToCluster implementation)
        const kvFloats = new Float32Array(handover.kvCache);
        this.opts.sendToCluster(
          handover.targetClusterId,
          kvFloats,
          handover.handoverId,
        );
      }

      handover.state = 'completed';
      this.opts.onHandoverComplete?.(handover);
    } catch (err) {
      handover.state = 'failed';
      this.opts.onHandoverFailed?.(handover, String(err));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Emergency Disconnect Protocol
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Emergency disconnect handler.
 *
 * When the NIC monitor detects an Ethernet→WiFi switch, this handler:
 *  1. Immediately sets the node status to OFFLINE.
 *  2. Sends a DEREGISTER packet to the master.
 *  3. Flushes any in-flight compute tasks with an error.
 *  4. Stops accepting new COMPUTE_TASK dispatches.
 */
export class EmergencyDisconnect {
  private offline = false;
  private readonly onDeregister: () => void;
  private readonly onAbortTasks: (reason: string) => void;

  constructor(
    onDeregister: () => void,
    onAbortTasks: (reason: string) => void,
  ) {
    this.onDeregister = onDeregister;
    this.onAbortTasks = onAbortTasks;
  }

  /**
   * Execute emergency disconnect sequence.
   */
  trigger(reason: string): void {
    if (this.offline) return;
    this.offline = true;

    // 1. Abort all in-flight compute tasks
    this.onAbortTasks(reason);

    // 2. Send DEREGISTER to master
    this.onDeregister();

    // 3. Log the event
    log?.info?.(`[emergency-disconnect] ${reason}`);
  }

  get isOffline(): boolean {
    return this.offline;
  }
}

// ─── Logger shim (no dependency) ───────────────────────────────────────────

const log = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:console') as Console;
  } catch {
    return console;
  }
})();

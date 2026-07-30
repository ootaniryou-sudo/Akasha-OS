export interface AkashaOptions {
    port?: number;
    /** Ring slot payload capacity (bytes). */
    slotSize?: number;
    slotCount?: number;
    faultTickMs?: number;
    /** EWMA + margin for failover (microseconds). Default 2000 = +2ms. */
    marginUs?: number;
    onEvent?: (ev: AkashaEvent) => void;
}
export type AkashaEvent = {
    type: 'ready';
    port: number;
} | {
    type: 'register';
    nodeId: string;
    clusterId: number;
    cluster: string;
} | {
    type: 'dispatch';
    txId: string;
    nodeId: string;
    clusterId: number;
    cluster: string;
    prompt: string;
} | {
    type: 'result';
    txId: string;
    nodeId: string;
    latencyUs: number;
    sample: number[];
    failover: boolean;
} | {
    type: 'failover';
    txId: string;
    primary: string;
    shadow: string;
} | {
    type: 'queue';
    reason: string;
    clusterId: number;
    cluster: string;
} | {
    type: 'node_gone';
    nodeId: string;
} | {
    type: 'stats';
    nodes: number;
    inFlight: number;
    idleGeneral: number;
    idleMath: number;
    idleShadow: number;
} | {
    type: 'error';
    err: string;
};
/**
 * Akasha OS Core — main-thread façade.
 *
 * Architecture:
 *   Main  ──control SAB──►  Router Worker  ◄──inbound SAB──  Network Worker
 *                           │                ──outbound SAB──►  (WebSocket mesh)
 *                           └─ IdleClusterPool + FaultTolerance
 *
 * JSON is never used on the data plane. Activation tensors ride as raw f32.
 */
export declare class AkashaOrchestrator {
    private readonly opts;
    private netWorker;
    private routerWorker;
    private controlRing;
    private started;
    constructor(options?: AkashaOptions);
    start(): Promise<void>;
    /**
     * Submit a prompt + seed activation tensor (zero JSON).
     * Encoded into the control SAB for the router worker.
     */
    submitPrompt(prompt: string, activation?: Float32Array): boolean;
    stop(): Promise<void>;
}
//# sourceMappingURL=orchestrator.d.ts.map
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SharedRingBuffer, RING_CTRL_BYTES } from '../ipc/ring-buffer.js';
import { HEADER_SIZE, MAX_PACKET_BYTES } from '../binary/protocol.js';
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
export class AkashaOrchestrator {
    opts;
    netWorker = null;
    routerWorker = null;
    controlRing = null;
    started = false;
    constructor(options = {}) {
        this.opts = {
            port: options.port ?? 8080,
            slotSize: options.slotSize ?? MAX_PACKET_BYTES + 16,
            slotCount: options.slotCount ?? 4096,
            faultTickMs: options.faultTickMs ?? 1,
            marginUs: options.marginUs ?? 2_000,
            onEvent: options.onEvent,
        };
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        const ringCfg = { slotSize: this.opts.slotSize, slotCount: this.opts.slotCount };
        const inbound = SharedRingBuffer.create(ringCfg);
        const outbound = SharedRingBuffer.create(ringCfg);
        const controlCfg = { slotSize: 8192, slotCount: 512 };
        this.controlRing = SharedRingBuffer.create(controlCfg);
        const here = path.dirname(fileURLToPath(import.meta.url));
        // Always load compiled workers (.js). Run `npm run build` before start/sim.
        const netPath = path.join(here, '../workers/network-worker.js');
        const routerPath = path.join(here, '../workers/router-worker.js');
        const { existsSync } = await import('node:fs');
        if (!existsSync(netPath) || !existsSync(routerPath)) {
            throw new Error(`Worker bundles missing at ${netPath}. Run \`npm run build\` first.`);
        }
        this.netWorker = new Worker(netPath, {
            workerData: {
                port: this.opts.port,
                inboundSab: inbound.sab,
                outboundSab: outbound.sab,
                slotSize: ringCfg.slotSize,
                slotCount: ringCfg.slotCount,
            },
        });
        this.routerWorker = new Worker(routerPath, {
            workerData: {
                inboundSab: inbound.sab,
                outboundSab: outbound.sab,
                controlSab: this.controlRing.sab,
                slotSize: ringCfg.slotSize,
                slotCount: ringCfg.slotCount,
                controlSlotSize: controlCfg.slotSize,
                controlSlotCount: controlCfg.slotCount,
                faultTickMs: this.opts.faultTickMs,
                marginUs: this.opts.marginUs,
            },
        });
        const emit = (ev) => this.opts.onEvent?.(ev);
        this.netWorker.on('message', (msg) => {
            if (msg.type === 'ready')
                emit({ type: 'ready', port: this.opts.port });
            else
                emit(msg);
        });
        this.netWorker.on('error', (err) => emit({ type: 'error', err: String(err) }));
        this.routerWorker.on('message', (msg) => {
            if (msg.type === 'ready')
                return; // network worker owns bind-ready
            emit(msg);
        });
        this.routerWorker.on('error', (err) => emit({ type: 'error', err: String(err) }));
        // Wait until network worker binds
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('network worker start timeout')), 10_000);
            const onMsg = (msg) => {
                if (msg.type === 'ready') {
                    clearTimeout(t);
                    this.netWorker?.off('message', onMsg);
                    resolve();
                }
            };
            this.netWorker?.on('message', onMsg);
            this.netWorker?.once('error', (e) => {
                clearTimeout(t);
                reject(e);
            });
        });
        console.log(`📡 Akasha OS Core online :${this.opts.port} | header=${HEADER_SIZE}B | ring=${ringCfg.slotCount}×${ringCfg.slotSize}B | ctrl=${RING_CTRL_BYTES}B`);
    }
    /**
     * Submit a prompt + seed activation tensor (zero JSON).
     * Encoded into the control SAB for the router worker.
     */
    submitPrompt(prompt, activation) {
        if (!this.controlRing)
            throw new Error('not started');
        const act = activation ?? new Float32Array([0.12, -0.45, 0.89, 0.33]);
        const promptBytes = new TextEncoder().encode(prompt);
        // [u8 kind][u32 promptLen][utf8][u32 floatCount][f32...]
        const total = 1 + 4 + promptBytes.length + 4 + act.byteLength;
        const frame = new Uint8Array(total);
        frame[0] = 6 /* IpcKind.SUBMIT_PROMPT */;
        const dv = new DataView(frame.buffer);
        dv.setUint32(1, promptBytes.length, true);
        frame.set(promptBytes, 5);
        dv.setUint32(5 + promptBytes.length, act.length, true);
        new Float32Array(frame.buffer, 5 + promptBytes.length + 4, act.length).set(act);
        let ok = this.controlRing.tryPush(frame, total);
        if (!ok) {
            this.controlRing.waitForSpace(10);
            ok = this.controlRing.tryPush(frame, total);
        }
        return ok;
    }
    async stop() {
        await Promise.all([
            this.netWorker?.terminate(),
            this.routerWorker?.terminate(),
        ]);
        this.netWorker = null;
        this.routerWorker = null;
        this.controlRing = null;
        this.started = false;
    }
}
//# sourceMappingURL=orchestrator.js.map
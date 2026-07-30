/**
 * WebGPU expert — browser-oriented; typed loosely so Node `tsc` stays clean.
 */
import { BinaryCodec } from '../binary/codec.js';
import { Cmd, HEADER_SIZE, MAX_PACKET_BYTES } from '../binary/protocol.js';
export declare function createWebGpuExpert(): Promise<{
    forward: (input: Float32Array) => Promise<Float32Array>;
    destroy: () => void;
}>;
export { BinaryCodec, Cmd, HEADER_SIZE, MAX_PACKET_BYTES };
//# sourceMappingURL=webgpu-expert.d.ts.map
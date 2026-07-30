import { AkashaOrchestrator } from './core/orchestrator.js';
import { AkashaInferenceLoop } from './core/inference-loop.js';
import { LogitTournament, HubAggregator, MasterSampler } from './core/logit-aggregator.js';
import { ShardAllocator } from './core/shard-allocator.js';
import { AkashaBootstrapper } from './bootstrap/akasha-bootstrapper.js';
import { AkashaEdgeNode } from './client/node-client.js';
import { ClusterId } from './binary/protocol.js';
import { BinaryCodec } from './binary/codec.js';
import { IdleClusterPool } from './structures/idle-cluster-pool.js';
import { SharedRingBuffer } from './ipc/ring-buffer.js';
import { ObjectPool, BufferPool } from './pool/object-pool.js';
import { FaultToleranceEngine, createTxPool, routeCluster, createDynamicRouter } from './fault/fault-tolerance.js';
import { DoublyLinkedList } from './structures/doubly-linked-list.js';
import { HEADER_SIZE, MAGIC, PROTOCOL_VERSION, Cmd, Flag, MAX_PACKET_BYTES } from './binary/protocol.js';
import { PluginRegistry } from './plugin/registry.js';
import { isLifecyclePlugin } from './plugin/types.js';

export {
  AkashaOrchestrator,
  AkashaInferenceLoop,
  LogitTournament,
  HubAggregator,
  MasterSampler,
  ShardAllocator,
  AkashaBootstrapper,
  AkashaEdgeNode,
  ClusterId,
  BinaryCodec,
  IdleClusterPool,
  SharedRingBuffer,
  ObjectPool,
  BufferPool,
  FaultToleranceEngine,
  createTxPool,
  routeCluster,
  createDynamicRouter,
  PluginRegistry,
  isLifecyclePlugin,
  DoublyLinkedList,
  HEADER_SIZE,
  MAGIC,
  PROTOCOL_VERSION,
  Cmd,
  Flag,
  MAX_PACKET_BYTES,
};

export type { AkashaOptions, AkashaEvent } from './core/orchestrator.js';
export type { InferenceLoopOptions, InferenceEvent, LayerBand, RelayTarget, PipelineStep } from './core/inference-loop.js';
export type { BootstrapOptions, BootstrapEvent, BootstrapCtx } from './bootstrap/akasha-bootstrapper.js';
export type { EdgeNodeOptions, EdgeComputeHandler } from './client/node-client.js';
export type {
  TokenCandidate,
  TopKPacket,
  HubAggregation,
  SamplingConfig,
} from './core/logit-aggregator.js';
export type {
  ModelSpec,
  DeviceSpec,
  ShardRecord,
  AllocationPlan,
  ShardType,
} from './core/shard-allocator.js';
export { SHARD_TYPE_NAMES, layerBytes, totalModelBytes, buildNodeToShards, shardsForNode } from './core/shard-allocator.js';
export type {
  AkashaExpertPlugin,
  AkashaLifecyclePlugin,
  PluginMetadata,
  PluginManifest,
  PluginHealthStatus,
  ExpertDomain,
  PluginClusterId,
} from './plugin/types.js';
export type { PluginRegistryEvent } from './plugin/registry.js';

/** CLI entry: `npm run dev` */
async function main(): Promise<void> {
  if (process.argv[1] && /index\.(js|ts)$/.test(process.argv[1])) {
    const orch = new AkashaOrchestrator({
      port: Number(process.env.AKASHA_PORT ?? 8080),
      onEvent: (ev) => {
        if (ev.type === 'dispatch') {
          console.log(`⚡ [${ev.txId}] "${ev.prompt}" → ${ev.cluster} @ node ${ev.nodeId}`);
        } else if (ev.type === 'result') {
          console.log(
            `✅ [${ev.txId}] node=${ev.nodeId} ${ev.latencyUs}μs sample=[${ev.sample.map((x) => x.toFixed(3)).join(', ')}]${ev.failover ? ' (via shadow)' : ''}`,
          );
        } else if (ev.type === 'failover') {
          console.log(`🛡️  failover tx=${ev.txId} primary=${ev.primary} → shadow=${ev.shadow}`);
        } else if (ev.type === 'register') {
          console.log(`📱 node ${ev.nodeId} joined ${ev.cluster}`);
        } else if (ev.type === 'stats') {
          console.log(
            `📊 nodes=${ev.nodes} inFlight=${ev.inFlight} idle[G/M/S]=${ev.idleGeneral}/${ev.idleMath}/${ev.idleShadow}`,
          );
        } else if (ev.type === 'error') {
          console.error('⚠️', ev.err);
        }
      },
    });
    await orch.start();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

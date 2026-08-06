/**
 * akasha-plugin/index.ts — barrel export
 */
export type {
  AkashaExpertPlugin,
  AkashaLifecyclePlugin,
  PluginMetadata,
  PluginManifest,
  PluginHealthStatus,
  ExpertDomain,
  PluginClusterId,
} from './types.js';
export { isLifecyclePlugin } from './types.js';
export { PluginRegistry } from './registry.js';
export type { PluginRegistryEvent } from './registry.js';

/**
 * akasha-plugin-registry.ts
 *
 * Akasha OS — Plugin Registry & Hot-Plug Engine
 * ─────────────────────────────────────────────
 * Manages the lifecycle of every AkashaExpertPlugin registered with the
 * orchestrator.  Provides the dynamic routing table that the semantic
 * router queries at inference time.
 *
 * ## Hot-plug flow
 *
 *   1. Developer writes a plugin implementing `AkashaExpertPlugin`.
 *   2. `registry.install(plugin)` → assigns a clusterId, indexes keywords.
 *   3. Semantic router immediately picks up the new keywords → O(1) lookup.
 *   4. `registry.uninstall(pluginId)` → de-indexes, calls onUnregister().
 *
 * No orchestrator restart required.
 */

import type {
  AkashaExpertPlugin,
  PluginManifest,
  PluginHealthStatus,
  ExpertDomain,
} from './types.js';
import { isLifecyclePlugin } from './types.js';

// ─── Registry event types ───────────────────────────────────────────────────

export type PluginRegistryEvent =
  | { type: 'installed'; pluginId: string; clusterId: number; domain: ExpertDomain }
  | { type: 'uninstalled'; pluginId: string }
  | { type: 'health_changed'; pluginId: string; healthy: boolean }
  | { type: 'error'; pluginId: string; error: string };

// ─── Internal bookkeeping ───────────────────────────────────────────────────

interface PluginEntry {
  plugin: AkashaExpertPlugin;
  clusterId: number;
  installedAtMs: number;
  totalInferences: number;
  totalLatencyUs: number;
  healthy: boolean;
  lastError: string | null;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class PluginRegistry {
  /** pluginId → PluginEntry */
  private readonly plugins = new Map<string, PluginEntry>();
  /** clusterId → pluginId */
  private readonly clusterToPlugin = new Map<number, string>();
  /** Lowercase keyword → set of pluginIds (O(1) lookup per keyword). */
  private readonly keywordIndex = new Map<string, Set<string>>();
  /** domain → set of pluginIds */
  private readonly domainIndex = new Map<ExpertDomain, Set<string>>();

  private nextClusterId = 100; // start above built-in clusters (1-99)
  private eventListener: ((ev: PluginRegistryEvent) => void) | null = null;

  // ─── Public API ─────────────────────────────────────────────────────────

  onEvent(fn: (ev: PluginRegistryEvent) => void): void {
    this.eventListener = fn;
  }

  private emit(ev: PluginRegistryEvent): void {
    this.eventListener?.(ev);
  }

  /**
   * Install a plugin into the swarm.
   *
   * 1. Validates metadata.
   * 2. Assigns a unique clusterId (or uses preferredClusterId if free).
   * 3. Indexes keywords for semantic routing.
   * 4. Calls onRegister() if the plugin implements lifecycle hooks.
   * 5. Returns the assigned clusterId.
   *
   * @throws if pluginId already registered.
   */
  async install(plugin: AkashaExpertPlugin): Promise<number> {
    const { metadata } = plugin;
    if (this.plugins.has(metadata.id)) {
      throw new Error(`Plugin "${metadata.id}" is already registered.`);
    }

    // Assign clusterId
    let clusterId = metadata.preferredClusterId;
    if (clusterId === 0 || this.clusterToPlugin.has(clusterId)) {
      clusterId = this.nextClusterId++;
      while (this.clusterToPlugin.has(clusterId)) {
        clusterId = this.nextClusterId++;
      }
    }

    // Lifecycle: onRegister
    if (isLifecyclePlugin(plugin) && plugin.onRegister) {
      try {
        await plugin.onRegister();
      } catch (err) {
        throw new Error(
          `Plugin "${metadata.id}" onRegister() failed: ${String(err)}`,
        );
      }
    }

    const entry: PluginEntry = {
      plugin,
      clusterId,
      installedAtMs: Date.now(),
      totalInferences: 0,
      totalLatencyUs: 0,
      healthy: true,
      lastError: null,
    };

    this.plugins.set(metadata.id, entry);
    this.clusterToPlugin.set(clusterId, metadata.id);
    this.indexKeywords(metadata.id, metadata.keywords);
    this.indexDomain(metadata.id, metadata.expertDomain);

    this.emit({
      type: 'installed',
      pluginId: metadata.id,
      clusterId,
      domain: metadata.expertDomain,
    });

    return clusterId;
  }

  /**
   * Remove a plugin and release its clusterId.
   */
  async uninstall(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;

    // Lifecycle: onUnregister
    const plugin = entry.plugin;
    if (isLifecyclePlugin(plugin) && plugin.onUnregister) {
      try {
        await plugin.onUnregister();
      } catch {
        // best-effort teardown
      }
    }

    this.deindexKeywords(pluginId, plugin.metadata.keywords);
    this.deindexDomain(pluginId, plugin.metadata.expertDomain);
    this.clusterToPlugin.delete(entry.clusterId);
    this.plugins.delete(pluginId);

    this.emit({ type: 'uninstalled', pluginId });
  }

  /** Get a plugin by id. */
  get(pluginId: string): AkashaExpertPlugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  /** Get a plugin by its assigned clusterId. */
  getByCluster(clusterId: number): AkashaExpertPlugin | undefined {
    const pluginId = this.clusterToPlugin.get(clusterId);
    if (!pluginId) return undefined;
    return this.plugins.get(pluginId)?.plugin;
  }

  /** Resolve the plugin associated with a clusterId (for inference dispatch). */
  pluginForCluster(clusterId: number): AkashaExpertPlugin | null {
    const pluginId = this.clusterToPlugin.get(clusterId);
    if (!pluginId) return null;
    return this.plugins.get(pluginId)?.plugin ?? null;
  }

  /** List all installed plugin ids. */
  list(): string[] {
    return [...this.plugins.keys()];
  }

  /** Number of installed plugins. */
  get size(): number {
    return this.plugins.size;
  }

  // ─── Semantic routing ────────────────────────────────────────────────────

  /**
   * Route a user prompt to the best-matching plugin cluster.
   *
   * Strategy (fast path, no alloc):
   * 1. Scan prompt for known keywords → if match, return that plugin's clusterId.
   * 2. Fall back to built-in domain heuristics.
   * 3. Ultimate fallback: GENERAL (ClusterId=1).
   *
   * @returns clusterId (guaranteed ≥ 1).
   */
  route(prompt: string, fallbackClusterId = 1): number {
    // 1. Keyword scan (single pass, no toLowerCase alloc)
    const len = prompt.length;
    for (const [keyword, pluginIds] of this.keywordIndex) {
      if (this._containsWord(prompt, keyword, len)) {
        // Return the first plugin that matches (deterministic via insertion order)
        for (const pid of pluginIds) {
          const entry = this.plugins.get(pid);
          if (entry && entry.healthy) return entry.clusterId;
        }
      }
    }

    // 2. Domain heuristics (built-in static rules)
    const domain = this._guessDomain(prompt);
    const domainPlugins = this.domainIndex.get(domain);
    if (domainPlugins && domainPlugins.size > 0) {
      for (const pid of domainPlugins) {
        const entry = this.plugins.get(pid);
        if (entry && entry.healthy) return entry.clusterId;
      }
    }

    // 3. Fallback
    return fallbackClusterId;
  }

  /**
   * Get all keywords that would route to a given clusterId.
   * Useful for UI auto-complete / documentation generation.
   */
  keywordsForCluster(clusterId: number): string[] {
    const result: string[] = [];
    for (const [keyword, pluginIds] of this.keywordIndex) {
      const pluginId = this.clusterToPlugin.get(clusterId);
      if (pluginId && pluginIds.has(pluginId)) {
        result.push(keyword);
      }
    }
    return result;
  }

  // ─── Health & stats ──────────────────────────────────────────────────────

  /** Record a completed inference for latency tracking. */
  recordInference(pluginId: string, latencyUs: number): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    entry.totalInferences++;
    entry.totalLatencyUs += latencyUs;
  }

  /** Mark a plugin as unhealthy (e.g. repeated timeouts). */
  markUnhealthy(pluginId: string, error: string): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    entry.healthy = false;
    entry.lastError = error;
    this.emit({ type: 'health_changed', pluginId, healthy: false });
  }

  /** Restore plugin health (e.g. after successful inference). */
  markHealthy(pluginId: string): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    if (!entry.healthy) {
      entry.healthy = true;
      entry.lastError = null;
      this.emit({ type: 'health_changed', pluginId, healthy: true });
    }
  }

  /** Run health checks on all lifecycle-aware plugins. */
  async runHealthChecks(): Promise<Map<string, PluginHealthStatus>> {
    const results = new Map<string, PluginHealthStatus>();
    for (const [id, entry] of this.plugins) {
      const plugin = entry.plugin;
      if (isLifecyclePlugin(plugin) && plugin.onHealthCheck) {
        try {
          const status = await plugin.onHealthCheck();
          results.set(id, status);
          if (!status.healthy) {
            this.markUnhealthy(id, status.lastError ?? 'health check failed');
          } else {
            this.markHealthy(id);
          }
        } catch (err) {
          this.markUnhealthy(id, String(err));
          results.set(id, {
            healthy: false,
            uptimeSeconds: 0,
            totalInferences: 0,
            averageLatencyUs: 0,
            lastError: String(err),
          });
        }
      }
    }
    return results;
  }

  /** Get plugin statistics for dashboard. */
  stats(pluginId: string): PluginEntry | undefined {
    return this.plugins.get(pluginId);
  }

  allStats(): PluginEntry[] {
    return [...this.plugins.values()];
  }

  // ─── Manifest-based bulk loading ─────────────────────────────────────────

  /**
   * Load and install plugins from an array of manifests.
   * Each manifest's `entry` is dynamic-imported; the default export
   * must satisfy `AkashaExpertPlugin`.
   */
  async loadManifests(manifests: PluginManifest[]): Promise<number> {
    let installed = 0;
    for (const manifest of manifests) {
      if (!manifest.autoRegister) continue;
      try {
        const mod = await import(manifest.entry);
        const plugin: AkashaExpertPlugin = mod.default ?? mod;
        if (manifest.metadata) {
          // Shallow-merge manifest metadata overrides
          Object.assign(plugin.metadata, manifest.metadata);
        }
        await this.install(plugin);
        installed++;
      } catch (err) {
        this.emit({
          type: 'error',
          pluginId: manifest.entry,
          error: `Failed to load manifest: ${String(err)}`,
        });
      }
    }
    return installed;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private indexKeywords(pluginId: string, keywords: string[]): void {
    for (const kw of keywords) {
      const lower = kw.toLowerCase();
      let set = this.keywordIndex.get(lower);
      if (!set) {
        set = new Set();
        this.keywordIndex.set(lower, set);
      }
      set.add(pluginId);
    }
  }

  private deindexKeywords(pluginId: string, keywords: string[]): void {
    for (const kw of keywords) {
      const lower = kw.toLowerCase();
      const set = this.keywordIndex.get(lower);
      if (set) {
        set.delete(pluginId);
        if (set.size === 0) this.keywordIndex.delete(lower);
      }
    }
  }

  private indexDomain(pluginId: string, domain: ExpertDomain): void {
    let set = this.domainIndex.get(domain);
    if (!set) {
      set = new Set();
      this.domainIndex.set(domain, set);
    }
    set.add(pluginId);
  }

  private deindexDomain(pluginId: string, domain: ExpertDomain): void {
    const set = this.domainIndex.get(domain);
    if (set) {
      set.delete(pluginId);
      if (set.size === 0) this.domainIndex.delete(domain);
    }
  }

  /**
   * Case-insensitive whole-word substring match.
   * Scans once, no allocation, no toLowerCase() on the full prompt.
   */
  private _containsWord(hay: string, needle: string, hayLen: number): boolean {
    const nLen = needle.length;
    if (nLen === 0 || nLen > hayLen) return false;

    outer: for (let i = 0; i <= hayLen - nLen; i++) {
      // Word-boundary check: match only at word start
      if (i > 0) {
        const prev = hay.charCodeAt(i - 1);
        // Allow word boundary: space, punctuation, start-of-string
        if (
          prev !== 32 && // space
          !(prev >= 65 && prev <= 90) && // A-Z
          !(prev >= 97 && prev <= 122) && // a-z
          !(prev >= 48 && prev <= 57) // 0-9
        ) {
          continue;
        }
      }

      for (let j = 0; j < nLen; j++) {
        let a = hay.charCodeAt(i + j);
        let b = needle.charCodeAt(j);
        // Fast ASCII case-fold
        if (a >= 65 && a <= 90) a += 32;
        if (b >= 65 && b <= 90) b += 32;
        if (a !== b) continue outer;
      }

      // Check word-end boundary
      const endIdx = i + nLen;
      if (endIdx < hayLen) {
        const next = hay.charCodeAt(endIdx);
        if (
          next !== 32 &&
          !(next >= 65 && next <= 90) &&
          !(next >= 97 && next <= 122) &&
          !(next >= 48 && next <= 57)
        ) {
          // Not a word boundary — this might be intentional for compound words
          // For strict word matching, uncomment:
          // continue;
        }
      }

      return true;
    }
    return false;
  }

  /**
   * Cheap domain guess from prompt content.
   * Used as fallback when no plugin keyword matches.
   */
  private _guessDomain(prompt: string): ExpertDomain {
    const len = prompt.length;
    let hasDigit = false;
    let hasMathOp = false;
    let hasCodeKW = false;

    for (let i = 0; i < len; i++) {
      const c = prompt.charCodeAt(i);
      if (c >= 48 && c <= 57) hasDigit = true;
      else if (c === 43 || c === 45 || c === 42 || c === 47 || c === 61)
        hasMathOp = true;
    }

    if (hasDigit && hasMathOp) return 'math';
    if (this._containsWord(prompt, 'function', len) || this._containsWord(prompt, 'code', len))
      hasCodeKW = true;
    if (hasCodeKW) return 'code';
    if (this._containsWord(prompt, 'diagnos', len) || this._containsWord(prompt, 'patient', len))
      return 'medical';

    return 'general';
  }
}

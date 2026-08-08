/**
 * arcasha — ArcAsha meta package (公開 API)
 *
 * 4 パッケージ (arcasha-core / arcasha-belief / arcasha-router /
 * arcasha-orchestrator) を 1 本の import にまとめたメタパッケージ。
 *
 *   import { LinUCBShadowRouter, ArcAshaController } from 'arcasha';
 *
 * 個別に使いたい場合は npm i arcasha-router / arcasha-orchestrator も可能。
 */

// arcasha-router が core + belief も再エクスポートしているため、これだけで全 API が揃う
export * from 'arcasha-router';
export * from 'arcasha-orchestrator';


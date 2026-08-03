import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

/// Metal 推論エンジン — ネイティブ (llama.cpp + ggml-metal, MethodChannel 'arcasha/metal') を呼ぶ。
class MetalEngine {
  MetalEngine._();
  static final MetalEngine instance = MetalEngine._();

  static const _channel = MethodChannel('arcasha/metal');
  static const modelAsset = 'assets/models/smollm2-135m-instruct-q4_k_m.gguf';
  static const modelFileName = 'smollm2-135m-instruct-q4_k_m.gguf';
  static const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';

  bool _loaded = false;
  bool get isLoaded => _loaded;

  /// アセットの GGUF を Application Support に展開してパスを返す (初回のみコピー)。
  Future<String> _ensureModelFile() async {
    final dir = await getApplicationSupportDirectory();
    final file = File('${dir.path}/$modelFileName');
    if (!await file.exists()) {
      final data = await rootBundle.load(modelAsset);
      await file.writeAsBytes(data.buffer.asUint8List(), flush: true);
    }
    return file.path;
  }

  /// モデルをロード (Metal に全層オフロード)。成功で true。
  Future<bool> load({int nCtx = 2048, int nThreads = 4}) async {
    final path = await _ensureModelFile();
    final ok = await _channel.invokeMethod<bool>('load', {
      'path': path,
      'nCtx': nCtx,
      'nThreads': nThreads,
    });
    _loaded = ok ?? false;
    return _loaded;
  }

  /// 同期生成 (ネイティブ側はバックグラウンドで実行)。
  Future<Map<String, dynamic>> generate(
    String prompt, {
    int maxNewTokens = 64,
    double temperature = 0.0,
  }) async {
    final res = await _channel.invokeMapMethod<String, dynamic>('generate', {
      'prompt': prompt,
      'maxNewTokens': maxNewTokens,
      'temperature': temperature,
    });
    return res ?? {'error': 'no result'};
  }

  Future<bool> unload() async {
    _loaded = false;
    return await _channel.invokeMethod<bool>('unload') ?? true;
  }
}

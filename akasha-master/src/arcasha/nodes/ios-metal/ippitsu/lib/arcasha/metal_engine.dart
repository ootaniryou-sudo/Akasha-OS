import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

/// Metal 推論エンジン — ネイティブ (llama.cpp + ggml-metal, MethodChannel 'arcasha/metal') を呼ぶ。
class MetalEngine {
  MetalEngine._();
  static final MetalEngine instance = MetalEngine._();

  static const _channel = MethodChannel('arcasha/metal');
  static const modelAsset = 'assets/models/qwen2.5-1.5b-instruct-q4_k_m.gguf';
  static const modelFileName = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';
  static const modelId = 'Qwen/Qwen2.5-1.5B-Instruct';

  bool _loaded = false;
  bool get isLoaded => _loaded;

  /// 端末情報を取得 (iPad / iPhone の判別に使用)。
  static Future<Map<String, dynamic>> deviceInfo() async {
    final res = await _channel.invokeMapMethod<String, dynamic>('deviceInfo');
    return res ?? {};
  }

  /// Application Support 内のダウンロード済みモデル一覧を返す (サイズ降順)。
  Future<List<Map<String, dynamic>>> listModels() async {
    final dir = await getApplicationSupportDirectory();
    final models = dir.listSync().whereType<File>()
        .where((f) => f.path.endsWith('.gguf'))
        .map((f) => <String, dynamic>{
              'name': f.uri.pathSegments.last,
              'size': f.lengthSync(),
            })
        .toList()
      ..sort((a, b) => (b['size'] as int).compareTo(a['size'] as int));
    return models;
  }

  /// 指定したダウンロード済みモデルファイルを削除する。
  Future<bool> deleteModel(String filename) async {
    try {
      final dir = await getApplicationSupportDirectory();
      final file = File('${dir.path}/$filename');
      if (await file.exists()) {
        await file.delete();
        return true;
      }
    } catch (_) {}
    return false;
  }

  /// アセットの GGUF を Application Support に展開してパスを返す。
  /// 1B モデル (約800MB) 対応:
  ///  - iOS では flutter_assets がアプリバンドル内の実ファイルなので、直接コピー
  ///    (rootBundle.load のように 800MB をメモリに載せず、ストリーミングで高速・省メモリ)
  ///  - **サイズ検証付き**: 既存ファイルのサイズがバンドルと一致しない場合は破損とみなして再コピー
  ///    (中断されたコピー/rootBundle.load 失敗で残った破損ファイルを自己修復)
  Future<String> _ensureModelFile() async {
    final dir = await getApplicationSupportDirectory();
    final file = File('${dir.path}/$modelFileName');

    // バンドル内ソースのパス (iOS: Runner.app/Frameworks/App.framework/flutter_assets)
    File? src;
    try {
      final exe = Platform.resolvedExecutable; // .../Runner.app/Runner
      final bundleDir = File(exe).parent.path;  // .../Runner.app
      final s = File('$bundleDir/Frameworks/App.framework/flutter_assets/$modelAsset');
      if (await s.exists()) src = s;
    } catch (_) {}

    final exists = await file.exists();
    final sizeOk = exists && src != null && await file.length() == await src.length();

    if (!sizeOk) {
      if (exists) {
        try { await file.delete(); } catch (_) {}
      }
      if (src != null) {
        await src.copy(file.path); // ストリーミングコピー (メモリ圧なし)
      } else {
        // フォールバック: rootBundle.load + チャンク書き込み
        final data = await rootBundle.load(modelAsset);
        final bytes = data.buffer.asUint8List();
        final raf = file.openSync(mode: FileMode.write);
        try {
          const chunk = 1 << 20; // 1MB
          for (int i = 0; i < bytes.length; i += chunk) {
            final len = math.min(chunk, bytes.length - i);
            raf.writeFromSync(bytes, i, len);
          }
        } finally {
          raf.closeSync();
        }
      }
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

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'metal_engine.dart';

enum NodeStatus { disconnected, connecting, registered, error }

/// 現在のノード状態 (UI 表示用スナップショット)。
class NodeSnapshot {
  final NodeStatus status;
  final String nodeId;
  final String hubUrl;
  final double? stability;
  final int tasksServed;
  final int totalTokens;
  final int totalMs;
  final String? lastError;

  NodeSnapshot({
    required this.status,
    required this.nodeId,
    required this.hubUrl,
    this.stability,
    this.tasksServed = 0,
    this.totalTokens = 0,
    this.totalMs = 0,
    this.lastError,
  });
}

/// ArcAsha WS ノードクライアント — ハブ (ExpertHub) のプロトコルと 1:1 対応。
///
/// register → register_ack / ping→pong / compute→(Metal 生成)→result
class ArcAshaNodeClient {
  ArcAshaNodeClient({
    required this.hubUrl,
    required this.nodeId,
    required this.engine,
    required this.onLog,
    required this.onState,
  });

  final String hubUrl;
  final String nodeId;
  final MetalEngine engine;
  final void Function(String) onLog;
  final void Function(NodeSnapshot) onState;

  WebSocketChannel? _ws;
  StreamSubscription<dynamic>? _sub;
  bool _running = false;

  NodeStatus _status = NodeStatus.disconnected;
  double? _stability;
  int _tasksServed = 0;
  int _totalTokens = 0;
  int _totalMs = 0;
  String? _lastError;

  void _emit() {
    onState(NodeSnapshot(
      status: _status,
      nodeId: nodeId,
      hubUrl: hubUrl,
      stability: _stability,
      tasksServed: _tasksServed,
      totalTokens: _totalTokens,
      totalMs: _totalMs,
      lastError: _lastError,
    ));
  }

  /// 接続を開始する。成功で true、失敗で false（呼び出し側で状態をリセットするため）。
  Future<bool> start() async {
    if (_running) return true;
    _running = true;
    _status = NodeStatus.connecting;
    _emit();
    try {
      final ws = WebSocketChannel.connect(Uri.parse(hubUrl));
      _ws = ws;
      _sub = ws.stream.listen(
        _onMessage,
        onError: (Object e) {
          _lastError = '接続エラー: $e';
          _status = NodeStatus.error;
          _emit();
        },
        onDone: () {
          _lastError = '接続が閉じられました';
          _status = NodeStatus.disconnected;
          _emit();
        },
      );
      onLog('接続中: $hubUrl');
      await ws.ready;
      onLog('WS 接続完了 → register 送信');
      ws.sink.add(jsonEncode({
        'type': 'register',
        'node': {
          'id': nodeId,
          'platform': 'ios-metal',
          'device': 'Apple GPU (Metal)',
          'role': 'expert',
          'backend': 'llama.cpp-metal',
          'precision': 'q4_k_m',
          'model_id': MetalEngine.modelId,
          'capabilities': {'coding': 0.4, 'math': 0.4, 'general': 0.5},
          // 内部設定 (Console側で確認できるようにする)
          'settings': {
            'n_ctx': 2048,
            'n_batch': 512,
            'n_threads': 4,
            'gpu_layers': -1, // 全層 Metal にオフロード
            'temperature': 0.0, // 決定論的生成
            'flash_attn': 'disabled',
          },
        },
      }));
      return true;
    } catch (e) {
      _lastError = '接続失敗: $e';
      _status = NodeStatus.error;
      _running = false; // 失敗時はリセットして再試行可能にする
      _emit();
      return false;
    }
  }

  Future<void> _onMessage(dynamic raw) async {
    final Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'register_ack':
        _stability = (msg['stability'] as num?)?.toDouble();
        _status = NodeStatus.registered;
        onLog('✅ register_ack (master=${msg['master']})');
        _emit();
      case 'ping':
        _ws?.sink.add(jsonEncode({'type': 'pong', 't': msg['t']}));
      case 'compute':
        await _handleCompute(msg);
    }
  }

  Future<void> _handleCompute(Map<String, dynamic> msg) async {
    final requestId = msg['request_id'] as String? ?? '';
    final prompt = msg['prompt'] as String? ?? '';
    final maxNew = (msg['max_new_tokens'] as num?)?.toInt() ?? 32;
    final temp = (msg['temperature'] as num?)?.toDouble() ?? 0.0;
    final preview = prompt.length > 40 ? '${prompt.substring(0, 40)}…' : prompt;
    onLog('📥 compute [$requestId] $preview');

    final t0 = DateTime.now();
    try {
      final res = await engine.generate(prompt, maxNewTokens: maxNew, temperature: temp);
      final elapsed = DateTime.now().difference(t0).inMilliseconds;

      if (res.containsKey('error')) {
        onLog('❌ 生成エラー: ${res['error']}');
        _ws?.sink.add(jsonEncode({
          'type': 'error',
          'request_id': requestId,
          'error': '${res['error']}',
        }));
        return;
      }

      final text = (res['text'] as String?) ?? '';
      final tokens = ((res['tokens'] as List<dynamic>?) ?? const <dynamic>[])
          .map((e) => (e as num).toInt())
          .toList();
      final timing = (res['timing'] as Map<dynamic, dynamic>?)?.cast<String, dynamic>() ?? {};

      _tasksServed++;
      _totalTokens += tokens.length;
      _totalMs += elapsed;

      onLog('📤 result [$requestId] ${tokens.length} tokens / ${elapsed}ms');

      _ws?.sink.add(jsonEncode({
        'type': 'result',
        'request_id': requestId,
        'tokens': tokens,
        'text': text,
        'timing': {
          'tokenize_ms': (timing['total_ms'] as num?)?.toDouble() ?? 0,
          'prefill_ms': (timing['prefill_ms'] as num?)?.toDouble() ?? 0,
          'decode_ms': (timing['decode_ms'] as num?)?.toDouble() ?? elapsed.toDouble(),
          'total_ms': elapsed.toDouble(),
        },
        'metadata': {
          'node_id': nodeId,
          'model_id': MetalEngine.modelId,
          'backend': 'llama.cpp-metal',
          'precision': 'q4_k_m',
          'platform': 'ios-metal',
          'role': 'expert',
        },
      }));
      _emit();
    } catch (e) {
      onLog('❌ compute 失敗: $e');
      _ws?.sink.add(jsonEncode({
        'type': 'error',
        'request_id': requestId,
        'error': '$e',
      }));
    }
  }

  Future<void> stop() async {
    _running = false;
    await _sub?.cancel();
    await _ws?.sink.close();
    _ws = null;
    _sub = null;
    _status = NodeStatus.disconnected;
    _emit();
  }
}

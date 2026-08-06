import 'dart:io';

import 'package:flutter/material.dart';
import 'package:multicast_dns/multicast_dns.dart';
import 'package:path_provider/path_provider.dart';

import 'arcasha/metal_engine.dart';
import 'arcasha/node_client.dart';

void main() {
  runApp(const ArcAshaNodeApp());
}

class ArcAshaNodeApp extends StatelessWidget {
  const ArcAshaNodeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ArcAsha Node',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4C6EF5),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const NodeScreen(),
    );
  }
}

class NodeScreen extends StatefulWidget {
  const NodeScreen({super.key});

  @override
  State<NodeScreen> createState() => _NodeScreenState();
}

class _NodeScreenState extends State<NodeScreen> {
  final _logs = <String>[];
  final _logScroll = ScrollController();
  final _hubCtrl = TextEditingController(text: 'ws://192.168.1.10:8080');
  final _nodeIdCtrl = TextEditingController(text: 'node-ios-metal');
  final _testCtrl = TextEditingController(text: 'What is 15% of 340? Answer with a number.');

  late final MetalEngine _engine = MetalEngine.instance;
  ArcAshaNodeClient? _node;

  bool _modelLoaded = false;
  bool _loadingModel = false;
  bool _connecting = false;
  bool _autoStarting = false;
  bool _isIpad = false;
  NodeSnapshot? _snap;
  List<Map<String, dynamic>> _models = [];

  @override
  void initState() {
    super.initState();
    _initAutoNode();
  }

  // ── 自律ノード: 起動時に保存済み設定でモデルロード+自動接続 ──────────
  Future<File> _configFile() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/node_config.txt');
  }

  Future<void> _loadConfig() async {
    try {
      final f = await _configFile();
      if (await f.exists()) {
        final lines = (await f.readAsString()).split('\n');
        if (lines.isNotEmpty && lines[0].trim().isNotEmpty) {
          _hubCtrl.text = lines[0].trim();
        }
        if (lines.length > 1 && lines[1].trim().isNotEmpty) {
          _nodeIdCtrl.text = lines[1].trim();
        }
      }
    } catch (_) {}
  }

  Future<void> _saveConfig() async {
    try {
      final f = await _configFile();
      await f.writeAsString('${_hubCtrl.text.trim()}\n${_nodeIdCtrl.text.trim()}');
    } catch (_) {}
  }

  Future<void> _initAutoNode() async {
    await _applyDeviceDefaults(); // 端末に応じたデフォルト (iPad/iPhone) を設定
    await _loadConfig();          // 保存済み設定があれば上書き
    await _refreshModels();       // ダウンロード済みモデル一覧を読み込み
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _autoStart();
    });
  }

  // ── モデル管理 (ダウンロード済みモデルの一覧・削除) ────────────────────
  String _formatBytes(int bytes) {
    if (bytes >= 1 << 30) return '${(bytes / (1 << 30)).toStringAsFixed(2)} GB';
    if (bytes >= 1 << 20) return '${(bytes / (1 << 20)).toStringAsFixed(1)} MB';
    if (bytes >= 1 << 10) return '${(bytes / (1 << 10)).toStringAsFixed(0)} KB';
    return '$bytes B';
  }

  Future<void> _refreshModels() async {
    final models = await MetalEngine.instance.listModels();
    if (mounted) setState(() => _models = models);
  }

  Future<void> _deleteModel(String name, int size) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('モデルを削除'),
        content: Text('「$name」(${_formatBytes(size)}) を削除しますか？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('キャンセル')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('削除')),
        ],
      ),
    );
    if (confirmed != true) return;
    final deleted = await MetalEngine.instance.deleteModel(name);
    _log(deleted ? '🗑️ $name を削除しました' : '❌ $name の削除に失敗しました');
    await _refreshModels();
  }

  /// 端末 (iPad / iPhone) を自動判別して、ハブURLとノードIDのデフォルトを設定する。
  /// これにより手入力なしで自動接続できる (変更時はUIから編集し保存される)。
  Future<void> _applyDeviceDefaults() async {
    try {
      final info = await MetalEngine.deviceInfo();
      final model = (info['model'] as String? ?? '').toLowerCase();
      _isIpad = model.contains('ipad');
      if (_isIpad) {
        _hubCtrl.text = 'ws://169.254.238.70:8080'; // iPad (Mac en10)
        _nodeIdCtrl.text = 'node-ios-ipad';
      } else {
        _hubCtrl.text = 'ws://169.254.172.114:8080'; // iPhone (Mac en11)
        _nodeIdCtrl.text = 'node-ios-iphone15';
      }
      _log('📱 端末判別: ${info['model']} (${info['name']}) → デフォルト設定適用');
    } catch (_) {
      // ネイティブ呼び出し失敗時はデフォルト値のまま
    }
  }

  /// 端末に応じたハブURL候補 (USBリンクローカル + Wi-Fi経由)。
  /// USBのリンクローカルIPは変わることがあるため、複数を順に試す。
  List<String> _deviceDefaultUrls() {
    if (_isIpad) {
      return [
        'ws://169.254.238.70:8080', // iPad (Mac en10)
        'ws://192.168.0.17:8080', // Mac Wi-Fi LAN
      ];
    }
    return [
      'ws://169.254.172.114:8080', // iPhone (Mac en11 旧)
      'ws://169.254.25.16:8080', // iPhone (Mac en11 新)
      'ws://192.168.0.17:8080', // Mac Wi-Fi LAN
    ];
  }

  /// mDNS (Bonjour) でハブを自動発見する。見つかった ws:// 候補を返す。
  /// ハブ (demo-web) は dns-sd で _arcasha._tcp を広告している。
  Future<List<String>> _discoverHubUrls() async {
    final urls = <String>[];
    try {
      final client = MDnsClient();
      await client.start();
      await for (final ptr in client.lookup<PtrResourceRecord>(
          ResourceRecordQuery.serverPointer('_arcasha._tcp.local'))) {
        await for (final srv in client.lookup<SrvResourceRecord>(
            ResourceRecordQuery.service(ptr.domainName))) {
          await for (final a in client.lookup<IPAddressResourceRecord>(
              ResourceRecordQuery.addressIPv4(srv.target))) {
            urls.add('ws://${a.address.address}:${srv.port}');
          }
        }
      }
      client.stop();
    } catch (_) {}
    return urls;
  }

  /// モデルロード → ハブ接続を自動実行。接続URLは候補を順に試行する。
  Future<void> _autoStart() async {
    if (_autoStarting) return;
    _autoStarting = true;
    _log('🔄 自律ノード: モデルロード → 自動接続');
    if (!_modelLoaded) {
      await _loadModel();
    }
    if (_modelLoaded) {
      final saved = _hubCtrl.text.trim();
      final discovered = await _discoverHubUrls(); // mDNSでハブを探索
      if (discovered.isNotEmpty) {
        _log('🛰️ mDNSでハブ発見: ${discovered.join(', ')}');
      }
      final candidates = <String>{saved, ...discovered, ..._deviceDefaultUrls()}
          .where((u) => u.isNotEmpty)
          .toList();
      var ok = false;
      for (final url in candidates) {
        if (_connecting) break;
        _hubCtrl.text = url;
        _log('🔗 接続試行: $url');
        ok = await _connect();
        if (ok) break;
      }
      if (!ok && !_connecting) {
        _hubCtrl.text = saved;
        _log('❌ 接続候補をすべて試しました（Wi-Fi / USB接続を確認してください）');
      }
    }
    _autoStarting = false;
  }

  void _log(String line) {
    final ts = DateTime.now().toIso8601String().substring(11, 19);
    setState(() {
      _logs.add('[$ts] $line');
      if (_logs.length > 200) _logs.removeAt(0);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_logScroll.hasClients) {
        _logScroll.animateTo(
          _logScroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _loadModel() async {
    setState(() => _loadingModel = true);
    _log('モデルをロード中 (Metal / GGML-Metal, 全層 GPU)…');
    try {
      final ok = await _engine.load(nCtx: 2048, nThreads: 4);
      setState(() {
        _modelLoaded = ok;
        _loadingModel = false;
      });
      _log(ok ? '✅ モデルロード完了 (Qwen2.5-1.5B-Instruct / Metal)' : '❌ モデルロード失敗');
    } catch (e) {
      setState(() => _loadingModel = false);
      _log('❌ モデルロード例外: $e');
    }
  }

  Future<bool> _connect() async {
    if (_connecting) {
      await _node?.stop();
      setState(() => _connecting = false);
      _log('切断しました');
      return false;
    }
    if (!_modelLoaded) {
      _log('先にモデルをロードしてください');
      return false;
    }
    setState(() => _connecting = true);
    if (_node != null) {
      await _node?.stop(); // 前回の失敗クライアントを後始末
      _node = null;
    }
    final client = ArcAshaNodeClient(
      hubUrl: _hubCtrl.text.trim(),
      nodeId: _nodeIdCtrl.text.trim(),
      engine: _engine,
      onLog: _log,
      onState: (s) => setState(() => _snap = s),
    );
    _node = client;
    _log('ノード起動: ${_nodeIdCtrl.text.trim()} → ${_hubCtrl.text.trim()}');
    final ok = await client.start();
    if (!ok) {
      setState(() => _connecting = false); // 接続失敗時はボタンを復帰させる
    } else {
      await _saveConfig(); // 接続成功時に設定を保存（次回起動時の自動接続用）
    }
    return ok;
  }

  Future<void> _selfTest() async {
    if (!_modelLoaded) {
      _log('先にモデルをロードしてください');
      return;
    }
    final prompt = _testCtrl.text.trim();
    if (prompt.isEmpty) return;
    _log('🧪 自己テスト: $prompt');
    final t0 = DateTime.now();
    final res = await _engine.generate(prompt, maxNewTokens: 64, temperature: 0.0);
    final ms = DateTime.now().difference(t0).inMilliseconds;
    if (res.containsKey('error')) {
      _log('❌ ${res['error']}');
    } else {
      _log('🧪 結果 (${ms}ms): ${res['text']}');
    }
  }

  String _statusLabel(NodeStatus s) => switch (s) {
        NodeStatus.disconnected => '未接続',
        NodeStatus.connecting => '接続中…',
        NodeStatus.registered => '登録済み',
        NodeStatus.error => 'エラー',
      };

  @override
  void dispose() {
    _hubCtrl.dispose();
    _nodeIdCtrl.dispose();
    _testCtrl.dispose();
    _logScroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final snap = _snap;
    final statusColor = switch (snap?.status ?? NodeStatus.disconnected) {
      NodeStatus.registered => Colors.green,
      NodeStatus.connecting => Colors.amber,
      NodeStatus.error => Colors.redAccent,
      _ => Colors.grey,
    };

    return Scaffold(
      appBar: AppBar(
        title: const Text('ArcAsha Node — Metal'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Row(children: [
                Icon(Icons.circle, size: 12, color: statusColor),
                const SizedBox(width: 6),
                Text(_statusLabel(snap?.status ?? NodeStatus.disconnected)),
              ]),
            ),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── モデル ─────────────────────────────────────────────
          _card(
            title: 'Metal モデル',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _kv('モデル', MetalEngine.modelId),
              _kv('バックエンド', 'llama.cpp + ggml-metal (metallib 埋め込み)'),
              _kv('量子化', 'Q4_K_M (約800MB)'),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _loadingModel ? null : _loadModel,
                  icon: _loadingModel
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.memory),
                  label: Text(_modelLoaded ? 'モデルロード済み ✓' : 'モデルをロード'),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 12),

          // ── 接続 ───────────────────────────────────────────────
          _card(
            title: 'ハブ接続 (WS)',
            child: Column(children: [
              TextField(
                controller: _hubCtrl,
                decoration: const InputDecoration(
                  labelText: 'ハブ URL',
                  hintText: 'ws://192.168.1.10:8080',
                  prefixIcon: Icon(Icons.hub),
                ),
                enabled: !_connecting,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _nodeIdCtrl,
                decoration: const InputDecoration(
                  labelText: 'ノード ID',
                  hintText: 'node-ios-metal',
                  prefixIcon: Icon(Icons.badge),
                ),
                enabled: !_connecting,
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _connect,
                  icon: Icon(_connecting ? Icons.link_off : Icons.link),
                  label: Text(_connecting ? '切断' : 'ハブに接続'),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 12),

          // ── 統計 ───────────────────────────────────────────────
          _card(
            title: 'ノード統計',
            child: Wrap(spacing: 16, runSpacing: 8, children: [
              _stat('状態', _statusLabel(snap?.status ?? NodeStatus.disconnected)),
              _stat('安定性', snap?.stability?.toStringAsFixed(3) ?? '-'),
              _stat('タスク', '${snap?.tasksServed ?? 0}'),
              _stat('トークン', '${snap?.totalTokens ?? 0}'),
              _stat('平均遅延', snap != null && snap.tasksServed > 0
                  ? '${(snap.totalMs / snap.tasksServed).round()}ms'
                  : '-'),
            ]),
          ),
          const SizedBox(height: 12),

          // ── モデル管理 ─────────────────────────────────────────
          _card(
            title: 'モデル管理 (ダウンロード済み)',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (_models.isEmpty)
                const Text('ダウンロード済みモデルはありません', style: TextStyle(color: Colors.grey)),
              for (final m in _models)
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${m['name']}  (${_formatBytes((m['size'] as int?) ?? 0)})',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.delete_outline, size: 20, color: Colors.redAccent),
                      tooltip: 'このモデルを削除',
                      onPressed: () => _deleteModel(
                        m['name'] as String,
                        (m['size'] as int?) ?? 0,
                      ),
                    ),
                  ],
                ),
              TextButton.icon(
                onPressed: _refreshModels,
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('一覧を更新'),
              ),
            ]),
          ),
          if (snap?.lastError != null) ...[
            const SizedBox(height: 12),
            _card(
              title: 'エラー',
              child: Text('${snap?.lastError}', style: const TextStyle(color: Colors.redAccent)),
            ),
          ],
          const SizedBox(height: 12),

          // ── 自己テスト ─────────────────────────────────────────
          _card(
            title: '自己テスト (オフライン)',
            child: Column(children: [
              TextField(
                controller: _testCtrl,
                maxLines: 2,
                decoration: const InputDecoration(
                  hintText: 'プロンプト',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: OutlinedButton.icon(
                  onPressed: _selfTest,
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('Metal で生成'),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 12),

          // ── ログ ───────────────────────────────────────────────
          _card(
            title: 'ログ',
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 260),
              child: ListView.builder(
                controller: _logScroll,
                itemCount: _logs.length,
                itemBuilder: (_, i) => Text(
                  _logs[i],
                  style: const TextStyle(fontFamily: 'Menlo', fontSize: 12),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _card({required String title, required Widget child}) {
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          child,
        ]),
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(k, style: const TextStyle(color: Colors.grey))),
          Expanded(child: Text(v)),
        ]),
      );

  Widget _stat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
          Text(value, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        ],
      );
}

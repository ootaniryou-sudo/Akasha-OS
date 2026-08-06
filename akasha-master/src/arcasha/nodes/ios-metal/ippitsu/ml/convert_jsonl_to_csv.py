"""
memo_app_training_data.jsonl + memo_app_training_data_student_general.jsonl → 一筆訓練CSV 変換スクリプト

マルチタスクデータを、10クラス分類＋重要度判定の訓練データに変換する。
"""
import json
import re
import os
import sys
from collections import Counter

# ============================================================
# カテゴリ → 10ラベル マッピング
# ============================================================
CATEGORY_MAP = {
    # 直接マッチ
    '買い物': '買い物', '旅行': '旅行', '健康': '健康',
    '財務': '財務', '読書': '読書', '人間関係': '人間関係',
    'アイデア': 'アイデア', '仕事': '仕事',

    # → 仕事
    '技術': '仕事', '法務': '仕事', '人事': '仕事', '管理': '仕事',
    'プロジェクト': '仕事', '営業': '仕事', '会議': '仕事',
    '総務': '仕事', '開発': '仕事', 'マーケティング': '仕事',
    '研究': '仕事', '契約': '仕事', '目標': '仕事',
    '学習': '仕事', '経理': '仕事', '投資': '仕事',
    '保険': '仕事', '緊急': '仕事',

    # → 日記
    '子育て': '日記', '趣味': '日記', '料理': '日記',
    '家事': '日記', 'デザイン': '日記', 'イベント': '日記',
    'DIY': '日記', 'ファッション': '日記', '音楽': '日記',
    '映画': '日記', 'プライベート': '日記', '美容': '日記',
    'ペット': '日記', '園芸': '日記', '記念日': '日記',

    # → その他カテゴリ
    '医療': '健康',
    '参考情報': 'メモ',

    # student_general データ追加分
    '進路': '仕事',       # 進路・キャリア → 仕事
    '車': '日記',         # 車関連 → 日記
    'レポート': '仕事',   # レポート → 仕事
    '趣味': '日記',       # 趣味 → 日記
    'ペット': '日記',
    '美容': '日記',
    'イベント': '日記',
    '音楽': '日記',
    '映画': '日記',
    'ファッション': '日記',
    'DIY': '日記',
    '料理': '日記',
    '子育て': '日記',
    '園芸': '日記',
    '記念日': '日記',
    '家事': '日記',
    '学習': '仕事',
    '受験': '仕事',
    '目標': '仕事',
    '経理': '仕事',
    '投資': '仕事',
    '保険': '仕事',
    '技術': '仕事',
    '法務': '仕事',
    '人事': '仕事',
    '管理': '仕事',
    '開発': '仕事',
    '研究': '仕事',
    '契約': '仕事',
    'マーケティング': '仕事',
    '営業': '仕事',
    '会議': '仕事',
    '総務': '仕事',
    'プロジェクト': '仕事',
    '緊急': '仕事',
    '医療': '健康',
}

# 重要度マッピング
IMPORTANCE_MAP = {
    '緊急': 1, '高': 1,
    '中': 0,
    '低': 2, '後回し': 2,
}

# タグ抽出でよく出る有用タグ
USEFUL_TAGS = {
    '仕事', '買い物', '日記', '読書', '旅行', '健康', 'アイデア',
    '人間関係', '家事', '趣味', '勉強', '運動', '料理',
}

# 感情→重要度/ラベル マッピング
EMOTION_LABEL_MAP = {
    '焦り': ('仕事', 1), '不安': ('メモ', 0), '冷静': ('メモ', 0),
    '満足': ('日記', 0), '混乱': ('仕事', 1), '不満': ('日記', 0),
    'ネガティブ': ('日記', 0), '驚き': ('日記', 0), '悲しみ': ('日記', 0),
    '怒り': ('仕事', 1), 'ポジティブ': ('日記', 0), '期待': ('日記', 0),
    '喜び': ('日記', 0), '切実': ('仕事', 1), '迷い': ('メモ', 0),
    '落ち込み': ('日記', 0),
}

# 行動キーワード → ラベルマッピング（todo_extraction用）
TODO_ACTION_LABEL_MAP = {
    '買う': '買い物', '購入': '買い物', '注文': '買い物',
    '予約': '旅行', '計画': '旅行', '旅行': '旅行',
    '提出': '仕事', '報告': '仕事', '連絡': '仕事', '期限': '仕事',
    '健康': '健康', '病院': '健康', '運動': '健康', '食事': '健康',
    '読む': '読書', '読書': '読書', '本': '読書',
    '家計': '財務', '支払': '財務', '節約': '財務', '投資': '財務',
    '連絡': '人間関係', '約束': '人間関係', '会う': '人間関係',
    '考える': 'アイデア', '企画': 'アイデア', 'アイデア': 'アイデア',
}

LABELS = ['アイデア', '買い物', '日記', '仕事', '読書', '旅行', '健康', '財務', '人間関係', 'メモ']


def extract_text(instruction: str) -> str:
    """指示文から実際のメモテキストを抽出"""
    parts = instruction.split('\n\n')
    if len(parts) >= 2:
        return parts[-1].strip()
    return instruction.strip()


def process_jsonl(filepath: str, rows: list, cat_stats: Counter, tag_stats: Counter,
                  importance_stats: Counter, label_counts: Counter) -> int:
    """1つのJSONLファイルを処理して行データを追加する"""
    total = 0
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            d = json.loads(line)
            total += 1
            task_type = d['task_type']
            text = extract_text(d['instruction'])
            output = d['output'].strip()
            subject = d['metadata']['subject']

            if not text or len(text) < 5:
                continue

            if task_type == 'categorization':
                mapped = CATEGORY_MAP.get(output)
                if mapped:
                    rows.append({'text': text, 'label': mapped, 'source': 'cat'})
                    cat_stats[mapped] += 1
                    label_counts[mapped] += 1

            elif task_type == 'tag_extraction':
                tags = [t.strip() for t in output.replace('、', ',').split(',')]
                for tag in tags:
                    if tag in LABELS:
                        rows.append({'text': text, 'label': tag, 'source': 'tag'})
                        tag_stats[tag] += 1
                        label_counts[tag] += 1
                        break

            elif task_type == 'priority_judgment':
                importance = IMPORTANCE_MAP.get(output)
                if importance is not None:
                    importance_stats[importance] += 1
                    if importance == 1:
                        rows.append({'text': text, 'label': '仕事', 'source': 'pri'})
                        label_counts['仕事'] += 1
                    elif importance == 0:
                        rows.append({'text': text, 'label': 'メモ', 'source': 'pri'})
                        label_counts['メモ'] += 1

            elif task_type == 'emotion_analysis':
                # 感情分析結果をラベル・重要度に活用
                mapped = EMOTION_LABEL_MAP.get(output)
                if mapped:
                    label, importance = mapped
                    rows.append({'text': text, 'label': label, 'source': 'emo'})
                    label_counts[label] += 1
                    importance_stats[importance] += 1

            elif task_type == 'search_query':
                # 検索クエリにラベルが含まれていれば採用
                query_tags = [t.strip() for t in output.replace('、', ',').split()]
                for tag in query_tags:
                    if tag in LABELS:
                        rows.append({'text': text, 'label': tag, 'source': 'qry'})
                        label_counts[tag] += 1
                        break

            elif task_type == 'title_generation':
                # タイトル生成 → タイトルに含まれる単語からラベル推定
                for label in LABELS:
                    if label in output:
                        rows.append({'text': text, 'label': label, 'source': 'title'})
                        label_counts[label] += 1
                        break
                else:
                    # ラベルなしでも語彙学習用に追加
                    if len(text) >= 10:
                        rows.append({'text': text, 'label': '', 'source': 'text'})

            elif task_type == 'todo_extraction':
                # TODO内のアクションからラベル推定
                action_text = output.lower()
                for keyword, label in TODO_ACTION_LABEL_MAP.items():
                    if keyword in action_text:
                        rows.append({'text': text, 'label': label, 'source': 'todo'})
                        label_counts[label] += 1
                        break
                else:
                    if len(text) >= 10:
                        rows.append({'text': text, 'label': '', 'source': 'text'})

            # その他のタスクはテキストのみ活用
            elif task_type in ('summarization', 'format_conversion', 'continuation'):
                if len(text) >= 10:
                    rows.append({'text': text, 'label': '', 'source': 'text'})

    return total


def convert():
    base_dir = '/Users/ooyaryou/i-pitu'
    ml_dir = os.path.join(base_dir, 'ippitsu/ml')
    output_path = os.path.join(ml_dir, 'training_data.csv')
    text_only_path = os.path.join(ml_dir, 'text_only_data.csv')
    combined_path = os.path.join(ml_dir, 'combined_data.csv')

    input_files = [
        os.path.join(base_dir, 'memo_app_training_data.jsonl'),
        os.path.join(base_dir, 'memo_app_training_data_student_general.jsonl'),
    ]

    rows = []
    cat_stats = Counter()
    tag_stats = Counter()
    importance_stats = Counter()
    label_counts = Counter()
    total_input = 0

    for fpath in input_files:
        if os.path.exists(fpath):
            n = process_jsonl(fpath, rows, cat_stats, tag_stats, importance_stats, label_counts)
            total_input += n
            print(f'  入力: {os.path.basename(fpath)} → {n}件')
        else:
            print(f'  ⚠️ ファイルが見つかりません: {fpath}')

    # 重複除去
    seen = set()
    unique_rows = []
    for r in rows:
        key = (r['text'], r['label'])
        if key not in seen:
            seen.add(key)
            unique_rows.append(r)

    # ラベルありデータをCSV出力（訓練用）
    labeled_count = 0
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('text,label\n')
        for r in unique_rows:
            if r['label']:
                escaped = r['text'].replace('"', '""')
                f.write(f'"{escaped}",{r["label"]}\n')
                labeled_count += 1

    # ラベルなしテキスト（語彙拡張用）
    with open(text_only_path, 'w', encoding='utf-8') as f:
        f.write('text,label\n')
        for r in unique_rows:
            if not r['label']:
                escaped = r['text'].replace('"', '""')
                f.write(f'"{escaped}",メモ\n')

    # 統計表示
    print('=' * 50)
    print('変換完了！')
    print('=' * 50)
    print(f'\n📊 入力合計: {total_input}件')
    print(f'📊 出力: {len(unique_rows)}件（ラベルあり: {labeled_count}件）')
    print(f'\n📁 訓練CSV: {output_path}')
    print(f'📁 補助CSV: {text_only_path}')

    print(f'\n📈 ラベル分布（分類由来）:')
    for lbl in LABELS:
        n = cat_stats.get(lbl, 0)
        bar = '█' * (n // 2) if n else ''
        print(f'  {lbl}: {n:3d}件 {bar}')

    print(f'\n📈 重要度分布:')
    for imp, name in [(1, '高(重要)'), (0, '中(普通)'), (2, '低(メモ)')]:
        n = importance_stats.get(imp, 0)
        print(f'  {name}: {n}件')

    # サンプルデータと結合
    import pandas as pd
    sample = pd.read_csv(os.path.join(ml_dir, 'sample_data.csv'))
    with open(combined_path, 'w', encoding='utf-8') as f:
        f.write('text,label\n')
        for _, r in sample.iterrows():
            if r['label'] in LABELS:
                f.write(f'"{r["text"]}",{r["label"]}\n')
        for r in unique_rows:
            if r['label']:
                escaped = r['text'].replace('"', '""')
                f.write(f'"{escaped}",{r["label"]}\n')

    combined_total = labeled_count + len(sample)
    print(f'\n📁 結合CSV: {combined_path}（{combined_total}件）')

    # データ不均衡チェック
    print('\n⚠️  データ不均衡チェック:')
    final_counts = Counter()
    with open(combined_path, 'r', encoding='utf-8') as f:
        next(f)
        for line in f:
            parts = line.strip().rsplit(',', 1)
            if len(parts) == 2:
                final_counts[parts[1]] += 1
    for lbl in LABELS:
        n = final_counts.get(lbl, 0)
        warn = '⚠️ 少ない' if n < 20 else '✓'
        print(f'  {warn} {lbl}: {n}件')


if __name__ == '__main__':
    convert()

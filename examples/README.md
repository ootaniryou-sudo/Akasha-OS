# ArcAsha Examples

新 Attachment 層（Phase 3.0）のサンプル実装です。

| ディレクトリ | 内容 |
|---|---|
| `attachment-code/` | コード生成 Attachment の例（`Attachment` 実装 + `AttachmentManager` 登録） |
| `attachment-math/` | 数学 Attachment の例（一次方程式 `ax + b = c` を決定論的に解く） |

## 実行

```bash
# 依存インストール（初回のみ）
cd akasha-master && npm install && cd ..

# コード Attachment
npx tsx examples/attachment-code/index.ts

# 数学 Attachment
npx tsx examples/attachment-math/index.ts
```

## 新 Attachment 層（Phase 3.0）とは

- `Attachment` インターフェースを実装し、`AttachmentManager` に登録する
- Kernel 状態は直接変更せず、`AttachmentContext`（text / booted / attach）経由でのみ実行
- 品質 / コスト / レイテンシのメタ情報を持ち、Executive Runtime が選択・スケジューリングする
- 旧 v1 の `plugin-*` サンプル（`AkashaExpertPlugin`）は本層に置き換え（`src/plugin/` は削除）

詳細はリポジトリルートの仕様書（`AI_ATTACHMENTS.md` / `AI_REASONING.md`）を参照。


# Roadmap

初期構築は「完成品」ではなく、仮説を実利用で試せるfoundation。
Issueの受入条件を満たしてから次の層へ進む。すべてを同時に作らない。

## 0. Foundation — この初期構築

5内容型＋Review、帰属とscope、原子的capture、request_id、immutable record、CLI、検索、show、export/restore、CI、回帰テスト。
原典の取得・照合やUIは含まない。

## 1. Dogfood — 最優先

受入条件: [Issue #1](https://github.com/TakahisaI/yurai/issues/1)。

既存のCLI実行可能なAIから、実際の調査を少なくとも3ケース保存して別セッションで取り出す。
支持と疑義、原典の主張と独自推論、旧版と訂正を各1ケース含める。
利用者がJSONを手で組み立てる必要がある箇所を特定する。匿名化したfixtureと所要操作数・欠落情報のメモを残す。
この段階の課題に必要なCLI改善以外は拡張しない。

## 2. Anchor verification / source preservation

受入条件: [Issue #2](https://github.com/TakahisaI/yurai/issues/2)。

読み取るファイルを明示して、原文quoteとprefix/suffixを照合するadapterを作る。
一致・不一致・複数一致・未到達を別の検証イベントとして保存し、採用状態と区別する。
版/hash/snapshotの不一致を検出する。引用の一致から主張の真実性を推論しない。
ネット取得は別途SSRF・サイズ制限・redirect・機密性の設計を要するため、最初はローカルの明示入力から始める。

## 3. MCP adapter

受入条件: [Issue #3](https://github.com/TakahisaI/yurai/issues/3)。

DogfoodでCLI契約が安定した後に実装。search / inspect / capture / reviewを中心とした薄いstdio adapter。
同じCore、schema、制限、dry-run、冪等性、actorを使う。read-only設定を用意し、暗黙の書き込みを禁止する。
MCP特有のエラー・capability・tool metadataをadapterに閉じ込める。特定モデルのSDKをCoreへ入れない。

## 4. Retrieval evaluation

受入条件: [Issue #4](https://github.com/TakahisaI/yurai/issues/4)。

匿名化fixtureで日本語短語、同義表現、scope差、反証、撤回済み根拠を含む問いを評価する。
まず不足例を作り、その例を解く最小のranking・展開・検索改善を入れる。
summary→詳細の出力量、ページングの取りこぼし、同じ原典の二重カウントを測る。
Embeddingは必要と分かってから任意indexとして追加し、唯一の検索経路にしない。

## 5. Durable operation / privacy

受入条件: [Issue #5](https://github.com/TakahisaI/yurai/issues/5)。

版付きmigration、異常終了・複数process試験、snapshot上限の改善、merge-import、機密情報のredaction/purge方針。
通常の訂正履歴と、私的情報を本当に消す操作を同一視しない。append-onlyをプライバシーより上位の目的にしない。
多人数・同期・GUIはこの計画の達成条件ではない。

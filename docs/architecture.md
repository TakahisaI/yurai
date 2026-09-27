# Architecture

## 境界

```text
src/cli.ts                  引数・ファイル・stdin/stdout
      │
src/core/ledger.ts           capture / search / show / export / restore
      │                     来歴・参照型・不変条件・レビュー状態
src/core/ports.ts            小さなStore interface
      │
src/storage/sqlite.ts       SQL・transaction・永続化・検索index

src/core/model.ts            型・入力schema・局所検証
```

CoreはCLI、MCP、ファイル取得、モデルAPI、SQLiteに依存しない。
Node標準の暗号学的hashとURL解析は使う。モデル非依存とランタイム非依存は同義ではない。
新しい入口は同じLedgerへ委譲する。adapterからStoreへ直接書くのは禁止する。

## なぜこのサイズか

1つのTypeScript package、1つのSQLite DB。monorepo、ORM、dependency injection framework、graph database、Web serverは置かない。
CLI/MCPが共有するのはuse caseとデータ契約であり、プロトコル固有の便利機能ではない。
実行時の外部依存はゼロ。Nodeの`node:sqlite`はstorage adapter一箇所に隔離する。
Node 22.16を互換性の最低線、24系を通常開発環境とし、両方をCIで検証する。

## 物理モデル

- `records`: 5つの内容型とReview。JSONのdata/actorに型検証を適用し、ID・型・順序・時刻は列で保持する。
- `links`: 検索可能な有向参照。FKと型チェックを併用する。FKは同じcapture内の前方参照を許す。
- `receipts`: request_id、正規化入力のSHA-256、作成ID列。再試行の二重書き込みを防ぐ。
- `lookup`: Claim/Sourceから再生成できるFTS5 trigram検索index。

これは任意の型やエッジを追加できる汎用グラフエンジンではない。固定の判別共用体とStore APIが公開契約になる。
JSONカラムにした理由は、自然言語の補助情報を持つ少数の型を、小さなadapterで無損失に出し入れするため。
参照と状態の問い合わせはindex化し、具体的に必要になったフィールドだけ列・indexに昇格する。

## 保存の不変条件

1. actorとcreated_atは全レコードに残す。actorは署名された身份ではない。
2. IDは不変。既存のIDを上書きしない。似た文章を自動統合しない。
3. EvidenceはSourceを、AssessmentはClaimとEvidenceを参照する。Relationの両端はClaim。
4. Evidenceにはquoteかlocatorが必要。要約だけを証拠箇所として保存しない。
5. ReviewはReviewを対象にしない。採用状態と真偽と引用照合を混ぜない。
6. 全レコード・参照・index・receiptを一つのSQLite transactionでcommitする。
7. 同じrequest_idと同じ入力は同じreceipt。内容が異なればCONFLICT。
8. supersedesの循環は禁止。他の意味関係から機械的な推論はしない。

UPDATE/DELETEを拒否するtriggerを置く。ただしDB所有者による改竄を防止する仕組みではない。
暗号署名、hash chain、event sourcing platformは導入しない。

## 検索と展開

保存原文は変更せず、検索用テキストだけNFKC＋小文字化する。
入力は空白区切りのliteral AND検索であり、検索式・SQL・正規表現として実行しない。
3文字以上の語はtrigram、1〜2文字の語は同じ正規化テキストの部分文字列検索にする。
「出生率」「出生」「AI」のいずれも扱う。形態素解析や意味検索ではない。

検索の既定はClaim。rejected/withdrawnは既定検索から除くが、ID指定とinclude-inactiveでは残す。
showは直接の接続と、必要なEvidence→Sourceまで展開する。無制限にgraphを辿らない。
関係先が未採用・撤回済みなら、その状態も応答に含める。ページにない反証を「存在しない」と説明してはいけない。

## 整合性・移行・バックアップ

`application_id`と`user_version`で自分のDBを確認する。未知のDB・将来版を黙って初期化しない。
v1のmigrationは初期スキーマだけ。今後の変更では番号付きの前進migrationと旧版fixtureによるテストを追加する。
WAL、foreign_keys、busy_timeout、synchronous=FULLを設定する。

exportは同一transactionから全レコードとreceiptを読み、Reviewの挿入順を維持する。
restoreは空の台帳に対してのみ、スキーマと参照を確認して全体をcommitする。既存台帳とのmergeではない。
原典のblobや外部URIの先はexport対象外。snapshotに記録されたactorやdigestの真正性は保証しない。

## 初期実装の意図的な限界

captureのsupersedes検証とexport/restoreは小規模台帳向けに全体を読む。
同期待ち・BEGIN IMMEDIATEによる直列化を使い、長時間サーバや大規模並列書き込みには最適化していない。
検索順は新しい記録からで、関連度ランキングではない。完全なUnicode case foldingや形態素処理もしない。
showのページにはReviewも含むため、全根拠を読むにはnext_offsetを辿る必要がある。
quoteの真偽・locatorの妥当性・原典の独立性は未評価。
大きな台帳、redaction、merge-import、引用照合、権限分離は後続Issueの対象であり、実装済みと表示しない。

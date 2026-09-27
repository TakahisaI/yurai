# CLI / Data Contract v1

## 入力の正本

TypeScript型と実行時schemaは`src/core/model.ts`。以下で機械可読のJSON Schemaを出力する。

```sh
node dist/cli.js schema bundle
node dist/cli.js schema record
node dist/cli.js schema snapshot
```

schemaで表せない参照先の型、quote/locator条件、URI、時刻の実在性、supersedesの循環はCoreで追加検証する。
未知のキー、空白のみの文字列、NUL、範囲外の配列・文字列は拒否する。
quoteを含め保存文字列のtrimや書き換えはしない。IDは英字で始まる2〜128文字の`A-Z a-z 0-9 _ . : -`。

## 単一レコードの例

```json
{
  "id": "clm_my_hypothesis",
  "type": "claim",
  "data": {
    "text": "この条件では別の説明が成立するかもしれない。",
    "kind": "hypothesis",
    "attributed_to": "me",
    "scope": "現在検討している事例のみ",
    "why": "次に検証したい仮説"
  }
}
```

`add --file record.json`で保存する。IDを変えずに再実行したい場合は同じ`--request-id`も指定する。
データの内容が変わる場合は新ID・新request_idにする。`capture`ではactorとrequest_idをbundle自身が持つため、CLIのactor overrideは拒否する。
200レコード/1 MiBまで。`--file -`でstdinも使える。

## 主要な操作

| 操作 | 意味 |
| --- | --- |
| init | 未作成の台帳を作る。既存のyurai台帳には冪等 |
| capture | bundle全体を検証・一括保存。dry-runは内容・receiptを書かない |
| add | 単一レコードをcaptureへ包む |
| review | Reviewレコードを生成してcaptureする |
| search | Claim中心のliteral AND検索。kind=sourceでSource検索 |
| show | 対象、最新Review、直接参照、接続、EvidenceのSourceを表示 |
| export | 台帳snapshotをstdoutへ出力 |
| import | 空の台帳へsnapshotを復元。既存データとのmergeではない |
| doctor | SQLite/FK/検索indexの構造整合性。内容の真偽判定ではない |

すべてのコマンドで`--db`を使える。他のフラグは`--help`に示した該当操作でのみ有効。
search/showのlimitは既定20、最大100。offsetは0〜1,000,000。next_offset=nullでその検索・接続ページが終わる。
検索語は最大500文字、空白区切り16語まで。FTS構文のOR/NOTやSQL wildcardは解釈しない。

## 状態と訂正

内容は初期状態proposed。最新Reviewの挿入順で作業状態を決める。同一時刻や取り込み時の時刻逆転で順序を推定しない。
採用状態を変えてもレコードや過去のReviewを削除しない。

```sh
node dist/cli.js review clm_my_hypothesis --state withdrawn --reason '条件を誤っていた' --request-id req_withdraw_v1
```

訂正は、新しいClaim＋new→oldのsupersedes Relation＋必要なら旧Claimのwithdrawn Reviewを一つのcaptureにまとめる。
supersedesだけでは撤回しない。どの状態もtrue/false/verifiedの代わりではない。
旧Evidenceの誤りはそのEvidenceをwithdrawnにし、別IDで訂正箇所とAssessmentを追加する。

## 関係の読み方

`from_claim_id --relation--> to_claim_id`。fromがtoを支持・限定・拡張・置換する。
`Assessment.claim_id`は解釈の対象、`evidence_id`は根拠箇所。rationaleはその接続理由。
`reports`を`supports`へ暗黙変換しない。contradictsは適用範囲が比較できる理由をrationaleへ残す。
ReviewがacceptedでもEvidenceにはanchor_not_verifiedが残る。

## 出力とエラー

help以外の成功出力はJSON。schema/exportはそのまま別ツールへ渡せる構造。
エラーはstderrに`{"error":{"code":"...","message":"..."}}`を出す。Nodeのランタイム警告もstderrに出る場合がある。
終了コードは0=成功、1=IO/runtime/schema/doctor異常、2=入力・使い方、3=対象なし、4=競合。
状態やwarningsを省略して内容だけを根拠扱いするadapterを作らない。

## Snapshot

`format=yurai.snapshot`、`version=1`、entries、receipts。entryにはcreated_atとactorを含む。
CLIのrestoreは最大16 MiB。100,000 entries/receiptsまでの小規模運用を想定した安全上限であり、その規模での性能保証ではない。
exportは小規模台帳向けの全件出力。現行CLIのrestore上限を超える出力は、復元できないバックアップを作らないよう、何も出力せずエラーにする。大規模な台帳にはストリーミング移行とSQLiteバックアップ操作の追加が必要。
OSファイル権限・ディスク暗号化・安全な保存先は利用者側で管理する。DBやsnapshotを公開リポジトリにcommitしない。

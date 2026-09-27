# Bootstrap validation

確認日: 2026-09-27

## 実行済み

- Linux / Node.js v22.16.0 / SQLite 3.49.1
- TypeScript 5.8.3 / @types/node 22.15.33
- `npm run check`: 型検査・build・21 tests、すべて成功
- CLIの別processでinit→capture→search→show→review→export→restore→doctor
- 日本語・1〜2文字・NFKC・literal記号検索
- 参照整合性、前方参照、途中失敗のrollback、再試行、変更済みrequest_idの拒否
- reviewの順序と撤回済み根拠、supersedes循環の拒否
- snapshotの内容・来歴・receipt round-trip、不正snapshotのrollback
- DB再open、未知/将来schemaの拒否、UPDATE/DELETE拒否

## GitHub Actionsでのclean CI — 成功

実装commit: `d583c498098583822dec34eaff1e79134e9d90fb`

[CI run #1](https://github.com/TakahisaI/yurai/actions/runs/36283356241)の4 jobがすべて成功した。
各jobで`npm ci --ignore-scripts`と`npm run check`を実行した。

| OS | Node | 結果 |
| --- | --- | --- |
| Ubuntu | 22.16.0 | 成功 |
| Ubuntu | 24系 | 成功 |
| macOS | 24系 | 成功 |
| Windows | 24系 | 成功 |

## ローカル検証方法の制約

初期構築環境はnpm registryへDNS接続できなかったため、同じ固定バージョンのローカル既存開発パッケージを使って検証した。
lockfileのresolved/integrityは環境内の既存lockfileから取得し、バージョンを照合した。
このローカル環境でclean `npm ci`が成功したとは主張しない。clean installは上記のGitHub Actionsで別途検証し成功した。

## 未検証・未実装

Node 24、macOS、Windowsの検証は上記CI上で行ったものであり、このローカル環境で実行したものではない。
実利用、並列process競合、異常終了時の耐久性、大規模台帳の性能は未検証。
原典内容の照合・到達性や研究結果の正しさをテストしているわけではない。fixtureは人工データ。

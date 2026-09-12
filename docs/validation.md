# 初回ローカル検証 — 2026-09-08 JST

これは開発時の疎通・回帰確認です。勝率やモデル間の優劣を推定する実験ではありません。ログIDはUTC表記のため、日付は前日です。完全ログと画像はこの作業環境の `runs/` に保存し、Gitには含めていません。

## 実装の検証

- Node.js 24.14.0、追加依存なし。
- `pnpm test`: 36件成功。開放盤面の7種合法配置数、実行経路、壁・床キック、I固有キック、塞がった空洞、同一セルのspin区別、攻撃・相殺・全消し、HOLD、交代、上端判定、非公開情報の不変性、preview境界、LLM再試行と障害、保存・分岐・並行判断拒否を含む。
- `pnpm run check`: JavaScript構文・package metadata成功。
- ヘッドレスChrome: 新規対局、1手、自動対戦、スライダー、操作再生、局面分岐、停止、保存リプレイ成功。1440pxと390px幅で表示確認。pageerrorなし、モバイル横方向overflowなし。
- JSONLに記録した操作を初期状態から再実行し、各局面とSHA-256を比較。対戦と途中停止のログを含めて検証。

## 接続確認

接続先: `http://localhost:8082`。`GET /v1/models` に指定された3つのIDが存在。公開メタデータではQwenと通常Gemmaはtext、軽量Gemmaはtext/image/audioを掲示していた。**画像・音声の入力成功は未検証**。

軽量Gemmaへのschema付きJSON要求は成功。初回約5.7秒、prompt 27 / completion 140 tokens。本文 `{"ok":true}` と `reasoning_content` が別フィールドで返った。生成要求のmodel指定により自動ロードされた。モデル切替時は本セッションでロードしたモデルだけを明示unloadした。

APIの実装に参照した一次資料: [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。native tool callingに依存せず、JSON actionをアプリケーションのpreviewツールに接続している。

## 対局・局面の実測

|試行|終了|実測と留意点|
|---|---|---|
|探索bot同士 / seed=101 / 先後交換|106固定、120固定で決着|両局とも先手が勝利。この2局で先手有利やbotの強さは判定できない|
|軽量Gemma / 試し読みなし先手|7固定で先手lock-out|先手のみ判断、平均6.74秒。後手の試し読み条件はこの対局では一度も動いていない|
|軽量Gemma preview vs search / 14固定上限|上限引き分け|Gemma 7判断、平均4.81秒。preview利用0回。主に先頭IDを選択|
|Qwen / サーバー既定思考 / 2048出力|最初の判断で失格|2回ともfinish_reason=length、本文空、各2048completion。約139秒。初期ログのreasonはinvalid-response、現行版ではoutput-truncatedとして分類|
|Qwen / 思考無効 / 同一空局面3条件|3条件とも合法手|llm 6.73秒・102completion、llm-preview 6.53秒・105completion、search 0.264秒・32遷移。LLM両条件は同じm0001、preview利用0回|
|Qwen / 思考無効 / 14固定上限|上限引き分け|preview側7判断・平均7.04秒、direct側7判断・平均6.98秒。preview利用0回。メモ長240文字超過を1回修正して成功。両者とも消去0行|
|通常Gemma / 思考無効 / 14固定上限|無効、0固定|約59.8秒でHTTP500、`failed to load`。モデル状態unloaded、failed=true、exit_code=1。API要求は保存。生成能力・時間の比較値は得られていない|

Qwenを使った別の **強制プロトコル診断** では、preview actionを指定したschemaで要求し、エンジン結果を返し、choose actionによるroot手確定を確認した。通常対局で自発的にpreviewを使った証拠ではなく、戦略評価や勝率に混ぜない。

## ローカル証跡

|内容|ファイル（`runs/` 内）|
|---|---|
|探索先後交換|`2026-09-07T21-57-47-314Z_26d1bb44.jsonl`, `2026-09-07T21-57-54-201Z_c0ca1e72.jsonl`|
|軽量Gemma direct|`2026-09-07T21-58-07-219Z_3758af7b.jsonl`|
|軽量Gemma preview|`2026-09-07T21-59-26-776Z_8a6eddbc.jsonl`|
|Qwen既定思考・打切り|`2026-09-07T22-02-20-589Z_e6ce5bef.jsonl`|
|Qwen同一局面3条件|`position-2026-09-07T22-07-56-869Z.json`|
|Qwen思考無効対局|`2026-09-07T22-10-12-775Z_1bc97600.jsonl`|
|強制preview疎通|`protocol-1788819203088.json`|
|通常Gemmaロード失敗|`2026-09-07T22-13-56-351Z_f13def24.jsonl`|
|画面|`ui-desktop.png`, `ui-mobile.png`|

## 次の実験前に決めること

通常Gemmaのロード失敗はサーバー側のログ調査が必要。サーバー設定・モデルファイルは変更していない。Qwenは思考有無、出力予算、説明・メモ長を先に固定し、失格率も測る。試し読みを許可しても使わないケースがあるため、利用率と実際の遷移数を併記する。

初期botは32遷移の一部候補探索で、未知のおじゃま穴に到達する手は一律に低く評価する。この保守的な処理と固定評価の弱さを考慮し、強い既存bot相当と扱わない。大量バッチは今回開始していない。

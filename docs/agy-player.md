# Antigravity CLI (agy) との対戦

`agy` は既存の Antigravity CLI セッションが専用コマンドで手を選ぶプレイヤーです。StackingBench から agy を起動したり、モデルAPIを呼び出したりはしません。

## 準備

1. StackingBench を起動し、ブラウザで自分を「人間（あなた）」、相手を「Antigravity CLI (agy)」にします。
2. 記録用モデル名は1欄で、初期値は `Gemini` です。必要なら変更してください。推論レベルの入力欄はありません。この値はモデルの起動設定を変更しません。
3. 対局を作成し、「対戦依頼をコピー」を押して、このリポジトリを作業場所にした Antigravity CLI の会話に貼り付けます。
4. セッションは以下の手順でプレイします。中断した場合は同じ対局IDで再開できます。

試し読みは「Codex / Antigravity の試し読み」で切り替えます。既定はあり、1判断32遷移です。API生成設定はこのセッションに適用しません。

## プレイ担当の手順

対戦の依頼を受けてから実行してください。対局情報と手の送信には **`scripts/agent.js` だけ**を使います。完全な `runs/` ログ、ビューアーAPI、seed、乱数状態、非公開NEXT、未来のおじゃま穴を読んではいけません。別の探索プログラムや他のエージェントに手の選択を委ねず、公開観測と許可された試し読みで判断します。

```bash
node scripts/agent.js list
node scripts/agent.js observe RUN_ID
node scripts/agent.js wait RUN_ID --after PREVIOUS_DECISION_ID --timeout-ms 50000
```

`list` には Codex 対局も含まれるので、依頼された対局IDと `players[].type` を確認してください。既定の接続先は `http://127.0.0.1:3210`、変更する場合は `STACKINGBENCH_URL` にローカルHTTPの接続先を設定します。

自分の番なら `observe` が公開盤面、合法手、ルール、メモ、`decisionId` を返します。相手の番では盤面を返しません。`wait` の `waiting:true` は待機時間の終了なので再度待機します。終了状態ならプレイを終えます。

試し読み用JSONの例:

```json
{"decisionId":"現在のdecisionId","node":"root","moveId":"m0012","requestId":"preview-1"}
```

```bash
node scripts/agent.js preview RUN_ID --file /tmp/stackingbench-preview.json
```

深い試し読みでは返されたノードIDとそのノードの合法手を使います。未知情報やターン末の境界で停止し、予算は観測を取り直しても回復しません。同じ要求の再送には同じ `requestId` を使ってください。

確定用JSONの例:

```json
{"decisionId":"現在のdecisionId","moveId":"m0012","reason":"短い選択理由","memo":"次の判断へのメモ","agentModel":"Gemini"}
```

```bash
node scripts/agent.js choose RUN_ID --file /tmp/stackingbench-choice.json
```

どちらも `--file -` で標準入力のJSONを受け付けます。確定には最新の **ルート観測** の合法手IDだけを使います。1個固定したら再度 `observe` を取り直し、7個固定して交代したら `wait` で待ちます。通信結果が不明なら観測を取り直し、固定済みか確認します。古い `decisionId` は拒否されます。

`reason` は400文字、`memo` は240文字、`agentModel` は160文字まで。モデル名が不明なら推測せず `agentModel` を省略すると開始時の記録用設定を使います。明示的なnullは未記録です。Antigravity の推論レベルは記録しません。

## 記録

プレイヤー種別は `agy`、入力方式は `agy-session-v1` として保存します。モデル名は開始時の `config.players[].agentModel` と各判断の `execution.model` に保存し、リプレイ・保存対局一覧に表示します。設定値と判断時の自己申告は provenance で区別し、自動検証済みとは扱いません。

観測・試し読み・選択・拒否を保存し、選択したSRS経路で再生できます。実トークン数・料金・内部推論は取得できません。API呼び出し数は0、トークン数と料金は不明として記録します。判断時間にはセッションの待機等も含まれます。エラー時のbotへの置換はありません。既存の会話やツール環境を含むため、API接続のモデル性能測定とは別条件です。

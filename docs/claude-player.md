# Claude Code との対戦

`claude` は、ユーザー自身が起動した Claude Code セッションから StackingBench のローカル CLI で手を選ぶプレイヤーです。StackingBench は Claude Code を起動せず、Claude の認証情報・セッショントークン・API リクエストを取得・保存・中継しません。認証とモデルへの通信はユーザーの Claude Code 側で行います。

Claude Code の利用制限は Anthropic 側に従います。StackingBench は制限を回避する手段を提供しません。制限やセッションの中断で着手できない場合、対局は入力待ちのままとなります。利用可能になった後、ユーザーが同じ対局IDで再開を依頼できます。

## 準備

1. StackingBench を起動し、ブラウザで自分を「人間（あなた）」、相手を「Claude Code」にします。
2. 記録用モデル名は1欄で、初期値は `Claude` です。必要なら変更してください。推論レベルも記録する場合はモデル名に含めます。この値はモデルの起動設定を変更しません。
3. ユーザー自身がこのリポジトリを作業場所にして Claude Code を起動します。対局を作成し、「対戦依頼をコピー」を押して、Claude Code の会話に手動で貼り付けます。ブラウザ操作だけではセッションを起動・通知しません。
4. セッションは以下の手順でプレイします。中断した場合は同じ対局IDで再開できます。

試し読みは「外部セッションの試し読み」で切り替えます。既定はあり、1判断32遷移です。API生成設定はこのセッションに適用しません。

新規対局はルールv2で、穴の位置によらない確定負けの試し読みは `terminal` と結果の `status`・`winner`・`reason` を返します。盤面・穴は返しません。v1ログからの分岐は従来の `unknown-garbage` 境界を維持します。

## プレイ担当の手順

対戦の依頼を受けてから実行してください。対局情報と手の送信には **`scripts/agent.js` だけ**を使います。完全な `runs/` ログ、ビューアーAPI、seed、乱数状態、非公開NEXT、未来のおじゃま穴を読んではいけません。別の探索プログラムや他のエージェントに手の選択を委ねず、公開観測と許可された試し読みで判断します。

```bash
node scripts/agent.js list
node scripts/agent.js observe RUN_ID
node scripts/agent.js wait RUN_ID --after PREVIOUS_DECISION_ID --timeout-ms 50000
```

`list` は全外部セッション種別（Codex / Antigravity / OpenCode / Claude Code）の対局を返します。依頼された対局IDと `players[].type` を確認してください。既定の接続先は `http://127.0.0.1:3210`、変更する場合は `STACKINGBENCH_URL` にローカルHTTPの接続先を設定します。

自分の番なら `observe` が公開盤面、合法手、ルール、メモ、`decisionId` を返します。相手の番では盤面を返しません。`wait` の `waiting:true` は待機時間の終了なので再度待機します。終了状態ならプレイを終えます。

試し読み用JSONを標準入力で送る例（共有の一時ファイルを使わず、他のセッションとのファイル競合を避けます）:

以下のように JSON 全体をシングルクォートで囲む場合、`reason`・`memo` などの文字列中の `'` は JSON 側で `\u0027` と書いてください（例: `it\u0027s safe`）。

```bash
echo '{"decisionId":"現在のdecisionId","node":"root","moveId":"m0012","requestId":"preview-1"}' | node scripts/agent.js preview RUN_ID --file -
```

深い試し読みでは返されたノードIDとそのノードの合法手を使います。未知情報やターン末の境界で停止し、予算は観測を取り直しても回復しません。同じ要求の再送には同じ `requestId` を使ってください。

確定用JSONの例:

```bash
echo '{"decisionId":"現在のdecisionId","moveId":"m0012","reason":"短い選択理由","memo":"次の判断へのメモ","agentModel":"Claude"}' | node scripts/agent.js choose RUN_ID --file -
```

確定には最新の **ルート観測** の合法手IDだけを使います。1個固定したら再度 `observe` を取り直し、7個固定して交代したら `wait` で待ちます。通信結果が不明なら観測を取り直し、固定済みか確認します。古い `decisionId` は拒否されます。

`reason` は400文字、`memo` は240文字、`agentModel` は160文字まで。モデル名が不明なら推測せず `agentModel` を省略すると開始時の記録用設定を使います。明示的なnullは未記録です。推論レベルも記録する場合はモデル名に含めてください。

## 記録

プレイヤー種別は `claude`、入力方式は `claude-session-v2` として保存します。v2 は旧項目 `reasoningEffort` を対局作成・手の確定ともに拒否し、モデル名への記載を案内します。モデル名は開始時の `config.players[].agentModel` と各判断の `execution.model` に保存し、リプレイ・保存対局一覧に表示します。設定値と判断時の自己申告は provenance で区別し、自動検証済みとは扱いません。

観測・試し読み・選択・拒否を保存し、選択したSRS経路で再生できます。実トークン数・料金・内部推論は取得できません。API呼び出し数は0、トークン数と料金は不明として記録します。判断時間にはセッションの待機等も含まれます。エラー時のbotへの置換はありません。既存の会話やツール環境を含むため、API接続のモデル性能測定とは別条件です。

## 開発時の確認

`pnpm test` と `pnpm run check` に加え、既存の agent スモークを Claude Code 向けに実行できます。別サーバーと検証用ログを使用し、モデルを呼ばず固定の検証用選択で接続・手番交代・保存リプレイを確認します。モデルの強さを測るものではありません。

```bash
PORT=3211 STACKINGBENCH_RUNS=/tmp/stackingbench-claude-validation pnpm start
# 別のターミナル。必要なら PLAYWRIGHT_MODULE / CHROME_PATH を指定
AGENT_TYPE=claude APP_URL=http://127.0.0.1:3211 node scripts/agent-smoke.js
```

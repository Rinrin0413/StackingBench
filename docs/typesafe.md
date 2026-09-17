# TypeSafe Jev 接続

環境変数 `TYPESAFE_API_KEY` をサーバープロセスに渡すか、ローカル `.env` に設定して `pnpm start` で起動する。キーはブラウザ・対局ログへ渡さない。

画面で一方を「人間（あなた）」、他方を「LLM · 試し読みなし」、モデルを「TypeSafe · Jev（試し読みなし） · jev-latest」にして対局を作成する。「接続確認」も Jev のネイティブ API に対応する。

2026-09-17 に取得した [HTTP API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling) に基づき、Node の fetch で `POST https://api.typesafe.ai/v1/systemone` を呼ぶ。認証は `Authorization: Bearer`。SDK 依存は追加しない。

`provider=typesafe`、`model=jev-latest`、`type=llm`、`observation=text`、`decisionProtocol=typesafe-choice-v1` を保存する。公開観測とルールを state とし、幾何学順の全合法手 ID を一つの Choice の criteria に入れる。候補の間引き・評価ソート・探索 bot による選択はない。モデルの choice を検証後、既存の SRS 実行経路で固定する。試し読み・画像観測は未対応で明示エラー。ゲーム状態遷移の変更はなく、ルール v1 と既存リプレイの互換性を維持する。

要求、質問、全候補、応答全体（実際のモデル名・probabilities・confidence・usage を含む）、時間、障害分類を既存の JSONL に保存する。`input_tokens` / `output_tokens` は共通集計の promptTokens / completionTokens に対応し、未報告なら null。費用は不明（null）。Jev は説明や作戦メモを生成せず、それらは空文字となる。低 confidence だけを理由に別の手へ変更しない。

通常は1判断1呼出し。不正な Choice/ID/分布は一度だけ修正要求し、再発は失格。maxCalls、timeoutMs、requestIntervalMs は有効。HTTP（429/529 を含む）・通信・タイムアウトは記録して対局無効とし、自動再試行や bot 代替は行わない。

現行 API に生成用 temperature、max_tokens、思考設定はないため送信しない。共通 UI のこれらの設定は Jev には適用せず、保存設定では temperature / maxTokens / decisionTokens を null、thinking を server-default とし、tokenBudgetPolicy にプロバイダー管理であることを記録する。生成トークン上限を保証する条件ではない。`jev-latest` は可変エイリアスなので応答のモデル名も保存する。

自動テストは通信をモックし、要求形式、全候補の保持、公開情報境界、認証・秘密情報除去、使用量、不正応答、通信失敗を検証する。実 API の疎通や対戦強度を示すものではない。

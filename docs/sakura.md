# さくらのAI Engine 接続と比較

実行結果と保存対局IDは [実測記録](sakura-validation.md) を参照してください。

対象は `preview/Kimi-K2.6` と `preview/gemma-4-31B-it`。UIまたはCLIでこのIDを選ぶとprovider=sakuraとして `https://api.ai.sakura.ad.jp/v1/chat/completions` に接続します。ゲームルールv1、合法手順序、観測、固定botは変更しません。

## APIキー

`SAKURA_AI_API_KEY` をNode.jsプロセスの環境変数で設定してください。アカウントトークン全体を使います。既に環境変数を設定したターミナルなら、そのターミナルから `pnpm start` や以下の検証コマンドを実行できます。別のプロセスで後からexportした環境変数は、実行中サーバーには自動では伝わりません。

代わりに `.env.example` を参考に、Git対象外の `.env` に保存できます。起動時に読み、既にある環境変数を優先します。キーを変更したときはサーバーを再起動します。キーをコマンド引数・画面・対局設定・ログに書き込みません。認証ヘッダーは公式HTTPSの接続先にのみ付け、リダイレクトを追いません。

この環境の設定に合わせ、プロセス環境と `.env` のどちらにも有効なキーがないときは `~/.config/environment.d/envvars.conf` の **SAKURA_AI_API_KEYだけ** を読みます。他の変数は取り込まず、ファイル内の変数展開やコマンド実行も行いません。設定ファイル全体やキーの値をログに出力しません。

## 接続確認と実験

```bash
# 1回ずつ短い応答で確認。対局の成績には含めない
pnpm run probe -- preview/Kimi-K2.6
pnpm run probe -- preview/gemma-4-31B-it

# 同じ保存局面を3条件で各1判断
pnpm run compare -- --model preview/Kimi-K2.6 --run RUN_ID --index 14 --max-tokens 4096 --decision-tokens 16384 --max-calls 10 --thinking off --request-interval-ms 10000
pnpm run compare -- --model preview/gemma-4-31B-it --run RUN_ID --index 14 --max-tokens 4096 --decision-tokens 16384 --max-calls 10

# 最大56固定の対戦。短すぎる14固定で攻防を判断しない
pnpm run bench -- --model preview/Kimi-K2.6 --a llm-preview --b search --max-locks 56 --seeds 101 --max-tokens 4096 --decision-tokens 16384 --max-calls 10 --thinking off --request-interval-ms 10000
pnpm run bench -- --model preview/gemma-4-31B-it --a llm-preview --b search --max-locks 56 --seeds 101 --max-tokens 4096 --decision-tokens 16384 --max-calls 10
```

UIのモデル選択にも両IDを追加。リプレイにモデルIDとproviderを表示します。「LLM 接続確認」は選択モデルへの短い生成要求を1回送信します。Aが探索botでBがLLMならB、それ以外はAの選択モデルを使います。以前のモデル一覧取得だけの確認から変更しました。

`--model-a` / `--model-b` で両者別モデルも設定できます。条件比較では同一局面、同じ公開情報、同じ予算を使い、本文・reasoning_content・usage・実際のpreview回数を保存します。HTTP401/429/500やtimeoutは無効で、接続先やプレイヤーの無断置換はありません。

`--request-interval-ms 10000` で同一プロセス・接続先への要求開始間隔を10秒以上にできます。previewと訂正要求にも適用し、別プロセスとは共有しません。HTTP429の自動再試行はしません。既定値は0、使用値は対局設定に保存します。待機時間は `pacingMs` に記録し、`elapsedMs` はこれを含むため、API自体の応答時間は各requestの `elapsedMs` を参照します。10秒は今回の試験値で、公式のレート上限を示すものではありません。

画面では「観測・生成・探索の設定」の「API 要求間隔 (秒)」から変更できます。今回のKimi対局を再試行するなら、思考を無効、出力4096、生成予算16384、最大API往復10、要求間隔10秒を指定します。

## 確認したAPI仕様と残る検証

[公式利用手順](https://manual.sakura.ad.jp/cloud/ai-engine/02-howto.html)でBearer認証とchat/completionsのURLを確認しました。[公式OpenAPI](https://manual.sakura.ad.jp/api/cloud/portal/openapis/ai-engine-inference-api.json)にはmax_tokens、temperature、chat_template_kwargs、reasoning_effortがあります。chat/completionsのresponse_formatは掲載されていないため、さくら接続では本文JSON方式を使用し、schema/jsonモード指定は未確認エラーにします。

思考は既定でサーバー設定を維持します。明示した `--thinking off` は、さくらのKimiには `chat_template_kwargs.thinking=false`、その他には `chat_template_kwargs.enable_thinking=false` を送る別条件です。Kimi固有のキーは[モデル作者の配信手順](https://huggingface.co/moonshotai/Kimi-K2.6)に基づきます。初回のKimi試行では汎用のenable_thinkingを送ってしまい、長文説明が本文に出て失格になりました。この試行は思考無効が成功した対局に数えません。実際の要求本文はログで確認できます。

初回の実局面ではKimiが4096出力上限で思考中に打切られ、Gemmaは合法手JSONをMarkdownコード枠に入れて返しました。さくら接続の `responseParsing=json-fence-v1` は応答全体が単一のJSONコード枠の場合に枠だけを除去します。JSONの修復・手の変更・任意の説明文からのJSON抽出はしません。元の応答を残し、除去した場合は要求ログにresponseNormalizationを記録します。旧ログとローカル既定はstrictのままです。

費用は公開レート（2026-09-08確認）とサーバーusageから `estimatedCostJpy` を計算します。Kimiは入力0.6円・出力3円/1万token、Gemmaは入力0.24円・出力0.96円/1万token。[公式料金](https://ai.sakura.ad.jp/sakura-ai/ai-engine/)が根拠です。無料枠や請求上の調整を反映した実際の請求額ではなく、実費 `cost` はnullのままです。usageが不明なら推定もnullです。レートの出典と確認日を対局headerに保存します。

## これまでの対局の解釈

探索bot同士の106/120固定の対局では両者が消去し、おじゃまを送受信しました。一方、通常Qwenの14固定試行は両者が7個ずつ置いただけで、消去0・攻撃0・preview0回です。軽量Gemmaは消去せず先頭候補を繰り返し選び、通常Gemmaはロード失敗のため判断自体ができていません。

したがって以前の「完走」は対局処理の疎通確認を指し、LLMの攻防が成立したという評価ではありません。短い試行・生成打切り・提示方法の影響もあり、モデル性能だけに原因を帰属させません。新しいモデルでは、合法応答だけでなく消去、攻撃、相殺、予告下での生存、preview利用を確認します。

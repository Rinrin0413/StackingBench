# 接続プロファイル

LLM プレイヤーの条件はモデル名から自動推測せず、`connectionId` と `modelId` の組で指定します。接続プロファイルは `config/connections.example.json` を `config/connections.json` にコピーしてサーバー側だけで登録します。実設定は Git 対象外で、ブラウザから base URL や header を注入することはできません。設定ファイルの場所を変える場合はサーバー起動時に `STACKINGBENCH_CONNECTIONS=/path/to/connections.json` を指定します。

## プロファイルの形

`config/connections.json` は次のような `connections` 配列を持ちます。`version` は設定形式の policy/versioning 値であり、probe TTL や run format と同様に将来変更できます。

```json
{
  "version": 1,
  "connections": [
    {
      "id": "internal-gateway",
      "label": "社内 OpenAI 互換 gateway",
      "baseUrl": "http://gateway.internal.example/v1",
      "protocol": "openai-chat-completions",
      "credential": {"type": "bearer-env", "env": "INTERNAL_GATEWAY_API_KEY"},
      "staticHeaders": {"X-Client": "stackingbench"},
      "requestDefaults": {"provider": {"allow_fallbacks": false}},
      "capabilityDefaults": {},
      "capabilityOverrides": {"model-id": {"jsonSchema": true}}
    }
  ]
}
```

`baseUrl` は `/v1` など API prefix まで含む完成形です。HTTP と HTTPS を使えますが、credential、query、fragment、endpoint path を含められません。`credential` は `none`、Bearer の環境変数参照、または `X-API-Key` / `API-Key` を含む任意の有効な header 名と環境変数参照を許可します。literal secret は設定ファイルに置けません。

`staticHeaders` は非秘密 header 専用です。`Authorization`、API key、cookie、token などの値は必ず `credential` の環境変数参照として扱い、static header には登録できません。`requestDefaults` は標準 benchmark fields を上書きできず、provider extension や routing policy のような追加フィールドに限定されます。

`capabilityDefaults` は接続全体の保守的な初期値、`capabilityOverrides` はモデル ID ごとの明示的な上書きです。いずれも probe 結果の代わりに永久的な事実を意味するものではなく、採用した snapshot に固定して run header へ保存します。

同梱 preset は `local-llamacpp`、`sakura-ai`、`openrouter`、`groq`、`cerebras`、`typesafe-jev` です。preset も内部実装上は connection profile ですが、TypeSafe Jev だけは `typesafe-jev-choice` protocol adapter を使用します。

## モデル一覧と probe

`/models` は optional です。取得できない connection でもモデル ID を手入力して使用できます。取得できた `supported_parameters` は capability hint として記録しますが、永続的な対応保証とは扱わず、選択した実行条件は probe で確認します。`POST /api/probe` は `connectionId` と `modelId` を受け取り、OpenAI-compatible では basic text、usage、JSON object、JSON schema、reasoning acceptance を別々に検証します。TypeSafe では protocol 固有の `choice` と usage だけを検証し、basic text、JSON output、reasoning は `not-applicable` とします。probe の結果は対局の token/call/score 集計には入りません。

未確認または期限切れの `connectionId + modelId + request policy` は、対局開始前に選択された response/reasoning mode に必要な target を自動 probe します。probe cache の identity には endpoint fingerprint に加えて `requestDefaults`、routing policy、非秘密 static headers を含めるため、routing 条件を変えた cache は再利用しません。TTL は初期値 24 時間ですが、`STACKINGBENCH_PROBE_TTL_MS` で変更できる policy です。cache file の既定位置も policy であり、`STACKINGBENCH_CAPABILITIES` で変更できます。採用した snapshot は header に固定され、実行中の再 probe や mode fallback は行いません。

## OpenRouter routing とログ

設定した routing policy と、レスポンスから明示的に観測できた downstream provider metadata は別々に記録します。レスポンスに安全に許可できる metadata がなければ `unknown` とし、model ID や policy から downstream provider を推測しません。

OpenRouter preset は `provider.allow_fallbacks=false` を既定 routing policy として送信し、対局中の downstream fallback を許可しません。また、非秘密の `X-OpenRouter-Metadata: enabled` を送るため、サービスが返す `openrouter_metadata` のうち安全な provider/model/route 情報だけを observed metadata として保存します。サービスや gateway が返さない場合は `unknown` のままです。

strict JSON Schema の wire projection は StackingBench 内部の `ACTION_SCHEMA` と別物です。preview 用 strict schema では provider 間の要件を満たすため `node` を required string とし、root は文字列 `"root"` で表します。optional field を空文字へ変換しません。`memo` / `reason` は portable wire schema から除外しますが、既存 parser は通常応答で引き続き受理します。JSON schema を使えない connection では、対局開始前に選択した plain JSON instruction / parser 条件をそのまま固定します。

custom/internal endpoint の run には raw URL を保存しません。header と trace には connection ID と SHA-256 endpoint fingerprint を保存できますが、fingerprint は匿名化・秘匿化の保証ではなく、同一 endpoint の識別用です。公開 preset の endpoint identity は再現性のため保存できます。credential、credential env 名、auth header は保存しません。

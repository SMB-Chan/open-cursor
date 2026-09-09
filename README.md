# Cursor Open Providers

Cursorのエディタ・ターミナルに、自由に接続先を選べるContinueを組み合わせた個人用構成です。
Cursor内蔵の課金対象Agentとは別の、Continueのチャット欄を使います。

## 起動と操作

- アプリ一覧の **Cursor（自由なLLM接続）**、または `~/.local/bin/cursor-open` で起動します。
- フォルダを指定するときは `~/.local/bin/cursor-open /path/to/project` を実行します。
- 左のContinueでモデルを選択し、Chat / Plan / Agentを切り替えます。
- Agentではファイル編集やコマンド実行を提案できます。承認方法はContinue側で管理します。
- `Ctrl+Shift+L`：Continueにフォーカス。選択コードの編集は `Ctrl+I`。
- `Ctrl+Shift+J`：ターミナルにフォーカス。`Ctrl+Shift+T`：新しいターミナル。
- 下部の **LLM Providers**：Continueの設定を開きます。

## プロバイダ設定

初期接続には既存のMiMo `mimo-v2.5-pro` 設定を移行します。
Agent用のツール対応を明示し、互換性を優先してMiMoのthinkingをdisabledに設定します。
thinkingを利用する場合は設定の `requestOptions.extraBodyProperties.thinking.type` を変更できます。
通常のチャット、編集、差分適用に同じモデルを利用します。
自動Tab補完は専用モデルが未検証のため初期状態では無効です。

- 有効な設定：`~/.local/share/cursor-open-providers/continue/config.yaml`
- APIキー：同じフォルダの `.env`（本人のみ読み書き可能）
- 他の既存プロバイダのひな型：同じフォルダの `providers.example.yaml`

config.yamlはJSON表記のYAMLです。通常のYAML表記に書き換えることもできます。
独自OpenAI互換APIを追加する場合のモデル設定例：

```yaml
- name: My Coding Model
  provider: openai
  model: YOUR_MODEL_ID
  apiBase: https://YOUR_PROVIDER/v1
  apiKey: ${{ secrets.MY_PROVIDER_API_KEY }}
  roles: [chat, edit, apply]
  capabilities: [tool_use]
```

対応モデルの場合にだけ `tool_use` を指定してください。
`.env`に `MY_PROVIDER_API_KEY=...` を設定し、上のモデルを `models` に追加します。
Ollama、OpenRouter、AnthropicなどはContinueが用意するproviderを指定できます。
既存ひな型のモデル名は移行元のままなので、利用先で提供中のIDを確認して更新してください。

Cursor Proのモデル選択制限を通らず、Continueから指定したプロバイダに接続します。
接続先APIの料金・レート制限・モデル側の制約はそのまま適用されます。
Cursor自体の組み込みAIコードを削除したビルドではありません。
通常の起動経路では内蔵Agent画面を閉じ、関係するAI拡張を無効にしています。
起動時はCursorに実装されている `--skip-onboarding --skip-welcome` を指定し、
ログイン用の初回画面を表示せずエディタへ進みます。
このCursor版にはタイトルバーのUpgrade案内が残ります。上記は有料機能を解放する改造ではありません。

## 既存環境と復元

元のCursorの設定・ログイン・履歴、`~/.continue/config.json` は変更しません。
**Cursor（元のIDE）** から以前の環境を開けます。`/usr/bin/cursor` も元のままです。

インストール内容は `python3 install.py plan`、適用は `python3 install.py install` で確認・実行できます。
`python3 install.py restore` で起動入口を元に戻します。
復元時には新構成の設定・キー・履歴を削除せず残します。
インストール後に変更されたランチャーは上書きせず停止します。

## 参考

- [Continueのプロバイダ設定](https://docs.continue.dev/customize/model-providers/top-level/openai)
- [Continueの設定とAgent用ツール対応](https://docs.continue.dev/reference)
- [MiMo Chat Completions API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)

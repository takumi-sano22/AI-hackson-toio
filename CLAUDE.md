# CLAUDE.md

## プロジェクト概要

- **全日本AIハッカソン** 向けの短時間開発プロダクト。
- **toio**（ソニーのミニロボット）を使い、テーマは **「友」**。
- 短時間勝負のため、**動くデモを最優先**。完成度より体験の伝わりやすさを優先する。

## 技術構成

| 項目 | 内容 |
| --- | --- |
| 実行環境 | ブラウザ。Web Bluetooth で toio Core Cube に接続する |
| ライブラリ | p5.js + [p5.toio](https://tetunori.github.io/p5.toio/)（CDN 読み込み。ビルド工程なし） |
| 現在のファイル | `sample.js` のみ（toio の 2D デジタルツイン表示サンプル。接続・位置/角度表示・キー操作） |
| エントリ | **未作成**。デモ実行には `index.html` を追加し、p5.js・p5.toio・各スクリプトを読み込む必要がある |

> Web Bluetooth は HTTPS もしくは `localhost` でしか動かない。ローカル確認時はローカルサーバを立てる。

## Skill 方針

- **global skill（`~/.claude/skills/`）を使う。** 本リポジトリに固有版 skill は置かない。
- 開発フローは **global 版 `github-workflow` を既定**とし、コード/ドキュメント変更は Issue → ブランチ → PR → 2段階レビュー（Claude 自己レビュー → Codex）の標準フローに従う。
- ほかは作業内容に応じて `create-issue` / `code-review` / `model-selection` / `subagent-briefing` 等の global skill を参照する。

## レビュー運用（ハッカソン中の短縮ルール）

- **Codex レビューは 1 PR につき 1 回だけ**実行する。指摘があれば修正し、**再レビューはせずマージしてよい**（時間短縮を優先するため）。
- ただし破壊的/不可逆な変更・認証/認可・設計の根本変更に該当する場合は、マージせず人間確認で停止する。

## 規約

- Issue / PR タイトルの prefix は `[toio]`。
- ブランチ名は `feature/` `fix/` `docs/` `infra/` + `<issue番号>-short-name`。
- worktree は `.claude/worktrees/<branch>` に作成し、マージ後に必ず削除する。

## 実装方針

- **最小実装を優先（KISS）**。ハッカソン中は先回りの抽象化・依頼範囲外のリファクタをしない。
- テストコードは作らない（明示指示がある場合を除く）。
- コメントは日本語で、「何をしているか」より「なぜそうしたか」を簡潔に添える。

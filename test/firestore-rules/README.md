# firestore.rules の検証

Firestoreエミュレータに実際にクエリを投げて、ルールが意図通りかを確かめる。
ルールを触ったら必ず回すこと（**未デプロイのまま本番に出さない**）。

```sh
cd test/firestore-rules
npm install
npm test
```

必要なもの: Firebase CLI（`firebase`）と Java（エミュレータが使う）。

`npm install` が `~/.npm` の権限で失敗する場合は `sudo chown -R $(id -u):$(id -g) ~/.npm`
か、`npm install --cache ./.npmcache` で回避する。

## 見ているもの（23項目）

- 非共有 `users/{uid}/**` は本人だけ
- 共有 `works/{id}` の**単体取得**はログイン済みなら可（リンク＝権限）
- 共有 `works` の**一覧**は自分が members に入っているものだけ
  - ここが `allow read` 一本だと list まで通ってしまい、**ログインできる人なら誰でも
    他人の共有作品を全部読めた**。get と list は必ず分ける
- 作成時の owner なりすまし / ownerUid の奪取 / 非メンバーの書き込みは拒否
- リンク参加は「受付中」「自分だけ追加」「他人を消さない」の3条件
- 削除はオーナーのみ、章と presence の権限

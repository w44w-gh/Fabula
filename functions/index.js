/**
 * Fabula backend（P1: 認証）
 *  - discordAuth : Discord OAuth の code → ロール確認 → Firebaseカスタムトークン発行
 *  - redeemCode  : 1回限りの個人コード照合 → Firebaseカスタムトークン発行
 * どちらも supporter クレーム付きトークンを返す（クライアントは signInWithCustomToken）。
 *
 * 必要な設定（デプロイ前に takano が用意）:
 *   環境変数(functions/.env)… DISCORD_CLIENT_ID / DISCORD_GUILD_ID / DISCORD_SUPPORTER_ROLE_ID
 *   シークレット …… DISCORD_CLIENT_SECRET / DISCORD_BOT_TOKEN
 *     firebase functions:secrets:set DISCORD_CLIENT_SECRET
 *     firebase functions:secrets:set DISCORD_BOT_TOKEN
 *   ※BotはサーバーにいてServer Members Intentが必要。Node20のグローバルfetchを使用。
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const DISCORD_CLIENT_SECRET = defineSecret("DISCORD_CLIENT_SECRET");
const DISCORD_BOT_TOKEN = defineSecret("DISCORD_BOT_TOKEN");

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SUPPORTER_ROLE_ID = process.env.DISCORD_SUPPORTER_ROLE_ID;
const REGION = "asia-northeast1";

// ---- Discordログイン: OAuth code → ロール確認 → カスタムトークン ----
exports.discordAuth = onCall(
  { region: REGION, secrets: [DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN] },
  async (req) => {
    const code = req.data && req.data.code;
    const redirectUri = req.data && req.data.redirectUri;
    if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code と redirectUri が必要です");
    if (!CLIENT_ID || !GUILD_ID || !SUPPORTER_ROLE_ID) throw new HttpsError("failed-precondition", "サーバー設定(環境変数)が未設定です");

    // 1) code → アクセストークン
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET.value(),
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new HttpsError("unauthenticated", "Discordのトークン交換に失敗しました");
    const token = await tokenRes.json();

    // 2) ユーザー取得
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) throw new HttpsError("unauthenticated", "Discordユーザー取得に失敗しました");
    const me = await meRes.json();
    const discordId = me.id;

    // 3) ギルドメンバーのロールを Bot で確認
    const memRes = await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN.value()}` },
    });
    if (memRes.status === 404) throw new HttpsError("permission-denied", "サーバーのメンバーではありません");
    if (!memRes.ok) {
      const body = await memRes.text().catch(() => "");
      console.error("[discordAuth] member fetch failed", memRes.status, body);
      // 403=Server Members Intent未有効 or Bot権限不足 / 401=Botトークン不正 のことが多い
      throw new HttpsError("internal", `メンバー情報の取得に失敗しました (HTTP ${memRes.status})`);
    }
    const member = await memRes.json();
    const isSupporter = Array.isArray(member.roles) && member.roles.includes(SUPPORTER_ROLE_ID);
    if (!isSupporter) throw new HttpsError("permission-denied", "支援者ロールがありません");

    // 4) カスタムトークン発行（uid は Discordユーザーid由来＝同じDiscord＝同じデータ）
    const uid = `discord_${discordId}`;
    const customToken = await admin.auth().createCustomToken(uid, { supporter: true, via: "discord" });
    return { token: customToken, name: me.global_name || me.username || "" };
  }
);

// ---- 1回限りコード: 照合 → カスタムトークン ----
// Firestore の codes/{code} を照合。初回で claimed=true＋安定uidを付与。以後は同じコードで同アカウントに再ログイン可。
exports.redeemCode = onCall({ region: REGION }, async (req) => {
  const code = ((req.data && req.data.code) || "").trim();
  if (!code) throw new HttpsError("invalid-argument", "コードを入力してください");

  const db = admin.firestore();
  const ref = db.collection("codes").doc(code);
  // ※ トランザクション内で HttpsError を throw すると internal に化けるため、
  //   理由は reason に積んで正常 return し、トランザクション外で throw する。
  let uid = null, reason = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) { reason = ["permission-denied", "無効なコードです"]; return; }
    const d = snap.data();
    if (d.revoked) { reason = ["permission-denied", "このコードは無効化されています"]; return; }
    if (d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now()) {
      reason = ["permission-denied", "このコードは期限切れです"]; return;
    }
    let assignedUid = d.uid;
    if (!d.claimed || !assignedUid) {
      assignedUid = "code_" + crypto.randomUUID().replace(/-/g, ""); // コードと分離した安定uid
      tx.update(ref, { claimed: true, uid: assignedUid, claimedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    uid = assignedUid;
  });
  if (reason) throw new HttpsError(reason[0], reason[1]);

  const customToken = await admin.auth().createCustomToken(uid, { supporter: true, via: "code" });
  return { token: customToken };
});

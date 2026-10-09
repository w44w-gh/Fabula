/**
 * Fabula backend（P1: 認証）
 *  - discordAuth : Discord OAuth の code → 支援者ロール確認 → Firebaseカスタムトークン発行
 * supporter クレーム付きトークンを返す（クライアントは signInWithCustomToken）。
 * ※ アクセスコード(redeemCode)は廃止。Discordサーバーに直接ユーザー追加＋ロール付与で誰でも許可できるため不要。
 *   firestore依存も無し（redeemCodeが唯一の利用者だった）。
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
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

const DISCORD_CLIENT_SECRET = defineSecret("DISCORD_CLIENT_SECRET");
const DISCORD_BOT_TOKEN = defineSecret("DISCORD_BOT_TOKEN");

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
// 複数ロール対応：DISCORD_SUPPORTER_ROLE_ID はカンマ区切りで複数OK（いずれか1つ持っていれば支援者）
const SUPPORTER_ROLE_IDS = (process.env.DISCORD_SUPPORTER_ROLE_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const REGION = "asia-northeast1";

// ---- Discordログイン: OAuth code → ロール確認 → カスタムトークン ----
exports.discordAuth = onCall(
  { region: REGION, secrets: [DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN] },
  async (req) => {
   try {
    const code = req.data && req.data.code;
    const redirectUri = req.data && req.data.redirectUri;
    if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code と redirectUri が必要です");
    if (!CLIENT_ID || !GUILD_ID || SUPPORTER_ROLE_IDS.length === 0) throw new HttpsError("failed-precondition", "サーバー設定(環境変数)が未設定です");

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
    const isSupporter = Array.isArray(member.roles) && member.roles.some((r) => SUPPORTER_ROLE_IDS.includes(r));
    if (!isSupporter) {
      console.error("[discordAuth] role mismatch. member.roles=", member.roles, " expected one of SUPPORTER_ROLE_IDS=", SUPPORTER_ROLE_IDS);
      throw new HttpsError("permission-denied", "支援者ロールがありません");
    }

    // 4) カスタムトークン発行（uid は Discordユーザーid由来＝同じDiscord＝同じデータ）
    const uid = `discord_${discordId}`;
    const customToken = await getAuth().createCustomToken(uid, { supporter: true, via: "discord" });
    return { token: customToken, name: me.global_name || me.username || "" };
   } catch (e) {
     if (e instanceof HttpsError) throw e;
     console.error("[discordAuth] unexpected error:", (e && e.stack) || e);
     // 原因を画面に出すために素のエラーメッセージを載せる（デバッグ用・一時的）
     throw new HttpsError("internal", "discordAuth失敗: " + ((e && e.message) ? e.message : String(e)));
   }
  }
);

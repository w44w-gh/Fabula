// firestore.rules の検証。エミュレータ上で実際にクエリを投げて確かめる。
//   実行: test/firestore-rules で npm install したあと npm test
// get と list を分けている理由（read ひとつだと他人の作品を全部読める）は DESIGN.md §3 を参照。
const fs=require("fs");
const path=require("path");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const RULES = process.env.RULES_FILE || path.resolve(__dirname, "../../firestore.rules");
const [EMU_HOST, EMU_PORT] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

const results=[];
async function check(name, p){
  try{ await p; results.push(["OK  ", name]); }
  catch(e){ results.push(["NG  ", name+"  ← "+String(e.message||e).split("\n")[0].slice(0,90)]); }
}

(async()=>{
  const env = await initializeTestEnvironment({
    projectId: "fabula-rules-test",
    firestore: { rules: fs.readFileSync(RULES,"utf8"), host:EMU_HOST, port:Number(EMU_PORT) },
  });
  await env.clearFirestore();

  // 下ごしらえ（ルールを無視して書き込む）
  await env.withSecurityRulesDisabled(async (ctx)=>{
    const db=ctx.firestore();
    await db.doc("works/W_open").set({ ownerUid:"owner", members:["owner","mate"], inviteOpen:true,  title:"公開中の共同作品", data:{secret:"本文"} });
    await db.doc("works/W_shut").set({ ownerUid:"owner", members:["owner"],         inviteOpen:false, title:"締め切った作品",   data:{secret:"本文"} });
    await db.doc("works/W_open/chapters/c1").set({ title:"第1章", body:"原稿" });
    await db.doc("users/owner/projects/p1").set({ title:"オーナーの非共有作品" });
  });

  const owner=env.authenticatedContext("owner").firestore();
  const mate =env.authenticatedContext("mate").firestore();
  const other=env.authenticatedContext("stranger").firestore();   // ログイン済みだが無関係な人
  const anon =env.unauthenticatedContext().firestore();

  // --- 非共有 ---
  await check("非共有: 本人は読める",            assertSucceeds(owner.doc("users/owner/projects/p1").get()));
  await check("非共有: 他人は読めない",          assertFails(other.doc("users/owner/projects/p1").get()));
  await check("非共有: 未ログインは読めない",    assertFails(anon.doc("users/owner/projects/p1").get()));

  // --- works 単体取得（リンクを知っていれば読める、が設計） ---
  await check("共有: メンバーは読める",          assertSucceeds(mate.doc("works/W_open").get()));
  await check("共有: 未ログインは読めない",      assertFails(anon.doc("works/W_open").get()));

  // --- 一覧（ここが本命） ---
  await check("一覧: 自分の参加作品は引ける",
    assertSucceeds(mate.collection("works").where("members","array-contains","mate").get()));
  await check("一覧: 無関係な人が全作品を列挙できない",
    assertFails(other.collection("works").get()));
  await check("一覧: 他人のmembersを指定して引けない",
    assertFails(other.collection("works").where("members","array-contains","owner").get()));

  // --- 作成 ---
  await check("作成: 自分をowner&memberにして作れる",
    assertSucceeds(other.doc("works/W_new").set({ ownerUid:"stranger", members:["stranger"], inviteOpen:true, title:"新作" })));
  await check("作成: 他人をownerにして作れない",
    assertFails(other.doc("works/W_new2").set({ ownerUid:"owner", members:["owner"], inviteOpen:true, title:"なりすまし" })));

  // --- 更新 ---
  await check("更新: メンバーは本文を書ける",    assertSucceeds(mate.doc("works/W_open").update({ title:"書き換え" })));
  await check("更新: 無関係な人は書けない",      assertFails(other.doc("works/W_open").update({ title:"荒らし" })));
  await check("更新: ownerUidは奪えない",        assertFails(mate.doc("works/W_open").update({ ownerUid:"mate" })));

  // --- リンク参加 ---
  await check("参加: 受付中なら自分だけ追加できる",
    assertSucceeds(other.doc("works/W_open").update({ members:["owner","mate","stranger"] })));
  await check("参加: 受付を閉じていたら入れない",
    assertFails(other.doc("works/W_shut").update({ members:["owner","stranger"] })));
  await check("参加: 他人を消しながら入れない",
    assertFails(env.authenticatedContext("x2").firestore().doc("works/W_open").update({ members:["owner","x2"] })));

  // --- 削除 ---
  await check("削除: メンバーでもオーナー以外は消せない", assertFails(mate.doc("works/W_open").delete()));
  await check("削除: オーナーは消せる",                   assertSucceeds(owner.doc("works/W_open").delete()));

  // --- 章 ---
  await env.withSecurityRulesDisabled(async (ctx)=>{
    await ctx.firestore().doc("works/W2").set({ ownerUid:"owner", members:["owner","mate"], inviteOpen:true, title:"章テスト" });
    await ctx.firestore().doc("works/W2/chapters/c1").set({ title:"第1章", body:"原稿" });
  });
  await check("章: メンバーは書ける",     assertSucceeds(mate.doc("works/W2/chapters/c1").update({ body:"追記" })));
  await check("章: 無関係な人は書けない", assertFails(other.doc("works/W2/chapters/c1").update({ body:"荒らし" })));
  await check("章: ログイン済みなら読める（リンク前提）", assertSucceeds(other.doc("works/W2/chapters/c1").get()));

  // --- コレクショングループ照会（入れ子のmatchはグループ照会に効かない＝拒否されるはず） ---
  await check("章: 無関係な人がcollectionGroupで全作品の原稿を読めない",
    assertFails(other.collectionGroup("chapters").get()));
  await check("presence: collectionGroupで全作品の参加者を読めない",
    assertFails(other.collectionGroup("presence").get()));

  // --- presence ---
  await check("presence: 自分のdocは書ける",   assertSucceeds(mate.doc("works/W2/presence/mate").set({ name:"相棒", at:Date.now() })));
  await check("presence: 他人のdocは書けない", assertFails(mate.doc("works/W2/presence/owner").set({ name:"なりすまし", at:Date.now() })));

  await env.cleanup();
  console.log("\n==== Firestore ルール検証 ====");
  results.forEach(([s,n])=>console.log(s+n));
  const ng=results.filter(r=>r[0].trim()==="NG").length;
  console.log(`---- ${results.length-ng}/${results.length} 期待通り ----`);
  process.exit(ng ? 1 : 0);   // 1件でも想定外ならCI的に失敗させる
})().catch(e=>{ console.error("テスト自体が失敗:", e); process.exit(1); });

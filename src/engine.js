'use strict';
/**
 * 中古ゲームショップ経営プロトタイプ — ゲームエンジン
 *
 * 仕様書 10 節「プロトタイプの範囲」に対応。
 * 実装: 50週×2ターンのループ / 店番（客の売買） / 行動フェイズ（オークション・処分品引取・整理）
 *       / 在庫枠の上限 / 家賃の引き落とし / 図鑑の登録・所持の二層管理
 * 未実装: 常連イベント、裏ストーリー、査定の詳細、店舗拡張、評判、グラフィック
 *
 * ブラウザ（<script src>）と Node（require）の両方から使える。
 */
(function (root, factory) {
  const Catalog = (typeof module === 'object' && module.exports)
    ? require('./catalog.js') : root.Catalog;
  const api = factory(Catalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Catalog) {

  const { makeRng, rInt, rPick, rWeighted, DATA } = Catalog;

  // ============================================================
  // バランス定数（調整はすべてここ）
  // ============================================================
  const BALANCE = {
    totalWeeks: 50,        // αテスト版は 10 で作る（UIの「範囲」で切り替え）
    rent: 30000,
    startCash: 100000,
    startInventory: 30,
    shelfSlots: 50,          // 保管も含めた総枠
    displaySlots: 20,        // うち店頭陳列できる数
    /**
     * 交渉術。金では買えず、常連との付き合いの中で教わる。
     * 客相手でも業者相手でも「値段の話」は同じなので、仕入れ全体に効く。
     * 周回引き継ぎでは腕として残る（店の資産は残らない）。
     */
    skills: {
      haggle:      { name: '値切り',   from: '大町',
                     desc: 'まとめ買いと処分品引取の言い値が25%下がる', lot: -0.25 },
      appraise:    { name: '目利き',   from: '蜷川',
                     desc: '持ち込みを30%安く買い取り、指名客には25%高く売れる', buy: -0.30, sell: 0.25 },
      connections: { name: '顔つなぎ', from: '速水',
                     desc: 'オークションと取り寄せが30%安くなり、未所持が回ってきやすい',
                     bid: -0.30, order: -0.30, unownedBias: 0.9 },
    },

    /**
     * 金で買える設備・人手。購入は行動フェイズを1回使う。
     * 設備は「棚売り（値札売り）」を、人手は「接客（指名客）」を伸ばす。
     */
    upgrades: [
      { id: 'warehouse', name: '倉庫を広げる', cost: 100000, max: 5,
        effect: { shelfSlots: 50 },
        desc: '保管できる本数が50枠増える。全タイトルを同時所持するには必須' },
      { id: 'shelf', name: '陳列棚を増やす', cost: 80000, max: 4,
        effect: { displaySlots: 10 },
        desc: '店に並べられる本数が10増える。並べた分だけ値札で売れる' },
      { id: 'storefront', name: '店内を改装する', cost: 150000, max: 3,
        effect: { passive: 2 },
        desc: '照明と什器を入れ替える。値札売りの本数が2本増える' },
      { id: 'clerk', name: '店員を雇う', cost: 200000, max: 2,
        effect: { customers: 1 },
        desc: '接客できる人数が1人増える。指名客と常連に会える機会が増える' },
    ],

    /**
     * 激レア15本の入手経路。
     *  'event'   … 仕様書 8 節どおりイベント報酬のみ（常連イベントの代役）
     *  'auction' … オークションで購入できる（終盤の資金の受け皿になる）
     *  'both'    … 両方
     */
    ultra: { source: 'auction' },
    catalogSize: 200,
    catalogSeed: 20260821,

    tiers: {
      common: { label: '並品',   count: 70, sale: [500, 2000],      buyRatio: 0.40 },
      mid:    { label: '中堅',   count: 30, sale: [3000, 8000],     buyRatio: 0.42 },
      rare:   { label: 'レア',   count: 35, sale: [15000, 40000],   buyRatio: 0.43 },
      ultra:  { label: '激レア', count: 15, sale: [80000, 300000],  buyRatio: 0.45 },
    },

    /**
     * 評判（0〜100）。開店時は最低で、商売の仕方によって上下する。
     *  - 来客数（判断が要る客）が 1〜6 人の範囲で増減する
     *  - 店頭の自動売上（賑わい）も連動する
     *  - 客が持ち込むソフトの希少度がわずかに上がる
     */
    reputation: {
      enabled: true,
      start: 0, min: 0, max: 100,
      customers: [1, 3],          // 評判 0 → 100 のときの来客数（店主一人で捌ける上限）
      passive: [6, 18],           // 同じく店頭の値札売りの本数（安いぶん数は出る）
      customerNoise: 1,           // 来客数のターンごとのブレ
      gainFalloff: 0.5,           // 評判が高いほど上がりにくくなる強さ（0で逓減なし）
      sellerRareBonus: 0.10,      // 評判100で持ち込みのレア率が+10ポイント（劇的にはしない）
      gain: {
        buyFromCustomer: 1.5,     // 持ち込みを買い取った
        junkLot: 1.5,             // 近所の処分品を引き取った（業者との取引では上がらない）
        refuseSeller: -0.6,       // 持ち込みを断った
        sellToCustomer: 0.5,      // 指名買いに応じた
        refuseBuyer: -0.8,        // 指名買いを断った
        markdownSold: 0.4,        // 値下げ品が売れた
        shelfFull: 3.0,           // 週末: 陳列枠の充実度に応じて（これが立ち上げの起点）
        rareOnShelf: 0.5,         // 週末: 陳列中／確保中のレア以上1本につき（上限6本ぶん）
        junkOnShelf: -0.25,       // 週末: 陳列中のガラクタ1本につき
        emptyShelf: -2,           // 週末: 棚に売り物が無い
        loseRare: -1.2,           // レア以上の最後の1本を手放した
        forcedSale: -6,           // 家賃が払えず在庫を毟られた
        weeklyDrift: -0.5,        // 何もしなければ少しずつ忘れられる
      },
    },

    /**
     * 店頭の通常売上（判断不要）。
     * 仕様書 2 節の「客3〜4人」は"判断が要る客"の数として扱い、
     * それ以外の一般客はまとめて自動処理する。これが無いと家賃を払える売上に届かない。
     */
    /**
     * 店頭の値札売り。棚に並べた＝値札を付けた、ということなので相場より安くしか売れない。
     * 客が勝手に手に取ってレジに持ってくるだけで、店主が値段を言う場面がないため。
     * 安いぶん回転は速い。
     */
    passiveSales: { count: [7, 12], priceRange: [0.78, 0.90],
                    // 寂れた店には客も来ない。品揃えが増えるにつれて客足が戻る
                    earlyCount: [5, 9], fullFromWeek: 16 },

    /**
     * 常連キャラ（仕様書 8 節）。data/regulars.json の内容が使われる。
     * 来店回数が visitThresholds に達するとイベントが発生する。
     */
    /**
     * 常連キャラ（仕様書 8 節）。data/regulars.json の内容が使われる。
     * 来客枠は1回ずつ「一般客か常連か」を抽選する。常連が枠に上乗せされるわけではない。
     * 寂れた店に常連はついていないので、常連が当たる確率も評判に連動する。
     */
    regulars: { enabled: true, visitChance: [0.15, 0.5], oncePerTurn: true },

    // 店番（＝売る／売らないの判断が発生する客）
    customers: {
      front: { count: [3, 4], weights: { seller: 0.45, buyer: 0.35, browser: 0.20 } },
      back:  { count: [4, 5], weights: { seller: 0.25, buyer: 0.60, browser: 0.15 } },
    },
    // 指名客の提示額。探し回った末に「〇〇ありますか」と尋ねに来る客なので、
    // 値札に縛られず相場かそれ以上を出す
    buyerOfferRange: [0.95, 1.25],
    buyerSecondItemChance: 0.25,     // ついで買い
    sellerAskRange: [0.80, 1.50],    // 買取目安に対する持ち込み希望額
    sellerTierWeights: { common: 0.62, mid: 0.28, rare: 0.10, ultra: 0 }, // 激レアは持ち込まれない
    reacquireBoost: 3.0,             // 詰み対策: 一度手放したソフトの再登場率
    markdownRate: 0.20,              // 値下げ幅
    markdownDemand: 2.2,             // 値下げ品の需要倍率
    staleWeeks: 8,                   // これ以上寝かせると死に在庫扱い（需要低下）
    staleDemand: 0.55,

    // 行動フェイズ
    /**
     * 処分品引取＝近所の人から引き取る。「捨てるくらいなら持ってって」の口。
     * 少量・安価で、ガラクタは入らない（最低でも傷あり）。レア以上は出ない。
     * まとめ買いとの違いは規模ではなく相手で、こちらは商売ではなく人付き合い。
     */
    junk:   { cost: [2000, 8000], freeChance: 0, items: [4, 8],
              mix: { junk: 0, common: 0.88, mid: 0.12, rare: 0, ultra: 0 } },
    /**
     * まとめ買い＝業者のオークションロット。量を金で買う。
     * ガラクタは入れない。中身は全部が実在のソフトで、安い並品が大半という形にする。
     * 区分の比率は旧 mix の非ガラクタ部分をそのまま正規化したもの（平均単価が変わらない）。
     */
    bulk:   { items: [16, 26], priceRatio: [0.20, 0.45], cap: [3000, 90000],
              // 寂れた店には良いロットが回ってこない。週が進むほど mix に近づく
              earlyMix: { junk: 0, common: 0.717, mid: 0.208, rare: 0.075, ultra: 0.004 },
              mixFullFromWeek: 16,
              // レアの含有率は総数に連動させる（総数が増えると1本あたりの遭遇率が下がる）
              mix: { junk: 0, common: 0.643, mid: 0.213, rare: 0.130, ultra: 0.014 } },
    single: { rivalRatio: [0.50, 0.95], askRatio: [0.35, 0.50],
              tierWeights: { mid: 0.18, rare: 0.70, ultra: 0.12 },
              ultraLateBonus: 0.35,   // 週が進むほど激レアが出品されやすい
              ownedPenalty: 0.15 },   // 所持済みは出品されにくい（＝欲しい物が回ってくる）

    /**
     * 行動フェイズの解禁週（仕様書 3 節の週フェーズ設計に対応）。
     * 1〜10週は資金繰りを覚える期間なので、大きく張れる選択肢を出さない。
     */
    unlock: { bulk: 1, junk: 1, organize: 1, single: 16, expand: 11, order: 26 },

    /**
     * 取り寄せ（仕様書 3 節「46〜50週: 最後の数本を狙い撃つ」に対応する手段）。
     * 図鑑に載っている＝一度は手にしたソフトを、割増料金で指名して仕入れる。
     * 終盤に余った資金の受け皿も兼ねる。
     */
    order: { premium: 1.6, fromWeek: 1, batch: 3 },   // 1手番でまとめて頼める本数

    /**
     * 周回引き継ぎ（仕様書 12 節の未決定事項）。
     * 引き継ぐのは「この世界に何があるかの知識」＝図鑑の登録だけ。
     * 資金も在庫も持ち越さないので、店の経営そのものは毎周ゼロから始まる。
     * 登録済みのソフトは最初から取り寄せで狙えるため、完全クリアが現実的になる。
     */
    carryOver: { registered: true, skills: true, reveals: true, cash: false, cashRatio: 0.2, slots: false },

    /**
     * ソフトの状態。最小構成——価格倍率だけを持ち、図鑑には干渉しない。
     *  - 登録も所持も「どの状態でも1本は1本」。真エンドの条件は変わらない
     *  - 修理・クリーニングの行動は作らない（手番がボトルネックなので増やさない）
     *  - 在庫で劣化もしない。買ったときの状態のまま
     * 仕入れ経路ごとに出やすさが違うので、それが仕入れの性格づけになる。
     */
    condition: {
      enabled: true,
      grades: [
        { id: 'worn',  label: '傷あり', mult: 0.80 },
        { id: 'plain', label: '並',     mult: 1.00 },
        { id: 'mint',  label: '美品',   mult: 1.50 },
      ],
      /**
       * まとめ買いは期待値1.0になるよう配合してある（0.8×0.45 + 1.0×0.37 + 1.5×0.18 = 1.00）。
       * 状態を入れたこと自体で経済が動かないようにするため。
       * 数値調整でわざと傾ける場合は、ここが独立したレバーになる。
       */
      mix: {
        bulk:   [0.45, 0.37, 0.18],   // まとめ買いロット。半分近くが傷あり、たまに当たりが混じる
        junk:   [0.85, 0.15, 0.00],   // 処分品引取。素人の押し入れ。美品は出ない
        seller: [0.30, 0.50, 0.20],   // 客の持ち込み。提示額も状態に連動する
        single: [0.10, 0.45, 0.45],   // 単品オークション。写真を見て入札するので状態はいい
        event:  [0.05, 0.45, 0.50],   // 常連からの譲渡。持ち主が大事にしていたもの
        start:  [0.35, 0.50, 0.15],   // 開店在庫。叔父が遺した売れ残り
      },
      // 取り寄せは割増を払って業者に探させるので、状態は「並」で固定。
      // ただし激レアだけは美品しか存在しないので、そちらが優先される。
      // 料金も届く状態に連動させる（連動させないと激レアの取り寄せだけが得になる）
      orderCond: 1,
      // 激レアは美品しか現存しない。数が少なく、持ち主が大事にしてきたものだけが残っている
      ultraAlwaysMint: true,
    },

    wholesaleRatio: 0.40,   // 業者への卸値（整理）
    forcedSaleRatio: 0.30,  // 家賃未払い時の強制売却
    junkValue: 50,          // ガラクタの処分単価

    /**
     * 業者の立替（家賃の穴埋め）。
     * これが無いと、金が足りない → 在庫を叩き売る → 棚が減る → 値札売りが減る、の
     * 螺旋しか無くなり、「カツカツだが回る」状態が存在できない。
     * 在庫を減らさずに現金を都合する道を作って、螺旋の底に床を張る。
     */
    credit: {
      enabled: true,
      limit: 250000,      // 立替の上限（家賃の8週分）
      interest: 0.06,     // 週あたりの手数料。残債に対して掛かる
      reserve: 20000,     // 返済後に手元へ残す額。全部返すと翌週すぐまた借りる
      stockUntilWeek: 50, // この週までは「ロットを買う金」としても借りられる（0で家賃の穴埋めのみ）
    },
  };

  const HALF_LABEL = ['前半（平日）', '後半（週末）'];

  /**
   * 先代（叔父）が遺した屋号。姓「辻」の英訳で、主人公の姓でもある。
   * 石橋→ブリヂストンと同じ流儀だが、そうとは誰も言わない。
   */
  const SHOP_NAME = (DATA && DATA.lore && DATA.lore.shop) || 'クロスロード';

  /**
   * 種明かし。図鑑登録100%で叔父の正体、所持100%（真エンド）で主人公の正体。
   * 主人公は最初から全部知っているので「気づく」のではなく「黙っていた」。
   * 一度出たら周回を越えて出ない（carryOver.reveals）。
   */
  const REVEALS = (DATA && DATA.lore && DATA.lore.reveals) || {};
  function checkReveals(st) {
    if (st.ended) return;
    const total = st.catalog.length;
    const hit = [];
    if (st.registered.size >= total) hit.push('registered');
    if (ownedIds(st).size >= total) hit.push('owned');
    for (const key of hit) {
      if (st.reveals[key] || !REVEALS[key]) continue;
      st.reveals[key] = { week: st.week, half: st.half };
      log(st, 'reveal', REVEALS[key].title, 0);
    }
  }

  // ============================================================
  // 生成ヘルパ
  // ============================================================
  function pickTier(rng, mix) {
    const pairs = Object.keys(mix).filter(k => mix[k] > 0).map(k => [k, mix[k]]);
    return rWeighted(rng, pairs);
  }

  /** カタログから1本選ぶ。tier 指定・所持状況・売却履歴で重み付け */
  function pickTitle(st, tier, opts) {
    opts = opts || {};
    const pool = st.catalog.filter(s => s.tier === tier);
    if (!pool.length) return null;
    const owned = ownedIds(st);
    const pairs = pool.map(s => {
      let w = 1;
      if (opts.byDemand) w *= s.demand;
      if (st.soldOnce.has(s.id)) w *= st.cfg.reacquireBoost;   // 詰み対策
      if (opts.ownedPenalty && owned.has(s.id)) w *= opts.ownedPenalty;
      if (opts.unregisteredOnly && st.registered.has(s.id)) w = 0;   // まだ存在を知らないものだけ
      return [s, w];
    });
    if (!pairs.some(p => p[1] > 0)) return null;
    return rWeighted(st.rng, pairs);
  }

  /**
   * 激レアは美品しか現存しない。抽選結果より優先する。
   * 経路をまたいで効かせたいので、状態を決める全経路がここを通る
   */
  function fixCond(st, title, cond) {
    const c = st.cfg.condition;
    if (!c || !c.enabled) return cond;
    if (c.ultraAlwaysMint && title && title.tier === 'ultra') return c.grades.length - 1;
    return cond;
  }
  /** 仕入れ経路ごとの状態抽選。cond は grades のインデックス */
  function rollCond(st, source, title) {
    const c = st.cfg.condition;
    if (!c || !c.enabled) return 1;
    const forced = fixCond(st, title, null);
    if (forced != null) return forced;
    const mix = (c.mix && c.mix[source]) || c.mix.bulk;
    let r = st.rng();
    for (let i = 0; i < mix.length; i++) { r -= mix[i]; if (r <= 0) return i; }
    return mix.length - 1;
  }
  /** その在庫の状態倍率。ジャンクと未設定は等倍 */
  function condMult(st, item) {
    const c = st.cfg.condition;
    if (!c || !c.enabled || !item || item.junk || item.cond == null) return 1;
    const g = c.grades[item.cond];
    return g ? g.mult : 1;
  }
  const condLabel = (st, item) => {
    const c = st.cfg.condition;
    if (!c || !c.enabled || !item || item.junk || item.cond == null) return '';
    const g = c.grades[item.cond];
    return g ? g.label : '';
  };

  function makeItem(st, title, source) {
    return {
      uid: st.uidSeq++,
      titleId: title ? title.id : null,
      junk: !title,
      display: false,
      markdown: false,
      protect: false,      // 非売品（コレクション用に確保）。客も自動売上も手を出さない
      cond: title ? rollCond(st, source || 'bulk', title) : null,
      acquiredWeek: st.week,
    };
  }

  function makeJunk(st) { return makeItem(st, null); }

  // ============================================================
  // 参照系
  // ============================================================
  const titleOf = (st, item) => item.junk ? null : st.byId.get(item.titleId);

  /** その在庫の売値（値下げ反映） */
  function priceOf(st, item) {
    const t = titleOf(st, item);
    if (!t) return st.cfg.junkValue;
    return Math.round(t.base * condMult(st, item)
      * (item.markdown ? 1 - st.cfg.markdownRate : 1));
  }

  function demandOf(st, item) {
    const t = titleOf(st, item);
    if (!t) return 0;
    let d = t.demand;
    if (item.markdown) d *= st.cfg.markdownDemand;
    if (st.week - item.acquiredWeek >= st.cfg.staleWeeks) d *= st.cfg.staleDemand;
    return d;
  }

  const ownedIds = st => new Set(st.inv.filter(i => !i.junk).map(i => i.titleId));
  /** 取り寄せ料金（相場＋割増） */
  const orderCost = (st, t) => {
    const c = st.cfg.condition;
    let m = 1;
    if (c && c.enabled) {
      const cond = fixCond(st, t, c.orderCond);
      const g = c.grades[cond];
      if (g) m = g.mult;
    }
    return Math.round(t.base * m * st.cfg.order.premium * (1 + skill(st, 'order')) / 100) * 100;
  };
  /** 取り寄せられるソフト＝登録済みだが今は持っていないもの */
  function orderable(st) {
    if (st.week < Math.max(st.cfg.order.fromWeek, st.cfg.unlock.order || 1)) return [];
    const owned = ownedIds(st);
    return st.catalog.filter(t => st.registered.has(t.id) && !owned.has(t.id));
  }
  const displayed = st => st.inv.filter(i => i.display && !i.junk);
  /** 実際に売れる在庫（陳列中かつ非売品でない） */
  const forSale = st => st.inv.filter(i => i.display && !i.junk && !i.protect);
  const freeSlots = st => st.cfg.shelfSlots - st.inv.length;
  const freeDisplay = st => st.cfg.displaySlots - st.inv.filter(i => i.display).length;
  const countOf = (st, titleId) => st.inv.filter(i => i.titleId === titleId).length;

  function stats(st) {
    const owned = ownedIds(st);
    return {
      week: st.week, half: st.half, cash: st.cash, debt: st.debt,
      inventory: st.inv.length, slots: st.cfg.shelfSlots, displaySlots: st.cfg.displaySlots,
      reputation: Math.round(st.reputation * 10) / 10,
      junk: st.inv.filter(i => i.junk).length,
      displayed: displayed(st).length,
      registered: st.registered.size,
      owned: owned.size,
      total: st.catalog.length,
      registeredRate: st.registered.size / st.catalog.length,
      ownedRate: owned.size / st.catalog.length,
    };
  }

  function log(st, kind, text, amount) {
    st.log.push({ week: st.week, half: st.half, kind, text, amount: amount || 0 });
    if (st.log.length > 600) st.log.splice(0, st.log.length - 600);
  }

  // ============================================================
  // 在庫操作
  // ============================================================
  function addItem(st, title, opts) {
    if (freeSlots(st) <= 0) return null;
    st.totals.acquired++;
    const item = makeItem(st, title, opts && opts.source);
    if (opts && opts.cond != null) item.cond = fixCond(st, title, opts.cond);
    st.inv.push(item);
    if (title) st.registered.add(title.id);            // 図鑑登録は一度でも入手すれば永続
    if (opts && opts.display && freeDisplay(st) > 0) item.display = true;
    return item;
  }

  function removeItem(st, uid, cause) {
    const idx = st.inv.findIndex(i => i.uid === uid);
    if (idx < 0) return null;
    const item = st.inv[idx];
    st.inv.splice(idx, 1);
    if (!item.junk && countOf(st, item.titleId) === 0) {
      st.soldOnce.add(item.titleId);                      // 買い戻し導線
      st.lost[cause || 'other'] = (st.lost[cause || 'other'] || 0) + 1;   // 所持率が削れた経路
      const t = titleOf(st, item);
      if (t && (t.tier === 'rare' || t.tier === 'ultra')) rep(st, st.cfg.reputation.gain.loseRare);
    }
    return item;
  }

  function setDisplay(st, uid, on) {
    const item = st.inv.find(i => i.uid === uid);
    if (!item) return false;
    if (on && !item.display && freeDisplay(st) <= 0) return false;
    item.display = !!on;
    return true;
  }

  function setProtect(st, uid, on) {
    const item = st.inv.find(i => i.uid === uid);
    if (!item) return false;
    item.protect = !!on;
    return true;
  }

  function setMarkdown(st, uid, on) {
    const item = st.inv.find(i => i.uid === uid);
    if (!item) return false;
    item.markdown = !!on;
    return true;
  }

  /** 業者に卸す（整理） */
  function wholesale(st, uids) {
    let total = 0, n = 0;
    for (const uid of uids) {
      const item = st.inv.find(i => i.uid === uid);
      if (!item) continue;
      const t = titleOf(st, item);
      const price = t
        ? Math.round(t.base * condMult(st, item) * st.cfg.wholesaleRatio)
        : st.cfg.junkValue;
      removeItem(st, uid);
      total += price; n++;
    }
    st.cash += total;
    st.totals.wholesale += total;
    if (n) log(st, 'wholesale', `${n}点を業者に卸した`, total);
    return total;
  }

  // ============================================================
  // 店番フェイズ
  // ============================================================
  const REGULARS = (Catalog.DATA && Catalog.DATA.regulars) || [];
  const THRESHOLDS = (Catalog.DATA && Catalog.DATA.visitThresholds) || [3, 8, 14, 20];

  /** 常連の来店記録。まだ無ければ作る */
  function regState(st, id) {
    if (!st.regulars[id]) st.regulars[id] = { visits: 0, fired: 0 };
    return st.regulars[id];
  }

  /** 次に来る常連を選ぶ。イベントが近い人ほど来やすい */
  function pickRegular(st, exclude) {
    if (!REGULARS.length) return null;
    const avail = exclude ? REGULARS.filter(r => !exclude.has(r.id)) : REGULARS;
    if (!avail.length) return null;
    const pool = avail.map(r => {
      const s = regState(st, r.id);
      const next = THRESHOLDS[s.fired];
      // まだイベントが残っている常連を優先する
      const eager = next === undefined ? 0.3 : 1 + Math.max(0, 1 - (next - s.visits) / 6);
      return [r, (r.weight || 1) * eager];
    });
    return rWeighted(st.rng, pool);
  }

  /** 常連の来店を1件作る。しきい値に達していればイベントになる */
  function makeRegularCustomer(st, exclude) {
    const r = pickRegular(st, exclude);
    if (!r) return null;
    if (exclude) exclude.add(r.id);
    const s = regState(st, r.id);
    s.visits++;
    const who = { id: r.id, name: r.name, title: r.title, visits: s.visits };
    const next = THRESHOLDS[s.fired];
    if (next !== undefined && s.visits >= next && r.events[s.fired]) {
      const ev = r.events[s.fired];
      // 物を置いていく／売ってくれるイベントは、棚が空くまで起こさない。
      // 満杯のまま起こしても受け取れず、せっかくの来店が無駄になる
      const needsSlot = ev.type === 'gift' || ev.type === 'giftUltra' || ev.type === 'offer';
      if (!needsSlot || freeSlots(st) > 0) {
        s.fired++;
        return { type: 'event', regular: who, event: ev };
      }
    }
    // イベント以外の日は普通の客と同じように振る舞う（売買の回数を減らさない）。
    // ただし alwaysBrowser の常連は必ず冷やかしになる＝来店枠を食うだけの邪魔者
    let type;
    if (r.alwaysBrowser) {
      type = 'browser';
    } else {
      const w = st.cfg.customers[st.half === 0 ? 'front' : 'back'].weights;
      type = rWeighted(st.rng, Object.keys(w).map(k => [k, w[k]]));
    }
    const c = makeCustomer(st, type);
    c.regular = who;
    if (c.type === 'browser' && r.lines && r.lines.length) c.line = rPick(st.rng, r.lines);
    return c;
  }

  function buildQueue(st) {
    const cfg = st.cfg.customers[st.half === 0 ? 'front' : 'back'];
    const rc = st.cfg.reputation;
    let n;
    if (rc.enabled) {
      // 評判で来客数が決まる。後半（週末）は少し多い
      const base = byRep(st, rc.customers) + (st.half === 1 ? 0.6 : 0) + st.clerkBonus;
      const noise = rInt(st.rng, -rc.customerNoise, rc.customerNoise);
      n = Math.max(rc.customers[0], Math.min(rc.customers[1] + st.clerkBonus, Math.round(base) + noise));
    } else {
      n = rInt(st.rng, cfg.count[0], cfg.count[1]);
    }
    const queue = [];
    const rg = st.cfg.regulars;
    // 常連が当たる確率も評判に連動する（寂れた店にはまだ常連がついていない）
    const chance = Array.isArray(rg.visitChance) ? byRep(st, rg.visitChance) : rg.visitChance;
    const seen = rg.oncePerTurn ? new Set() : null;   // 同じ常連が1ターンに二度来ないように
    for (let i = 0; i < n; i++) {
      if (rg.enabled && REGULARS.length && st.rng() < chance) {
        const c = makeRegularCustomer(st, seen);
        if (c) { queue.push(c); continue; }
      }
      const type = rWeighted(st.rng, Object.keys(cfg.weights).map(k => [k, cfg.weights[k]]));
      queue.push(makeCustomer(st, type));
    }
    return queue;
  }

  /** 常連イベントの効果を適用する。yes は offer 型で買うかどうか */
  function resolveEvent(st, c, yes) {
    const e = c.event, who = c.regular;
    const res = { kind: e.type, gained: null, spent: 0 };
    const byTitle = name => st.catalog.find(t => t.name === name);

    // どのイベントでもスキルを教われる（本来の効果とは別に付く）。
    // 周回で既に覚えている場合は、教え直さずに skillKnown の別セリフ＋現金になる。
    if (e.skill && st.cfg.skills[e.skill]) {
      const sk = st.cfg.skills[e.skill];
      if (!st.skills[e.skill]) {
        st.skills[e.skill] = true;
        log(st, 'skill', `${who.name}から「${sk.name}」を教わった — ${sk.desc}`, 0);
      } else if (e.skillKnown) {
        const amount = e.skillKnown.amount || 0;
        st.cash += amount;
        res.skillCash = amount;   // res.spent は後段の offer で上書きされるので別に持つ
        log(st, 'skill', `${who.name}: ${e.skillKnown.text}`, amount);
      }
    }

    if (e.type === 'talk') {
      // 何も起きない。時間だけが過ぎる
      log(st, 'event', `${who.name}: ${e.text}`, 0);

    } else if (e.type === 'cash') {
      st.cash += e.amount;
      res.spent = -e.amount;
      log(st, 'event', `${who.name}: ${e.text}`, e.amount);

    } else if (e.type === 'info') {
      // 存在を知る＝図鑑に登録される。取り寄せで狙えるようになる
      const t = pickTitle(st, e.tier, { ownedPenalty: 1, unregisteredOnly: true });
      if (t) {
        st.registered.add(t.id);
        res.gained = t.id;
        log(st, 'event', `${who.name}: ${e.text}（図鑑に「${t.name}」が載った）`, 0);
      } else {
        log(st, 'event', `${who.name}: ${e.text}`, 0);
      }

    } else if (e.type === 'buyBonus') {
      st.buyBonus += e.value;
      log(st, 'event', `${who.name}: ${e.text}`, 0);

    } else if (e.type === 'gift' || e.type === 'giftUltra') {
      // 指名の贈り物は、既に持っていてもそのまま貰う（ダブりは売ればいい）。
      // 激レアに化けさせると、中堅1本のつもりのイベントが破格の当たりになってしまう
      let t = e.type === 'gift' ? byTitle(e.title) : null;
      if (!t) t = pickTitle(st, 'ultra', { ownedPenalty: 0.02 });
      if (t && freeSlots(st) > 0) {
        addItem(st, t, { source: 'event' });
        res.gained = t.id;
        log(st, 'event', `${who.name}: ${e.text}（「${t.name}」を手に入れた）`, 0);
      } else {
        // 棚が満杯で受け取れないイベントを消費してしまうと、激レアが永久に消える。
        // 空けてからもう一度来てもらう
        res.missed = true;
        log(st, 'event', `${who.name}: ${e.text} ※棚が満杯で受け取れなかった（また持ってきてくれるだろう）`, 0);
      }

    } else if (e.type === 'offer') {
      const t = byTitle(e.title);
      if (!t) { log(st, 'event', `${who.name}: ${e.text}`, 0); return res; }
      const price = Math.round(t.base * e.priceRatio / 100) * 100;
      if (!yes) { log(st, 'event', `${who.name}: 「${t.name}」の話を断った`, 0); return res; }
      if (st.cash < price || freeSlots(st) <= 0) {
        res.missed = true;   // 断ったのではなく買えなかっただけなので、話は流さない
        log(st, 'event', `${who.name}: 「${t.name}」を買えなかった（また声を掛けてくれるだろう）`, 0);
        return res;
      }
      st.cash -= price;
      st.totals.purchases += price;
      st.totals.boughtCount++;
      addItem(st, t, { source: 'event' });
      res.gained = t.id;
      res.spent = price;
      log(st, 'event', `${who.name}: ${e.text}（「${t.name}」を${price.toLocaleString()}円で買い取った）`, -price);
    }
    return res;
  }

  const BROWSE_LINES = [
    'この棚、前より増えたね。',
    '昔ここで買ったソフトを探してるんだ。また来るよ。',
    '駅前の店が潰れたらしいよ。在庫はどこに行ったんだろうね。',
    '黒川インタラクティブの最後のソフト、見たことある？',
    'ポケッタのソフトって、まだ動くもんかね。',
    '子供の頃に売っちゃったやつ、いま高いんでしょ？',
  ];

  function makeCustomer(st, type) {
    if (type === 'buyer') {
      const shelf = forSale(st);
      if (!shelf.length) return { type: 'browser', line: '（棚を一周して、何も買わずに出て行った）' };
      const item = rWeighted(st.rng, shelf.map(i => [i, demandOf(st, i)]));
      const t = titleOf(st, item);
      const r = st.cfg.buyerOfferRange;
      const offer = Math.round(priceOf(st, item)
        * (r[0] + st.rng() * (r[1] - r[0])) * (1 + skill(st, 'sell')) / 100) * 100;
      return { type: 'buyer', uid: item.uid, titleId: t.id, offer };
    }
    if (type === 'seller') {
      const w = Object.assign({}, st.cfg.sellerTierWeights);
      const rc = st.cfg.reputation;
      if (rc.enabled && rc.sellerRareBonus) {
        // 評判が高いほど良い物が持ち込まれる（劇的にはしない）
        const b = repRate(st) * rc.sellerRareBonus;
        w.rare = (w.rare || 0) + b;
        w.mid = (w.mid || 0) + b * 0.5;
        w.common = Math.max(0.05, (w.common || 0) - b * 1.5);
      }
      const tier = pickTier(st.rng, w);
      const t = pickTitle(st, tier, { byDemand: true });
      if (!t) return { type: 'browser', line: rPick(st.rng, BROWSE_LINES) };
      const r = st.cfg.sellerAskRange;
      const cond = rollCond(st, 'seller');
      const cm = (st.cfg.condition && st.cfg.condition.enabled)
        ? st.cfg.condition.grades[cond].mult : 1;
      let ask = t.buy * cm * (r[0] + st.rng() * (r[1] - r[0])) * (1 + skill(st, 'buy'));
      if (st.buyBonus) ask *= (1 - Math.min(0.4, st.buyBonus));   // 常連の値引き
      ask = Math.max(100, Math.round(ask / 100) * 100);
      return { type: 'seller', titleId: t.id, ask, cond };
    }
    return { type: 'browser', line: rPick(st.rng, BROWSE_LINES) };
  }

  /** 現在の客に応答する。yes=売る／買う */
  function answer(st, yes) {
    if (st.phase !== 'shop' || !st.current) return null;
    const c = st.current;
    if (c.type === 'event') {
      const r = resolveEvent(st, c, yes);
      // 受け取れなかったイベントは無かったことにして、次の来店でもう一度出す
      if (r.missed && c.regular) {
        const rs = regState(st, c.regular.id);
        rs.fired = Math.max(0, rs.fired - 1);
      }
      st.current = st.queue.shift() || null;
      if (!st.current) enterActionPhase(st);
      return { customer: c, accepted: true, event: r };
    }
    const result = { customer: c, accepted: false, reason: null };

    // 断ると評判が下がる
    if (!yes && c.type === 'buyer') rep(st, st.cfg.reputation.gain.refuseBuyer);
    if (!yes && c.type === 'seller') rep(st, st.cfg.reputation.gain.refuseSeller);

    if (c.type === 'buyer' && yes) {
      const item = st.inv.find(i => i.uid === c.uid);
      if (item) {
        const t = titleOf(st, item);
        if (item.markdown) rep(st, st.cfg.reputation.gain.markdownSold);
        rep(st, st.cfg.reputation.gain.sellToCustomer);
        removeItem(st, c.uid, 'buyer');
        st.cash += c.offer;
        st.totals.sales += c.offer;
        st.totals.soldCount++;
        result.accepted = true;
        log(st, 'sell', `「${t.name}」を売った`, c.offer);

        // ついで買い: 陳列中の安い一本を追加で買っていく
        if (st.rng() < st.cfg.buyerSecondItemChance) {
          const cheap = forSale(st).filter(i => priceOf(st, i) <= 3000);
          if (cheap.length) {
            const extra = rWeighted(st.rng, cheap.map(i => [i, demandOf(st, i)]));
            const et = titleOf(st, extra);
            const ep = priceOf(st, extra);
            removeItem(st, extra.uid, 'buyer');
            st.cash += ep;
            st.totals.sales += ep;
            st.totals.soldCount++;
            result.extra = { titleId: et.id, price: ep };
            log(st, 'sell', `ついでに「${et.name}」も売れた`, ep);
          }
        }
      }
    } else if (c.type === 'seller' && yes) {
      if (st.cash < c.ask) result.reason = 'cash';
      else if (freeSlots(st) <= 0) result.reason = 'slots';
      else {
        const t = st.byId.get(c.titleId);
        st.cash -= c.ask;
        st.totals.purchases += c.ask;
        st.totals.boughtCount++;
        addItem(st, t, { display: true, cond: c.cond });
        rep(st, st.cfg.reputation.gain.buyFromCustomer);
        result.accepted = true;
        log(st, 'buy', `「${t.name}」を買い取った`, -c.ask);
      }
    }

    st.history.customers.push({ week: st.week, type: c.type, accepted: result.accepted });
    st.current = st.queue.shift() || null;
    if (!st.current) enterActionPhase(st);
    return result;
  }

  // ============================================================
  // 行動フェイズ
  // ============================================================
  /** 週の進みに応じてロットの中身を良くする */
  function lotMix(st, spec) {
    if (!spec.earlyMix) return spec.mix;
    const span = Math.max(1, (spec.mixFullFromWeek || 1) - 1);
    const t = Math.max(0, Math.min(1, (st.week - 1) / span));
    const out = {};
    for (const k of Object.keys(spec.mix)) {
      const a = spec.earlyMix[k] === undefined ? spec.mix[k] : spec.earlyMix[k];
      out[k] = a + t * (spec.mix[k] - a);
    }
    return out;
  }

  function rollLot(st, spec) {
    const n = rInt(st.rng, spec.items[0], spec.items[1]);
    const mix = lotMix(st, spec);
    const titles = [];
    let junkCount = 0, retail = 0;
    for (let i = 0; i < n; i++) {
      const tier = pickTier(st.rng, mix);
      if (tier === 'junk') { junkCount++; continue; }
      const t = pickTitle(st, tier, { byDemand: true });
      if (!t) { junkCount++; continue; }
      titles.push(t.id);
      retail += t.base;
    }
    return { count: n, titles, junkCount, retail };
  }

  const unlocked = (st, key) => st.week >= (st.cfg.unlock[key] || 1);
  /** 習得済みスキルの効果を合計する。key は lot / buy / sell / bid / order / unownedBias */
  function skill(st, key) {
    let v = 0;
    for (const id in st.skills) {
      const def = st.cfg.skills[id];
      if (def && def[key]) v += def[key];
    }
    return v;
  }
  /** いま買える設備・人手の一覧 */
  const availableUpgrades = st => (st.cfg.upgrades || [])
    .filter(u => (st.upgrades[u.id] || 0) < u.max)
    .map(u => Object.assign({}, u, { owned: st.upgrades[u.id] || 0 }));

  /**
   * 評判を動かす。0〜100 に収める。
   * 上げ幅は評判が高いほど小さくなる（逓減）。寂れた店が有名になるのは速いが、
   * 名店がさらに名を上げるのは難しい。下げ幅には逓減をかけない。
   */
  function rep(st, delta) {
    const c = st.cfg.reputation;
    if (!c.enabled || !delta) return;
    if (delta > 0) delta *= Math.pow(1 - repRate(st), c.gainFalloff);
    st.reputation = Math.max(c.min, Math.min(c.max, st.reputation + delta));
  }
  /** 評判の 0〜1 正規化 */
  const repRate = st => {
    const c = st.cfg.reputation;
    if (!c.enabled) return 1;
    return (st.reputation - c.min) / Math.max(1, c.max - c.min);
  };
  /** 評判から決まる値を線形補間する */
  const byRep = (st, range) => range[0] + repRate(st) * (range[1] - range[0]);

  function generateOffers(st) {
    const cfg = st.cfg;

    // 処分品引取
    const junkLot = rollLot(st, cfg.junk);
    const junkSkill = 1 + skill(st, 'lot');
    const junkCost = st.rng() < cfg.junk.freeChance ? 0
      : Math.round(rInt(st.rng, cfg.junk.cost[0], cfg.junk.cost[1]) * junkSkill / 100) * 100;

    // オークション（まとめ買い）
    const bulkLot = rollLot(st, cfg.bulk);
    const pr = cfg.bulk.priceRatio;
    let bulkCost = Math.round(bulkLot.retail * (pr[0] + st.rng() * (pr[1] - pr[0]))
      * (1 + skill(st, 'lot')) / 1000) * 1000;
    bulkCost = Math.min(cfg.bulk.cap[1], Math.max(cfg.bulk.cap[0], bulkCost));

    // オークション（単品入札）
    const sw = Object.assign({}, cfg.single.tierWeights);
    if (cfg.ultra.source === 'auction' || cfg.ultra.source === 'both') {
      sw.ultra += cfg.single.ultraLateBonus * (st.week / cfg.totalWeeks); // 終盤ほど激レアが出る
    } else {
      sw.ultra = 0;
    }
    const tier = pickTier(st.rng, sw);
    const target = pickTitle(st, tier,
      { ownedPenalty: cfg.single.ownedPenalty * (1 - skill(st, 'unownedBias')) });
    const ar = cfg.single.askRatio, rr = cfg.single.rivalRatio;
    const singleCond = rollCond(st, 'single', target);
    const singleMult = (cfg.condition && cfg.condition.enabled)
      ? cfg.condition.grades[singleCond].mult : 1;
    const singleOffer = target ? {
      titleId: target.id, cond: singleCond,
      current: Math.round(target.base * singleMult * (ar[0] + st.rng() * (ar[1] - ar[0])) / 1000) * 1000,
      rival: Math.round(target.base * singleMult * (rr[0] + st.rng() * (rr[1] - rr[0]))),
    } : null;

    return {
      junk: unlocked(st, 'junk')
        ? { cost: junkCost, lot: junkLot, hint: `雑多な箱が${junkLot.count}点ほど` } : null,
      bulk: unlocked(st, 'bulk')
        ? { cost: bulkCost, lot: bulkLot,
            hint: `${bulkLot.count}点セット。${bulkLot.titles.length >= 10 ? '中身は当たりかもしれない' : 'ガラクタが多そうだ'}` } : null,
      single: unlocked(st, 'single') ? singleOffer : null,
    };
  }

  function enterActionPhase(st) {
    st.phase = 'action';
    st.offers = generateOffers(st);
  }

  /**
   * 行動を実行してターンを終える。
   * key: 'bulk' | 'single' | 'junk' | 'organize' | 'rest'
   * params: single のとき {bid}, organize のとき {wholesale:[uid], display:[uid], markdown:[uid]}
   */
  function doAction(st, key, params) {
    if (st.phase !== 'action') return { ok: false, reason: 'phase' };
    params = params || {};
    const res = { ok: true, key, gained: [], spent: 0 };

    if (key === 'bulk' || key === 'junk') {
      const offer = st.offers[key];
      if (!offer) return { ok: false, reason: 'locked' };
      if (st.cash < offer.cost) return { ok: false, reason: 'cash' };
      st.cash -= offer.cost;
      st.totals.purchases += offer.cost;
      res.spent = offer.cost;

      // 価値の高い順に棚へ入れ、枠に入りきらない分はその場で業者に流す
      const incoming = offer.lot.titles.map(id => st.byId.get(id))
        .sort((a, b) => b.base - a.base);
      let added = 0, overflow = 0, overflowCash = 0;
      for (const t of incoming) {
        if (addItem(st, t, { source: key })) { added++; res.gained.push(t.id); }
        else {
          // 棚に入れずそのまま業者行きなので図鑑には載らない
          overflow++; st.totals.overflow++;
          // 棚に入らず直行するので状態は引かない（並品として流す）
          overflowCash += Math.round(t.base * st.cfg.wholesaleRatio);
        }
      }
      for (let i = 0; i < offer.lot.junkCount; i++) {
        if (freeSlots(st) > 0) { st.inv.push(makeJunk(st)); added++; }
        else { overflow++; overflowCash += st.cfg.junkValue; }
      }
      if (overflowCash) { st.cash += overflowCash; st.totals.wholesale += overflowCash; }
      res.overflow = overflow;
      res.overflowCash = overflowCash;
      // 業者との取引は誰も見ていないが、近所の人の処分品を引き取るのは町に付き合うこと
      if (key === 'junk') rep(st, st.cfg.reputation.gain.junkLot);
      const label = key === 'bulk' ? 'まとめ買い' : '処分品引取';
      log(st, key, `${label}: ${added}点を棚に入れた（うちソフト${res.gained.length}点）`
        + (overflow ? ` ※枠に入らない${overflow}点はその場で業者に流した（+${overflowCash.toLocaleString()}円）` : ''),
        -offer.cost + overflowCash);

    } else if (key === 'single') {
      const offer = st.offers.single;
      if (!offer) return { ok: false, reason: 'nooffer' };
      const bid = Math.max(0, Math.round(params.bid || 0));
      if (bid < offer.current) return { ok: false, reason: 'lowbid' };
      if (bid > st.cash) return { ok: false, reason: 'cash' };
      const t = st.byId.get(offer.titleId);
      if (bid >= offer.rival) {
        if (freeSlots(st) <= 0) return { ok: false, reason: 'slots' };
        const paid = Math.round(Math.min(bid, Math.max(offer.current, offer.rival))
          * (1 + skill(st, 'bid')));                                    // 二位価格に近い決着
        st.cash -= paid;
        st.totals.purchases += paid;
        res.spent = paid;
        res.won = true;
        res.gained.push(t.id);
        addItem(st, t, { display: t.tier !== 'ultra', cond: offer.cond });
        log(st, 'single', `落札: 「${t.name}」`, -paid);
      } else {
        res.won = false;
        log(st, 'single', `競り負け: 「${t.name}」（${offer.rival.toLocaleString()}円で他者が落札）`, 0);
      }

    } else if (key === 'organize') {
      if (params.wholesale && params.wholesale.length) wholesale(st, params.wholesale);
      for (const uid of params.display || []) setDisplay(st, uid, true);
      for (const uid of params.store || []) setDisplay(st, uid, false);
      for (const uid of params.markdown || []) setMarkdown(st, uid, true);

    } else if (key === 'order') {
      if (!unlocked(st, 'order')) return { ok: false, reason: 'locked' };
      // まとめて頼める。titleIds でも titleId でも受ける
      const ids = params.titleIds || [params.titleId];
      const max = Math.max(1, st.cfg.order.batch || 1);
      const done = [];
      let spent = 0;
      let stop = null;                                    // 途中で止まった理由
      for (const id of ids.slice(0, max)) {
        const t = st.byId.get(id);
        if (!t) continue;
        if (!st.registered.has(t.id)) continue;          // 知らない物は頼めない
        if (ownedIds(st).has(t.id)) continue;
        if (freeSlots(st) <= 0) { stop = 'slots'; break; }
        const cost = orderCost(st, t);
        if (st.cash < cost) { stop = 'cash'; break; }
        st.cash -= cost;
        st.totals.purchases += cost;
        st.totals.orderCount++;
        spent += cost;
        addItem(st, t, { cond: st.cfg.condition.orderCond });   // 激レアは fixCond で美品になる
        res.gained.push(t.id);
        done.push(t.name);
      }
      if (!done.length) return { ok: false, reason: stop || 'none' };
      res.spent = spent;
      log(st, 'order', `取り寄せ: ${done.join('、')}が届いた`, -spent);

    } else if (key === 'upgrade') {
      const up = (st.cfg.upgrades || []).find(u => u.id === params.id);
      if (!up) return { ok: false, reason: 'nosuch' };
      if (!unlocked(st, 'expand')) return { ok: false, reason: 'locked' };
      if ((st.upgrades[up.id] || 0) >= up.max) return { ok: false, reason: 'max' };
      if (st.cash < up.cost) return { ok: false, reason: 'cash' };
      st.cash -= up.cost;
      st.totals.expand += up.cost;
      st.upgrades[up.id] = (st.upgrades[up.id] || 0) + 1;
      const e = up.effect;
      if (e.shelfSlots) st.cfg = Object.assign({}, st.cfg, { shelfSlots: st.cfg.shelfSlots + e.shelfSlots });
      if (e.displaySlots) st.cfg = Object.assign({}, st.cfg, { displaySlots: st.cfg.displaySlots + e.displaySlots });
      if (e.passive) st.passiveBonus += e.passive;
      if (e.customers) st.clerkBonus += e.customers;
      res.spent = up.cost;
      log(st, 'upgrade', `${up.name}（${st.upgrades[up.id]}/${up.max}）`, -up.cost);

    } else if (key === 'rest') {
      log(st, 'rest', '店を閉めて休んだ', 0);
    } else {
      return { ok: false, reason: 'unknown' };
    }

    endTurn(st);
    return res;
  }

  // ============================================================
  // ターン／週の進行
  // ============================================================
  /**
   * 常連イベントの代役。仕様書 8 節では常連キャラのイベント報酬で激レアが手に入るが、
   * プロトタイプでは常連を作らないので「一定週ごとに未所持の激レアが1本手に入る」で代用する。
   */
  function tryUltraEvent(st) {
    const u = st.cfg.ultra;
    if (u.source !== 'event' && u.source !== 'both') return;   // 既定では常連イベントが担うので発生しない
    // 予定週になったら「譲ってもらえる約束」が1件たまる
    if (st.ultraEvents + st.ultraDue < u.maxEvents
        && st.week >= u.eventFromWeek
        && (st.week - u.eventFromWeek) % u.eventEveryWeeks === 0) {
      st.ultraDue++;
    }
    if (st.ultraDue <= 0) return;
    if (freeSlots(st) <= 0) return;        // 棚が空くまで持ち越す（約束は消えない）
    const t = pickTitle(st, 'ultra', { ownedPenalty: 0.02 });
    if (!t) return;
    st.ultraDue--;
    st.ultraEvents++;
    addItem(st, t, { source: 'event' });
    log(st, 'event', `常連客からの譲渡: 「${t.name}」を手に入れた`, 0);
  }

  function endTurn(st) {
    checkReveals(st);
    if (st.half === 0) {
      st.half = 1;
      startTurn(st);
    } else {
      tryUltraEvent(st);
      const week = payRent(st);
      if (st.ended) return;
      st.history.weeks.push(week);
      st.week++;
      st.half = 0;
      if (st.week > st.cfg.totalWeeks) finish(st);
      else startTurn(st);
    }
  }

  /** 週末に棚の中身を評価する。珍しいものを置いている店は評判が上がる */
  function appraiseShelf(st) {
    const c = st.cfg.reputation;
    if (!c.enabled) return;
    const shelf = st.inv.filter(i => i.display);
    const good = shelf.filter(i => {
      const t = titleOf(st, i);
      return t && (t.tier === 'rare' || t.tier === 'ultra');
    }).length;
    const junk = shelf.filter(i => i.junk).length;
    // 非売品として抱えているレアも「あの店にはある」と伝わる
    const kept = st.inv.filter(i => {
      const t = titleOf(st, i);
      return i.protect && t && (t.tier === 'rare' || t.tier === 'ultra');
    }).length;
    let d = c.gain.weeklyDrift;
    // 棚がどれだけ埋まっているか。品揃えのある店は客足が戻る
    d += Math.min(1, shelf.length / Math.max(1, st.cfg.displaySlots)) * c.gain.shelfFull;
    d += Math.min(6, good + kept * 0.5) * c.gain.rareOnShelf;
    d += Math.min(10, junk) * c.gain.junkOnShelf;
    if (!forSale(st).length) d += c.gain.emptyShelf;
    rep(st, d);
  }

  /** 立替を受ける。借りられた額を返す */
  function borrow(st, want) {
    const c = st.cfg.credit;
    if (!c || !c.enabled) return 0;
    const room = Math.max(0, c.limit - st.debt);
    const got = Math.min(room, Math.max(0, Math.ceil(want)));
    if (!got) return 0;
    st.cash += got;
    st.debt += got;
    st.totals.borrowed += got;
    log(st, 'credit', `業者に${got.toLocaleString()}円を立て替えてもらった（残債${st.debt.toLocaleString()}円）`, got);
    return got;
  }

  /** 手元に reserve を残して、返せるだけ返す */
  function repay(st) {
    const c = st.cfg.credit;
    if (!c || !c.enabled || st.debt <= 0) return 0;
    const spare = st.cash - c.reserve;
    if (spare <= 0) return 0;
    const paid = Math.min(spare, st.debt);
    st.cash -= paid;
    st.debt -= paid;
    st.totals.repaid += paid;
    log(st, 'credit', `立替を${paid.toLocaleString()}円返した（残債${st.debt.toLocaleString()}円）`, -paid);
    return paid;
  }

  /** 手放す順番。ガラクタ→重複→安いものの順 */
  function dumpOrder(st) {
    const owned = new Map();
    for (const i of st.inv) if (!i.junk) owned.set(i.titleId, (owned.get(i.titleId) || 0) + 1);
    return st.inv.slice().sort((a, b) => {
      const rank = it => it.junk ? 0 : (owned.get(it.titleId) > 1 ? 1 : 2);
      return rank(a) - rank(b) || priceOf(st, a) - priceOf(st, b);
    });
  }

  /**
   * 最後の精算。現金で足りなければ在庫を叩いて返す。
   * ここが無いと、最終週に上限まで借りて買うのが常に得になってしまう
   */
  function settleDebt(st) {
    if (st.debt <= 0) return;
    const paid = Math.min(st.cash, st.debt);
    st.cash -= paid; st.debt -= paid;
    let sold = 0;
    for (const item of dumpOrder(st)) {
      if (st.debt <= 0) break;
      const t = titleOf(st, item);
      const price = t
        ? Math.round(t.base * condMult(st, item) * st.cfg.forcedSaleRatio)
        : st.cfg.junkValue;
      removeItem(st, item.uid, 'forced');
      st.debt = Math.max(0, st.debt - price);
      sold++;
    }
    if (sold) log(st, 'credit', `残債の精算で在庫${sold}点を手放した`, 0);
    else log(st, 'credit', `残債を精算した（${paid.toLocaleString()}円）`, -paid);
  }

  function payRent(st) {
    appraiseShelf(st);
    const rent = st.cfg.rent;
    let forced = 0, forcedCount = 0;

    // 在庫を叩き売る前に、まず立て替えてもらう。棚を減らさずに済む道を先に通す
    if (st.cash < rent) borrow(st, rent - st.cash);

    if (st.cash < rent) {
      const order = dumpOrder(st);
      for (const item of order) {
        if (st.cash >= rent) break;
        const t = titleOf(st, item);
        const price = t
          ? Math.round(t.base * condMult(st, item) * st.cfg.forcedSaleRatio)
          : st.cfg.junkValue;
        removeItem(st, item.uid, 'forced');
        st.cash += price;
        forced += price; forcedCount++;
      }
      if (forcedCount) {
        rep(st, st.cfg.reputation.gain.forcedSale);
        log(st, 'forced', `家賃のため在庫${forcedCount}点を強制売却`, forced);
      }
    }

    const snapshot = Object.assign(stats(st), { forcedCount, forcedAmount: forced });

    if (st.cash < rent) {
      log(st, 'rent', `家賃${rent.toLocaleString()}円を払えなかった。閉店。`, 0);
      finish(st, 'bad');
      snapshot.cash = st.cash;
      snapshot.bankrupt = true;
      return snapshot;
    }

    st.cash -= rent;
    st.totals.rent += rent;

    // 手数料は残債に乗る。返せるときに返しておかないと膨らむ
    const cc = st.cfg.credit;
    if (cc && cc.enabled && st.debt > 0) {
      const fee = Math.round(st.debt * cc.interest);
      if (fee > 0) {
        st.debt += fee;
        st.totals.interest += fee;
        log(st, 'credit', `立替の手数料${fee.toLocaleString()}円（残債${st.debt.toLocaleString()}円）`, 0);
      }
    }
    repay(st);
    log(st, 'rent', `${st.week}週目の家賃を支払った`, -rent);
    snapshot.cash = st.cash;
    return snapshot;
  }

  function finish(st, forceEnding) {
    // 体験版（50週未満）は達成度ではなく「ここまで」で終わる
    if (st.cfg.totalWeeks < 50 && forceEnding !== 'bad' && !st.ended) {
      const s0 = stats(st);
      st.ended = true;
      st.ending = 'demo';
      st.result = s0;
      log(st, 'end', `体験版はここまで。${st.cfg.totalWeeks}週で登録${s0.registered}本／所持${s0.owned}本。`, 0);
      return;
    }
    st.ended = true;
    st.phase = 'ended';
    if (forceEnding !== 'bad') settleDebt(st);
    const s = stats(st);
    if (forceEnding === 'bad') st.ending = 'bad';
    else if (s.owned >= s.total) st.ending = 'true';
    else if (s.registered >= s.total) st.ending = 'normal';
    else st.ending = 'incomplete';
    st.result = Object.assign(s, { ending: st.ending });
  }

  /** 陳列棚から自動的に売れる分。判断は発生しない */
  function resolvePassiveSales(st) {
    const ps = st.cfg.passiveSales;
    let lo = ps.count[0], hi = ps.count[1];
    const rc = st.cfg.reputation;
    if (rc.enabled) {
      // 賑わいは評判に連動する。序盤の客足の伸びとも掛け合わせる
      const center = byRep(st, rc.passive) + st.passiveBonus;
      lo = Math.max(0, center - 2);
      hi = center + 2;
    } else if (ps.earlyCount) {
      const t = Math.max(0, Math.min(1, (st.week - 1) / Math.max(1, (ps.fullFromWeek || 1) - 1)));
      lo = ps.earlyCount[0] + t * (ps.count[0] - ps.earlyCount[0]);
      hi = ps.earlyCount[1] + t * (ps.count[1] - ps.earlyCount[1]);
    }
    const n = rInt(st.rng, Math.round(lo), Math.round(hi));
    let total = 0, sold = 0;
    const names = [];
    for (let i = 0; i < n; i++) {
      const shelf = forSale(st);
      if (!shelf.length) break;
      const item = rWeighted(st.rng, shelf.map(x => [x, demandOf(st, x)]));
      const t = titleOf(st, item);
      const price = Math.round(priceOf(st, item)
        * (ps.priceRange[0] + st.rng() * (ps.priceRange[1] - ps.priceRange[0])) / 100) * 100;
      removeItem(st, item.uid, 'passive');
      st.cash += price;
      st.totals.sales += price;
      st.totals.soldCount++;
      total += price; sold++;
      if (names.length < 3) names.push(t.name);
    }
    if (sold) {
      log(st, 'passive', `店頭で${sold}本売れた（${names.join('、')}${sold > names.length ? ' ほか' : ''}）`, total);
    }
    st.lastPassive = { count: sold, total };
    return { count: sold, total };
  }

  function startTurn(st) {
    if (st.ended) return;
    st.phase = 'shop';
    // 開店直後だけは、プレイヤーが何もしないうちに在庫が減らないようにする
    if (st.week > 1 || st.half > 0) resolvePassiveSales(st);
    st.queue = buildQueue(st);
    st.current = st.queue.shift() || null;
    st.offers = null;
    if (!st.current) enterActionPhase(st);
  }

  // ============================================================
  // 初期化
  // ============================================================
  function createGame(opts) {
    opts = opts || {};
    const cfg = Object.assign({}, BALANCE, opts.balance || {});
    const st = {
      cfg,
      rng: makeRng((opts.seed === undefined ? 1 : opts.seed) >>> 0),
      seed: opts.seed === undefined ? 1 : opts.seed,
      catalog: null, byId: new Map(),
      week: 1, half: 0, phase: 'shop',
      cash: cfg.startCash,
      inv: [], uidSeq: 1,
      registered: new Set(), soldOnce: new Set(),
      queue: [], current: null, offers: null,
      log: [], ended: false, ending: null, result: null,
      history: { weeks: [], customers: [] },
      ultraEvents: 0, ultraDue: 0, lost: {}, regulars: {}, buyBonus: 0,
      upgrades: {}, passiveBonus: 0, clerkBonus: 0, skills: {}, reveals: {},
      reputation: 0,
      debt: 0,
      totals: { sales: 0, purchases: 0, wholesale: 0, rent: 0, expand: 0, soldCount: 0, boughtCount: 0, orderCount: 0, acquired: 0, overflow: 0,
                borrowed: 0, repaid: 0, interest: 0 },
    };

    st.catalog = Catalog.build(cfg.tiers, cfg.catalogSize, cfg.catalogSeed);
    for (const s of st.catalog) st.byId.set(s.id, s);

    // 初期在庫: 並品中心の売れ残り30本
    for (let i = 0; i < cfg.startInventory; i++) {
      const tier = pickTier(st.rng, { common: 0.8, mid: 0.2 });
      const t = pickTitle(st, tier, { byDemand: true });
      addItem(st, t, { display: true, source: 'start' });
    }
    // 前周からの引き継ぎ（opts.previous は carryFrom() の戻り値）
    const prev = opts.previous;
    if (prev) {
      const co = cfg.carryOver;
      if (co.registered && prev.registered) {
        for (const id of prev.registered) if (st.byId.has(id)) st.registered.add(id);
      }
      if (co.skills && prev.skills) for (const id of prev.skills) st.skills[id] = true;
      // 一度知ったことは知ったまま。次の周でもう一度明かされたりしない
      if (co.reveals && prev.reveals) for (const k of prev.reveals) st.reveals[k] = { carried: true };
      if (co.cash && prev.cash) st.cash += Math.round(prev.cash * co.cashRatio);
      if (co.slots && prev.shelfSlots) {
        st.cfg = cfg = Object.assign({}, cfg, { shelfSlots: Math.max(cfg.shelfSlots, prev.shelfSlots) });
      }
      st.carriedOver = true;
    }
    st.reputation = cfg.reputation.enabled ? cfg.reputation.start : cfg.reputation.max;
    st.startRegistered = st.registered.size;
    st.run = prev ? (prev.run || 1) + 1 : 1;
    // 開店の一言。年齢には触れないが、嘘もついていない（「仕事を辞めた」＝定年退職）。
    // 店の屋号でプレイヤーに姓を渡しておく。図鑑に埋めた伏線はこれと突き合わせて効く
    log(st, 'start',
      '叔父の店を引き継ぐことになった。事故だった。前に会ったときはあんなに元気だったのにな。'
      + `看板は『${SHOP_NAME}』のまま。`
      + 'ちょっと前に仕事を辞めてから暇だったし、しばらくやってみるつもりだ。'
      + `　資金${st.cash.toLocaleString()}円、在庫${st.inv.length}点。`
      + (prev ? `（前回の記録から図鑑${st.registered.size}本を引き継いだ）` : ''), 0);

    startTurn(st);
    return st;
  }

  return {
    BALANCE, HALF_LABEL, createGame,
    answer, doAction, endTurn,
    stats, priceOf, demandOf, titleOf, ownedIds, displayed,
    freeSlots, freeDisplay, countOf, orderCost, orderable, unlocked, setDisplay,
    carryFrom: st => ({ registered: Array.from(st.registered), skills: Object.keys(st.skills),
      reveals: Object.keys(st.reveals || {}),
      cash: st.cash, shelfSlots: st.cfg.shelfSlots, run: st.run }), setMarkdown, setProtect, wholesale, removeItem,
    forSale, REGULARS, THRESHOLDS, repRate, byRep, availableUpgrades, skill, REVEALS, borrow, repay, resolveEvent, makeRegularCustomer,
    condLabel, condMult,
    /** 既に覚えている交渉術のイベントなら、差し替え用のセリフと金額を返す */
    skillKnownNote: (st, e) =>
      (e && e.skill && st.skills[e.skill] && e.skillKnown) ? e.skillKnown : null,
    /** 判断が要らない客か（会話スキップの対象） */
    skippable: c => !!c && (c.type === 'browser'
      || (c.type === 'event' && c.event && c.event.type !== 'offer')),
  };
});

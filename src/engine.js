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

  const { makeRng, rInt, rPick, rWeighted } = Catalog;

  // ============================================================
  // バランス定数（調整はすべてここ）
  // ============================================================
  const BALANCE = {
    totalWeeks: 50,
    rent: 30000,
    startCash: 100000,
    startInventory: 30,
    shelfSlots: 50,          // 保管も含めた総枠
    displaySlots: 20,        // うち店頭陳列できる数
    // 棚拡張（仕様書 5 節）。50枠では150本を同時所持できないため必須
    expand: { cost: 100000, step: 50, max: 200, displayPerStep: 5 },

    /**
     * 激レア15本の入手経路。
     *  'event'   … 仕様書 8 節どおりイベント報酬のみ（常連イベントの代役）
     *  'auction' … オークションで購入できる（終盤の資金の受け皿になる）
     *  'both'    … 両方
     */
    ultra: { source: 'both', eventFromWeek: 12, eventEveryWeeks: 2, maxEvents: 15 },
    catalogSize: 150,
    catalogSeed: 20260821,

    tiers: {
      common: { label: '並品',   count: 70, sale: [500, 2000],      buyRatio: 0.40 },
      mid:    { label: '中堅',   count: 30, sale: [3000, 8000],     buyRatio: 0.42 },
      rare:   { label: 'レア',   count: 35, sale: [15000, 40000],   buyRatio: 0.43 },
      ultra:  { label: '激レア', count: 15, sale: [80000, 300000],  buyRatio: 0.45 },
    },

    /**
     * 店頭の通常売上（判断不要）。
     * 仕様書 2 節の「客3〜4人」は"判断が要る客"の数として扱い、
     * それ以外の一般客はまとめて自動処理する。これが無いと家賃を払える売上に届かない。
     */
    passiveSales: { count: [7, 12], priceRange: [0.90, 1.05],
                    // 寂れた店には客も来ない。品揃えが増えるにつれて客足が戻る
                    earlyCount: [5, 9], fullFromWeek: 16 },

    // 店番（＝売る／売らないの判断が発生する客）
    customers: {
      front: { count: [3, 4], weights: { seller: 0.45, buyer: 0.35, browser: 0.20 } },
      back:  { count: [4, 5], weights: { seller: 0.25, buyer: 0.60, browser: 0.15 } },
    },
    buyerOfferRange: [0.85, 1.15],   // 基準相場に対する客の提示額
    buyerSecondItemChance: 0.25,     // ついで買い
    sellerAskRange: [0.80, 1.50],    // 買取目安に対する持ち込み希望額
    sellerTierWeights: { common: 0.62, mid: 0.28, rare: 0.10, ultra: 0 }, // 激レアは持ち込まれない
    reacquireBoost: 3.0,             // 詰み対策: 一度手放したソフトの再登場率
    markdownRate: 0.20,              // 値下げ幅
    markdownDemand: 2.2,             // 値下げ品の需要倍率
    staleWeeks: 8,                   // これ以上寝かせると死に在庫扱い（需要低下）
    staleDemand: 0.55,

    // 行動フェイズ
    junk:   { cost: [0, 5000], freeChance: 0.5, items: [10, 20],
              mix: { junk: 0.72, common: 0.26, mid: 0.02, rare: 0, ultra: 0 } },
    bulk:   { items: [30, 50], priceRatio: [0.20, 0.45], cap: [3000, 90000],
              // 寂れた店には良いロットが回ってこない。週が進むほど mix に近づく
              earlyMix: { junk: 0.47, common: 0.38, mid: 0.11, rare: 0.04, ultra: 0.002 },
              mixFullFromWeek: 16,
              mix: { junk: 0.44, common: 0.38, mid: 0.12, rare: 0.055, ultra: 0.005 } },
    single: { rivalRatio: [0.50, 0.95], askRatio: [0.35, 0.50],
              tierWeights: { mid: 0.18, rare: 0.70, ultra: 0.12 },
              ultraLateBonus: 0.35,   // 週が進むほど激レアが出品されやすい
              ownedPenalty: 0.15 },   // 所持済みは出品されにくい（＝欲しい物が回ってくる）

    /**
     * 行動フェイズの解禁週（仕様書 3 節の週フェーズ設計に対応）。
     * 1〜10週は資金繰りを覚える期間なので、大きく張れる選択肢を出さない。
     */
    unlock: { bulk: 1, junk: 1, organize: 1, single: 11, expand: 11, order: 11 },

    /**
     * 取り寄せ（仕様書 3 節「46〜50週: 最後の数本を狙い撃つ」に対応する手段）。
     * 図鑑に載っている＝一度は手にしたソフトを、割増料金で指名して仕入れる。
     * 終盤に余った資金の受け皿も兼ねる。
     */
    order: { premium: 1.6, fromWeek: 1 },

    /**
     * 周回引き継ぎ（仕様書 12 節の未決定事項）。
     * 引き継ぐのは「この世界に何があるかの知識」＝図鑑の登録だけ。
     * 資金も在庫も持ち越さないので、店の経営そのものは毎周ゼロから始まる。
     * 登録済みのソフトは最初から取り寄せで狙えるため、完全クリアが現実的になる。
     */
    carryOver: { registered: true, cash: false, cashRatio: 0.2, slots: false },

    wholesaleRatio: 0.40,   // 業者への卸値（整理）
    forcedSaleRatio: 0.30,  // 家賃未払い時の強制売却
    junkValue: 50,          // ガラクタの処分単価
  };

  const HALF_LABEL = ['前半（平日）', '後半（週末）'];

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
      return [s, w];
    });
    return rWeighted(st.rng, pairs);
  }

  function makeItem(st, title) {
    return {
      uid: st.uidSeq++,
      titleId: title ? title.id : null,
      junk: !title,
      display: false,
      markdown: false,
      protect: false,      // 非売品（コレクション用に確保）。客も自動売上も手を出さない
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
    return Math.round(t.base * (item.markdown ? 1 - st.cfg.markdownRate : 1));
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
  const orderCost = (st, t) => Math.round(t.base * st.cfg.order.premium / 100) * 100;
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
      week: st.week, half: st.half, cash: st.cash,
      inventory: st.inv.length, slots: st.cfg.shelfSlots, displaySlots: st.cfg.displaySlots,
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
    const item = makeItem(st, title);
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
      const price = t ? Math.round(t.base * st.cfg.wholesaleRatio) : st.cfg.junkValue;
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
  function buildQueue(st) {
    const cfg = st.cfg.customers[st.half === 0 ? 'front' : 'back'];
    const n = rInt(st.rng, cfg.count[0], cfg.count[1]);
    const queue = [];
    for (let i = 0; i < n; i++) {
      const type = rWeighted(st.rng, Object.keys(cfg.weights).map(k => [k, cfg.weights[k]]));
      queue.push(makeCustomer(st, type));
    }
    return queue;
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
      const offer = Math.round(priceOf(st, item) * (r[0] + st.rng() * (r[1] - r[0])) / 100) * 100;
      return { type: 'buyer', uid: item.uid, titleId: t.id, offer };
    }
    if (type === 'seller') {
      const tier = pickTier(st.rng, st.cfg.sellerTierWeights);
      const t = pickTitle(st, tier, { byDemand: true });
      if (!t) return { type: 'browser', line: rPick(st.rng, BROWSE_LINES) };
      const r = st.cfg.sellerAskRange;
      const ask = Math.max(100, Math.round(t.buy * (r[0] + st.rng() * (r[1] - r[0])) / 100) * 100);
      return { type: 'seller', titleId: t.id, ask };
    }
    return { type: 'browser', line: rPick(st.rng, BROWSE_LINES) };
  }

  /** 現在の客に応答する。yes=売る／買う */
  function answer(st, yes) {
    if (st.phase !== 'shop' || !st.current) return null;
    const c = st.current;
    const result = { customer: c, accepted: false, reason: null };

    if (c.type === 'buyer' && yes) {
      const item = st.inv.find(i => i.uid === c.uid);
      if (item) {
        const t = titleOf(st, item);
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
        addItem(st, t, { display: true });
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

  function generateOffers(st) {
    const cfg = st.cfg;

    // 処分品引取
    const junkLot = rollLot(st, cfg.junk);
    const junkCost = st.rng() < cfg.junk.freeChance ? 0
      : Math.round(rInt(st.rng, cfg.junk.cost[0], cfg.junk.cost[1]) / 100) * 100;

    // オークション（まとめ買い）
    const bulkLot = rollLot(st, cfg.bulk);
    const pr = cfg.bulk.priceRatio;
    let bulkCost = Math.round(bulkLot.retail * (pr[0] + st.rng() * (pr[1] - pr[0])) / 1000) * 1000;
    bulkCost = Math.min(cfg.bulk.cap[1], Math.max(cfg.bulk.cap[0], bulkCost));

    // オークション（単品入札）
    const sw = Object.assign({}, cfg.single.tierWeights);
    if (cfg.ultra.source === 'auction' || cfg.ultra.source === 'both') {
      sw.ultra += cfg.single.ultraLateBonus * (st.week / cfg.totalWeeks); // 終盤ほど激レアが出る
    } else {
      sw.ultra = 0;
    }
    const tier = pickTier(st.rng, sw);
    const target = pickTitle(st, tier, { ownedPenalty: cfg.single.ownedPenalty });
    const ar = cfg.single.askRatio, rr = cfg.single.rivalRatio;
    const singleOffer = target ? {
      titleId: target.id,
      current: Math.round(target.base * (ar[0] + st.rng() * (ar[1] - ar[0])) / 1000) * 1000,
      rival: Math.round(target.base * (rr[0] + st.rng() * (rr[1] - rr[0]))),
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
        if (addItem(st, t)) { added++; res.gained.push(t.id); }
        else {
          // 棚に入れずそのまま業者行きなので図鑑には載らない
          overflow++; st.totals.overflow++;
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
        const paid = Math.min(bid, Math.max(offer.current, offer.rival)); // 二位価格に近い決着
        st.cash -= paid;
        st.totals.purchases += paid;
        res.spent = paid;
        res.won = true;
        res.gained.push(t.id);
        addItem(st, t, { display: t.tier !== 'ultra' });
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
      const t = st.byId.get(params.titleId);
      if (!t) return { ok: false, reason: 'notitle' };
      if (!st.registered.has(t.id)) return { ok: false, reason: 'unknown' };   // 知らない物は頼めない
      if (ownedIds(st).has(t.id)) return { ok: false, reason: 'owned' };
      if (freeSlots(st) <= 0) return { ok: false, reason: 'slots' };
      const cost = orderCost(st, t);
      if (st.cash < cost) return { ok: false, reason: 'cash' };
      st.cash -= cost;
      st.totals.purchases += cost;
      st.totals.orderCount++;
      res.spent = cost;
      res.gained.push(t.id);
      addItem(st, t);
      log(st, 'order', `取り寄せ: 「${t.name}」が届いた`, -cost);

    } else if (key === 'expand') {
      if (!unlocked(st, 'expand')) return { ok: false, reason: 'locked' };
      const ex = st.cfg.expand;
      if (st.cfg.shelfSlots >= ex.max) return { ok: false, reason: 'max' };
      if (st.cash < ex.cost) return { ok: false, reason: 'cash' };
      st.cash -= ex.cost;
      st.totals.expand += ex.cost;
      st.cfg = Object.assign({}, st.cfg, {
        shelfSlots: Math.min(ex.max, st.cfg.shelfSlots + ex.step),
        displaySlots: st.cfg.displaySlots + ex.displayPerStep,
      });
      res.spent = ex.cost;
      log(st, 'expand', `棚を拡張した（${st.cfg.shelfSlots}枠）`, -ex.cost);

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
    if (u.source !== 'event' && u.source !== 'both') return;
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
    addItem(st, t);
    log(st, 'event', `常連客からの譲渡: 「${t.name}」を手に入れた`, 0);
  }

  function endTurn(st) {
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

  function payRent(st) {
    const rent = st.cfg.rent;
    let forced = 0, forcedCount = 0;

    if (st.cash < rent) {
      // 在庫の強制売却。ガラクタ→重複→安いものの順に手放す
      const owned = new Map();
      for (const i of st.inv) if (!i.junk) owned.set(i.titleId, (owned.get(i.titleId) || 0) + 1);
      const order = st.inv.slice().sort((a, b) => {
        const rank = it => it.junk ? 0 : (owned.get(it.titleId) > 1 ? 1 : 2);
        return rank(a) - rank(b) || priceOf(st, a) - priceOf(st, b);
      });
      for (const item of order) {
        if (st.cash >= rent) break;
        const t = titleOf(st, item);
        const price = t ? Math.round(t.base * st.cfg.forcedSaleRatio) : st.cfg.junkValue;
        removeItem(st, item.uid, 'forced');
        st.cash += price;
        forced += price; forcedCount++;
      }
      if (forcedCount) log(st, 'forced', `家賃のため在庫${forcedCount}点を強制売却`, forced);
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
    log(st, 'rent', `${st.week}週目の家賃を支払った`, -rent);
    snapshot.cash = st.cash;
    return snapshot;
  }

  function finish(st, forceEnding) {
    st.ended = true;
    st.phase = 'ended';
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
    if (ps.earlyCount) {
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
      ultraEvents: 0, ultraDue: 0, lost: {},
      totals: { sales: 0, purchases: 0, wholesale: 0, rent: 0, expand: 0, soldCount: 0, boughtCount: 0, orderCount: 0, acquired: 0, overflow: 0 },
    };

    st.catalog = Catalog.build(cfg.tiers, cfg.catalogSize, cfg.catalogSeed);
    for (const s of st.catalog) st.byId.set(s.id, s);

    // 初期在庫: 並品中心の売れ残り30本
    for (let i = 0; i < cfg.startInventory; i++) {
      const tier = pickTier(st.rng, { common: 0.8, mid: 0.2 });
      const t = pickTitle(st, tier, { byDemand: true });
      addItem(st, t, { display: true });
    }
    // 前周からの引き継ぎ（opts.previous は carryFrom() の戻り値）
    const prev = opts.previous;
    if (prev) {
      const co = cfg.carryOver;
      if (co.registered && prev.registered) {
        for (const id of prev.registered) if (st.byId.has(id)) st.registered.add(id);
      }
      if (co.cash && prev.cash) st.cash += Math.round(prev.cash * co.cashRatio);
      if (co.slots && prev.shelfSlots) {
        st.cfg = cfg = Object.assign({}, cfg, { shelfSlots: Math.max(cfg.shelfSlots, prev.shelfSlots) });
      }
      st.carriedOver = true;
    }
    st.startRegistered = st.registered.size;
    st.run = prev ? (prev.run || 1) + 1 : 1;
    log(st, 'start', `開店。資金${st.cash.toLocaleString()}円、在庫${st.inv.length}点。`
      + (prev ? `（前回の記録から図鑑${st.registered.size}本を引き継いだ）` : ''), 0);

    startTurn(st);
    return st;
  }

  return {
    BALANCE, HALF_LABEL, createGame,
    answer, doAction, endTurn,
    stats, priceOf, demandOf, titleOf, ownedIds, displayed,
    freeSlots, freeDisplay, countOf, orderCost, orderable, unlocked, setDisplay,
    carryFrom: st => ({ registered: Array.from(st.registered), cash: st.cash, shelfSlots: st.cfg.shelfSlots, run: st.run }), setMarkdown, setProtect, wholesale, removeItem,
    forSale,
  };
});

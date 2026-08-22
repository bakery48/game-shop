'use strict';
/**
 * 自動プレイ用の方針。
 * 「安く仕入れて回転させ、終盤は売らずに集める」という想定プレイヤーの再現。
 * 資金カーブ検証（仕様書 10 節）の基準線として使う。
 */
(function (root, factory) {
  const E = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.Engine;
  const api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Policy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {

  const TUNING = {
    reserve: 80000,        // 家賃に加えて残しておきたい運転資金
    slotBuffer: 3,         // 買い取り用に空けておく枠
    keepFromWeek: 30,      // この週以降は単品を手放さない
    orderFromWeek: 44,       // この週から取り寄せでコレクションの穴を埋める
    protectFromWeek: 30,     // この週以降は全タイトルの最後の1本を非売品にする
    protectRareFromWeek: 12, // レアはこの週から確保する
    rareSellUntil: 38,     // レアを売っていいのはこの週まで
    singleBidRatio: 0.85,  // 単品入札の入札額（基準相場比）
    junkMinSlots: 16,      // 処分品引取に必要な空き枠
    bulkMinSlots: 8,       // まとめ買いに必要な空き枠（あふれた分は業者行き）
    expandWhenSlotsBelow: 10,
    clerkCashFloor: 450000,  // これだけ現金があるなら人手を入れる
    expandReserveRent: 3,    // 棚拡張後に残しておく家賃の倍数
    singleReserveRent: 2.5,  // 単品入札に残しておく家賃の倍数
    singleCashFloor: 400000, // これだけ現金が残るならレア狙いを優先する
    warChestFromWeek: 99,    // 終盤の仕入れ抑制（仕入れは売り物の供給源でもあるため既定は無効）
    weekdayFloor: 1.0,     // 平日でも家賃分は必ず残す（週末の投げ売りを防ぐ）
    dumpStaleWeeks: 10,    // これ以上寝ている並品は卸す
  };

  const isDup = (st, titleId) => E.countOf(st, titleId) > 1;

  /** 客が指名したソフトを売るか */
  function sellDecision(st, c) {
    const t = st.byId.get(c.titleId);
    const weeksLeft = st.cfg.totalWeeks - st.week;
    if (isDup(st, t.id)) return true;                       // 重複は常に売る
    if (st.cash < st.cfg.rent) return true;                 // 家賃が危ないなら何でも売る
    if (st.week >= TUNING.keepFromWeek) return false;       // 終盤は手放さない
    if (t.tier === 'ultra') return false;
    if (t.tier === 'rare') return st.week <= TUNING.rareSellUntil && c.offer >= t.base * 1.0;
    return weeksLeft > 5;                                   // 並品・中堅は回転させる
  }

  /** 持ち込みを買い取るか */
  function buyDecision(st, c) {
    const t = st.byId.get(c.titleId);
    if (E.freeSlots(st) <= TUNING.slotBuffer) return false;
    if (st.cash - c.ask < st.cfg.rent + TUNING.reserve) return false;
    const owned = E.ownedIds(st).has(t.id);
    // 未所持なら図鑑のために相場近くまで出す。所持済みは転売できる値段でだけ買う
    return c.ask <= t.base * (owned ? 0.55 : 0.85);
  }

  /**
   * 陳列と非売品札の付け替え（無料操作）。
   * 「最後の1本を売り物にするか」がこのゲームの中心的な判断なので、ここが方針の核になる。
   */
  function arrangeDisplay(st) {
    const cfg = st.cfg;
    const willing = [];
    // 同一タイトルの所持数を数え、1本目だけを守る候補にする
    const seen = new Map();
    const order = st.inv.slice().sort((a, b) => (b.junk ? 0 : 1) - (a.junk ? 0 : 1));
    for (const item of order) {
      if (item.junk) { item.protect = false; continue; }
      const t = E.titleOf(st, item);
      const nth = (seen.get(t.id) || 0) + 1;
      seen.set(t.id, nth);
      const isLast = nth === 1;                     // このタイトルの確保用の1本
      // 重複は常に売り物。最後の1本は、守る時期に入っていれば非売品にする
      // 総週数が短い体験版では確保の局面まで進まない。売り続けるのが正しい
      const guard = isLast && (st.week >= TUNING.protectFromWeek
        || t.tier === 'ultra'
        || (t.tier === 'rare' && st.week >= TUNING.protectRareFromWeek));
      item.protect = guard;
      if (!guard) willing.push(item);
    }
    willing.sort((a, b) => E.demandOf(st, b) * E.priceOf(st, b) - E.demandOf(st, a) * E.priceOf(st, a));
    // 非売品は保管に回し、陳列枠は売り物だけで埋める
    const show = new Set(willing.slice(0, cfg.displaySlots).map(i => i.uid));
    for (const item of st.inv) item.display = show.has(item.uid);
  }

  /** 整理で卸す在庫を選ぶ */
  function pickDump(st, need) {
    const owned = new Map();
    for (const i of st.inv) if (!i.junk) owned.set(i.titleId, (owned.get(i.titleId) || 0) + 1);
    const cand = [];
    for (const item of st.inv) {
      if (item.junk) { cand.push({ item, score: 0, value: st.cfg.junkValue }); continue; }
      const t = E.titleOf(st, item);
      const dup = owned.get(t.id) > 1;
      // 最後の1本は卸さない。図鑑の所持率がそのまま削れるため
      if (!dup) continue;
      cand.push({ item, score: 1, value: Math.round(t.base * st.cfg.wholesaleRatio) });
      owned.set(t.id, owned.get(t.id) - 1);
    }
    // ガラクタ → 重複 → 寝ている並品 の順。資金目当てなら高い順に足りるまで
    cand.sort((a, b) => a.score - b.score || b.value - a.value);
    if (need === undefined) return cand.map(c => c.item.uid);
    let sum = 0;
    const out = [];
    for (const c of cand.slice().sort((a, b) => b.value - a.value)) {
      if (sum >= need) break;
      out.push(c.item.uid); sum += c.value;
    }
    // 資金を作るついでにガラクタも捨てる
    for (const c of cand) if (c.score === 0 && !out.includes(c.item.uid)) out.push(c.item.uid);
    return out;
  }

  /** 常連イベントへの応答。offer 型だけが判断を要する */
  function eventDecision(st, c) {
    if (c.event.type !== 'offer') return true;
    const t = st.catalog.find(x => x.name === c.event.title);
    if (!t) return false;
    const price = Math.round(t.base * c.event.priceRatio / 100) * 100;
    if (E.freeSlots(st) <= 0) return false;
    if (st.cash - price < st.cfg.rent) return false;
    // 常連の持ち込みは相場より安い。未所持なら多少高くても取る
    const limit = E.ownedIds(st).has(t.id) ? t.base * 0.5 : t.base * 0.8;
    return price <= limit;
  }

  /** 行動フェイズの選択 */
  function chooseAction(st) {
    const cfg = st.cfg, o = st.offers;
    const slots = E.freeSlots(st);
    const owned = E.ownedIds(st);
    const weeksLeft = cfg.totalWeeks - st.week;
    // 前半（平日）は仕入れに攻める。後半（週末）は家賃を確保してから動く
    // ＝仕様書 2 節「前半に安く仕入れて後半に売る」
    const weekend = st.half === 1;
    // 終盤は残り週数ぶんの家賃を握っておく。ここを削ると最後に在庫を毟られて所持率が落ちる
    const warChest = st.week >= TUNING.warChestFromWeek
      ? cfg.rent * Math.max(0, weeksLeft + 1) : 0;
    // 現金化の判断に使う下限（家賃を払えるか）
    const rentFloor = weekend ? cfg.rent + TUNING.reserve : Math.round(cfg.rent * TUNING.weekdayFloor);
    // 仕入れの判断に使う下限（終盤は残り家賃を握る分だけ厳しくなる）
    const floor = rentFloor + warChest;

    // 1. 週末に家賃が足りない → 整理して現金化
    if (st.cash < rentFloor) {
      const uids = pickDump(st, rentFloor - st.cash);
      if (uids.length) return { key: 'organize', params: { wholesale: uids } };
    }

    // 2. 取り寄せ: 図鑑に載っているのに手元に無いものを、安い順に埋めていく。
    //    仕様書 3 節の「最後の数本を狙い撃つ」局面はここで作られる
    if (st.week >= TUNING.orderFromWeek && slots > 0) {
      const want = E.orderable(st)
        .map(t => ({ t, cost: E.orderCost(st, t) }))
        .filter(x => st.cash - x.cost >= floor)
        .sort((a, b) => a.cost - b.cost);
      if (want.length) {
        // 手番が足りないので、頼めるだけまとめて頼む
        const batch = [];
        let budget = st.cash - floor;
        for (const w of want) {
          if (batch.length >= (cfg.order.batch || 1) || batch.length >= slots) break;
          if (budget - w.cost < 0) break;
          budget -= w.cost;
          batch.push(w.t.id);
        }
        if (batch.length) return { key: 'order', params: { titleIds: batch } };
      }
    }

    // 3. 未所持のレア・激レアが出ていれば、資金に余裕がある限り最優先で取りに行く。
    //    まとめ図鑑を埋める本数はここでしか稼げないため、中盤以降はまとめ買いより優先する
    const single = o.single ? st.byId.get(o.single.titleId) : null;
    const singleBid = single ? Math.round(single.base * TUNING.singleBidRatio) : 0;
    const singleWanted = single && !owned.has(single.id)
      && (single.tier === 'rare' || single.tier === 'ultra')
      && slots > 0
      && st.cash - singleBid >= cfg.rent * TUNING.singleReserveRent + TUNING.reserve;
    if (singleWanted && st.cash - singleBid >= TUNING.singleCashFloor) {
      return { key: 'single', params: { bid: singleBid } };
    }

    // 4. まとめ買い＝収益の本体。枠に入りきらない分は業者に流れるので資金だけ見る
    if (o.bulk && st.cash - o.bulk.cost >= floor && weeksLeft > 2
        && slots >= TUNING.bulkMinSlots) {
      return { key: 'bulk', params: {} };
    }

    // 5. 設備と人手。詰まっているところから順に買う
    if (E.unlocked(st, 'expand') && weeksLeft > 4) {
      const avail = E.availableUpgrades(st);
      const pick = id => avail.find(u => u.id === id);
      const afford = u => u && st.cash - u.cost >= cfg.rent * TUNING.expandReserveRent + TUNING.reserve;
      // 棚が詰まっている → 倉庫、陳列枠が埋まっている → 陳列棚、その後は売上と接客
      const order = [];
      if (slots < TUNING.expandWhenSlotsBelow) order.push('warehouse');
      if (E.freeDisplay(st) <= 0) order.push('shelf');
      // 資金に余裕があるうちに人手を入れる。接客が増えると常連にも会いやすくなる
      if (st.cash > TUNING.clerkCashFloor) order.push('clerk');
      order.push('storefront', 'warehouse', 'shelf', 'clerk');
      for (const id of order) {
        const u = pick(id);
        if (afford(u)) return { key: 'upgrade', params: { id } };
      }
    }

    // 6. 序盤の単品入札（資金に余裕があるときだけ）
    if (singleWanted) return { key: 'single', params: { bid: singleBid } };

    // 7. 処分品引取: 枠が余っているとき。ただ働きでも在庫は増える
    if (o.junk && slots >= TUNING.junkMinSlots && weeksLeft > 2
        && (st.cash - o.junk.cost >= floor || o.junk.cost === 0)) {
      return { key: 'junk', params: {} };
    }

    // 8. それ以外は整理（枠を空けて次の仕入れに備える）
    const uids = pickDump(st);
    if (uids.length) return { key: 'organize', params: { wholesale: uids } };
    return { key: 'rest', params: {} };
  }

  /** 1ターン進める */
  function playTurn(st) {
    arrangeDisplay(st);
    while (st.phase === 'shop' && st.current) {
      const c = st.current;
      if (c.type === 'buyer') E.answer(st, sellDecision(st, c));
      else if (c.type === 'seller') E.answer(st, buyDecision(st, c));
      else if (c.type === 'event') E.answer(st, eventDecision(st, c));
      else E.answer(st, false);
    }
    if (st.phase === 'action') {
      const a = chooseAction(st);
      const r = E.doAction(st, a.key, a.params);
      if (!r.ok) E.doAction(st, 'rest', {});   // 失敗したら休むで確実にターンを消費
    }
  }

  function playAll(st) {
    let guard = 0;
    while (!st.ended && guard++ < 500) playTurn(st);
    return st;
  }

  return { TUNING, playTurn, playAll, arrangeDisplay, chooseAction, sellDecision, buyDecision, eventDecision, pickDump };
});

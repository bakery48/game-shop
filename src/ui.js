'use strict';
/* ブラウザ用の最小UI。仕様書 10 節のとおり「表とボタンのみ」 */
(function () {
  const E = window.Engine, P = window.Policy;
  let st = null;
  const selected = new Set();

  const $ = id => document.getElementById(id);

  /**
   * 会話スキップ。周回すると同じイベントを何度も読むことになるので、
   * 「判断が要らない客」だけ自動で進める。何が起きたかはログに残り、
   * 飛ばした分は要約カードで見える。判断が要る客（買う／売る／取引）は飛ばさない。
   */
  const SKIP_KEY = 'gameshop.skipTalk';
  let skipTalk = false;
  try { skipTalk = localStorage.getItem(SKIP_KEY) === '1'; } catch (e) { /* 使えなくても動く */ }
  let skipped = [];   // 直近に飛ばしたログ行
  let readReveals = new Set();   // 読み終えた種明かし（この周のあいだだけ覚える）

  /** 種明かしのカード。閉じるまで店内の先頭に残る */
  function revealCard(key, onClose) {
    const r = E.REVEALS[key];
    if (!r) return null;
    const card = el('div', 'card event');
    card.appendChild(el('div', 'who', r.title));
    for (const para of r.text.split('\n\n')) {
      card.appendChild(el('p', 'detail-body', para));
    }
    if (onClose) {
      const row = el('div', 'row');
      row.appendChild(btn('閉じる', onClose, true));
      card.appendChild(row);
    }
    return card;
  }
  const yen = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const tierCls = t => 'tier-' + t;
  /** 状態の見せ方。美品は良い色、傷ありは沈める */
  const condCls = item => (item && item.cond != null)
    ? (item.cond === 2 ? 'ok' : item.cond === 0 ? 'warn' : 'sub') : 'sub';
  /** 「美品（相場の125%）」のような注記 */
  function condNote(st2, cond) {
    const c = st2.cfg.condition;
    if (!c || !c.enabled || cond == null || !c.grades[cond]) return '';
    const g = c.grades[cond];
    return `${g.label}（相場の${Math.round(g.mult * 100)}%）`;
  }

  // ---------------- 状態バー ----------------
  function renderStat() {
    const s = E.stats(st);
    const rentSoon = st.half === 1;
    $('stat').innerHTML = '';
    const add = (label, value, cls) => {
      const d = el('div');
      d.appendChild(el('span', 'sub', label + ' '));
      d.appendChild(el('b', cls, value));
      $('stat').appendChild(d);
    };
    add('周', `${st.run || 1}周目` + (st.startRegistered ? `（図鑑${st.startRegistered}本から）` : ''));
    add('週', `${s.week} / ${st.cfg.totalWeeks}`);
    if (st.cfg.reputation.enabled) {
      const r = s.reputation;
      const label = r >= 85 ? '名店' : r >= 65 ? '評判の店' : r >= 40 ? '知られてきた'
                  : r >= 20 ? '常連がつき始めた' : r >= 8 ? '細々と' : '寂れている';
      add('評判', `${Math.round(r)} ${label}`, r >= 40 ? 'ok' : r < 8 ? 'warn' : null);
    }
    add('ターン', E.HALF_LABEL[s.half]);
    add('資金', yen(s.cash), s.cash < st.cfg.rent ? 'warn' : null);
    add('家賃', yen(st.cfg.rent) + (rentSoon ? ' 今週末' : ''), rentSoon ? 'warn' : null);
    if (s.debt > 0) {
      const c = st.cfg.credit;
      add('残債', yen(s.debt) + `（週${Math.round(c.interest * 100)}%）`, 'warn');
    }
    const learned = Object.keys(st.skills || {});
    if (learned.length) {
      add('交渉術', learned.map(k => st.cfg.skills[k].name).join('・'), 'ok');
    }
    if (st.cfg.promo.enabled && s.promo) {
      const cap = st.cfg.promo.cap;
      add('宣伝', `${s.promo} / ${cap}` + (s.promo >= cap ? '（頭打ち）' : ''),
        s.promo >= cap ? null : 'ok');
    }
    const ups = Object.values(st.upgrades || {}).reduce((a, b) => a + b, 0);
    if (ups) add('設備', `${ups}件` + (st.clerkBonus ? `／店員${st.clerkBonus}人` : ''));
    add('在庫', `${s.inventory} / ${s.slots}` + (s.junk ? `（雑${s.junk}）` : ''));
    add('陳列', `${s.displayed} / ${s.displaySlots}`);
    add('図鑑 登録', `${s.registered} / ${s.total}（${Math.round(s.registeredRate * 100)}%）`);
    add('所持', `${s.owned} / ${s.total}（${Math.round(s.ownedRate * 100)}%）`,
      s.ownedRate >= 1 ? 'ok' : null);
  }

  // ---------------- 店内（フェイズ） ----------------
  function renderPhase() {
    const box = $('phase');
    box.innerHTML = '';

    if (skipped.length) {
      const c = el('div', 'card');
      c.appendChild(el('div', 'who', `会話を${skipped.length}件飛ばしました`));
      for (const l of skipped) {
        const d = el('div', 'sub');
        d.appendChild(el('span', null, l.text));
        if (l.amount) d.appendChild(el('span', l.amount < 0 ? ' warn' : ' ok', '  ' + yen(l.amount)));
        c.appendChild(d);
      }
      box.appendChild(c);
      skipped = [];
    }

    if (st.ended) {
      const name = { true: `真エンド（全${st.cfg.catalogSize}本を同時所持）`, normal: 'ノーマルエンド（図鑑は完成、所持は未達）',
                     bad: 'バッドエンド（家賃を払えず閉店）', incomplete: '未達成',
                     demo: `体験版はここまで（${st.cfg.totalWeeks}週）` }[st.ending];
      const c = el('div', 'card');
      c.appendChild(el('div', 'who', 'ゲーム終了 — ' + name));
      const s = st.result || E.stats(st);
      c.appendChild(el('div', null,
        `${s.week - 1}週まで営業 / 登録 ${s.registered}本 / 所持 ${s.owned}本 / 残高 ${yen(s.cash)}`));
      if (st.cfg.carryOver.registered) {
        c.appendChild(el('div', 'sub',
          `「次の周へ」で図鑑の登録${s.registered}本を引き継げます（資金と在庫は引き継ぎません）。`
          + '登録済みのソフトは最初から取り寄せで狙えます'));
        const mem = E.REGULARS.filter(r => st.memories && st.memories[r.id]);
        c.appendChild(el('div', mem.length ? 'ok' : 'sub',
          mem.length
            ? `${mem.map(r => r.name).join('・')}との記憶が残ります。次の周では会いやすくなります`
              + '（常連表で一人ずつ切り替えられます。絞るほどその相手に会いやすくなります）'
            : '最後まで見届けた常連がいません。全4回のイベントを見ると「記憶」が残り、次の周で会いやすくなります'));
      }
      box.appendChild(c);
      for (const key of ['registered', 'owned']) {
        if (st.reveals[key] && !st.reveals[key].carried) {
          const rc = revealCard(key, null);
          if (rc) box.appendChild(rc);
        }
      }
      return;
    }

    // 種明かしが出たら、読むまで店内の先頭に居座る
    for (const key of ['registered', 'owned']) {
      if (st.reveals[key] && !st.reveals[key].carried && !readReveals.has(key)) {
        const rc = revealCard(key, () => { readReveals.add(key); render(); });
        if (rc) { box.appendChild(rc); return; }
      }
    }

    if (st.phase === 'shop' && st.current) {
      const c = st.current;
      const card = el('div', 'card');
      if (c.regular) {
        card.classList.add('regular');
        const w = el('div', 'who');
        w.textContent = `${c.regular.name}（${c.regular.title}）`;
        w.appendChild(el('span', 'sub', `　${c.regular.visits}回目の来店`));
        card.appendChild(w);
      }
      if (c.type === 'event') {
        card.classList.add('event');
        if (!c.regular) card.appendChild(el('div', 'who', 'イベント'));
        card.appendChild(el('p', 'detail-body', c.event.text));
        // 既に覚えている交渉術のイベントは、教え直しではなく別のやりとりになる
        const known = E.skillKnownNote(st, c.event);
        if (known) {
          card.appendChild(el('p', 'detail-body', known.text));
          card.appendChild(el('div', 'ok',
            `${st.cfg.skills[c.event.skill].name}は習得済み — 代わりに ${yen(known.amount)}`));
        }
        const row = el('div', 'row');
        if (c.event.type === 'offer') {
          const t = st.catalog.find(x => x.name === c.event.title);
          if (t) {
            const price = Math.round(t.base * c.event.priceRatio / 100) * 100;
            card.appendChild(el('div', 'sub',
              `「${t.name}」／${t.tierLabel}／基準相場 ${yen(t.base)} → ${yen(price)}`));
            showDetail(t.id);
            const canBuy = st.cash >= price && E.freeSlots(st) > 0;
            row.appendChild(btn('買い取る', () => { E.answer(st, true); render(); }, true, !canBuy));
            row.appendChild(btn('断る', () => { E.answer(st, false); render(); }));
            if (!canBuy) row.appendChild(el('span', 'warn', st.cash < price ? '資金不足' : '棚枠が満杯'));
          }
        } else {
          row.appendChild(btn('次へ', () => { E.answer(st, true); render(); }, true));
        }
        card.appendChild(row);
        box.appendChild(card);
        box.appendChild(el('div', 'sub', `この後あと${st.queue.length}人`));
        return;
      }
      if (c.type === 'buyer') {
        const t = st.byId.get(c.titleId);
        if (!c.regular) card.appendChild(el('div', 'who', '買いに来た客'));
        const p = el('div');
        p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
        p.appendChild(el('span', null, ` を ${yen(c.offer)} で売ってほしい`));
        card.appendChild(p);
        // 値札との差を見せる（棚から勝手に売れる分より指名客のほうが高く払う）
        const item = st.inv.find(i => i.uid === c.uid);
        const tag = item ? Math.round(E.priceOf(st, item)
          * (st.cfg.passiveSales.priceRange[0] + st.cfg.passiveSales.priceRange[1]) / 2 / 100) * 100 : null;
        card.appendChild(el('div', 'sub',
          `${t.year}年 / ${t.maker} / ${t.tierLabel}`
          + (t.rating != null ? ` / 評価${t.rating.toFixed(1)}` : '')
          + `｜基準相場 ${yen(t.base)}｜所持 ${E.countOf(st, t.id)}本`));
        if (tag) {
          const diff = Math.round((c.offer / tag - 1) * 100);
          const d = el('div');
          d.appendChild(el('span', 'sub', `棚に出しておけばおよそ ${yen(tag)}。`));
          d.appendChild(el('span', diff > 0 ? 'ok' : 'warn',
            ` この客は${diff >= 0 ? '+' : ''}${diff}%`));
          card.appendChild(d);
        }
        showDetail(t.id);
        if (E.countOf(st, t.id) <= 1) {
          card.appendChild(el('div', 'warn', '※ 最後の1本です。売ると所持率が下がります'));
        }
        const row = el('div', 'row');
        row.appendChild(btn('売る', () => { E.answer(st, true); render(); }, true));
        row.appendChild(btn('売らない', () => { E.answer(st, false); render(); }));
        card.appendChild(row);
      } else if (c.type === 'seller') {
        const t = st.byId.get(c.titleId);
        const owned = E.ownedIds(st).has(t.id);
        if (!c.regular) card.appendChild(el('div', 'who', '売りに来た客'));
        const p = el('div');
        p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
        p.appendChild(el('span', null, ` を ${yen(c.ask)} で買い取ってほしい`));
        card.appendChild(p);
        const note = condNote(st, c.cond);
        const d = el('div', 'sub');
        d.appendChild(el('span', null,
          `${t.year}年 / ${t.maker} / ${t.tierLabel}`
          + (t.rating != null ? ` / 評価${t.rating.toFixed(1)}` : '')
          + `｜基準相場 ${yen(t.base)}｜`));
        if (note) d.appendChild(el('span', condCls({ cond: c.cond }), note + '｜'));
        d.appendChild(el('span', null, owned ? '所持済み' : '未所持'));
        card.appendChild(d);
        showDetail(t.id);
        const row = el('div', 'row');
        const canBuy = st.cash >= c.ask && E.freeSlots(st) > 0;
        row.appendChild(btn('買う', () => { E.answer(st, true); render(); }, true, !canBuy));
        row.appendChild(btn('買わない', () => { E.answer(st, false); render(); }));
        if (!canBuy) row.appendChild(el('span', 'warn', st.cash < c.ask ? '資金不足' : '棚枠が満杯'));
        card.appendChild(row);
      } else {
        if (!c.regular) card.appendChild(el('div', 'who', '冷やかし'));
        // 常連の雑談は長いので、読みやすい行間で出す
        card.appendChild(el('p', c.regular ? 'detail-body' : null, c.line));
        const row = el('div', 'row');
        row.appendChild(btn('次へ', () => { E.answer(st, false); render(); }, true));
        card.appendChild(row);
      }
      box.appendChild(card);
      box.appendChild(el('div', 'sub', `この後あと${st.queue.length}人`));
      return;
    }

    // 行動フェイズ
    const o = st.offers;
    box.appendChild(el('div', 'sub', '行動フェイズ — 1つ選ぶとターンが終わります'));
    if (st.cfg.reputation.enabled) {
      const rc = st.cfg.reputation;
      box.appendChild(el('div', 'sub',
        `評判 ${Math.round(st.reputation)}：来客はおよそ${Math.round(E.byRep(st, rc.customers))}人／ターン。`
        + '棚を埋める・買い取りに応じる・珍しいものを置くと上がり、断る・売り物を切らすと下がります'));
    }

    const mk = (title, detail, label, fn, disabled, note) => {
      const card = el('div', 'card');
      card.appendChild(el('div', 'who', title));
      card.appendChild(el('div', null, detail));
      if (note) card.appendChild(el('div', 'sub', note));
      const row = el('div', 'row');
      row.appendChild(btn(label, fn, true, disabled));
      card.appendChild(row);
      box.appendChild(card);
    };

    // 解禁前の選択肢は理由とともに伏せる
    const locked = (title, key) => {
      const card = el('div', 'card');
      card.style.borderLeftColor = 'var(--rule)';
      card.appendChild(el('div', 'who', title));
      card.appendChild(el('div', 'sub', `${st.cfg.unlock[key]}週目から選べるようになります`));
      box.appendChild(card);
    };

    if (o.bulk) {
      mk('まとめ買い（業者オークション）',
        `${o.bulk.lot.count}点セット — ${yen(o.bulk.cost)}`,
        '入札する', () => { E.doAction(st, 'bulk', {}); render(); },
        st.cash < o.bulk.cost,
        o.bulk.hint + '｜棚に入りきらない分はその場で業者に流れます'
        + '｜業者どうしの取引なので、町の評判は動きません');
    } else locked('まとめ買い（業者オークション）', 'bulk');

    if (!E.unlocked(st, 'single')) locked('オークション（単品入札）', 'single');
    if (o.single) {
      const t = st.byId.get(o.single.titleId);
      const owned = E.ownedIds(st).has(t.id);
      const card = el('div', 'card');
      card.appendChild(el('div', 'who', 'オークション（単品入札）'));
      const p = el('div');
      p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
      p.appendChild(el('span', null, ` — 現在価格 ${yen(o.single.current)}`));
      card.appendChild(p);
      const sd = el('div', 'sub');
      sd.appendChild(el('span', null,
        `${t.hardware} / ${t.year}年 / ${t.maker} / ${t.tierLabel}｜基準相場 ${yen(t.base)}｜`));
      const sn = condNote(st, o.single.cond);
      if (sn) sd.appendChild(el('span', condCls({ cond: o.single.cond }), sn + '｜'));
      sd.appendChild(el('span', null, owned ? '所持済み' : '未所持'));
      card.appendChild(sd);
      const row = el('div', 'row');
      const input = el('input');
      input.type = 'number';
      input.value = Math.max(o.single.current, Math.round(t.base * 0.8));
      input.step = 1000;
      row.appendChild(el('span', 'sub', '入札額'));
      row.appendChild(input);
      row.appendChild(btn('入札する', () => {
        const r = E.doAction(st, 'single', { bid: Number(input.value) });
        if (!r.ok) alert({ lowbid: '現在価格を下回っています', cash: '資金が足りません',
                           slots: '棚枠が満杯です' }[r.reason] || '入札できません');
        render();
      }, true));
      card.appendChild(row);
      box.appendChild(card);
    }

    // 取り寄せ — 図鑑に載っているのに手元に無いものを指名して仕入れる
    const want = E.orderable(st);
    if (!E.unlocked(st, 'order')) locked('取り寄せを頼む', 'order');
    if (want.length) {
      const card = el('div', 'card');
      card.appendChild(el('div', 'who', '取り寄せを頼む'));
      const batch = Math.max(1, st.cfg.order.batch || 1);
      card.appendChild(el('div', null,
        `図鑑に載っているのに手元に無いソフト ${want.length}本から、1回に${batch}本まで指名できます`));
      const sel = document.createElement('select');
      if (batch > 1) {
        sel.multiple = true;
        sel.size = Math.min(8, Math.max(3, want.length));
      }
      want.slice().sort((a, b) => E.orderCost(st, a) - E.orderCost(st, b)).forEach(t => {
        const op = document.createElement('option');
        op.value = t.id;
        op.textContent = `${t.name}（${t.tierLabel}） — ${yen(E.orderCost(st, t))}`;
        sel.appendChild(op);
      });
      card.appendChild(el('div', 'sub',
        `相場の${Math.round(st.cfg.order.premium * 100)}%を払います。終盤に最後の数本を狙い撃つための手段です`
        + (batch > 1 ? `（Ctrl＋クリックで${batch}本まで選べます。まとめて頼んでも手番は1回）` : '')));
      const row = el('div', 'row');
      row.appendChild(sel);
      row.appendChild(btn('頼む', () => {
        const picked = [...sel.selectedOptions].slice(0, batch).map(o => Number(o.value));
        if (!picked.length) { alert('取り寄せるソフトを選んでください'); return; }
        const r = E.doAction(st, 'order', { titleIds: picked });
        if (!r.ok) {
          alert({ cash: '資金が足りません', slots: '棚枠が満杯です', none: '取り寄せできません' }[r.reason]
            || '取り寄せできません');
        }
        render();
      }, true));
      card.appendChild(row);
      box.appendChild(card);
    }

    if (o.junk) {
      mk('処分品引取（近所の人から）',
        `押し入れの整理もの ${o.junk.lot.count}点 — ${o.junk.cost ? yen(o.junk.cost) : '無料'}`,
        '引き取る', () => { E.doAction(st, 'junk', {}); render(); },
        st.cash < o.junk.cost,
        '安い並品ばかりで状態も良くありませんが、'
        + `引き取ると町での評判が上がります（+${st.cfg.reputation.gain.junkLot}）`);
    } else locked('処分品引取', 'junk');

    mk('店舗・保管庫の整理',
      selected.size ? `選択中の${selected.size}点を業者に卸します` : '在庫表で選んだ在庫を業者に卸します',
      '整理する', () => {
        E.doAction(st, 'organize', { wholesale: Array.from(selected) });
        selected.clear();
        render();
      }, false, `卸値は基準相場の${Math.round(st.cfg.wholesaleRatio * 100)}%です`);

    // 設備と人手
    if (!E.unlocked(st, 'expand')) locked('設備と人手を買う', 'expand');
    else {
      for (const u of E.availableUpgrades(st)) {
        mk(`${u.name}（${u.owned}/${u.max}）`,
          yen(u.cost),
          '買う', () => {
            const r = E.doAction(st, 'upgrade', { id: u.id });
            if (!r.ok) alert({ cash: '資金が足りません', max: 'これ以上は増やせません' }[r.reason] || '買えません');
            render();
          }, st.cash < u.cost, u.desc);
      }
    }

    const pc = st.cfg.promo;
    if (pc && pc.enabled) {
      if (!E.unlocked(st, 'promo')) {
        const card = el('div', 'card');
        card.style.borderLeftColor = 'var(--rule)';
        card.appendChild(el('div', 'who', 'SNSで宣伝する'));
        card.appendChild(el('div', 'sub', 'アカウントがありません'));
        box.appendChild(card);
      } else {
        const done = st.promo || 0, capped = done >= pc.cap;
        const pct = Math.round(E.promoRate(st) * 100);
        mk('SNSで宣伝する',
          capped ? `${done} / ${pc.cap}　もう届く人には届いています`
                 : `${done} / ${pc.cap}　店の名前が広がっています`,
          '投稿する', () => { E.doAction(st, 'promo', {}); render(); }, false,
          `評判が上がり、持っていないソフトが持ち込まれやすくなります`
          + `（いまの効き ${pct}%／${pc.cap}回で頭打ち）`
          + (capped ? '｜これ以上は伸びません' : ''));
      }
    }

    const cc = st.cfg.credit;
    if (cc && cc.enabled) {
      const room = Math.max(0, cc.limit - st.debt);
      const step = Math.min(room, st.cfg.rent * 2);
      mk('業者に立て替えてもらう',
        room ? `あと ${yen(room)} まで頼めます` : '上限まで借りています',
        `${yen(step)} 借りる`, () => { E.borrow(st, step); render(); }, !room,
        '手番は使いません。週末に手数料が乗り、余裕ができたぶんから自動で返します'
        + '｜在庫を叩き売ると棚が痩せて売上が戻らなくなるので、先にこちらを頼るほうが立て直せます');
    }

    mk('休む', '何もしません', '休む', () => { E.doAction(st, 'rest', {}); render(); });
  }

  function btn(label, fn, primary, disabled) {
    const b = el('button', primary ? 'primary' : null, label);
    b.disabled = !!disabled;
    b.onclick = fn;
    return b;
  }

  // ---------------- 在庫 ----------------
  function renderInv() {
    const tb = $('inv');
    tb.innerHTML = '';
    const head = tb.insertRow();
    ['', 'タイトル', 'ハード', '希少', '状態', '相場', '陳列', '非売品', '値下'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i === 5) th.className = 'num';
      head.appendChild(th);
    });

    const items = st.inv.slice().sort((a, b) => {
      if (a.junk !== b.junk) return a.junk ? 1 : -1;
      return E.priceOf(st, b) - E.priceOf(st, a);
    });

    for (const item of items) {
      const t = E.titleOf(st, item);
      const r = tb.insertRow();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(item.uid);
      cb.onchange = () => {
        if (cb.checked) selected.add(item.uid); else selected.delete(item.uid);
        $('selNote').textContent = selected.size ? `${selected.size}点を選択中` : '';
      };
      r.insertCell().appendChild(cb);
      if (!t) {
        const c = r.insertCell();
        c.textContent = 'ガラクタ';
        c.className = 'sub';
        r.insertCell().textContent = '—';
        r.insertCell().textContent = '—';
        r.insertCell().textContent = '—';
        const pc = r.insertCell(); pc.textContent = yen(st.cfg.junkValue); pc.className = 'num';
        r.insertCell(); r.insertCell(); r.insertCell();
        continue;
      }
      const nc = r.insertCell();
      nc.textContent = t.name + (E.countOf(st, t.id) > 1 ? ` ×${E.countOf(st, t.id)}` : '');
      nc.className = tierCls(t.tier);
      nc.title = t.desc;
      r.style.cursor = 'pointer';
      r.onclick = e => { if (e.target.tagName !== 'INPUT') showDetail(t.id); };
      r.insertCell().textContent = t.hardware;
      r.insertCell().textContent = t.tierLabel;
      const cc = r.insertCell();
      cc.textContent = E.condLabel(st, item);
      cc.className = condCls(item);
      const pc = r.insertCell();
      pc.textContent = yen(E.priceOf(st, item));
      pc.className = 'num';
      r.insertCell().appendChild(toggle(item.display, v => {
        if (!E.setDisplay(st, item.uid, v)) alert('陳列枠がいっぱいです');
        render();
      }));
      r.insertCell().appendChild(toggle(item.protect, v => { E.setProtect(st, item.uid, v); render(); }));
      r.insertCell().appendChild(toggle(item.markdown, v => { E.setMarkdown(st, item.uid, v); render(); }));
    }
    $('invNote').textContent = `${st.inv.length} / ${st.cfg.shelfSlots}枠｜非売品は客も自動売上も手を出しません`;
    $('selNote').textContent = selected.size ? `${selected.size}点を選択中` : '';
  }

  function toggle(on, fn) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!on;
    cb.onchange = () => fn(cb.checked);
    return cb;
  }

  // ---------------- 図鑑 ----------------
  function renderDex() {
    const tb = $('dex');
    tb.innerHTML = '';
    const head = tb.insertRow();
    ['状態', 'タイトル', '年', 'メーカー', '希少', '評価', '相場'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i >= 5) th.className = 'num';
      head.appendChild(th);
    });
    const owned = E.ownedIds(st);
    const onlyMissing = $('dexMissing').checked;
    for (const t of st.catalog) {
      const has = owned.has(t.id), reg = st.registered.has(t.id);
      if (onlyMissing && has) continue;
      const r = tb.insertRow();
      const sc = r.insertCell();
      sc.textContent = has ? '所持' : reg ? '登録' : '—';
      sc.className = has ? 'ok' : reg ? 'sub' : 'sub';
      const nc = r.insertCell();
      nc.textContent = (reg ? t.name : '？？？') + (reg && !t.authored ? ' *' : '');
      nc.className = reg ? tierCls(t.tier) : 'sub';
      if (reg && !t.authored) nc.title = '仮データ';
      if (reg) nc.title = t.desc;
      r.insertCell().textContent = reg ? t.year : '—';
      r.insertCell().textContent = reg ? t.maker : '—';
      r.insertCell().textContent = t.tierLabel;
      const rc = r.insertCell();
      rc.textContent = reg && t.rating != null ? t.rating.toFixed(1) : '—';
      rc.className = 'num';
      const pc = r.insertCell();
      pc.textContent = reg ? yen(t.base) : '—';
      pc.className = 'num';
      if (reg) { r.style.cursor = 'pointer'; r.onclick = () => showDetail(t.id); }
    }
    const s = E.stats(st);
    $('dexNote').textContent = `登録 ${s.registered} / 所持 ${s.owned} / 全${s.total}本`;
  }

  // ---------------- ログ ----------------
  function renderLog() {
    const box = $('log');
    box.innerHTML = '';
    for (const l of st.log.slice(-80).reverse()) {
      const d = el('div');
      d.appendChild(el('span', 'sub', `${l.week}週${l.half === 0 ? '前' : '後'} `));
      d.appendChild(el('span', null, l.text));
      if (l.amount) {
        d.appendChild(el('span', l.amount < 0 ? ' warn' : ' ok', '  ' + yen(l.amount)));
      }
      box.appendChild(d);
    }
  }

  // ---------------- ソフトの詳細 ----------------
  let detailId = null;

  function showDetail(id) { detailId = id; renderDetail(); }

  function renderDetail() {
    const box = $('detail');
    if (!box) return;
    box.innerHTML = '';
    const t = detailId != null ? st.byId.get(detailId) : null;
    if (!t || !st.registered.has(t.id)) {
      box.appendChild(el('div', 'sub', '図鑑や在庫の行をクリックすると、そのソフトの詳細が出ます'));
      return;
    }
    const h = el('div', 'detail-title');
    h.appendChild(el('span', tierCls(t.tier), t.name));
    box.appendChild(h);
    box.appendChild(el('div', 'sub',
      `${t.maker}／${t.year}年／${st.cfg.catalogHardware || 'SEC'}／${t.genreLabel}`));
    const meta = el('div', 'detail-meta');
    const chip = (label, value, cls) => {
      const d = el('span', 'chip');
      d.appendChild(el('span', 'sub', label + ' '));
      d.appendChild(el('b', cls, value));
      meta.appendChild(d);
    };
    chip('希少度', t.tierLabel, tierCls(t.tier));
    chip('基準相場', yen(t.base));
    chip('買取目安', yen(t.buy));
    if (t.rating != null) chip('評価', t.rating.toFixed(1));
    chip('所持', E.countOf(st, t.id) + '本', E.countOf(st, t.id) ? 'ok' : 'sub');
    box.appendChild(meta);
    box.appendChild(el('p', 'detail-body', t.desc));
    if (!t.authored) {
      box.appendChild(el('div', 'sub', '※ このソフトはまだ仮データです（タイトルと説明文は自動生成）'));
    }
    if (t.related && t.related.length) {
      const names = t.related.map(id => st.byId.get(id))
        .filter(x => st.registered.has(x.id)).map(x => x.name);
      if (names.length) {
        box.appendChild(el('div', 'sub', '同じメーカー: ' + names.slice(0, 6).join('、')
          + (names.length > 6 ? ` ほか${names.length - 6}本` : '')));
      }
    }
  }

  // ---------------- 常連 ----------------
  function renderRegulars() {
    const tb = $('regulars');
    if (!tb) return;
    tb.innerHTML = '';
    const head = tb.insertRow();
    ['常連', '素性', '呼び方', '来店', '次のイベントまで', '記憶（押すと切替）'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i === 3) th.className = 'num';
      head.appendChild(th);
    });
    const teaches = {};
    for (const id in st.cfg.skills) teaches[st.cfg.skills[id].from] = id;
    for (const r of E.REGULARS) {
      const s = st.regulars[r.id] || { visits: 0, fired: 0 };
      const row = tb.insertRow();
      const nameCell = row.insertCell();
      nameCell.textContent = r.name;
      const sk = teaches[r.name];
      if (sk) {
        nameCell.appendChild(el('span', st.skills[sk] ? 'ok' : 'sub',
          st.skills[sk] ? `　${st.cfg.skills[sk].name}◯` : `　${st.cfg.skills[sk].name}`));
      }
      const tc = row.insertCell();
      tc.textContent = s.visits > 0 ? r.title : '——';
      tc.className = s.visits > 0 ? '' : 'sub';
      // 店主をどう呼ぶか。対等に見ている相手は「あんた」、店として見ている相手は「店長」
      const cc = row.insertCell();
      cc.textContent = s.visits > 0 ? (r.calls || '——') : '——';
      cc.className = s.visits > 0 ? 'sub' : 'sub';
      const vc = row.insertCell();
      vc.textContent = s.visits + '回';
      vc.className = 'num';
      const next = E.THRESHOLDS[s.fired];
      const nc = row.insertCell();
      if (next === undefined) { nc.textContent = 'すべて見た'; nc.className = 'ok'; }
      else if (s.visits === 0) { nc.textContent = 'まだ来ていない'; nc.className = 'sub'; }
      else { nc.textContent = `あと${Math.max(0, next - s.visits)}回（${s.fired}/${E.THRESHOLDS.length}）`; }
      // 最後まで見届けた相手とは、次の周でも会いやすい。
      // 引き直しは1回きりなので、絞るほどその相手が濃くなる
      const mc = row.insertCell();
      if (st.memories && st.memories[r.id]) {
        const on = !st.memoryOff[r.id];
        mc.appendChild(btn(on ? '◯ 会いやすい' : '— 切っている',
          () => { E.setMemory(st, r.id, !on); render(); }, false));
        mc.className = on ? 'ok' : 'sub';
      } else { mc.textContent = '——'; mc.className = 'sub'; }
    }
  }

  /** 判断の要らない客をまとめて消化する。何が起きたかは skipped に控える */
  function runSkips() {
    if (!skipTalk || !st || st.ended) return;
    const from = st.log.length;
    let guard = 0;
    while (st.phase === 'shop' && st.current && E.skippable(st.current) && guard++ < 50) {
      E.answer(st, st.current.type === 'event');   // ボタンと同じ引数を渡す
    }
    if (st.log.length > from) skipped = st.log.slice(from);
  }

  function render() {
    runSkips();
    renderStat(); renderPhase(); renderInv(); renderDex(); renderLog(); renderDetail(); renderRegulars();
  }
  window.renderUI = render;   // デバッグ用

  // ---------------- 操作 ----------------
  let lastRun = null;   // 前周の記録（図鑑の引き継ぎ用）

  function newGame(previous) {
    const sel = $('weeks');
    st = E.createGame({
      seed: Number($('seed').value) || 1,
      balance: { totalWeeks: sel ? Number(sel.value) : 50 },
      previous: previous || undefined,
    });
    selected.clear();
    readReveals = new Set();
    window.st = st;
    render();
  }

  const skipBox = $('skipTalk');
  if (skipBox) {
    skipBox.checked = skipTalk;
    skipBox.onchange = () => {
      skipTalk = skipBox.checked;
      try { localStorage.setItem(SKIP_KEY, skipTalk ? '1' : '0'); } catch (e) { /* 保存できなくても動く */ }
      render();
    };
  }

  $('btnNew').onclick = () => { lastRun = null; newGame(); };
  $('btnCarry').onclick = () => {
    if (!st.ended) { alert('50週を終えてから引き継げます'); return; }
    lastRun = E.carryFrom(st);
    $('seed').value = (Number($('seed').value) || 1) + 1;   // 次の周は別の展開に
    newGame(lastRun);
  };
  $('btnTurn').onclick = () => { if (!st.ended) P.playTurn(st); render(); };
  $('btnWeek').onclick = () => { const w = st.week; while (!st.ended && st.week === w) P.playTurn(st); render(); };
  $('btnAll').onclick = () => { P.playAll(st); render(); };
  $('dexMissing').onchange = renderDex;
  if ($('weeks')) $('weeks').onchange = () => { lastRun = null; newGame(); };
  $('btnWholesale').onclick = () => {
    if (!selected.size) { alert('在庫表で卸す在庫を選んでください'); return; }
    E.wholesale(st, Array.from(selected));
    selected.clear();
    render();
  };
  $('btnSim').onclick = () => {
    $('simPanel').style.display = '';
    $('simOut').textContent = '実行中…';
    setTimeout(() => { $('simOut').textContent = runSim(100); }, 20);
  };

  // ブラウザ内での簡易シミュレーション（node src/sim.js と同じ指標）
  function runSim(n) {
    const games = [];
    for (let i = 0; i < n; i++) {
      const g = E.createGame({ seed: 1000 + i });
      P.playAll(g);
      games.push(g);
    }
    const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
    const L = [`${n}回の平均的な推移`, '週    生存   残高(中央値)     登録  所持'];
    for (const w of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
      const s = games.map(g => g.history.weeks[w - 1]).filter(Boolean);
      if (!s.length) { L.push(`${String(w).padStart(2)}週   0回`); continue; }
      L.push(`${String(w).padStart(2)}週  ${String(s.length).padStart(3)}回  ${yen(med(s.map(x => x.cash))).padStart(13)}  `
        + `${String(med(s.map(x => x.registered))).padStart(4)}  ${String(med(s.map(x => x.owned))).padStart(4)}`);
    }
    const endings = {};
    for (const g of games) endings[g.ending] = (endings[g.ending] || 0) + 1;
    const fin = games.map(g => g.result || E.stats(g));
    L.push('');
    L.push('エンド分布: ' + Object.entries(endings).map(([k, v]) =>
      `${{ true: '真', normal: 'ノーマル', incomplete: '未達', bad: 'バッド' }[k] || k} ${v}回`).join(' / '));
    L.push(`最終所持: 中央値 ${med(fin.map(f => f.owned))}本 / 最高 ${Math.max(...fin.map(f => f.owned))}本`);
    return L.join('\n');
  }

  newGame();
})();

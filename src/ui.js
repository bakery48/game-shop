'use strict';
/* ブラウザ用の最小UI。仕様書 10 節のとおり「表とボタンのみ」 */
(function () {
  const E = window.Engine, P = window.Policy;
  let st = null;
  const selected = new Set();

  const $ = id => document.getElementById(id);
  const yen = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const tierCls = t => 'tier-' + t;

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
    add('週', `${s.week} / ${st.cfg.totalWeeks}`);
    add('ターン', E.HALF_LABEL[s.half]);
    add('資金', yen(s.cash), s.cash < st.cfg.rent ? 'warn' : null);
    add('家賃', yen(st.cfg.rent) + (rentSoon ? '（今ターン終了時）' : ''), rentSoon ? 'warn' : null);
    add('在庫', `${s.inventory} / ${s.slots}` + (s.junk ? `（ガラクタ${s.junk}）` : ''));
    add('陳列', `${s.displayed} / ${s.displaySlots}`);
    add('図鑑 登録', `${s.registered} / ${s.total}（${Math.round(s.registeredRate * 100)}%）`);
    add('所持', `${s.owned} / ${s.total}（${Math.round(s.ownedRate * 100)}%）`,
      s.ownedRate >= 1 ? 'ok' : null);
  }

  // ---------------- 店内（フェイズ） ----------------
  function renderPhase() {
    const box = $('phase');
    box.innerHTML = '';

    if (st.ended) {
      const name = { true: '真エンド（全150本を同時所持）', normal: 'ノーマルエンド（図鑑は完成、所持は未達）',
                     bad: 'バッドエンド（家賃を払えず閉店）', incomplete: '未達成' }[st.ending];
      const c = el('div', 'card');
      c.appendChild(el('div', 'who', 'ゲーム終了 — ' + name));
      const s = st.result || E.stats(st);
      c.appendChild(el('div', null,
        `${s.week - 1}週まで営業 / 登録 ${s.registered}本 / 所持 ${s.owned}本 / 残高 ${yen(s.cash)}`));
      box.appendChild(c);
      return;
    }

    if (st.phase === 'shop' && st.current) {
      const c = st.current;
      const card = el('div', 'card');
      if (c.type === 'buyer') {
        const t = st.byId.get(c.titleId);
        card.appendChild(el('div', 'who', '買いに来た客'));
        const p = el('div');
        p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
        p.appendChild(el('span', null, ` を ${yen(c.offer)} で売ってほしい`));
        card.appendChild(p);
        card.appendChild(el('div', 'sub',
          `${t.hardware} / ${t.year}年 / ${t.maker} / ${t.tierLabel}｜基準相場 ${yen(t.base)}｜所持 ${E.countOf(st, t.id)}本`));
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
        card.appendChild(el('div', 'who', '売りに来た客'));
        const p = el('div');
        p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
        p.appendChild(el('span', null, ` を ${yen(c.ask)} で買い取ってほしい`));
        card.appendChild(p);
        card.appendChild(el('div', 'sub',
          `${t.hardware} / ${t.year}年 / ${t.maker} / ${t.tierLabel}｜基準相場 ${yen(t.base)}｜買取目安 ${yen(t.buy)}｜`
          + (owned ? '所持済み' : '未所持')));
        const row = el('div', 'row');
        const canBuy = st.cash >= c.ask && E.freeSlots(st) > 0;
        row.appendChild(btn('買う', () => { E.answer(st, true); render(); }, true, !canBuy));
        row.appendChild(btn('買わない', () => { E.answer(st, false); render(); }));
        if (!canBuy) row.appendChild(el('span', 'warn', st.cash < c.ask ? '資金不足' : '棚枠が満杯'));
        card.appendChild(row);
      } else {
        card.appendChild(el('div', 'who', '冷やかし'));
        card.appendChild(el('div', null, c.line));
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

    mk('オークション（まとめ買い）',
      `${o.bulk.lot.count}点セット — ${yen(o.bulk.cost)}`,
      '入札する', () => { E.doAction(st, 'bulk', {}); render(); },
      st.cash < o.bulk.cost,
      o.bulk.hint + '｜棚に入りきらない分はその場で業者に流れます');

    if (o.single) {
      const t = st.byId.get(o.single.titleId);
      const owned = E.ownedIds(st).has(t.id);
      const card = el('div', 'card');
      card.appendChild(el('div', 'who', 'オークション（単品入札）'));
      const p = el('div');
      p.appendChild(el('span', tierCls(t.tier), `「${t.name}」`));
      p.appendChild(el('span', null, ` — 現在価格 ${yen(o.single.current)}`));
      card.appendChild(p);
      card.appendChild(el('div', 'sub',
        `${t.hardware} / ${t.year}年 / ${t.maker} / ${t.tierLabel}｜基準相場 ${yen(t.base)}｜`
        + (owned ? '所持済み' : '未所持')));
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

    mk('処分品引取',
      `雑多な箱 ${o.junk.lot.count}点 — ${o.junk.cost ? yen(o.junk.cost) : '無料'}`,
      '引き取る', () => { E.doAction(st, 'junk', {}); render(); },
      st.cash < o.junk.cost,
      'ほとんどガラクタですが並品が数本混じります');

    mk('店舗・保管庫の整理',
      selected.size ? `選択中の${selected.size}点を業者に卸します` : '在庫表で選んだ在庫を業者に卸します',
      '整理する', () => {
        E.doAction(st, 'organize', { wholesale: Array.from(selected) });
        selected.clear();
        render();
      }, false, `卸値は基準相場の${Math.round(st.cfg.wholesaleRatio * 100)}%です`);

    const ex = st.cfg.expand;
    mk('棚を拡張する',
      `${st.cfg.shelfSlots} → ${Math.min(ex.max, st.cfg.shelfSlots + ex.step)}枠 — ${yen(ex.cost)}`,
      '拡張する', () => { E.doAction(st, 'expand', {}); render(); },
      st.cash < ex.cost || st.cfg.shelfSlots >= ex.max,
      st.cfg.shelfSlots >= ex.max ? 'これ以上は拡張できません' : `最大${ex.max}枠まで`);

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
    ['', 'タイトル', 'ハード', '希少', '売値', '陳列', '非売品', '値下'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i === 4) th.className = 'num';
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
        const pc = r.insertCell(); pc.textContent = yen(st.cfg.junkValue); pc.className = 'num';
        r.insertCell(); r.insertCell(); r.insertCell();
        continue;
      }
      const nc = r.insertCell();
      nc.textContent = t.name + (E.countOf(st, t.id) > 1 ? ` ×${E.countOf(st, t.id)}` : '');
      nc.className = tierCls(t.tier);
      nc.title = t.desc;
      r.insertCell().textContent = t.hardware;
      r.insertCell().textContent = t.tierLabel;
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
    ['状態', 'タイトル', 'ハード', '年', 'メーカー', '希少', '相場'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i === 6) th.className = 'num';
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
      nc.textContent = reg ? t.name : '？？？';
      nc.className = reg ? tierCls(t.tier) : 'sub';
      if (reg) nc.title = t.desc;
      r.insertCell().textContent = reg ? t.hardware : '—';
      r.insertCell().textContent = reg ? t.year : '—';
      r.insertCell().textContent = reg ? t.maker : '—';
      r.insertCell().textContent = t.tierLabel;
      const pc = r.insertCell();
      pc.textContent = reg ? yen(t.base) : '—';
      pc.className = 'num';
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

  function render() {
    renderStat(); renderPhase(); renderInv(); renderDex(); renderLog();
  }

  // ---------------- 操作 ----------------
  function newGame() {
    st = E.createGame({ seed: Number($('seed').value) || 1 });
    selected.clear();
    window.st = st;
    render();
  }

  $('btnNew').onclick = newGame;
  $('btnTurn').onclick = () => { if (!st.ended) P.playTurn(st); render(); };
  $('btnWeek').onclick = () => { const w = st.week; while (!st.ended && st.week === w) P.playTurn(st); render(); };
  $('btnAll').onclick = () => { P.playAll(st); render(); };
  $('dexMissing').onchange = renderDex;
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

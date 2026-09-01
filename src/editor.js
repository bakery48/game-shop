'use strict';
/**
 * 台本机 — ゲーム中の文章を直して、data/*.json に書き戻すための道具。
 * 本体（engine/ui）とは独立していて、読むのは data だけ。
 *
 * ORIGINAL は build/gen-editor.js が埋め込む（file:// では fetch できないため）。
 * 直した内容はブラウザに下書きとして残り、「JSONをコピー」で書き戻す。
 */
(function () {
  const SRC = window.EditorData;                 // { software, regulars }
  const KEY = 'crossroad-script-desk';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const clone = o => JSON.parse(JSON.stringify(o));

  const ORIGINAL = Object.freeze({ software: clone(SRC.software), regulars: clone(SRC.regulars) });
  let work = clone(SRC);
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) work = JSON.parse(saved);
  } catch (e) { /* 下書きが読めなくても、元データで始められればいい */ }

  // ── パスで読み書きする（'titles.3.details' のような文字列で場所を指す） ──
  const dig = (root, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), root);
  function put(root, path, value) {
    const ks = path.split('.');
    const last = ks.pop();
    ks.reduce((o, k) => o[k], root)[last] = value;
  }
  const now = (file, path) => dig(work[file], path);
  const was = (file, path) => dig(ORIGINAL[file], path);
  const changed = (file, path) => now(file, path) !== was(file, path);

  // ── 何を編集できるか。ここが台本机の目次になる ─────────────────
  const SELF = ORIGINAL.software.lore.self;
  const UNCLE = ORIGINAL.software.lore.uncle;

  function regularEntries() {
    return ORIGINAL.regulars.regulars.map((r, i) => {
      const fields = [];
      fields.push({ file: 'regulars', path: `regulars.${i}.title`, name: '素性', short: true });
      fields.push({ file: 'regulars', path: `regulars.${i}.calls`, name: '店主の呼び方', short: true });
      (r.lines || []).forEach((_, j) => fields.push({
        file: 'regulars', path: `regulars.${i}.lines.${j}`, name: `セリフ ${j + 1}`,
      }));
      (r.events || []).forEach((e, j) => {
        fields.push({ file: 'regulars', path: `regulars.${i}.events.${j}.text`,
          name: `${ORIGINAL.regulars.visitThresholds[j]}回目（${e.type}）` });
        if (e.skillKnown) fields.push({ file: 'regulars', path: `regulars.${i}.events.${j}.skillKnown.text`,
          name: `${ORIGINAL.regulars.visitThresholds[j]}回目（習得済みのとき）` });
      });
      fields.push({ file: 'regulars', path: `regulars.${i}.ageNote`, name: '設定メモ（ゲームには出ない）' });
      return { id: 'r' + i, group: 'regulars', label: r.name, meta: `${(r.lines || []).length}本`, fields, regular: i };
    });
  }

  function titleEntries() {
    return ORIGINAL.software.titles.map((t, i) => ({
      id: 't' + i, group: 'titles', label: t.title, meta: t.tier,
      titleIndex: i,
      fields: [
        { file: 'software', path: `titles.${i}.title`, name: 'タイトル', short: true },
        { file: 'software', path: `titles.${i}.maker`, name: 'メーカー', short: true },
        { file: 'software', path: `titles.${i}.genre`, name: 'ジャンル', short: true },
        { file: 'software', path: `titles.${i}.details`, name: '図鑑の説明' },
      ],
    }));
  }

  function loreEntries() {
    const rev = ORIGINAL.software.lore.reveals;
    const fields = [];
    for (const k of Object.keys(rev)) {
      fields.push({ file: 'software', path: `lore.reveals.${k}.title`, name: `${k}：見出し`, short: true });
      fields.push({ file: 'software', path: `lore.reveals.${k}.text`, name: `${k}：本文` });
    }
    fields.push({ file: 'software', path: 'lore.uncle.note', name: '叔父の設定メモ' });
    fields.push({ file: 'software', path: 'lore.self.note', name: '主人公の設定メモ' });
    return [{ id: 'lore', group: 'lore', label: '種明かしと設定', meta: `${Object.keys(rev).length}段`, fields }];
  }

  const GROUPS = [
    { id: 'regulars', label: '常連', build: regularEntries },
    { id: 'titles', label: 'ソフト', build: titleEntries },
    { id: 'lore', label: '物語', build: loreEntries },
    { id: 'out', label: '書き出し', build: () => [] },
  ];
  const ENTRIES = {};
  for (const g of GROUPS) ENTRIES[g.id] = g.build();

  let tab = 'regulars';
  let sel = { regulars: 'r0', titles: 't0', lore: 'lore' };
  let query = '';
  let onlyEdited = false;

  // ── 検査。test/check.js が見ているのと同じ約束をその場で確かめる ──────
  const BANNED_CALL = /おじいちゃん|おじいさん|お兄さん|お若い|若く見え/;
  const strip = s => String(s).replace(/「[^」]*」/g, '');   // 「」の中は他人の発言

  function checkRegular(i) {
    const r = work.regulars.regulars[i];
    const orig = ORIGINAL.regulars.regulars[i];
    const out = [];
    const spoken = (r.lines || []).concat((r.events || []).map(e => e.text || ''))
      .concat((r.events || []).filter(e => e.skillKnown).map(e => e.skillKnown.text || ''));

    for (const nm of [UNCLE.surname, SELF.surname, SELF.name]) {
      const hit = spoken.find(l => l.includes(nm));
      if (hit) out.push(['bad', `「${nm}」が会話に出ている`, hit]);
    }
    const bad = spoken.map(l => l.match(BANNED_CALL)).find(Boolean);
    if (bad) out.push(['bad', `年齢が漏れる呼びかけ「${bad[0]}」`, bad.input]);

    const calls = [...new Set(work.regulars.regulars.map(x => x.calls))];
    for (const f of calls) {
      if (f === r.calls || r.calls.includes(f) || f.includes(r.calls)) continue;
      const hit = (r.lines || []).find(l => strip(l).includes(f));
      if (hit) out.push(['bad', `${r.calls}派なのに「${f}」と呼んでいる`, hit]);
    }
    if (!(r.lines || []).some(l => l.includes(r.calls))) {
      out.push(['warn', `「${r.calls}」を一度も使っていない`, '']);
    }
    if ((r.lines || []).length < 12) {
      out.push(['warn', `セリフが${(r.lines || []).length}本（1周で12〜18回来るので12本は要る）`, '']);
    }
    const dup = new Set(), same = [];
    for (const l of (r.lines || [])) { if (dup.has(l)) same.push(l); dup.add(l); }
    if (same.length) out.push(['warn', `同じセリフが${same.length}件ある`, same[0]]);

    const hi = ORIGINAL.software.hardware.span[1];
    if (orig.born > hi) {
      const hit = spoken.map(l => strip(l).match(/当時|発売日に買|子供の頃/)).find(Boolean);
      if (hit) out.push(['bad', `${orig.born}年生まれが「${hit[0]}」と実体験を語っている`, hit.input]);
    }
    if (orig.id === 'ruri') {
      const hit = spoken.find(l => /先代|前の店主|叔父/.test(l));
      if (hit) out.push(['bad', '瑠璃は先代と面識が無い設定', hit]);
    }
    // 常連が指名するソフトが実在するか（タイトルを直すと壊れる）
    const names = new Set(work.software.titles.map(t => t.title));
    for (const e of (r.events || [])) {
      if (e.title && !names.has(e.title)) out.push(['bad', `「${e.title}」というソフトが無い`, '']);
    }
    return out;
  }

  function checkTitle(i) {
    const t = work.software.titles[i];
    const out = [];
    const m = t.details.match(/わずか(\d+)本/);
    if (m && Number(m[1]) !== t.sales) {
      out.push(['bad', `本文の「わずか${m[1]}本」と出荷本数 ${t.sales.toLocaleString()} が違う`, '']);
    }
    if (/ミリオンセラー/.test(t.details) && t.sales < 1000000) {
      out.push(['bad', `ミリオンと書いてあるのに${t.sales.toLocaleString()}本`, '']);
    }
    const used = ORIGINAL.regulars.regulars.some(r => (r.events || []).some(e => e.title === ORIGINAL.software.titles[i].title));
    if (used && t.title !== ORIGINAL.software.titles[i].title) {
      out.push(['warn', '常連のイベントが指名しているタイトル。変えると参照が切れる', '']);
    }
    if (t.lore) {
      const who = t.lore === 'uncle' ? UNCLE : SELF;
      if (!t.details.includes(who.name) && t.lore === 'uncle') {
        out.push(['warn', `伏線の1本。${who.name}の名前が説明から消えている`, '']);
      }
    }
    return out;
  }

  // ── 描画 ────────────────────────────────────────────────
  function dirtyCount() {
    let n = 0;
    for (const g of GROUPS) for (const e of (ENTRIES[g.id] || [])) {
      for (const f of e.fields) if (changed(f.file, f.path)) n++;
    }
    return n;
  }
  const entryEdited = e => e.fields.some(f => changed(f.file, f.path));

  function renderTabs() {
    const box = $('tabs');
    box.innerHTML = '';
    for (const g of GROUPS) {
      const b = el('button', g.id === tab ? 'on' : null, g.label);
      b.onclick = () => { tab = g.id; render(); };
      box.appendChild(b);
    }
  }

  function visibleEntries() {
    const q = query.trim().toLowerCase();
    return (ENTRIES[tab] || []).filter(e => {
      if (onlyEdited && !entryEdited(e)) return false;
      if (!q) return true;
      if (e.label.toLowerCase().includes(q)) return true;
      return e.fields.some(f => String(now(f.file, f.path) || '').toLowerCase().includes(q));
    });
  }

  function renderIndex() {
    const box = $('index');
    box.innerHTML = '';
    if (tab === 'out') return;
    const list = visibleEntries();
    if (!list.length) { box.appendChild(el('div', 'note', '当てはまるものがありません')); return; }
    for (const e of list) {
      const cls = [e.id === sel[tab] ? 'on' : '', entryEdited(e) ? 'edited' : ''].filter(Boolean).join(' ');
      const b = el('button', cls || null);
      b.appendChild(el('span', null, e.label));
      b.appendChild(el('span', 'n', e.meta));
      b.onclick = () => { sel[tab] = e.id; render(); };
      box.appendChild(b);
    }
  }

  function fieldRow(f) {
    const row = el('div', 'f' + (changed(f.file, f.path) ? ' edited' : ''));
    const top = el('div', 'top');
    top.appendChild(el('span', 'name', f.name));
    const count = el('span', 'count');
    top.appendChild(count);
    row.appendChild(top);

    const ta = document.createElement('textarea');
    ta.value = now(f.file, f.path) == null ? '' : String(now(f.file, f.path));
    ta.rows = f.short ? 1 : 2;
    ta.spellcheck = false;

    // 「元に戻す」は最初から作っておいて、変わったときだけ見せる。
    // 打つたびに作り直すと、入力中のカーソルが飛ぶ
    const line = el('div', 'top');
    const w = el('div', 'was');
    const undo = el('button', 'ghost', '元に戻す');
    undo.onclick = () => {
      put(work[f.file], f.path, was(f.file, f.path));
      ta.value = was(f.file, f.path) == null ? '' : String(was(f.file, f.path));
      save(); sync();
      renderChecks(); renderHead(); renderIndex();
    };
    line.appendChild(w);
    line.appendChild(undo);

    const grow = () => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 4) + 'px'; };
    function sync() {
      count.textContent = ta.value.length + '字';
      const dirty = changed(f.file, f.path);
      row.classList.toggle('edited', dirty);
      line.hidden = !dirty;
      if (dirty) w.textContent = '元: ' + was(f.file, f.path);
      grow();
    }
    ta.addEventListener('input', () => {
      put(work[f.file], f.path, ta.value);
      save(); sync();
      renderChecks(); renderHead(); renderIndex();
    });
    row.appendChild(ta);
    row.appendChild(line);
    sync();
    setTimeout(grow, 0);
    return row;
  }

  function renderChecks() {
    const box = $('checks');
    if (!box) return;
    box.innerHTML = '';
    const e = (ENTRIES[tab] || []).find(x => x.id === sel[tab]);
    if (!e) return;
    let flags = [];
    if (e.regular != null) flags = checkRegular(e.regular);
    else if (e.titleIndex != null) flags = checkTitle(e.titleIndex);
    if (!flags.length) {
      const ok = el('div', 'flag ok');
      ok.appendChild(el('b', null, '通過'));
      ok.appendChild(el('span', null, '約束を破っているところはありません'));
      box.appendChild(ok);
      return;
    }
    for (const [level, msg, sample] of flags) {
      const d = el('div', 'flag ' + level);
      d.appendChild(el('b', null, level === 'bad' ? '違反' : '注意'));
      d.appendChild(el('span', null, msg + (sample ? `　— ${String(sample).slice(0, 34)}…` : '')));
      box.appendChild(d);
    }
  }

  function renderHead() {
    const n = dirtyCount();
    const d = $('dirty');
    d.textContent = n ? `${n}か所を変更中` : '変更なし';
    d.className = n ? 'gold' : 'sub';
    d.style.color = n ? 'var(--gold)' : 'var(--sub)';
    $('btnRevertAll').disabled = !n;
  }

  function renderOut() {
    const main = $('main');
    const g = el('div', 'group');
    const h = el('h2', null, '書き出し');
    h.appendChild(el('span', 'sub', 'コピーして data/ のファイルに貼り替えます'));
    g.appendChild(h);
    const rows = el('div', 'rows');
    for (const [file, path] of [['software', 'data/software.json'], ['regulars', 'data/regulars.json']]) {
      const f = el('div', 'f');
      const top = el('div', 'top');
      top.appendChild(el('span', 'name', path));
      const n = ['software', 'regulars'].includes(file)
        ? (ENTRIES.regulars.concat(ENTRIES.titles, ENTRIES.lore)
            .reduce((s, e) => s + e.fields.filter(x => x.file === file && changed(x.file, x.path)).length, 0)) : 0;
      top.appendChild(el('span', 'count', n ? `${n}か所を変更` : '変更なし'));
      f.appendChild(top);
      const json = JSON.stringify(work[file], null, 2) + '\n';
      const ta = document.createElement('textarea');
      ta.value = json; ta.readOnly = true; ta.spellcheck = false;
      const line = el('div', 'top');
      const copy = el('button', null, 'JSONをコピー');
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(json);
          copy.textContent = 'コピーしました';
        } catch (err) {
          ta.select();
          copy.textContent = '選択しました（⌘/Ctrl+C）';
        }
        setTimeout(() => { copy.textContent = 'JSONをコピー'; }, 1800);
      };
      line.appendChild(copy);
      line.appendChild(el('span', 'note', `${(json.length / 1024).toFixed(0)}KB`));
      f.appendChild(line);
      f.appendChild(ta);
      rows.appendChild(f);
    }
    g.appendChild(rows);
    main.appendChild(g);

    const note = el('div', 'group');
    const nh = el('h2', null, '書き戻したあと');
    note.appendChild(nh);
    const body = el('div', 'f');
    body.appendChild(el('div', 'note',
      'ファイルを貼り替えたら node build/gen-data.js && node build/build.js を実行してください。'
      + ' src/software-data.js が作り直され、dist/prototype.html に反映されます。'
      + ' そのあと node test/check.js が通ることを確認してください——'
      + 'この机で見ている約束は、あちらでも同じように検査されます。'));
    note.appendChild(body);
    main.appendChild(note);
  }

  function render() {
    renderTabs();
    renderIndex();
    renderHead();
    const main = $('main');
    main.innerHTML = '';
    if (tab === 'out') { renderOut(); return; }

    const e = (ENTRIES[tab] || []).find(x => x.id === sel[tab]) || visibleEntries()[0];
    if (!e) { main.appendChild(el('div', 'note', '当てはまるものがありません')); return; }
    sel[tab] = e.id;

    const box = el('div', 'group');
    const h = el('h2', null, e.label);
    h.appendChild(el('span', 'sub', e.meta));
    box.appendChild(h);
    const checks = el('div', 'f');
    const cb = el('div', null);
    cb.id = 'checks';
    checks.appendChild(cb);
    box.appendChild(checks);
    const rows = el('div', 'rows');
    for (const f of e.fields) rows.appendChild(fieldRow(f));
    box.appendChild(rows);
    main.appendChild(box);
    renderChecks();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(work)); } catch (err) { /* 保存できなくても編集は続く */ }
  }

  $('q').addEventListener('input', ev => { query = ev.target.value; renderIndex(); });
  $('onlyEdited').addEventListener('change', ev => { onlyEdited = ev.target.checked; renderIndex(); });
  $('btnRevertAll').addEventListener('click', () => {
    if (!confirm('この机での変更を全部捨てて、元の文章に戻します。よろしいですか？')) return;
    work = clone(ORIGINAL);
    save(); render();
  });

  render();
  window.ScriptDesk = { work, ORIGINAL, checkRegular, checkTitle, dirtyCount };
})();

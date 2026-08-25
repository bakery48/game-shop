#!/usr/bin/env node
'use strict';
/**
 * 回帰チェック。`node test/check.js` で全部走る。
 * 依存なし。ブラウザ側の確認は test/browser.js（playwright があるときだけ）。
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0, passed = 0;
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log('  ok   ' + name + (note ? '  — ' + note : ''));
  } catch (e) {
    failed++;
    console.log('  NG   ' + name + '\n         ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
/** シェバンを外してから構文を見る */
const syntaxOk = file => {
  const code = fs.readFileSync(path.join(root, file), 'utf8').replace(/^#![^\n]*\n/, '');
  new Function(code);
};
const section = t => console.log('\n' + t);

// ---------------- 1. 構文 ----------------
section('構文');
const srcFiles = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js'));
for (const f of srcFiles) {
  check(`src/${f}`, () => syntaxOk('src/' + f));   // 構文エラーならここで落ちる
}
for (const f of ['build/build.js', 'build/gen-data.js', 'test/check.js']) {
  check(f, () => syntaxOk(f));
}

// ---------------- 2. データ ----------------
section('データ');
const sw = JSON.parse(fs.readFileSync(path.join(root, 'data/software.json'), 'utf8'));
const rg = JSON.parse(fs.readFileSync(path.join(root, 'data/regulars.json'), 'utf8'));
const E = require(path.join(root, 'src/engine.js'));

check('software.json の希少度が有効', () => {
  const tiers = Object.keys(E.BALANCE.tiers);
  for (const t of sw.titles) assert(tiers.includes(t.tier), `${t.title} の tier=${t.tier}`);
  return `${sw.titles.length}本`;
});
check('software.json にタイトルの重複がない', () => {
  const n = new Set(sw.titles.map(t => t.title)).size;
  assert(n === sw.titles.length, `${sw.titles.length - n}件が重複`);
});
check('software.json の相場と発売年が妥当', () => {
  for (const t of sw.titles) {
    assert(t.base > 0, `${t.title} の base`);
    assert(t.year >= sw.hardware.span[0] && t.year <= sw.hardware.span[1],
      `${t.title} の year=${t.year} がハードの期間外`);
  }
});
check('発売年がハードの寿命の形になっている', () => {
  // 1990と1998が1本ずつ、という不自然な平地を防ぐ。生成分も含めた200本で見る
  const st = E.createGame({ seed: 1 });
  const by = {};
  for (const t of st.catalog) by[t.year] = (by[t.year] || 0) + 1;
  const [lo, hi] = sw.hardware.span;
  for (let y = lo; y <= hi; y++) {
    assert(by[y] >= 5, `${y}年が${by[y] || 0}本しかない`);
  }
  // 山型: 中盤が立ち上がりと末期より厚い
  const mid = (by[1994] || 0) + (by[1995] || 0) + (by[1996] || 0);
  const ends = (by[lo] || 0) + (by[lo + 1] || 0) + (by[hi - 1] || 0) + (by[hi] || 0);
  assert(mid > ends, `中盤${mid}本 ≦ 端${ends}本 で山になっていない`);
  return Array.from({ length: hi - lo + 1 }, (_, i) => by[lo + i]).join('/');
});
check('タイトルに入っている年と発売年が一致', () => {
  // 『全日本F1チャンピオンシップ'94』が1996年発売、のような事故を防ぐ
  let n = 0;
  for (const t of sw.titles) {
    const m = t.title.match(/'(9\d)(?!\d)|(?<![0-9'\d])(9[0-8])(?![0-9])/);
    if (!m) continue;
    n++;
    const yy = 1900 + Number(m[1] || m[2]);
    assert(t.year === yy, `「${t.title}」が${t.year}年発売になっている`);
  }
  return `${n}本`;
});
check('シリーズの前後関係が崩れていない', () => {
  const y = name => {
    const t = sw.titles.find(x => x.title === name);
    assert(t, `「${name}」が無い`);
    return t.year;
  };
  const series = [
    ['ドラゴン・レガシーIV 〜導かれし五つの意志〜', 'ドラゴン・レガシーV 〜天空の花嫁たち〜'],
    ['聖剣のラストガーディアン', '聖剣のラストガーディアンII 〜復讐の刃〜'],
    ['影狼伝説（かげろうでんせつ） 〜魔城の血風録〜', '影狼伝説II 〜魔界摩天楼の罠〜'],
    ['スーパードリフト・レーサーX', 'スーパードリフト・レーサーX 2'],
    ['エターナル・ルーン 〜失われた刻印〜', 'エターナル・ルーン外伝 〜青き海の航海詩〜'],
    ['激走！駿馬ドリームブリーダー', "激走！駿馬ドリームブリーダー'96"],
  ];
  for (const [a, b] of series) assert(y(a) < y(b), `${a} (${y(a)}) → ${b} (${y(b)})`);
  return `${series.length}シリーズ`;
});
check('叔父の年表が並び順どおり', () => {
  const years = sw.titles.filter(t => t.lore === 'uncle').map(t => t.year).sort((a, b) => a - b);
  assert(years.length >= 4, `${years.length}本`);
  assert(years[0] === 1990, `最初が${years[0]}年（ハード立ち上げの年であること）`);
  assert(new Set(years).size >= 4, '同じ年に固まっている');
  return years.join(' → ');
});
check('作中の年から見た年齢がつじつま合っている', () => {
  const L = sw.lore, now = L.present;
  assert(now > sw.hardware.span[1], `現在${now}年がハードの期間内`);
  assert(now - L.self.born === 68, `主人公が${now - L.self.born}歳（68歳のはず）`);
  assert(L.uncle.died <= now, `叔父の没年${L.uncle.died}が現在より後`);
  assert(L.self.born - L.uncle.born === 20, '叔父との年齢差が20歳でない');
  // 「ちょっと前に仕事を辞めてから」が通る範囲に退職年があること
  const ago = now - (L.self.born + L.self.retiredAt);
  assert(ago >= 1 && ago <= 5, `退職が${ago}年前では「ちょっと前」と言えない`);
  return `${now}年: 主人公${now - L.self.born}歳 / 退職は${ago}年前 / 叔父${L.uncle.died - L.uncle.born}歳で没`;
});
check('図鑑に書いた年齢が発売年と生年に合う', () => {
  // 発売年を動かしたときに「当時34歳」だけ取り残される事故を防ぐ
  const L = sw.lore;
  const who = name => (name === L.self.name ? L.self : name === L.uncle.name ? L.uncle : null);
  let n = 0;
  for (const t of sw.titles) {
    const re = /当時(\d+)歳の(\S{2,5}?)(?=が|は|、)/g;
    let m;
    while ((m = re.exec(t.details))) {
      const p = who(m[2]);
      assert(p, `「${t.title}」の「${m[2]}」が誰か分からない`);
      n++;
      assert(t.year - p.born === Number(m[1]),
        `「${t.title}」(${t.year}年) の「当時${m[1]}歳」は ${t.year - p.born}歳のはず`);
    }
  }
  assert(n >= 2, `年齢の記述が${n}件しかない`);
  return `${n}件`;
});
check('叔父の4本がすべてエスニック絡み', () => {
  // 版元の社員という設定なので、関わった作品は全部エスニックが売っている
  for (const t of sw.titles.filter(x => x.lore === 'uncle')) {
    assert(t.maker.includes('エスニック'), `「${t.title}」の版元が${t.maker}`);
    assert(!/外部から呼ばれた|外部から入って/.test(t.details),
      `「${t.title}」に外部の人間としての記述が残っている`);
  }
  // 主人公は逆に、下請けを渡り歩く外注であること
  const selfMakers = new Set(sw.titles.filter(x => x.lore === 'self').map(x => x.maker));
  assert(selfMakers.size >= 3, `主人公の関わり先が${selfMakers.size}社しかない`);
  for (const m of selfMakers) assert(!m.includes('エスニック'), `主人公が${m}に関わっている`);
  return `叔父=エスニック4本 / 主人公=${selfMakers.size}社を渡り歩き`;
});
check('regulars.json のイベント数がしきい値と一致', () => {
  const n = rg.visitThresholds.length;
  for (const r of rg.regulars) assert(r.events.length === n, `${r.name} は${r.events.length}件`);
  return `${rg.regulars.length}人 × ${n}件`;
});
check('regulars.json が参照するタイトルが実在する', () => {
  const titles = new Set(sw.titles.map(t => t.title));
  for (const r of rg.regulars) for (const e of r.events) {
    if (e.title) assert(titles.has(e.title), `${r.name}: 「${e.title}」が無い`);
  }
});
check('常連の年齢がつじつま合っている', () => {
  const now = sw.lore.present, [lo, hi] = sw.hardware.span;
  const age = r => now - r.born;
  const by = {};
  for (const r of rg.regulars) {
    assert(r.born, `${r.name} に born が無い`);
    assert(r.ageNote, `${r.name} に ageNote が無い`);
    by[r.id] = r;
  }
  // 素性から外れていないか
  const yuta = age(by.yuta);
  assert(yuta >= 6 && yuta <= 12, `ゆうたが${yuta}歳では小学生でない`);
  assert(by.kurosawa.born + 22 <= 1996, '黒沢が1996年に社会人として若すぎる');
  assert(by.hayami.born + 22 <= hi, '速水がスーエレ期にライターとして若すぎる');
  const uAtEnd = hi - by.urushibara.born;
  assert(uAtEnd >= 6 && uAtEnd <= 18, `漆原がスーエレ末期に${uAtEnd}歳では「小学生の俺」に合わない`);
  assert(age(by.satoe) - 25 >= 40, 'サトエさんに独立した息子と孫がいるには若すぎる');
  assert(age(by.satoe) - age(by.ruri) >= 40, '瑠璃がサトエさんの孫にしては歳が近すぎる');
  assert(by.ruri.born > hi, '瑠璃がスーエレ期を知っている世代になっている');
  return rg.regulars.map(r => `${r.name}${age(r)}`).join(' ');
});
check('イベントを完走すると記憶が残り、周回で持ち越される', () => {
  const st = E.createGame({ seed: 41 });
  assert(Object.keys(st.memories).length === 0, '最初から記憶がある');
  const r = E.REGULARS[0];
  const s = st.regulars[r.id] = { visits: 99, fired: E.THRESHOLDS.length - 1 };
  st.reputation = 100;
  // 最後の1件を出させる
  let got = null;
  for (let i = 0; i < 200 && !got; i++) {
    st.regulars[r.id] = { visits: 99, fired: E.THRESHOLDS.length - 1 };
    const c = E.makeRegularCustomer(st, null, [r]);
    if (c && c.type === 'event') got = c;
  }
  assert(got, '最終イベントが出ない');
  assert(st.memories[r.id], `${r.name}の記憶が残っていない`);
  // 引き継ぐ
  const next = E.createGame({ seed: 42, previous: E.carryFrom(st) });
  assert(next.memories[r.id], '次の周に持ち越されていない');
  assert(Object.keys(next.memories).length === 1, '持ち越しすぎている');
  return `${r.name}との記憶`;
});
check('記憶のある常連は外れたときに引き直される', () => {
  // 「誰も来ない」が出たときだけ、記憶持ちだけでもう一度引く
  const count = memories => {
    const st = E.createGame({ seed: 43 });
    for (const id of memories) st.memories[id] = true;
    st.reputation = 0;              // 当たりにくい側で差を見る
    let n = 0, turns = 0;
    for (let i = 0; i < 600 && !st.ended; i++) {
      if (st.phase === 'shop') {
        const q = [st.current].concat(st.queue).filter(Boolean);
        if (q.some(c => c.regular)) n++;
        turns++;
        while (st.phase === 'shop' && st.current) E.answer(st, false);
      }
      if (st.phase === 'action') E.doAction(st, 'rest', {});
      st.reputation = 0; st.cash = 10000000;
    }
    return n / Math.max(1, turns);
  };
  const none = count([]);
  const all = count(E.REGULARS.map(r => r.id));
  const c = E.BALANCE.regulars.visitChance[0];
  assert(all > none * 1.3, `記憶なし${none.toFixed(2)} / 記憶あり${all.toFixed(2)} で差が出ていない`);
  // 2回引くので 1-(1-c)^2 に近づくはず
  const want = 1 - (1 - c) * (1 - c);
  assert(Math.abs(all - want) < 0.12, `記憶ありの来店率 ${all.toFixed(2)}（理論値${want.toFixed(2)}）`);
  return `${none.toFixed(2)} → ${all.toFixed(2)}（理論値${want.toFixed(2)}）`;
});
check('記憶は一人ずつ切り替えられ、絞るほど濃くなる', () => {
  // 引き直しは記憶が何個あっても1回きり。だから対象を絞ると一人あたりが濃くなる
  const ids = E.REGULARS.map(r => r.id);
  const rate = onIds => {
    const st = E.createGame({ seed: 51 });
    for (const id of ids) st.memories[id] = true;
    for (const id of ids) if (!onIds.includes(id)) E.setMemory(st, id, false);
    let hit = 0, any = 0, turns = 0;
    for (let i = 0; i < 1500 && !st.ended; i++) {
      if (st.phase === 'shop') {
        const q = [st.current].concat(st.queue).filter(Boolean);
        if (q.some(c => c.regular && c.regular.id === ids[0])) hit++;
        if (q.some(c => c.regular)) any++;
        turns++;
        while (st.phase === 'shop' && st.current) E.answer(st, false);
      }
      if (st.phase === 'action') E.doAction(st, 'rest', {});
      st.reputation = 0; st.cash = 10000000;
      for (const id of ids) st.regulars[id] = { visits: 0, fired: 0 };
    }
    return { one: hit / Math.max(1, turns), any: any / Math.max(1, turns) };
  };
  const off = rate([]), one = rate([ids[0]]), all = rate(ids);
  // 絞ると、その相手に会える率が上がる
  assert(one.one > all.one * 1.5,
    `絞っても濃くならない（1人${one.one.toFixed(2)} / 全員${all.one.toFixed(2)}）`);
  // 記憶を入れると、常連に会えるターン自体が増える（誰か1人でも入れれば同じだけ増える）
  assert(all.any > off.any * 1.2,
    `記憶を入れても常連が増えない（切${off.any.toFixed(2)} / 全員${all.any.toFixed(2)}）`);
  assert(Math.abs(all.any - one.any) < 0.12,
    `入れる人数で常連の総数が変わっている（1人${one.any.toFixed(2)} / 全員${all.any.toFixed(2)}）`);
  // 持っていない相手は切り替えられない
  const st2 = E.createGame({ seed: 52 });
  assert(E.setMemory(st2, ids[0], false) === false, '未取得の記憶を操作できる');
  return `${E.REGULARS[0].name}に会えるターン: 切${(off.one * 100).toFixed(0)}%`
    + ` → 全員${(all.one * 100).toFixed(0)}% → 1人だけ${(one.one * 100).toFixed(0)}%`;
});
check('記憶の切り方も周回で持ち越される', () => {
  const st = E.createGame({ seed: 53 });
  const ids = E.REGULARS.map(r => r.id);
  st.memories[ids[0]] = true; st.memories[ids[1]] = true;
  E.setMemory(st, ids[1], false);
  const next = E.createGame({ seed: 54, previous: E.carryFrom(st) });
  assert(next.memories[ids[0]] && next.memories[ids[1]], '記憶が持ち越されていない');
  assert(!next.memoryOff[ids[0]], '入れていた記憶が切れている');
  assert(next.memoryOff[ids[1]], '切っていた記憶が入っている');
  assert(E.activeMemories(next).length === 1, `効いている記憶が${E.activeMemories(next).length}件`);
  return `${E.REGULARS[0].name}だけを入れた状態で次の周へ`;
});
check('常連は1ターンに最大1人で、一般客とは別枠', () => {
  // 常連が来た日に普通の客が減ると、常連に会えること自体が損になる。
  // 例外は漆原だけ（冷やかし専門なので枠を食うのが役割）
  const st = E.createGame({ seed: 31 });
  st.reputation = 100;              // 常連が必ず来る側に寄せる
  let turns = 0, many = 0, withReg = [], without = [];
  for (let i = 0; i < 400 && !st.ended; i++) {
    if (st.phase === 'shop') {
      const q = [st.current].concat(st.queue).filter(Boolean);
      const regs = q.filter(c => c.regular);
      if (regs.length > 1) many++;
      const uru = regs.some(c => c.regular.id === 'urushibara');
      if (!uru) (regs.length ? withReg : without).push(q.length);
      turns++;
      while (st.phase === 'shop' && st.current) E.answer(st, false);
    }
    if (st.phase === 'action') E.doAction(st, 'rest', {});
    st.reputation = 100;            // 断り続けても常連が来る側に保つ
    st.cash = 10000000;             // 家賃で潰れずに観測だけ続ける
  }
  assert(turns > 30, `${turns}ターンしか見ていない`);
  assert(many === 0, `1ターンに常連が2人以上来た日が${many}回`);
  const avg = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  assert(withReg.length && without.length, '比較する日が足りない');
  // 常連が来た日は、来なかった日より客がちょうど1人多いはず
  const d = avg(withReg) - avg(without);
  assert(d > 0.7 && d < 1.3, `常連が来た日の客数の差が ${d.toFixed(2)}人（1人のはず）`);
  return `常連の日 ${avg(withReg).toFixed(2)}人 / 来ない日 ${avg(without).toFixed(2)}人`;
});
check('漆原だけは来店枠を食う', () => {
  const st = E.createGame({ seed: 32 });
  const uru = E.REGULARS.find(r => r.id === 'urushibara');
  assert(uru && uru.alwaysBrowser, '漆原の alwaysBrowser が外れている');
  const others = E.REGULARS.filter(r => r.alwaysBrowser && r.id !== 'urushibara');
  assert(!others.length, `冷やかし専門が他にもいる: ${others.map(r => r.name).join('・')}`);
  return '冷やかし専門は漆原だけ';
});
check('瑠璃だけが先代を知らない', () => {
  // 他の常連は全員「先代の店」として見ている。彼女だけが店主だけを見ている
  const r = rg.regulars.find(x => x.id === 'ruri');
  assert(r, '瑠璃がいない');
  const all = (r.lines || []).concat(r.events.map(e => e.text));
  for (const line of all) {
    assert(!/先代|前の店主|叔父/.test(line), `瑠璃が先代を知っている口ぶり: ${line.slice(0, 24)}`);
  }
  // 逆に、先代を知っている常連が他にいること
  const knows = rg.regulars.filter(x => x.id !== 'ruri'
    && (x.lines || []).concat(x.events.map(e => e.text)).some(l => /先代/.test(l)));
  assert(knows.length >= 2, `先代に触れる常連が${knows.length}人しかいない`);
  return `瑠璃は面識なし / 先代を知るのは${knows.map(x => x.name).join('・')}`;
});
check('常連の守備範囲が混ざっていない', () => {
  // 蜷川=モノの価値 / 大町=商売 / 漆原=知識（開発秘話）。
  // 誰でも言えそうな話題ほど、持ち主を決めておかないと薄まる
  const owns = [
    { id: 'urushibara', ng: /値付け|値段|相場|いくらで売/, why: '値段の話は蜷川と大町の持ち札' },
    { id: 'yuta', ng: /現存数|開発陣|仮タイトル/, why: 'うんちくは漆原の持ち札' },
  ];
  for (const o of owns) {
    const r = rg.regulars.find(x => x.id === o.id);
    assert(r, `${o.id} がいない`);
    for (const l of (r.lines || [])) {
      const said = l.replace(/「[^」]*」/g, '');
      const hit = said.match(o.ng);
      assert(!hit, hit && `${r.name}が「${hit[0]}」— ${o.why}`);
    }
  }
  return owns.map(o => o.id).join('・');
});
check('スーエレを知らない世代が実体験を語っていない', () => {
  // ゆうた（2016年生）が「当時」を語るような事故を防ぐ。
  // 「」の中は他人の発言なので外す
  const [lo, hi] = sw.hardware.span;
  const rules = [
    // ハードが終わったあとに生まれた人は、そもそも何も語れない
    { when: r => r.born > hi, marker: /当時|発売日に買|子供の頃/, why: '実体験を語っている' },
    // 発売日に並ぶには、ハード発売時に6歳は要る
    { when: r => r.born > lo - 6, marker: /発売日に買/, why: '発売日に買えた年齢でない' },
  ];
  let n = 0;
  for (const r of rg.regulars) {
    const all = (r.lines || []).concat(r.events.map(e => e.text));
    for (const rule of rules) {
      if (!rule.when(r)) continue;
      n++;
      for (const line of all) {
        const said = line.replace(/「[^」]*」/g, '');   // 「」の中は他人の発言
        const hit = said.match(rule.marker);
        assert(!hit, hit && `${r.name}（${r.born}年生）が「${hit[0]}」— ${rule.why}`);
      }
    }
  }
  assert(n > 0, '世代外の常連がいない');
  return `${n}件の判定`;
});
check('常連の年齢をUIに出していない', () => {
  // 年齢が並ぶと、そこから主人公の年齢が透ける。主人公の名前と同じ扱いにする
  for (const f of ['src/ui.js', 'build/template.html', 'index.html']) {
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!/\bborn\b|ageNote/.test(body), `${f} が常連の生年を参照している`);
  }
});
check('常連の呼び方が主人公の年齢を漏らさない', () => {
  // 名前でも年齢でも呼ばせない。
  // 「おじさん」は禁止しない——子供にとっては25〜70歳が全部「おじさん」で、
  // むしろ「おじいさんではない」と錯覚させる方向に効く。
  // 「おじいちゃん」「お兄さん」は歳を絞ってしまうので禁止。
  const banned = /おじいちゃん|おじいさん|お兄さん|お若い|若く見え/;
  const self = sw.lore.self.name;
  for (const r of rg.regulars) {
    assert(r.calls, `${r.name} に calls が無い`);
    const all = (r.lines || []).concat(r.events.map(e => e.text))
      .concat(r.events.filter(e => e.skillKnown).map(e => e.skillKnown.text));
    for (const line of all) {
      const hit = line.match(banned);
      assert(!hit, hit && `${r.name}: 年齢が漏れる呼びかけ「${hit[0]}」`);
      assert(!line.includes(self), `${r.name}: 主人公を名前で呼んでいる`);
    }
  }
  const calls = {};
  for (const r of rg.regulars) calls[r.calls] = (calls[r.calls] || 0) + 1;
  return Object.entries(calls).map(([k, v]) => `${k}${v}人`).join(' / ');
});
check('常連が自分の呼び方だけを使っている', () => {
  const forms = [...new Set(rg.regulars.map(r => r.calls))];
  for (const r of rg.regulars) {
    const lines = r.lines || [];
    assert(lines.some(l => l.includes(r.calls)),
      `${r.name} は calls=${r.calls} なのに一度も使っていない`);
    // 他人の呼び方が混ざっていないか。
    // 「」の中は他人の発言（漆原の母親など）なので外してから見る。
    // 「店長」と「店長さん」のような包含関係も除く
    for (const f of forms) {
      if (f === r.calls || r.calls.includes(f) || f.includes(r.calls)) continue;
      for (const l of lines) {
        const said = l.replace(/「[^」]*」/g, '');
        assert(!said.includes(f), `${r.name}（${r.calls}派）が「${f}」と呼んでいる`);
      }
    }
  }
  const by = {};
  for (const r of rg.regulars) (by[r.calls] = by[r.calls] || []).push(r.name);
  return Object.entries(by).map(([k, v]) => `${k}:${v.join('・')}`).join(' / ');
});
check('常連のセリフが来店回数に対して足りている', () => {
  // 1周で12〜18回来店するので、同じ言い回しの繰り返しがどれだけ残っているかを見る
  const counts = rg.regulars.map(r => (r.lines || []).length);
  const min = Math.min(...counts);
  assert(min >= 12, `最少${min}本（1周12〜18回来店するので12本は要る）`);
  // 同じ常連の中で言い回しが重複していないか
  for (const r of rg.regulars) {
    const uniq = new Set(r.lines || []).size;
    assert(uniq === (r.lines || []).length, `${r.name} のセリフに重複がある`);
  }
  return `${min}〜${Math.max(...counts)}本（計${counts.reduce((a, b) => a + b, 0)}本）`;
});
check('regulars.json が参照するスキルが実在する', () => {
  for (const r of rg.regulars) for (const e of r.events) {
    if (e.skill) assert(E.BALANCE.skills[e.skill], `${r.name}: スキル ${e.skill} が無い`);
  }
});
check('スキルを教える常連が実在する', () => {
  const names = new Set(rg.regulars.map(r => r.name));
  for (const id in E.BALANCE.skills) {
    assert(names.has(E.BALANCE.skills[id].from), `${id} の from=${E.BALANCE.skills[id].from}`);
  }
});
check('src/software-data.js が data/*.json と一致', () => {
  const gen = require(path.join(root, 'src/software-data.js'));
  assert(gen.titles.length === sw.titles.length, 'ソフトの数が違う（node build/gen-data.js を実行）');
  assert(gen.regulars.length === rg.regulars.length, '常連の数が違う（node build/gen-data.js を実行）');
  assert(String(gen.visitThresholds) === String(rg.visitThresholds),
    'しきい値が違う（node build/gen-data.js を実行）');
});

check('伏線がカタログに必ず載る', () => {
  // 区分の枠から溢れると伏線ごと消えるので、7本すべてが200本の中にいることを見る
  const st = E.createGame({ seed: 1 });
  const inCatalog = new Set(st.catalog.map(t => t.name));
  const lore = sw.titles.filter(t => t.lore);
  assert(lore.length >= 8, `伏線が${lore.length}本しかない`);
  for (const t of lore) {
    assert(inCatalog.has(t.title), `「${t.title}」が枠から溢れている`);
    assert(['uncle', 'self'].includes(t.lore), `${t.title}: lore=${t.lore}`);
  }
  const self = lore.filter(t => t.lore === 'self').length;
  return `${lore.length}本（叔父${lore.length - self} / 主人公${self}）`;
});
check('主人公の正体をUIに出していない', () => {
  // 真エンドまで伏せる。ソースに直接名前を書かないこと（データ側にだけ置く）
  const self = sw.lore.self.name;
  for (const f of ['src/ui.js', 'build/template.html', 'index.html']) {
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!body.includes(self), `${f} に「${self}」が直書きされている`);
  }
  return `「${self}」はデータの中だけ`;
});
check('会話では誰も家名を口にしない', () => {
  // 図鑑の details だけが姓を持つ。会話に出ると種明かしが先に割れる
  const names = [sw.lore.uncle.surname, sw.lore.self.surname];
  for (const r of rg.regulars) {
    const all = (r.lines || []).concat(r.events.map(e => e.text))
      .concat(r.events.filter(e => e.skillKnown).map(e => e.skillKnown.text));
    for (const line of all) for (const nm of names) {
      assert(!line.includes(nm), `${r.name} が「${nm}」と言っている`);
    }
  }
  return `${names.join('・')} は図鑑の中だけ`;
});
check('屋号が叔父の姓の暗号になっている', () => {
  // 石橋→ブリヂストン方式。看板を見ても姓は分からない、が正解を知れば一致する
  const st = E.createGame({ seed: 1 });
  assert(st.log[0].text.includes(sw.lore.shop), '屋号が開店の一言に出ていない');
  assert(!sw.lore.shop.includes(sw.lore.uncle.surname), '屋号に姓がそのまま入っている');
  return `${sw.lore.shop} ← ${sw.lore.uncle.surname}`;
});
check('主人公の姓が看板と無関係', () => {
  // 「生涯なにも署名していない」男なので、看板の姓と一致してはいけない
  const u = sw.lore.uncle.surname, self = sw.lore.self.surname;
  assert(u !== self, `叔父と主人公が同じ姓（${u}）だと、看板が主人公の署名になってしまう`);
  for (const t of sw.titles.filter(x => x.lore === 'self')) {
    assert(!t.details.includes(u), `「${t.title}」に叔父の姓が混ざっている`);
  }
  return `叔父${u} / 主人公${self}（別姓）`;
});
check('図鑑に載る回数が叔父＞主人公になっている', () => {
  // 叔父は「ゲームファンなら知っている名前」、主人公は「署名しなかった男」。
  // ここが逆転すると、二人の対比も真エンドの落差も消える
  const named = who => sw.titles.filter(t => t.details.includes(sw.lore[who].name)).length;
  const u = named('uncle'), self = named('self');
  assert(u >= 3, `叔父が${u}本しか載っていない。読んでいて覚える名前にならない`);
  assert(self === 1, `主人公が${self}本に載っている。名前が残るのは1本だけにすること`);
  assert(u > self, `叔父${u}本 ≦ 主人公${self}本 で逆転している`);

  // 主人公側の残りは無名のまま置く（真エンドで初めて結びつく）
  const anon = sw.titles.filter(t => t.lore === 'self' && !t.details.includes(sw.lore.self.surname));
  assert(anon.length >= 3, `無名の痕跡が${anon.length}本しかない`);
  return `叔父${u}本 / 主人公${self}本（＋無名の痕跡${anon.length}本）`;
});
check('開店の一言が屋号を出し、年齢に触れない', () => {
  const st = E.createGame({ seed: 1 });
  const first = st.log[0].text;
  assert(first.includes(sw.lore.shop), '屋号が出ていない');
  assert(!/歳|定年|退職/.test(first), '年齢の手がかりを出してしまっている');
  return first.slice(0, 34) + '…';
});
check('叔父の死に方が年齢を悟らせない', () => {
  // 老衰だと「叔父が高齢＝甥も高齢」が自動的に成立してしまう。事故で切ってある
  assert(sw.lore.uncle.cause, '死因が設定されていない');
  assert(!/老衰|病|衰弱/.test(sw.lore.uncle.cause), `死因が${sw.lore.uncle.cause}では年齢が透ける`);
  const first = E.createGame({ seed: 1 }).log[0].text;
  assert(/元気/.test(first), '開店の一言に「元気だった」のミスリードが無い');
  // 種明かしの二段目でそれを回収していること
  assert(sw.lore.reveals.owned.text.includes('元気'), '二段目で回収していない');
  return `${sw.lore.uncle.cause} / 「元気だったのに」→ 二段目で回収`;
});

// ---------------- 3. カタログ ----------------
section('カタログ生成');
check('カタログ総数ぶんが区分どおりに揃う', () => {
  const st = E.createGame({ seed: 1 });
  const total = E.BALANCE.catalogSize;
  assert(st.catalog.length === total, `カタログが ${st.catalog.length} 本（期待 ${total}）`);

  // catalog.js と同じ按分（tiers[k].count の比率を総数に合わせる）
  const keys = Object.keys(E.BALANCE.tiers);
  const declared = keys.reduce((s, k) => s + E.BALANCE.tiers[k].count, 0);
  const want = {};
  let assigned = 0;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) want[k] = total - assigned;
    else { want[k] = Math.round(E.BALANCE.tiers[k].count / declared * total); assigned += want[k]; }
  });

  const by = {};
  for (const t of st.catalog) by[t.tier] = (by[t.tier] || 0) + 1;
  for (const k of keys) {
    assert(by[k] === want[k], `${k} が ${by[k]} 本（期待 ${want[k]}）`);
  }
  return `${total}本 ` + keys.map(k => `${k}${by[k]}`).join(' ');
});
check('カタログは seed によらず同じ', () => {
  const a = E.createGame({ seed: 1 }).catalog.map(t => t.name).join('|');
  const b = E.createGame({ seed: 999 }).catalog.map(t => t.name).join('|');
  assert(a === b, 'seed でカタログが変わっている');
});

// ---------------- 4. 通し実行と不変条件 ----------------
section('通し実行');
const P = require(path.join(root, 'src/policy.js'));

function playChecked(opts) {
  const st = E.createGame(opts);
  let guard = 0;
  const violations = [];
  while (!st.ended && guard++ < 500) {
    P.playTurn(st);
    if (st.inv.length > st.cfg.shelfSlots) violations.push(`在庫${st.inv.length} > 棚枠${st.cfg.shelfSlots}`);
    if (E.displayed(st).length > st.cfg.displaySlots) {
      violations.push(`陳列${E.displayed(st).length} > 陳列枠${st.cfg.displaySlots}`);
    }
    if (st.cash < 0) violations.push(`残高が負 ${st.cash}`);
    if (E.ownedIds(st).size > st.registered.size) violations.push('所持数が登録数を超えた');
    if (st.reputation < 0 || st.reputation > 100) violations.push(`評判 ${st.reputation}`);
    if (violations.length) break;
  }
  assert(guard < 500, 'ターンが終わらない（無限ループ）');
  assert(!violations.length, violations[0]);
  return st;
}

check('50週を10シード完走できる', () => {
  const ends = {};
  for (let i = 0; i < 10; i++) {
    const st = playChecked({ seed: 200 + i });
    assert(st.ended, '終了していない');
    ends[st.ending] = (ends[st.ending] || 0) + 1;
  }
  return Object.entries(ends).map(([k, v]) => `${k}:${v}`).join(' ');
});
check('αテスト版（10週）が完走できる', () => {
  const st = playChecked({ seed: 42, balance: { totalWeeks: 10 } });
  assert(st.ending === 'demo' || st.ending === 'bad', `ending=${st.ending}`);
  return `${st.week - 1}週 / ending=${st.ending}`;
});
check('全ソフトが図鑑に載る状態でも破綻しない', () => {
  const st = E.createGame({ seed: 7 });
  for (const t of st.catalog) st.registered.add(t.id);
  P.playAll(st);
  assert(st.ended, '終了していない');
});

check('skill を持つイベントには skillKnown がある', () => {
  let n = 0;
  for (const r of rg.regulars) for (const e of r.events) {
    if (!e.skill) continue;
    n++;
    assert(e.skillKnown && e.skillKnown.text && e.skillKnown.amount > 0,
      `${r.name}: ${e.skill} に skillKnown が無い`);
  }
  assert(n === Object.keys(E.BALANCE.skills).length, `${n}件（交渉術の数と合わない）`);
  return `${n}件`;
});
check('習得済みなら教え直さず現金になる', () => {
  const ev = E.REGULARS.find(r => r.id === 'omachi').events.find(e => e.skill === 'haggle');
  const st = E.createGame({ seed: 5 });
  st.skills.haggle = true;
  const before = st.cash;
  st.phase = 'shop'; st.queue = [];
  st.current = { type: 'event', event: ev, regular: { id: 'omachi', name: '大町', title: 'x', visits: 7 } };
  E.answer(st, false);
  assert(st.cash - before === ev.skillKnown.amount, `${st.cash - before}円`);
  const line = st.log.filter(l => l.kind === 'skill').pop();
  assert(line && !/教わった/.test(line.text), '教え直しのログが出ている');
  return `${ev.skillKnown.amount.toLocaleString()}円`;
});
check('判断が要る客は会話スキップの対象外', () => {
  const yes = [{ type: 'browser' }, { type: 'event', event: { type: 'talk' } },
               { type: 'event', event: { type: 'giftUltra' } }];
  const no  = [{ type: 'buyer' }, { type: 'seller' },
               { type: 'event', event: { type: 'offer' } }];
  for (const c of yes) assert(E.skippable(c), `${c.type} が飛ばせない`);
  for (const c of no) assert(!E.skippable(c), `${c.type} を飛ばしてしまう`);
});

check('種明かしのテキストが揃っている', () => {
  const R = sw.lore.reveals;
  for (const k of ['registered', 'owned']) {
    assert(R[k] && R[k].title && R[k].text, `${k} が無い`);
    assert(R[k].text.length > 200, `${k} が${R[k].text.length}文字と短い`);
  }
  // 一段目で叔父、二段目で主人公。逆や取り違えを防ぐ
  assert(R.registered.text.includes(sw.lore.uncle.name), '一段目に叔父の名前が無い');
  assert(!R.registered.text.includes(sw.lore.self.name), '一段目で主人公を名乗ってしまっている');
  assert(R.owned.text.includes(sw.lore.self.name), '二段目に主人公の名前が無い');
  assert(R.registered.text.includes(sw.lore.shop), '一段目で屋号の暗号を明かしていない');
  return `一段目${R.registered.text.length}字 / 二段目${R.owned.text.length}字`;
});
check('種明かしの漢数字がデータと一致', () => {
  // テキストは後から書き換える前提なので、埋め込んだ数字が取り残されるのを機械的に防ぐ
  const D = '〇一二三四五六七八九';
  const digits = n => String(n).split('').map(c => D[+c]).join('');   // 1990 → 一九九〇
  const num = n => {                                                  // 1300 → 千三百
    let out = '';
    for (const [unit, kanji] of [[1000, '千'], [100, '百'], [10, '十']]) {
      const k = Math.floor(n / unit) % 10;
      if (k) out += (k === 1 ? '' : D[k]) + kanji;
    }
    const one = n % 10;
    return (out + (one ? D[one] : '')) || D[0];
  };

  const R = sw.lore.reveals, L = sw.lore, [lo, hi] = sw.hardware.span;
  const boy = sw.titles.find(t => t.title === '爆走！宅配ボーイ ターボ');
  const crimson = sw.titles.find(t => t.title === 'クリムゾン・ブレイド 〜完全版〜');
  const romCount = Number((crimson.details.match(/(\d+)本すべて/) || [])[1]);
  assert(romCount > 0, 'クリムゾン・ブレイドの本数が読めない');

  const want = [
    [R.registered.text, num(E.BALANCE.catalogSize) + '本', 'カタログ総数'],
    [R.owned.text, num(E.BALANCE.catalogSize) + '本', 'カタログ総数'],
    [R.owned.text, digits(lo) + '年', 'ハード発売年'],
    [R.owned.text, digits(hi) + '年', 'ハード終了年'],
    [R.owned.text, digits(L.self.born) + '年', '主人公の生年'],
    [R.owned.text, num(lo - L.self.born) + '歳', 'ハード発売時の年齢'],
    [R.owned.text, num(hi - L.self.born) + '歳', 'ハード終了時の年齢'],
    [R.owned.text, num(boy.year - L.self.born) + '歳', '宅配ボーイ発売時の年齢'],
    [R.owned.text, num(boy.base) + '円', '宅配ボーイの相場'],
    [R.owned.text, num(romCount) + '本', 'クリムゾン・ブレイドの交換ロム本数'],
    [R.owned.text, num(L.uncle.died - L.uncle.born) + '歳', '叔父の没年齢'],
  ];
  for (const [text, token, why] of want) {
    assert(text.includes(token), `${why}「${token}」が本文に無い`);
  }
  return `${want.length}箇所`;
});
check('図鑑を全部登録すると一段目が出る', () => {
  const st = E.createGame({ seed: 1 });
  st.catalog.forEach(t => st.registered.add(t.id));
  E.endTurn(st);
  assert(st.reveals.registered, '発火していない');
  assert(!st.reveals.owned, '所持していないのに二段目が出ている');
  return `${st.reveals.registered.week}週目に発火`;
});
check('全部所持すると二段目が出る', () => {
  const st = E.createGame({ seed: 1, balance: { shelfSlots: 999 } });
  st.catalog.forEach(t => { st.registered.add(t.id); });
  // 在庫を全タイトルで満たす
  for (const t of st.catalog) {
    if (!E.ownedIds(st).has(t.id)) st.inv.push({ uid: 'x' + t.id, titleId: t.id, weeks: 0 });
  }
  const before = E.ownedIds(st).size;
  assert(before === st.catalog.length, `所持が${before}/${st.catalog.length}で揃っていない`);
  E.endTurn(st);   // この後の値札売りで減るので、判定は endTurn の先頭で行われる
  assert(st.reveals.owned, '発火していない');
  return `所持${before}/${st.catalog.length}で発火`;
});
check('種明かしは次の周で繰り返さない', () => {
  const a = E.createGame({ seed: 1 });
  a.catalog.forEach(t => a.registered.add(t.id));
  E.endTurn(a);
  assert(a.reveals.registered, '1周目で発火していない');
  const b = E.createGame({ seed: 2, previous: E.carryFrom(a) });
  assert(b.reveals.registered && b.reveals.registered.carried,
    '引き継がれていない（次の周でもう一度明かされてしまう）');
  return '引き継ぎ済みとして持ち越す';
});

// ---------------- 4.5 ソフトの状態 ----------------
section('ソフトの状態');
check('全在庫に有効な状態が付く', () => {
  const st = E.createGame({ seed: 4 });
  const n = E.BALANCE.condition.grades.length;
  for (const i of st.inv) {
    if (i.junk) { assert(i.cond == null, 'ジャンクに状態が付いている'); continue; }
    assert(Number.isInteger(i.cond) && i.cond >= 0 && i.cond < n, `cond=${i.cond}`);
  }
  const by = {};
  for (const i of st.inv) if (!i.junk) by[E.condLabel(st, i)] = (by[E.condLabel(st, i)] || 0) + 1;
  return Object.entries(by).map(([k, v]) => `${k}${v}`).join(' ');
});
check('どのロットにもガラクタが入らない', () => {
  // 処分品引取もまとめ買らも、中身は全部が実在のソフト
  for (const key of ['bulk', 'junk']) {
    assert(!E.BALANCE[key].mix.junk, `${key} にガラクタが ${E.BALANCE[key].mix.junk}`);
  }
  assert(!E.BALANCE.bulk.earlyMix.junk, 'bulk の序盤 mix にガラクタが残っている');
  let n = 0;
  for (let s = 0; s < 8; s++) {
    const st = E.createGame({ seed: 900 + s });
    P.playAll(st);
    n += st.inv.filter(i => i.junk).length;
  }
  assert(n === 0, `終局時にガラクタが${n}点残っている`);
  return '8シードで0点';
});
check('処分品引取は少量・安価・レアなし', () => {
  // まとめ買いとの差別化。規模ではなく「近所の人から引き取る」という相手の違い
  const j = E.BALANCE.junk, b = E.BALANCE.bulk;
  assert(j.items[1] < b.items[0], `点数が重なっている（引取${j.items} / まとめ買い${b.items}）`);
  assert(!j.mix.rare && !j.mix.ultra, '処分品引取からレア以上が出ている');
  assert(b.mix.rare > 0, 'まとめ買いからレアが出ない');
  const mint = E.BALANCE.condition.grades.length - 1;
  assert(E.BALANCE.condition.mix.junk[mint] === 0, '処分品引取から美品が出ている');
  return `引取${j.items[0]}〜${j.items[1]}点 / まとめ買い${b.items[0]}〜${b.items[1]}点`;
});
check('立替は上限までしか借りられない', () => {
  const st = E.createGame({ seed: 7 });
  const c = st.cfg.credit;
  const before = st.cash;
  const got = E.borrow(st, c.limit * 3);
  assert(got === c.limit, `${got}円 借りられた（上限${c.limit}）`);
  assert(st.cash === before + c.limit, '現金が増えていない');
  assert(st.debt === c.limit, `残債が ${st.debt}`);
  assert(E.borrow(st, 10000) === 0, '上限を超えて借りられる');
  return `上限${c.limit.toLocaleString()}円`;
});
check('立替は在庫を減らさずに家賃をしのげる', () => {
  // 叩き売る前に立替を通すのが要点。棚が減ると売上が減って戻れなくなる
  const st = E.createGame({ seed: 8 });
  st.cash = 0;
  st.half = 1;
  E.endTurn(st);
  assert(!st.ended, '閉店してしまった');
  assert(st.debt > 0, '立替が発生していない');
  // 店頭で売れるのは通常の売上なので、見るのは強制売却だけ
  const forced = st.log.filter(l => l.kind === 'forced');
  assert(!forced.length, `強制売却が起きた（${forced.map(l => l.text).join('／')}）`);
  return `叩き売りなしで残債${st.debt.toLocaleString()}円`;
});
check('残債には手数料が乗り、余裕から返される', () => {
  const st = E.createGame({ seed: 9 });
  E.borrow(st, 100000);
  const c = st.cfg.credit;
  st.cash = c.reserve;              // 返す余裕が無い週
  st.half = 1;
  const before = st.debt;
  E.endTurn(st);
  assert(st.debt > before, `手数料が乗っていない（${before} → ${st.debt}）`);
  // 余裕がある週は返る
  st.cash = 500000;
  st.half = 1;
  E.endTurn(st);
  assert(st.debt === 0, `返済されていない（残債${st.debt}）`);
  return `手数料 週${Math.round(c.interest * 100)}%`;
});
check('最後まで借りたままなら在庫で精算される', () => {
  // ここが無いと、最終週に上限まで借りて買うのが常に得になる
  const st = E.createGame({ seed: 10 });
  E.borrow(st, st.cfg.credit.limit);
  st.cash = st.cfg.rent + 10000;      // 家賃は払えるが、残債には全く足りない
  const inv = st.inv.length;
  st.week = st.cfg.totalWeeks; st.half = 1;
  E.endTurn(st);
  assert(st.ended, '終わっていない');
  assert(st.cash >= 0, `残高が負（${st.cash}）`);
  assert(st.inv.length < inv, '在庫が減っていない');
  // 返しきれなければ在庫が尽きるまで持っていかれる。集めた物が消えるのが罰
  assert(st.debt === 0 || !st.inv.length,
    `在庫${st.inv.length}点を残したまま残債${st.debt}が残っている`);
  return `在庫${inv} → ${st.inv.length}点 / 残債${st.debt.toLocaleString()}円`;
});
check('タダで渡す口ぶりのイベントが有料になっていない', () => {
  // サトエさんの「持ってって」が相場30%の買取だった。口ぶりと処理は揃っている必要がある
  const free = ['持ってって', 'タダ', 'ただであげ', 'あげるわ', 'あげるよ', 'いらない'];
  const paid = [];
  for (const r of E.REGULARS) {
    for (const e of r.events || []) {
      if (e.type !== 'offer') continue;
      const hit = free.find(w => (e.text || '').includes(w));
      if (hit) paid.push(`${r.name}${e.at}回目「${hit}」`);
    }
  }
  assert(!paid.length, paid.join(' / '));
  // 逆に、有料のイベントは値段の話をしていること
  const noPrice = [];
  for (const r of E.REGULARS) {
    for (const e of r.events || []) {
      if (e.type !== 'offer') continue;
      if (!/安く|いくらでも|相場より|安い|値/.test(e.text || '')) noPrice.push(`${r.name}${e.at}回目`);
    }
  }
  assert(!noPrice.length, `値段に触れていない買取イベント: ${noPrice.join('／')}`);
  return `買取イベント${E.REGULARS.reduce((n, r) => n + (r.events || []).filter(e => e.type === 'offer').length, 0)}件`;
});
check('棚が満杯のあいだは物をくれるイベントが起きない', () => {
  const st = E.createGame({ seed: 13 });
  const sat = E.REGULARS.find(r => r.id === 'satoe');
  const ev = (sat.events || []).find(e => e.type === 'gift');
  assert(ev === sat.events[0], '1回目が贈り物イベントである前提が崩れた');
  const fill = () => { st.cfg = Object.assign({}, st.cfg, { shelfSlots: st.inv.length }); };
  const open = () => { st.cfg = Object.assign({}, st.cfg, { shelfSlots: st.inv.length + 5 }); };

  fill();
  st.regulars[sat.id] = { visits: 5, fired: 0 };   // とっくに1回目の条件は満たしている
  let fired = false;
  for (let i = 0; i < 40; i++) {
    const c = E.makeRegularCustomer(st, new Set());
    if (c && c.type === 'event' && c.regular.id === sat.id) fired = true;
  }
  assert(!fired, '満杯なのに贈り物イベントが起きた');
  assert(st.regulars[sat.id].fired === 0, 'イベントが消費されている');

  open();
  st.regulars[sat.id].visits = 5;
  for (let i = 0; i < 40 && !fired; i++) {
    const c = E.makeRegularCustomer(st, new Set());
    if (c && c.type === 'event' && c.regular.id === sat.id) fired = true;
  }
  assert(fired, '棚を空けても起きない');
  return '満杯のあいだは持ち越し、空けば起きる';
});
check('棚が満杯で受け取れなかったイベントは消えない', () => {
  // イベントは発生時に消費済みになるので、渡せないと激レアが永久に消えていた
  const st = E.createGame({ seed: 12 });
  const sat = E.REGULARS.find(r => r.id === 'satoe');
  const ev = (sat.events || []).find(e => e.type === 'gift');
  const rs = st.regulars[sat.id] = { visits: 1, fired: 1 };
  // 棚を満杯にする
  st.cfg = Object.assign({}, st.cfg, { shelfSlots: st.inv.length });
  assert(E.freeSlots(st) <= 0, '棚が満杯になっていない');
  const inv = st.inv.length;
  st.phase = 'shop';
  st.queue = [];
  st.current = { type: 'event', regular: { id: sat.id, name: sat.name }, event: ev };
  E.answer(st, true);
  assert(st.inv.length === inv, '満杯なのに受け取れている');
  assert(rs.fired === 0, `イベントが消費されたまま（fired=${rs.fired}）`);
  // 空ければ受け取れる
  st.cfg = Object.assign({}, st.cfg, { shelfSlots: st.inv.length + 1 });
  E.resolveEvent(st, { event: ev, regular: { id: sat.id, name: sat.name } }, true);
  assert(st.inv.length === inv + 1, '空けても受け取れない');
  return '満杯なら次の来店に持ち越す';
});
check('指名の贈り物は激レアに化けない', () => {
  // 既に持っていると激レアに差し替わる実装だった。中堅1本のつもりが破格の当たりになる
  const st = E.createGame({ seed: 11 });
  const sat = E.REGULARS.find(r => r.id === 'satoe');
  const ev = (sat.events || []).find(e => e.type === 'gift');
  assert(ev, 'サトエさんの贈り物イベントが無い');
  const t = st.catalog.find(x => x.name === ev.title);
  assert(t, `「${ev.title}」がカタログに無い`);
  assert(t.tier !== 'ultra', '前提が変わっている（贈り物が激レアになった）');
  // 既に持っている状態で受け取っても、貰えるのは同じタイトル
  const before = st.inv.filter(i => i.titleId === t.id).length;
  E.resolveEvent(st, { event: ev, regular: sat }, true);
  const after = st.inv.filter(i => i.titleId === t.id).length;
  assert(after === before + 1, `「${t.name}」が増えていない（${before} → ${after}）`);
  E.resolveEvent(st, { event: ev, regular: sat }, true);
  assert(st.inv.filter(i => i.titleId === t.id).length === before + 2, '2本目で別の物に化けた');
  return `「${t.name}」（${t.tier}）を2本とも同じ物として受け取った`;
});
check('宣伝は瑠璃のイベントで解禁される', () => {
  // 週ではなくイベントで開く。1回目の来店で必ず開くこと
  const st = E.createGame({ seed: 23 });
  assert(!E.unlocked(st, 'promo'), '最初から宣伝できる');
  const ruri = E.REGULARS.find(r => r.id === 'ruri');
  assert(ruri, '瑠璃がいない');
  const ev = ruri.events[0];
  assert(ev.type === 'openPromo', `1回目が ${ev.type}`);
  assert(E.THRESHOLDS[0] === 1, '1回目の来店で起きない');
  E.resolveEvent(st, { event: ev, regular: { id: ruri.id, name: ruri.name } }, true);
  assert(E.unlocked(st, 'promo'), 'イベントを経ても解禁されない');
  // 通しで回せば必ず開く
  let opened = 0;
  for (let s2 = 0; s2 < 12; s2++) {
    const g = E.createGame({ seed: 600 + s2 });
    P.playAll(g);
    if (g.promoOpen) opened++;
  }
  assert(opened === 12, `12シード中${opened}回しか解禁されない`);
  return '12シードすべてで解禁';
});
check('宣伝は評判を上げ、50回で頭打ちになる', () => {
  const st = E.createGame({ seed: 21 });
  const c = st.cfg.promo;
  const act = () => { st.phase = 'action'; E.doAction(st, 'promo', {}); };
  assert(E.promoRate(st) === 0, '最初から効いている');
  act();
  assert(st.promo === 0, 'アカウントを作る前から投稿できている');
  st.promoOpen = true;
  const rep0 = st.reputation;
  act();
  assert(st.promo === 1, `回数が ${st.promo}`);
  assert(st.reputation > rep0, '評判が上がっていない');
  for (let i = 0; i < c.cap * 2; i++) act();
  assert(st.promo === c.cap, `上限を超えた（${st.promo} / ${c.cap}）`);
  assert(E.promoRate(st) === 1, '効きが100%になっていない');
  return `${c.cap}回で頭打ち`;
});
check('宣伝すると持っていない物が持ち込まれやすくなる', () => {
  const st = E.createGame({ seed: 22 });
  const c = st.cfg.promo;
  const before = E.sellerOwnedPenalty(st);
  assert(Math.abs(before - 1) < 1e-9, `撒く前から効いている（${before}）`);
  st.promo = c.cap;
  const after = E.sellerOwnedPenalty(st);
  assert(Math.abs(after - (1 - c.ownedPenalty)) < 1e-9, `上限での重みが ${after}`);
  assert(after < before, '重みが下がっていない');
  // 半分だけ撒いた状態は、ちょうど中間になる
  st.promo = c.cap / 2;
  assert(Math.abs(E.sellerOwnedPenalty(st) - (1 - c.ownedPenalty / 2)) < 1e-9, '効きが線形でない');
  return `持っている物の重み 1.00 → ${after.toFixed(2)}`;
});
check('処分品引取だけが評判を上げる', () => {
  // 引取は劣化まとめ買いになりがち。「業者相手か、町の人相手か」を評判で分ける
  const g = E.BALANCE.reputation.gain;
  assert(g.junkLot > 0, `junkLot が ${g.junkLot}`);
  const at = (key, seed) => {
    const st = E.createGame({ seed });
    // 接客を片付けて行動フェイズに入り、その行動だけを取って評判の差を見る
    let guard = 0;
    while (!st.ended && guard++ < 400) {
      while (st.phase === 'shop' && st.current) E.answer(st, false);
      if (st.phase !== 'action') break;
      const o = st.offers;
      if (o && o[key] && st.cash >= (o[key].cost || 0)) {
        const before = st.reputation;
        E.doAction(st, key, {});
        return Math.round((st.reputation - before) * 100) / 100;
      }
      E.doAction(st, 'rest', {});
    }
    return null;
  };
  const j = at('junk', 31), b = at('bulk', 31);
  assert(j != null && b != null, '行動の機会が来なかった');
  assert(Math.abs(j - g.junkLot) < 1e-6, `処分品引取で評判が ${j} しか動いていない`);
  assert(b === 0, `まとめ買いで評判が ${b} 動いている`);
  return `引取 +${j} / まとめ買い ${b}`;
});
check('まとめ買いの状態の期待値が1.0', () => {
  // ここが1.0から外れると、状態を入れただけで経済が動いてしまう。
  // わざと傾けるのは数値調整の仕事で、この機能の仕事ではない
  const c = E.BALANCE.condition;
  const e = c.mix.bulk.reduce((sum, p, i) => sum + p * c.grades[i].mult, 0);
  assert(Math.abs(e - 1) < 0.02, `期待値 ${e.toFixed(3)}`);
  for (const k in c.mix) {
    const sum = c.mix[k].reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 1) < 1e-6, `${k} の確率の合計が ${sum}`);
    assert(c.mix[k].length === c.grades.length, `${k} の要素数が段階数と違う`);
  }
  return `期待値 ${e.toFixed(3)}`;
});
check('状態が売値に効く', () => {
  const st = E.createGame({ seed: 4 });
  const t = st.catalog.find(x => x.tier === 'mid');
  const mk = cond => {
    const item = { uid: -1, titleId: t.id, junk: false, cond, markdown: false, acquiredWeek: 1 };
    return E.priceOf(st, item);
  };
  const g = E.BALANCE.condition.grades;
  assert(mk(0) < mk(1) && mk(1) < mk(2), `${mk(0)} / ${mk(1)} / ${mk(2)}`);
  assert(Math.abs(mk(2) / t.base - g[2].mult) < 0.01, '美品の倍率が効いていない');
  return `${mk(0).toLocaleString()} / ${mk(1).toLocaleString()} / ${mk(2).toLocaleString()}`;
});
check('激レアは美品しか存在しない', () => {
  const mint = E.BALANCE.condition.grades.length - 1;
  // まとめ買い・処分品・単品入札・イベント・取り寄せ、どの経路から入っても美品であること
  let n = 0;
  for (let s = 0; s < 12; s++) {
    const g = E.createGame({ seed: 800 + s });
    P.playAll(g);
    for (const i of g.inv) {
      const t = E.titleOf(g, i);
      if (!t || t.tier !== 'ultra') continue;
      n++;
      assert(i.cond === mint, `「${t.name}」が${E.condLabel(g, i)}になっている`);
    }
  }
  assert(n > 0, '激レアが1本も出ていない');
  return `${n}点すべて美品`;
});
check('激レアの取り寄せ料金が美品ぶん高い', () => {
  // 料金を状態に連動させないと、激レアの取り寄せだけが5割得になる
  const st = E.createGame({ seed: 8 });
  const g = E.BALANCE.condition.grades;
  const u = st.catalog.find(x => x.tier === 'ultra');
  const m = st.catalog.find(x => x.tier === 'mid');
  const ratio = t => E.orderCost(st, t) / (t.base * E.BALANCE.order.premium);
  assert(Math.abs(ratio(u) - g[g.length - 1].mult) < 0.02, `激レアの倍率 ${ratio(u).toFixed(2)}`);
  assert(Math.abs(ratio(m) - g[E.BALANCE.condition.orderCond].mult) < 0.02,
    `中堅の倍率 ${ratio(m).toFixed(2)}`);
  return `激レア×${ratio(u).toFixed(2)} / 中堅×${ratio(m).toFixed(2)}`;
});
check('図鑑は状態を問わない', () => {
  // 登録も所持も「どの状態でも1本は1本」。真エンドの条件を変えないための一線
  const st = E.createGame({ seed: 4 });
  const t = st.catalog.find(x => !E.ownedIds(st).has(x.id));
  st.inv.push({ uid: -2, titleId: t.id, junk: false, cond: 0, markdown: false, acquiredWeek: 1 });
  assert(E.ownedIds(st).has(t.id), '傷あり品が所持に数えられていない');
  st.registered.add(t.id);
  assert(st.registered.has(t.id), '登録されていない');
});
check('自動プレイが状態の良い1本を残す', () => {
  // 状況を直接作って判定する。通しで回すと重複が売れたあとの残骸しか見られない
  const st = E.createGame({ seed: 21, balance: { unlock: { organize: 1 } } });
  st.week = 40;                                   // 非売品札を付ける時期に入れる
  const mint = E.BALANCE.condition.grades.length - 1;
  const picks = st.catalog.filter(t => t.tier === 'mid').slice(0, 4);
  st.inv = [];
  for (const t of picks) {                        // 同じタイトルを傷あり→美品の順で積む
    for (const cond of [0, mint]) {
      st.inv.push({ uid: st.uidSeq++, titleId: t.id, junk: false, cond,
        display: false, markdown: false, protect: false, acquiredWeek: 1 });
    }
  }
  P.arrangeDisplay(st);
  for (const t of picks) {
    const list = st.inv.filter(i => i.titleId === t.id);
    const kept = list.filter(i => i.protect);
    assert(kept.length === 1, `「${t.name}」の非売品が${kept.length}本`);
    assert(kept[0].cond === mint, `「${t.name}」で${E.condLabel(st, kept[0])}を残している`);
  }
  return `${picks.length}タイトルで美品を残した`;
});
check('自動プレイが状態を見て値踏みする', () => {
  // 固定の閾値だと、安い傷あり品ばかり買って美品を一度も買わない逆選択が起きる
  const st = E.createGame({ seed: 4 });
  st.cash = 5000000;
  const t = st.catalog.find(x => x.tier === 'mid');
  const ask = Math.round(t.base * 1.2);
  const mint = P.buyDecision(st, { titleId: t.id, ask, cond: 2 });
  const worn = P.buyDecision(st, { titleId: t.id, ask, cond: 0 });
  assert(mint && !worn, `美品${mint} / 傷あり${worn}（同じ提示額なら美品だけ買うべき）`);
  return `提示${ask.toLocaleString()}円: 美品○ / 傷あり×`;
});

// ---------------- 5. 周回引き継ぎ ----------------
section('周回引き継ぎ');
check('図鑑と交渉術が次の周に残る', () => {
  const a = E.createGame({ seed: 11 });
  P.playAll(a);
  const carried = E.carryFrom(a);
  const b = E.createGame({ seed: 12, previous: carried });
  for (const id of carried.registered) assert(b.registered.has(id), '図鑑が引き継がれていない');
  for (const id of carried.skills) assert(b.skills[id], `スキル ${id} が引き継がれていない`);
  assert(b.cash === E.BALANCE.startCash, '資金が引き継がれてしまっている');
  assert(b.inv.length === E.BALANCE.startInventory, '在庫が引き継がれてしまっている');
  return `図鑑${carried.registered.length}本 / スキル${carried.skills.length}個`;
});

// ---------------- 6. スキルと設備の効果 ----------------
section('スキルと設備');
check('スキルが価格に効く', () => {
  const st = E.createGame({ seed: 3 });
  const t = st.catalog.find(x => x.tier === 'rare');
  const before = E.orderCost(st, t);
  st.skills.connections = true;
  const after = E.orderCost(st, t);
  assert(after < before, `取り寄せ ${before} → ${after}`);
  return `取り寄せ ${before.toLocaleString()} → ${after.toLocaleString()}`;
});
check('設備が枠を増やす', () => {
  const st = E.createGame({ seed: 3, balance: { unlock: Object.assign({}, E.BALANCE.unlock, { expand: 1 }) } });
  st.cash = 1000000;
  while (st.phase === 'shop' && st.current) E.answer(st, false);
  const before = st.cfg.shelfSlots;
  const r = E.doAction(st, 'upgrade', { id: 'warehouse' });
  assert(r.ok, `購入に失敗 reason=${r.reason}`);
  assert(st.cfg.shelfSlots > before, `棚枠 ${before} → ${st.cfg.shelfSlots}`);
  return `棚枠 ${before} → ${st.cfg.shelfSlots}`;
});

// ---------------- 7. 配布物 ----------------
section('配布物');
check('dist/prototype.html が src より新しい', () => {
  const dist = fs.statSync(path.join(root, 'dist/prototype.html')).mtimeMs;
  const newest = ['src', 'build', 'data'].flatMap(d =>
    fs.readdirSync(path.join(root, d)).map(f => fs.statSync(path.join(root, d, f)).mtimeMs));
  const max = Math.max(...newest);
  assert(dist >= max, 'ビルドが古い（node build/gen-data.js && node build/build.js を実行）');
});
check('dist/prototype.html が自己完結している', () => {
  const html = fs.readFileSync(path.join(root, 'dist/prototype.html'), 'utf8');
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
  const bad = ext.filter(u => !/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(u));
  assert(!bad.length, '外部参照: ' + bad.join(', '));
  assert(html.includes('<title>'), 'title が無い');
  return `${(html.length / 1024).toFixed(0)}KB / 外部はGoogle Fontsのみ`;
});

// ---------------- 結果 ----------------
console.log('\n' + '─'.repeat(50));
console.log(`${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed ? 1 : 0);

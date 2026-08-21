'use strict';
/**
 * 架空ソフトカタログの生成。
 * 世界設定（ハード・メーカー）は仕様書 7 節の骨子のみを実装した仮データ。
 * 固定シードで生成するので、実行のたびに同じ150本が出る。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Catalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---------------- 乱数（mulberry32） ----------------
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rInt = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
  const rPick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  function rWeighted(rng, pairs) { // [[value, weight], ...]
    let total = 0;
    for (const p of pairs) total += p[1];
    let x = rng() * total;
    for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }

  // ---------------- 世界設定 ----------------
  const HARDWARE = [
    { id: 'mighty8',  name: 'マイティ8',    kind: '8bit据置',  span: [1985, 1991] },
    { id: 'neotron',  name: 'ネオトロン16', kind: '16bit据置', span: [1990, 1996] },
    { id: 'pocketa',  name: 'ポケッタ',     kind: '携帯機',    span: [1994, 1999] },
    { id: 'zerodisc', name: 'ゼロディスク', kind: '32bit据置', span: [1996, 1998] },
  ];

  const MAKERS = [
    { id: 'ohtori',    name: '大鳥電機',           genres: ['RPG', 'SLG', 'AVG'], rarity: 0.8, trait: '老舗の大手。手堅いが冒険はしない' },
    { id: 'cosmo',     name: 'コスモウェーブ',     genres: ['STG', 'ACT'],        rarity: 1.1, trait: 'アーケード出身。理不尽な難度で知られる' },
    { id: 'jumbo',     name: 'ジャンボソフト',     genres: ['AVG', 'ACT', 'TBL'], rarity: 0.5, trait: '年に20本出す量産メーカー。中身は推して知るべし' },
    { id: 'ginrei',    name: '銀嶺スタジオ',       genres: ['AVG', 'RPG'],        rarity: 1.2, trait: '文芸志向。テキスト量だけは一級品' },
    { id: 'tiger',     name: 'タイガーワークス',   genres: ['FTG', 'ACT'],        rarity: 1.0, trait: '格闘ゲーム専門。移植の出来にムラがある' },
    { id: 'penguin',   name: 'ペンギン企画',       genres: ['PZL', 'SPT'],        rarity: 0.7, trait: '子供向け。教育ソフトも手がける' },
    { id: 'kurokawa',  name: '黒川インタラクティブ', genres: ['RPG', 'AVG'],      rarity: 2.6, until: 1997, trait: '1997年に倒産。末期の出荷数はごくわずか' },
    { id: 'thunder',   name: 'サンダーバレー',     genres: ['RCG', 'SPT'],        rarity: 0.9, trait: 'レースとスポーツ一筋' },
    { id: 'hoshikuzu', name: '星屑ソフトウェア',   genres: ['SLG', 'PZL', 'AVG'], rarity: 1.8, trait: '実験作しか作らない。一部に熱狂的な信者がいる' },
  ];

  const GENRE_LABEL = {
    RPG: 'RPG', STG: 'シューティング', AVG: 'アドベンチャー', ACT: 'アクション',
    SLG: 'シミュレーション', PZL: 'パズル', SPT: 'スポーツ', RCG: 'レース',
    FTG: '対戦格闘', TBL: 'テーブル',
  };

  const CORES = {
    RPG: ['クリスタルオーダー', 'ドラグーンサーガ', '精霊記', 'ルミナスクエスト', '古代王の指輪', '幻想大陸', 'エレメンタルテイル', '聖剣ロマンシア', '天空の系譜', 'ヴァルハラ戦記', '黄昏の塔', '流浪のグリモア'],
    STG: ['コスモファイター', 'ヴァルカン爆撃隊', 'ゼロシューター', '銀河突撃隊', 'サンダーレイド', 'メタルバレット', 'ネビュラウォーズ', '超弩級ガンナー', '蒼穹の弾幕'],
    AVG: ['霧の館', '放課後探偵団', '消えた七日間', '雨宿りの記憶', '港町殺人事件', '夜想曲', '見知らぬ来訪者', '十三時の電話', '海辺のノート'],
    ACT: ['忍者疾風伝', 'ロックボーイ', '鋼鉄のジャック', 'ジャンプマニア', '大冒険パンチ', 'リトルヒーロー', '暴走メカニクス'],
    SLG: ['戦国覇道', '惑星開拓記', '鉄道王', '経営の達人', '都市計画1999', '大提督の海図', '牧場のいちねん'],
    PZL: ['ぷちぷちパズル', 'ブロックランド', 'くるくるキューブ', 'おじゃまカプセル', '積み木の国'],
    SPT: ['熱血野球', 'スーパーサッカー', '格闘バレー', '全日本柔道', 'パーフェクトゴルフ', '真夏の甲子園'],
    RCG: ['ターボレーサー', '峠伝説', 'サーキットキング', 'ダートアタック', 'ナイトドライヴ'],
    FTG: ['虎牙伝説', 'ファイターズギア', '鉄拳道', '武神列伝', 'ストリートブロウ', '拳王無双'],
    TBL: ['麻雀道楽', '花札物語', '将棋名人', 'カジノパラダイス', '大貧民帝国'],
  };

  const PREFIX = ['', '', '', '', '新', 'ザ・', 'ネオ', 'スーパー', '真・', '超'];
  const SUFFIX = ['', '', '', 'II', 'III', '外伝', 'DX', 'スペシャル', '完全版', 'R', 'ZERO', "'98"];

  // 説明文（100〜150字を目安にした仮テキスト。ネタ枠を混ぜる）
  const FLAVOR = {
    RPG: ['王道の世界観だが、終盤のダンジョンだけ理不尽に長い。', 'エンカウント率が異常に高く、当時から苦情が多かった。', 'シナリオの評価は高いが、戦闘バランスが崩壊している。'],
    STG: ['自機が大きく、当たり判定の話は今も語り草。', '二周目から敵弾が倍になる硬派な設計。', 'BGMだけが突出して評価され、サントラが本体より高い。'],
    AVG: ['選択肢が実質一本道で、総当たりを強いられる。', '真相に辿り着くと画面が数秒暗転する演出が有名。', '当時としては異例の長文テキストで、容量の大半を占めた。'],
    ACT: ['操作性が独特で、慣れるまでは苦行だが化ける。', '一面の難度が最も高いという逆転構成。', 'ジャンプの慣性が強く、初見では確実に落ちる。'],
    SLG: ['一周に数十時間かかり、セーブ回数に制限がある。', '内政パートが緻密すぎて、戦闘は付け足しに見える。', '説明書を読まないと何も始まらない不親切設計。'],
    PZL: ['単純だが中毒性が高く、店頭デモで人だかりができた。', '二人対戦モードの出来だけが妙に良い。', '後半の面はテストされていないと噂される。'],
    SPT: ['選手名が実在しないが、能力値だけは妙にリアル。', '実況の語彙が四種類しかない。', '操作説明がなく、ボタンを総当たりする必要がある。'],
    RCG: ['コースが三つしかないが、挙動の作り込みは本物。', 'BGMが一曲のループで、長時間プレイに向かない。', '当時最速を謳ったスクロールが売り。'],
    FTG: ['家庭用移植で技が数個消えている。', '一部のキャラの性能が壊れており、大会で禁止された。', 'コマンド入力の受付が短く、上級者向け。'],
    TBL: ['CPUの思考が異常に長い。', 'ルール説明が丁寧で、入門書代わりに使われた。', '隠しモードの存在が長らく都市伝説だった。'],
  };

  const RARITY_FLAVOR = {
    common: ['どこのワゴンにも積まれていた一本。', '中古棚の常連で、値札はいつも三桁。'],
    mid: ['そこそこ売れたが、完品はじわじわ減っている。', '中古市場では安定した動きを見せる。'],
    rare: ['出荷数が少なく、状態の良い箱付きは滅多に出ない。', '雑誌の企画で取り上げられて以来、値が上がり続けている。'],
    ultra: ['流通経路が特殊で、市場に出るのは年に数本。', '現存数は二桁とも言われ、取引はほぼ個人間で行われる。'],
  };

  const TIER_KEYS = ['common', 'mid', 'rare', 'ultra'];

  // 希少度ごとの基礎需要（1ターンあたり指名されやすさ）
  const DEMAND = { common: 1.0, mid: 0.78, rare: 0.52, ultra: 0.16 };

  /**
   * @param {object} tiers BALANCE.tiers（区分ごとの本数・相場帯）
   * @param {number} total 生成本数（tiers の比率で按分する）
   */
  function build(tiers, total, seed) {
    const rng = makeRng(seed >>> 0);

    // 区分ごとの本数を total に合わせて按分
    const declared = TIER_KEYS.reduce((s, k) => s + tiers[k].count, 0);
    const counts = {};
    let assigned = 0;
    TIER_KEYS.forEach((k, i) => {
      if (i === TIER_KEYS.length - 1) counts[k] = total - assigned;
      else { counts[k] = Math.round(tiers[k].count / declared * total); assigned += counts[k]; }
    });

    const used = new Set();
    const list = [];
    let idSeq = 1;

    for (const tierKey of TIER_KEYS) {
      const tier = tiers[tierKey];
      for (let i = 0; i < counts[tierKey]; i++) {
        // 希少度が高いほど「レア寄りメーカー」が選ばれやすい
        const bias = { common: -1, mid: 0, rare: 1, ultra: 2 }[tierKey];
        const maker = rWeighted(rng, MAKERS.map(m => [m, Math.pow(m.rarity, bias)]));
        const genre = rPick(rng, maker.genres);
        // ハードの発売期間とメーカーの活動期間が重なるものだけを選ぶ
        const avail = HARDWARE.filter(h => h.span[0] <= (maker.until || 9999));
        const hw = rPick(rng, avail);
        const year = rInt(rng, hw.span[0], Math.min(hw.span[1], maker.until || 9999));

        let core, name, guard = 0;
        do {
          core = rPick(rng, CORES[genre]);
          name = rPick(rng, PREFIX) + core + (rng() < 0.35 ? ' ' + rPick(rng, SUFFIX) : '');
          name = name.trim();
        } while (used.has(name) && ++guard < 60);
        if (used.has(name)) name = name + ' 【' + year + '】';
        used.add(name);

        // 相場は帯の下寄りに偏らせる（高額帯を薄くする）
        const t = Math.pow(rng(), 1.5);
        const raw = tier.sale[0] + t * (tier.sale[1] - tier.sale[0]);
        const step = raw >= 50000 ? 5000 : raw >= 10000 ? 1000 : 100;
        const base = Math.max(step, Math.round(raw / step) * step);

        list.push({
          id: idSeq++,
          name,
          core,
          hardware: hw.name,
          hardwareId: hw.id,
          year,
          maker: maker.name,
          makerId: maker.id,
          genre,
          genreLabel: GENRE_LABEL[genre],
          tier: tierKey,
          tierLabel: tier.label,
          base,                                  // 販売基準相場
          buy: Math.round(base * tier.buyRatio / 100) * 100, // 買取目安
          desc: `${maker.name}が${year}年に${hw.name}向けに発売した${GENRE_LABEL[genre]}。`
              + rPick(rng, FLAVOR[genre]) + rPick(rng, RARITY_FLAVOR[tierKey]),
          // 客が指名する頻度。安いソフトほど需要は多いが、高額帯も捌ける程度に留める
          demand: DEMAND[tierKey] * Math.pow(2000 / base, 0.18),
        });
      }
    }

    // 関連タイトル（同じ core を持つものをシリーズとみなす）
    const bySeries = new Map();
    for (const s of list) {
      if (!bySeries.has(s.core)) bySeries.set(s.core, []);
      bySeries.get(s.core).push(s.id);
    }
    for (const s of list) s.related = bySeries.get(s.core).filter(id => id !== s.id);

    list.sort((a, b) => a.year - b.year || a.id - b.id);
    return list;
  }

  return { build, makeRng, rInt, rPick, rWeighted, HARDWARE, MAKERS, GENRE_LABEL };
});

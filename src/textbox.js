'use strict';
/**
 * メッセージ窓の組版。
 *
 * 本番（Godot）では文章を「24字×2行」で1ページ出し、▼で送る。
 * どこで切れるかは書いたあとにしか分からないので、書く側が確かめられるように
 * 組版だけをここに切り出してある。プロトタイプの表示には使っていない。
 *
 *   const box = require('./textbox');
 *   box.paginate(text)   // → [[1行目, 2行目], [1行目, 2行目], …]
 *   box.faults(text)     // → 直したほうがいい箇所
 *
 * 文の途中で▼が来ると間が抜けるので、**句点で区切ってから詰める**。
 * 1文が1ページに収まらないときだけ、文の途中で送る。
 * 書き手が置ける記号は1つだけ:
 *
 *   \n\n  …… ここで必ずページを送る（間を取りたいとき）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextBox = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const WIDTH = 24;   // 1行に入る全角の数
  const LINES = 2;    // 1ページの行数

  // 半角として数える字。本文には数字と『』内の英字が出る
  const HALF = /[\x20-\x7E｡-ﾟ]/;
  /** 全角を1、半角を0.5として数えた幅 */
  function width(s) {
    let n = 0;
    for (const c of s) n += HALF.test(c) ? 0.5 : 1;
    return n;
  }

  // 行頭に置けない字。句読点も入れてある——ぶら下げが先に走るので、
  // ここに残るのは「。……」のように続きがあってぶら下げきれなかったときだけ
  const NO_HEAD = /[。、，．！？）］｝〉》」』】〕・：；…‥ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ]/;
  const NO_TAIL = /[（［｛〈《「『【〔]/;                                                    // 行末に置けない
  const HANG = /[。、，．！？]/;                                                             // ぶら下げてよい

  /** 1行ぶんを切り出して [その行, 残り] を返す */
  function takeLine(s) {
    if (width(s) <= WIDTH) return [s, ''];
    let cut = 0, w = 0;
    for (const c of s) {
      const cw = HALF.test(c) ? 0.5 : 1;
      if (w + cw > WIDTH) break;
      w += cw; cut += c.length;
    }
    while (cut < s.length && HANG.test(s[cut])) cut++;               // ぶら下げ
    let guard = 0;
    while (cut > 1 && guard++ < WIDTH) {                             // 追い出し
      if (cut < s.length && NO_HEAD.test(s[cut])) { cut--; continue; }
      if (NO_TAIL.test(s[cut - 1])) { cut--; continue; }
      break;
    }
    return [s.slice(0, cut), s.slice(cut)];
  }

  /** ひと続きの文字列を行の配列にする */
  function wrap(s) {
    const out = [];
    let rest = s;
    while (rest !== '') { const [line, r] = takeLine(rest); out.push(line); rest = r; }
    return out.length ? out : [''];
  }

  /**
   * 本文を「地の文」と「台詞（鉤括弧の中）」に割る。
   * 台詞は途中で切ると誰の言葉か分からなくなるので、ひと塊として扱う
   */
  function segments(s) {
    const out = [];
    let buf = '', depth = 0;
    for (const c of Array.from(s)) {
      if (c === '「') {
        if (depth === 0 && buf) { out.push({ quote: false, text: buf }); buf = ''; }
        depth++;
      }
      buf += c;
      if (c === '」' && depth > 0) {
        depth--;
        if (depth === 0) { out.push({ quote: true, text: buf }); buf = ''; }
      }
    }
    if (buf) out.push({ quote: depth > 0, text: buf });
    return out;
  }

  /**
   * 文に切る。句点・感嘆符のあとで切り、閉じ括弧はその文に付ける。
   * 鉤括弧の中では切らない（切ると台詞が途中で送られる）
   */
  function sentences(s) {
    const out = [];
    for (const seg of segments(s)) {
      if (seg.quote) { out.push(seg.text); continue; }
      let buf = '';
      const chars = Array.from(seg.text);
      for (let i = 0; i < chars.length; i++) {
        buf += chars[i];
        if (!/[。！？]/.test(chars[i])) continue;
        let j = i + 1;
        while (j < chars.length && /[』）！？…]/.test(chars[j])) { buf += chars[j]; j++; }
        i = j - 1;
        out.push(buf); buf = '';
      }
      if (buf) out.push(buf);
    }
    // 「……」って。 のように、行頭に置けない字で始まる切れ端は前にくっつける。
    // 離すとページの頭が「って」から始まってしまう
    const merged = [];
    for (const u of out) {
      if (merged.length && NO_HEAD.test(u[0])) merged[merged.length - 1] += u;
      else merged.push(u);
    }
    return merged;
  }

  /**
   * 文や台詞を、順に足しては2行で送る。
   * 1つで2行に収まらないものは中で割れるので、その継ぎ目に印を付ける
   */
  function pack(units) {
    const pages = [];
    let held = '', head = true;          // head: このページが文の頭から始まるか
    const flush = () => {
      if (held === '') return;
      const lines = wrap(held);
      for (let i = 0; i < lines.length; i += LINES) {
        pages.push({ lines: lines.slice(i, i + LINES), head: i === 0 ? head : false });
      }
      held = '';
    };
    // 閉じない台詞（何ページも続く長台詞の頭）は、地の文と同じページに置かない。
    // 置くと、そのページだけ誰の声か分からなくなる
    const opens = u => u.startsWith('「') && !u.includes('」');
    for (const u of units) {
      if (held === '') { held = u; head = true; continue; }
      if (!opens(u) && wrap(held + u).length <= LINES) held += u;
      else { flush(); held = u; head = true; }
    }
    flush();
    return pages;
  }

  /** 1ページに収まらない台詞を、中の句点で割ってから詰め直す */
  function split(s) {
    if (wrap(s).length <= LINES) return [s];
    const out = [];
    let buf = '';
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
      buf += chars[i];
      if (/[。！？]/.test(chars[i])) {
        let j = i + 1;
        while (j < chars.length && /[』）！？…　 ]/.test(chars[j])) { buf += chars[j]; j++; }
        i = j - 1;
        out.push(buf); buf = '';
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  /** 本文をページの配列（1ページ = 行の配列）にする */
  function pages(text) {
    const out = [];
    for (const block of String(text).split(/\n[ \t]*\n/)) {
      const units = [];
      for (const u of sentences(block.replace(/\n/g, ''))) units.push(...split(u));
      out.push(...pack(units));
    }
    return out.length ? out : [{ lines: [''], head: true }];
  }

  function paginate(text) { return pages(text).map(p => p.lines); }

  /**
   * 組んでみて具合の悪いところを挙げる。書いた文章を直すための道具で、
   * 「読めない」ではなく「間が抜けて見える」を拾う。
   *
   *   cut   … 文の途中で▼が入る。次のページが助詞から始まって読みが切れる
   *   quote … 地の文と、閉じない台詞が同じページに乗る。誰の声か分からなくなる
   *
   * 台詞が何ページも続くのは普通なので、それは咎めない
   */
  function faults(text) {
    const ps = pages(text);
    const bad = [];
    ps.forEach((p, i) => {
      if (i > 0 && !p.head) {
        bad.push({ kind: 'cut', page: i + 1, note: '文の途中でページが送られる', text: p.lines.join('') });
      }
      const s = p.lines.join('');
      const at = s.indexOf('「');
      if (at > 0 && !s.slice(at).includes('」') && i < ps.length - 1) {
        bad.push({ kind: 'quote', page: i + 1, note: '地の文の途中から台詞が始まって、そのページで閉じない', text: s });
      }
    });
    return bad;
  }

  return { WIDTH, LINES, width, wrap, segments, sentences, paginate, faults };
}));

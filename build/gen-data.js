#!/usr/bin/env node
'use strict';
/** data/software.json をブラウザからも読めるJSに変換する（file:// では fetch できないため） */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const json = fs.readFileSync(path.join(root, 'data', 'software.json'), 'utf8');
const out = `'use strict';
/* このファイルは build/gen-data.js が data/software.json から自動生成します。直接編集しないこと */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoftwareData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return ${json.trim()};
});
`;
fs.writeFileSync(path.join(root, 'src', 'software-data.js'), out);
console.log('wrote src/software-data.js');

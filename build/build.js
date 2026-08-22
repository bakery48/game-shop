#!/usr/bin/env node
'use strict';
/** src/*.js を1枚のHTMLに埋め込んで dist/prototype.html を作る（配布・共有用） */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const parts = ['software-data.js', 'catalog.js', 'engine.js', 'policy.js', 'ui.js']
  .map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8'));
const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const scripts = parts.map(src => '<script>\n' + src.replace(/<\/script>/gi, '<\\/script>') + '\n</script>').join('\n');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'prototype.html');
fs.writeFileSync(out, tpl + '\n' + scripts + '\n');
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + 'KB');

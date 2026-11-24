// CSV для Excel: UTF-8 з позначкою BOM (щоб Excel правильно показав кирилицю), роздільник «;», рядки через CRLF.
// Значення, яке Excel сприйняв би як формулу (=, @, +…, -…), отримує апостроф на початку; телефони +380… не чіпаємо.
function cell(v) {
  let s = String(v ?? '');
  if (/^[=@]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s()-]+$/.test(s))) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const toCsv = (lines) => '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n';
function sendCsv(res, filename, lines) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(lines));
}
module.exports = { toCsv, sendCsv, cell };

// Повне видалення клієнта на його прохання (право на видалення персональних даних, сторінка /privacy).
// Клієнт = останні 9 цифр телефону. Видаляється все, що з ним пов'язано:
//   записи (і майбутні), відгуки до них, нотатки, архів, фото стоп (разом із файлами) і позначки згоди,
//   кабінет клієнта з сесіями й кодами, заявки в черзі очікування, нагадування курсу лікування.
// Історія складу матеріалів лишається, але відв'язується від записів (там немає даних клієнта).
// Не пов'язані з телефоном і тому не видаляються тут: анонімний чат на сайті, імена в подарункових сертифікатах.
// У резервних копіях дані зникнуть, коли старі копії видаляться (BACKUP_KEEP_DAYS).
// Лише для суперадміна: маршрутів немає в MASTER_ROUTES. Для підтвердження потрібні останні 4 цифри телефону.
const fs = require('fs');
const path = require('path');

function setupClientErase({ app, db, dataDir, todayStr, last9, notifyMasterOf, waitlistCheck, live = () => {} }) {
  const photoDir = path.join(dataDir, 'private', 'client-photos');
  const isKey = (k) => /^\d{9}$/.test(k);
  const apptsOf = (key) => db.prepare('SELECT id, date, start_time, status, client_name, client_phone, master_id FROM appointments').all()
    .filter((a) => last9(a.client_phone) === key);
  const waitOf = (key) => db.prepare('SELECT id, phone FROM waitlist').all().filter((w) => last9(w.phone) === key);

  function preview(key) {
    const appts = apptsOf(key);
    const ids = appts.map((a) => a.id);
    const inIds = ids.length ? `(${ids.map(() => '?').join(',')})` : '(NULL)';
    const today = todayStr();
    return {
      name: appts.length ? appts[appts.length - 1].client_name : (db.prepare('SELECT name FROM accounts WHERE phone_key = ?').get(key)?.name || ''),
      appointments: appts.length,
      future: appts.filter((a) => a.date >= today && ['new', 'confirmed'].includes(a.status)).length,
      reviews: db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE appointment_id IN ${inIds}`).get(...ids).n,
      photos: db.prepare('SELECT COUNT(*) AS n FROM client_photos WHERE phone_key = ?').get(key).n,
      note: !!db.prepare("SELECT 1 FROM client_notes WHERE phone_key = ? AND note != ''").get(key),
      account: !!db.prepare('SELECT 1 FROM accounts WHERE phone_key = ?').get(key),
      waitlist: waitOf(key).length,
    };
  }

  app.get('/api/admin/clients/:key/erase-preview', (req, res) => {
    const key = req.params.key;
    if (!isKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    const p = preview(key);
    if (!p.appointments && !p.account && !p.waitlist && !p.photos && !p.note) return res.status(404).json({ error: 'Клієнта не знайдено' });
    res.json(p);
  });

  app.delete('/api/admin/clients/:key', (req, res) => {
    const key = req.params.key;
    if (!isKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    if (String(req.body?.confirm ?? '') !== key.slice(-4)) {
      return res.status(400).json({ error: 'Для підтвердження вкажіть останні 4 цифри телефону клієнта' });
    }
    const p = preview(key);
    if (!p.appointments && !p.account && !p.waitlist && !p.photos && !p.note) return res.status(404).json({ error: 'Клієнта не знайдено' });
    const appts = apptsOf(key);
    const today = todayStr();
    const futureAppts = appts.filter((a) => a.date >= today && ['new', 'confirmed'].includes(a.status));
    const files = db.prepare('SELECT file FROM client_photos WHERE phone_key = ?').all(key).map((r) => r.file);

    db.transaction(() => {
      const ids = appts.map((a) => a.id);
      for (const id of ids) {
        db.prepare('DELETE FROM reviews WHERE appointment_id = ?').run(id);
        db.prepare('DELETE FROM course_reminders WHERE start_appt_id = ?').run(id);
        db.prepare('UPDATE material_moves SET appt_id = NULL WHERE appt_id = ?').run(id);
        db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
      }
      for (const w of waitOf(key)) db.prepare('DELETE FROM waitlist WHERE id = ?').run(w.id);
      for (const t of ['client_notes', 'client_archive', 'client_photo_consent', 'client_photos']) {
        db.prepare(`DELETE FROM ${t} WHERE phone_key = ?`).run(key);
      }
      const acc = db.prepare('SELECT id FROM accounts WHERE phone_key = ?').get(key);
      if (acc) {
        db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(acc.id);
        db.prepare("DELETE FROM account_codes WHERE kind = 'link' AND value = ?").run(String(acc.id));
        db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
      }
      db.prepare("DELETE FROM account_codes WHERE kind = 'reset' AND key = ?").run(key);
    })();

    // Файли фото — після успішного видалення записів з бази; синхронно, щоб на момент відповіді їх уже не було
    for (const f of files) {
      if (!/^[\w.-]+$/.test(f)) continue;
      try { fs.rmSync(path.join(photoDir, f), { force: true }); } catch (e) { console.error('Видалення фото клієнта:', e.message); }
    }
    // Майстрам — про зниклі майбутні записи; звільнений час — черзі очікування
    for (const a of futureAppts) {
      notifyMasterOf(a.master_id, `🗑 Запис видалено на прохання клієнта\n${a.date.split('-').reverse().join('.')} о ${a.start_time}\n${a.client_name}`);
    }
    if (futureAppts.length) waitlistCheck();
    if (appts.length) live('changed', {}, [...new Set(appts.map((a) => a.master_id))]); // відкриті адмінки оновлять розклад
    res.json({ ok: true, deleted: p });
  });
}

module.exports = { setupClientErase };

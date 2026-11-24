// «Майстер не вийде»: що робити з його записами на ці дні — за один раз.
// Для кожного запису сайт пропонує вільного майстра на той самий час (якщо такий є)
// або найближчий вільний час; адміністратор погоджує або змінює вибір і застосовує все разом.
// - Передача іншому майстру на той самий час дозволена навіть менш ніж за годину до візиту:
//   клієнт прийде, як планував. Перенесення на інший час — за звичайним правилом (не раніше ніж за годину).
// - За бажанням закриваються робочі години майстра на ці дні (разові блокування), щоб не було нових записів.
// - Клієнтам із Telegram бот пише сам; для решти повертається список, кому подзвонити.
// Лише для суперадміна: маршрутів немає в MASTER_ROUTES.

const MAX_DAYS = 31;        // найдовший період за один раз
const SUGGEST_DAYS = 14;    // на скільки днів уперед шукати інший час
const SUGGEST_MAX = 6;      // скільки варіантів іншого часу показувати
const SUGGEST_PER_DAY = 3;  // і не більше стількох на один день
const SUGGEST_GAP_MIN = 120; // варіанти одного дня — не ближче ніж через 2 год один від одного

function setupReassign(ctx) {
  const {
    app, db, telegram, masterFreeSlots, masterFreeAt, workHours, bufferMin, nowMin, weekdayOf,
    toMin, toHHMM, todayStr, addDays, isValidDate, isTime, last9, notifyMasterOf, setStatus, waitlistCheck, studioPhone, live = () => {},
  } = ctx;
  const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const fmt = (d) => d.split('-').reverse().join('.');
  const dayLabel = (d) => `${WD[weekdayOf(d)]} ${fmt(d)}`;
  const masterName = (id) => db.prepare('SELECT name FROM masters WHERE id = ?').get(id)?.name || '';
  const chatFor = (a) => a.tg_chat_id
    || db.prepare('SELECT tg_chat_id FROM accounts WHERE phone_key = ?').get(last9(a.client_phone))?.tg_chat_id
    || null;
  // Активні майстри, які роблять цю послугу
  const offering = (serviceId) => db.prepare(`SELECT m.id, m.name FROM masters m JOIN master_services ms ON ms.master_id = m.id
    WHERE m.status = 'active' AND ms.service_id = ? ORDER BY m.id`).all(serviceId);
  const durationOf = (a) => toMin(a.end_time) - toMin(a.start_time);
  const started = (a) => a.date < todayStr() || (a.date === todayStr() && toMin(a.start_time) <= nowMin());
  const contact = () => (studioPhone() ? ` або подзвоніть: ${studioPhone()}` : '');

  function parseRange(src) {
    const id = Number(src?.masterId);
    const master = Number.isInteger(id) && id > 0
      && db.prepare("SELECT id, name, status FROM masters WHERE id = ? AND status != 'deleted'").get(id);
    if (!master) return { status: 404, error: 'Майстра не знайдено' };
    const from = String(src.from || '');
    const to = String(src.to || '');
    if (!isValidDate(from) || !isValidDate(to)) return { status: 400, error: 'Вкажіть дати' };
    if (from < todayStr()) return { status: 400, error: 'Початок — не раніше сьогодні' };
    if (to < from) return { status: 400, error: 'Кінець має бути не раніше початку' };
    if (to > addDays(from, MAX_DAYS - 1)) return { status: 400, error: `Не більше ${MAX_DAYS} днів за раз` };
    return { master, from, to };
  }

  const listAppts = (masterId, from, to) => db.prepare(`SELECT a.*, s.name AS service FROM appointments a JOIN services s ON s.id = a.service_id
    WHERE a.master_id = ? AND a.date BETWEEN ? AND ? AND a.status IN ('new', 'confirmed') ORDER BY a.date, a.start_time`).all(masterId, from, to);

  // Робочі дні майстра в періоді (їх закриють разові блокування)
  function workDays(masterId, from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const h = workHours(db, d, masterId);
      if (h) out.push({ date: d, start_time: toHHMM(h.start), end_time: toHHMM(h.end) });
    }
    return out;
  }

  // Інший час: від дня запису вперед; сам майстер — лише поза днями, коли його немає.
  // taken — уже розподілені в цьому плані проміжки, щоб варіанти не збігалися з ними.
  function suggest(a, absent, from, to, taken) {
    const dur = durationOf(a);
    const buffer = bufferMin(db);
    const masters = offering(a.service_id);
    const out = [];
    const start = a.date > todayStr() ? a.date : todayStr();
    for (let i = 0; i < SUGGEST_DAYS && out.length < SUGGEST_MAX; i++) {
      const d = addDays(start, i);
      const opts = [];
      for (const m of masters) {
        if (m.id === absent && d >= from && d <= to) continue;
        for (const t of masterFreeSlots(db, d, dur, m.id, a.id)) {
          if (d === a.date && t === a.start_time) continue; // той самий час — це варіант «інший майстер»
          const s = toMin(t);
          if (taken.some((x) => x.mid === m.id && x.date === d && s < x.e + buffer && s + dur > x.s)) continue;
          opts.push({ date: d, time: t, master_id: m.id, master: m.name, label: `${dayLabel(d)} о ${t} · ${m.name}` });
        }
      }
      // свій майстер — першим серед однакового часу: клієнтові звичніше
      opts.sort((x, y) => x.time.localeCompare(y.time) || (x.master_id === a.master_id ? -1 : y.master_id === a.master_id ? 1 : x.master_id - y.master_id));
      let lastMin = -Infinity;
      let perDay = 0;
      for (const o of opts) {
        if (perDay >= SUGGEST_PER_DAY || out.length >= SUGGEST_MAX) break;
        if (toMin(o.time) - lastMin < SUGGEST_GAP_MIN) continue;
        out.push(o);
        lastMin = toMin(o.time);
        perDay++;
      }
    }
    return out;
  }

  // План: для кожного запису варіанти й рекомендований вибір.
  // Рекомендації розподіляються по черзі, щоб одному майстру не дісталося два записи на той самий час.
  function plan(master, from, to) {
    const buffer = bufferMin(db);
    const taken = [];
    const load = new Map();
    const loadOf = (mid, date) => {
      const k = `${mid}|${date}`;
      if (!load.has(k)) load.set(k, db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE master_id = ? AND date = ? AND status != 'cancelled'").get(mid, date).n);
      return load.get(k);
    };
    return listAppts(master.id, from, to).map((a) => {
      const dur = durationOf(a);
      const s = toMin(a.start_time);
      const isStarted = started(a);
      const sameTime = isStarted ? [] : offering(a.service_id)
        .filter((m) => m.id !== master.id && masterFreeAt(db, a.date, a.start_time, dur, m.id, 0, 0));
      const clash = (mid) => taken.some((x) => x.mid === mid && x.date === a.date && s < x.e + buffer && s + dur > x.s);
      const free = sameTime.filter((m) => !clash(m.id)).sort((x, y) => loadOf(x.id, a.date) - loadOf(y.id, a.date) || x.id - y.id);
      let def = { type: 'keep' };
      if (free.length) {
        def = { type: 'master', master_id: free[0].id };
        taken.push({ mid: free[0].id, date: a.date, s, e: s + dur });
        load.set(`${free[0].id}|${a.date}`, loadOf(free[0].id, a.date) + 1);
      }
      const slots = suggest(a, master.id, from, to, taken);
      if (def.type === 'keep' && slots.length) {
        def = { type: 'time', date: slots[0].date, time: slots[0].time, master_id: slots[0].master_id };
        taken.push({ mid: slots[0].master_id, date: slots[0].date, s: toMin(slots[0].time), e: toMin(slots[0].time) + dur });
      }
      return {
        id: a.id, date: a.date, start_time: a.start_time, end_time: a.end_time, status: a.status, started: isStarted,
        service: a.service, service_id: a.service_id, client_name: a.client_name, client_phone: a.client_phone,
        telegram: !!chatFor(a), same_time: sameTime.map(({ id, name }) => ({ id, name })), slots, default: def,
      };
    });
  }

  app.get('/api/admin/reassign', (req, res) => {
    const r = parseRange(req.query);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({
      master: { id: r.master.id, name: r.master.name }, from: r.from, to: r.to,
      work_days: workDays(r.master.id, r.from, r.to),
      appointments: plan(r.master, r.from, r.to),
    });
  });

  // Закрити робочі години майстра на ці дні (повторно ті самі блокування не створюються)
  function blockDays(masterId, from, to, note) {
    const exists = db.prepare('SELECT 1 FROM blocks WHERE master_id = ? AND date = ? AND start_time = ? AND end_time = ?');
    const ins = db.prepare('INSERT INTO blocks (date, start_time, end_time, note, master_id) VALUES (?, ?, ?, ?, ?)');
    const text = ('Майстер не працює' + (note ? ': ' + note : '')).slice(0, 100);
    let n = 0;
    db.transaction(() => {
      for (const d of workDays(masterId, from, to)) {
        if (exists.get(masterId, d.date, d.start_time, d.end_time)) continue;
        ins.run(d.date, d.start_time, d.end_time, text, masterId);
        n++;
      }
    })();
    return n;
  }

  const activeOffering = (mid, serviceId) => offering(serviceId).find((m) => m.id === mid) || null;

  // Одна дія над записом. Кидає помилку з поясненням, якщо виконати не можна.
  function applyOne(a, act, r) {
    const base = { type: act.type, service: a.service, client_name: a.client_name, client_phone: a.client_phone, telegram: !!chatFor(a), date: a.date, time: a.start_time };
    const chat = chatFor(a);
    const dur = durationOf(a);
    if (act.type === 'keep') return base;

    if (act.type === 'master') {
      const m = activeOffering(Number(act.master_id), a.service_id);
      if (!m) throw new Error('Цей майстер не виконує цю послугу або заблокований');
      if (m.id === a.master_id) throw new Error('Обрано того самого майстра');
      if (started(a)) throw new Error('Запис уже почався — перенесіть його на інший час або скасуйте');
      db.transaction(() => {
        if (!masterFreeAt(db, a.date, a.start_time, dur, m.id, a.id, 0)) throw new Error(`У майстра ${m.name} цей час уже зайнятий`);
        db.prepare('UPDATE appointments SET master_id = ? WHERE id = ?').run(m.id, a.id);
      })();
      if (chat) {
        telegram.sendToClient(chat, `🔁 Зміна майстра: ваш запис «${a.service}», ${fmt(a.date)} о ${a.start_time} — тепер до майстра ${m.name}. ` +
          `Час той самий. Якщо вам це не підходить, напишіть нам${contact()}.`);
      }
      notifyMasterOf(m.id, `🗓 Вам передано запис\n${a.service}\n${fmt(a.date)} о ${a.start_time}\n${a.client_name}, ${a.client_phone}`);
      return { ...base, new: { date: a.date, time: a.start_time, master: m.name } };
    }

    if (act.type === 'time') {
      const date = String(act.date || '');
      const time = String(act.time || '');
      if (!isValidDate(date) || date < todayStr() || date > addDays(todayStr(), 365)) throw new Error('Некоректна дата');
      if (!isTime(time)) throw new Error('Некоректний час');
      const mid = Number(act.master_id) || a.master_id;
      if (mid === r.master.id && date >= r.from && date <= r.to) throw new Error('Майстер у ці дні не працює — оберіть іншого майстра або інший день');
      const m = activeOffering(mid, a.service_id);
      if (!m) throw new Error('Цей майстер не виконує цю послугу або заблокований');
      db.transaction(() => {
        if (!masterFreeAt(db, date, time, dur, mid, a.id)) throw new Error(`Час ${dayLabel(date)} о ${time} у майстра ${m.name} уже зайнятий`);
        db.prepare('UPDATE appointments SET date = ?, start_time = ?, end_time = ?, master_id = ?, reminded = 0 WHERE id = ?')
          .run(date, time, toHHMM(toMin(time) + dur), mid, a.id);
      })();
      if (chat) {
        telegram.sendToClient(chat, `🔁 Ваш запис перенесено: «${a.service}», ${fmt(date)} о ${time}, майстер ${m.name}. ` +
          `Вибачте за незручність. Якщо час не підходить, напишіть нам${contact()}.`);
      }
      notifyMasterOf(mid, mid === a.master_id
        ? `🔁 Ваш запис перенесено\n${a.service}\n${fmt(date)} о ${time}\n${a.client_name}, ${a.client_phone}`
        : `🗓 Вам передано запис\n${a.service}\n${fmt(date)} о ${time}\n${a.client_name}, ${a.client_phone}`);
      return { ...base, new: { date, time, master: m.name } };
    }

    if (act.type === 'cancel') {
      setStatus(a.id, 'cancelled');
      if (chat && !started(a)) {
        telegram.sendToClient(chat, `На жаль, ${fmt(a.date)} о ${a.start_time} майстер не зможе вас прийняти, тому запис «${a.service}» скасовано. ` +
          `Вибачте за незручність. Щоб обрати інший час, запишіться на сайті${contact()}.`);
      }
      return base;
    }

    throw new Error('Невідома дія');
  }

  app.post('/api/admin/reassign', (req, res) => {
    const body = req.body || {};
    const r = parseRange(body);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const actions = Array.isArray(body.actions) ? body.actions : [];
    if (actions.length > 1000) return res.status(400).json({ error: 'Забагато записів за раз' });
    const note = String(body.note ?? '').trim().slice(0, 80);

    const blocksCreated = body.block ? blockDays(r.master.id, r.from, r.to, note) : 0;

    const pending = new Map(listAppts(r.master.id, r.from, r.to).map((a) => [a.id, a]));
    const results = [];
    for (const act of actions) {
      const id = Number(act?.id);
      const a = pending.get(id);
      if (!a) {
        results.push({ id, ok: false, error: 'Запису немає серед активних записів цього майстра на ці дні (можливо, його вже змінили)' });
        continue;
      }
      pending.delete(id); // одна дія на запис
      try {
        results.push({ id, ok: true, ...applyOne(a, act || {}, r) });
      } catch (e) {
        results.push({ id, ok: false, error: e.message, type: act?.type, service: a.service, client_name: a.client_name, client_phone: a.client_phone, date: a.date, time: a.start_time });
      }
    }

    const ok = results.filter((x) => x.ok);
    const count = (t) => ok.filter((x) => x.type === t).length;
    const counts = { master: count('master'), time: count('time'), cancel: count('cancel'), keep: count('keep'), failed: results.length - ok.length };
    const callList = ok.filter((x) => x.type !== 'keep' && !x.telegram);
    if (counts.cancel || counts.time) waitlistCheck(); // звільнився час: може, хтось у черзі на нього чекає

    const period = r.from === r.to ? fmt(r.from) : `${fmt(r.from)}–${fmt(r.to)}`;
    const changed = counts.master + counts.time + counts.cancel;
    if (changed || blocksCreated) {
      telegram.notifyMaster(`🧑‍⚕️ Майстер ${r.master.name} не працює ${period}.\n` +
        `Передано іншим майстрам: ${counts.master}, перенесено на інший час: ${counts.time}, скасовано: ${counts.cancel}, без змін: ${counts.keep}.` +
        (counts.failed ? `\nНе вдалося: ${counts.failed}.` : '') +
        (callList.length ? `\nПодзвонити (без Telegram): ${callList.length}.` : '') +
        (blocksCreated ? `\nЗапис до майстра закрито на днів: ${blocksCreated}.` : ''));
      notifyMasterOf(r.master.id, `📋 Ваші записи на ${period} опрацьовано: передано іншим — ${counts.master}, перенесено — ${counts.time}, скасовано — ${counts.cancel}.` +
        (blocksCreated ? ' Запис до вас на ці дні закрито.' : ''));
    }
    if (changed) {
      // адмінка наживо: оновити розклад у майстра, якого немає, і в тих, кому передали записи
      const touched = [...new Set([r.master.id, ...actions.filter((x) => x.master_id).map((x) => Number(x.master_id))])];
      live('changed', {}, touched);
    }
    res.json({ results, counts, blocks_created: blocksCreated, call_list: callList });
  });
}

module.exports = { setupReassign };

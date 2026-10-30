/* Autoplaner – App-Oberfläche. Logik zur Konfliktprüfung steht in logic.js. */
(function () {
  'use strict';

  var API_URL = String(window.AUTOPLANER_API || '').trim();
  var MOCK = !API_URL || /[?&]testmodus/.test(location.search); // ?testmodus = Beispieldaten statt Google
  var HOUR_PX = 52;
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var COLUMNS = CARS.concat([ANY_CAR]);
  var WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  var MODES = ['day', 'week', 'month'];

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Speicher auf dem Gerät ---------- */
  var store = {
    get: function (k) { try { return localStorage.getItem('autoplaner.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('autoplaner.' + k, v); } catch (e) { /* egal */ } }
  };

  /* ---------- Datum & Zeit ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function weekStart(ms) { var d = new Date(startOfDay(ms)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }
  function monthStart(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  function addMonths(ms, n) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); }
  function isoWeek(ms) {
    var d = new Date(startOfDay(ms));
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7); // Donnerstag dieser Woche
    var jan4 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - jan4) / DAY - 3 + (jan4.getDay() + 6) % 7) / 7);
  }
  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dm(ms) { var d = new Date(ms); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.'; }
  function wdm(ms) { return WEEKDAYS[new Date(ms).getDay()] + ' ' + dm(ms); }
  function minutesInDay(ms, dayStart) {
    if (ms <= dayStart) return 0;
    if (ms >= addDays(dayStart, 1)) return 1440;
    var d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  }
  function toInput(ms) { return ymd(ms) + 'T' + hm(ms); }
  function fromInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
  }
  function fromDateInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3]).getTime() : NaN;
  }
  function dayName(dayStart) {
    var diff = Math.round((dayStart - startOfDay(Date.now())) / DAY);
    var prefix = diff === 0 ? 'Heute · ' : diff === 1 ? 'Morgen · ' : diff === -1 ? 'Gestern · ' : '';
    return prefix + wdm(dayStart);
  }
  /** „08:00–12:00“ oder mit Datum, wenn die Buchung über mehrere Tage geht. */
  function rangeText(b, refDay) {
    var sameDay = ymd(b.start) === ymd(b.end - 1);
    if (sameDay && refDay && ymd(b.start) === ymd(refDay)) return hm(b.start) + '–' + hm(b.end);
    if (sameDay) return wdm(b.start) + ', ' + hm(b.start) + '–' + hm(b.end);
    return wdm(b.start) + ' ' + hm(b.start) + ' – ' + wdm(b.end) + ' ' + hm(b.end);
  }
  function overlapping(list, from, to) {
    return list.filter(function (b) { return b.start < to && b.end > from; })
      .sort(function (a, b) { return a.start - b.start; });
  }
  var FMT = { day: ymd, time: hm, date: dm };

  /* ---------- Verbindung zum Google-Script ---------- */
  function userError(message, data) {
    var e = new Error(message);
    e.user = true;
    if (data && data.conflicts) e.conflicts = data.conflicts;
    return e;
  }

  var api = MOCK ? mockApi() : {
    list: function (from, to) {
      return call(fetch(API_URL + '?action=list&from=' + from + '&to=' + to)).then(function (d) { return d.bookings; });
    },
    save: function (b) { return post({ action: 'save', booking: b }).then(function (d) { return d.booking; }); },
    saveSeries: function (b, occurrences, skip) {
      return post({ action: 'saveSeries', booking: b, occurrences: occurrences, skipConflicts: !!skip });
    },
    remove: function (b, wholeSeries) {
      return post({ action: 'delete', id: b.id, series: wholeSeries ? b.series : null, from: b.start });
    }
  };

  function post(body) {
    return call(fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // kein CORS-Preflight nötig
      body: JSON.stringify(body)
    }));
  }
  function call(request) {
    return request.then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data.ok) throw userError(data.error || 'Unbekannter Fehler.', data);
      return data;
    });
  }

  /** Testmodus: gleiche Schnittstelle, Daten liegen nur im Browser. */
  function mockApi() {
    function load() {
      var raw = store.get('mock');
      if (raw) { try { return JSON.parse(raw); } catch (e) { /* neu anlegen */ } }
      var t = startOfDay(Date.now());
      var demo = [
        { id: 'm1', car: 'schwarz', person: 'Papa', note: 'Arbeit', start: t + 7 * HOUR, end: t + 17 * HOUR },
        { id: 'm2', car: 'blau', person: 'Mama', note: 'Einkaufen', start: t + 9 * HOUR, end: t + 11.5 * HOUR },
        { id: 'm3', car: 'any', person: 'Lena', note: 'Training', start: t + 15 * HOUR, end: t + 18 * HOUR },
        { id: 'm4', car: 'elektro', person: 'Mama', note: '', start: addDays(t, 1) + 8 * HOUR, end: addDays(t, 1) + 12 * HOUR }
      ];
      save(demo);
      return demo;
    }
    function save(all) { store.set('mock', JSON.stringify(all)); }
    function later(fn) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { try { resolve(fn()); } catch (e) { reject(e); } }, 250);
      });
    }
    var n = 0;
    function newId() { return 'm' + Date.now() + '-' + (n++); }
    return {
      list: function (from, to) {
        return later(function () { return overlapping(load(), from, to); });
      },
      save: function (b) {
        return later(function () {
          var all = load();
          var invalid = validateBooking(b);
          if (invalid) throw userError(invalid);
          var conflict = checkBooking(b, all, FMT);
          if (conflict) throw userError(conflict.message);
          if (b.id) {
            if (!all.some(function (o) { return o.id === b.id; })) throw userError('Diese Buchung gibt es nicht mehr.');
            all = all.map(function (o) { return o.id === b.id ? Object.assign({}, o, b) : o; });
          } else {
            b.id = newId();
            all.push(b);
          }
          save(all);
          return b;
        });
      },
      saveSeries: function (base, occurrences, skip) {
        return later(function () {
          var invalid = validateSeries(occurrences);
          if (invalid) throw userError(invalid);
          var all = load();
          var plan = planSeries(base, occurrences, all, FMT);
          if (plan.conflicts.length && (!skip || !plan.accepted.length)) {
            throw userError(plan.accepted.length
              ? 'An ' + plan.conflicts.length + ' von ' + occurrences.length + ' Terminen geht es nicht.'
              : 'Keiner der Termine ist frei.', { conflicts: plan.conflicts });
          }
          var series = 's' + Date.now();
          var created = plan.accepted.map(function (b) { return Object.assign({}, b, { id: newId(), series: series }); });
          save(all.concat(created));
          return { bookings: created, skipped: plan.conflicts.length };
        });
      },
      remove: function (b, wholeSeries) {
        return later(function () {
          save(load().filter(function (o) {
            return wholeSeries ? !(o.series === b.series && o.start >= b.start) : o.id !== b.id;
          }));
          return {};
        });
      }
    };
  }

  /* ---------- Zustand ---------- */
  var savedMode = store.get('mode');
  var state = {
    me: store.get('name') || '',
    day: startOfDay(Date.now()),
    mode: MODES.indexOf(savedMode) >= 0 ? savedMode : 'day',
    bookings: [],
    view: 'day',
    listFilter: 'mine',
    detail: null,
    form: null,
    loadToken: 0
  };
  var cache = {};

  function isMine(b) { return b.person.trim().toLowerCase() === state.me.trim().toLowerCase(); }

  /* ---------- Hilfen für die Oberfläche ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function errorText(err) {
    return err && err.user ? err.message : 'Keine Verbindung. Bitte prüfe dein Internet und versuch es nochmal.';
  }
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }

  /* ---------- Kalender: Tag / Woche / Monat ---------- */
  function calRange() {
    if (state.mode === 'week') {
      var ws = weekStart(state.day);
      return { from: ws, to: addDays(ws, 7) };
    }
    if (state.mode === 'month') {
      var gs = weekStart(monthStart(state.day));
      return { from: gs, to: addDays(gs, 42) };
    }
    return { from: state.day, to: addDays(state.day, 1) };
  }

  function loadCal(opts) {
    var r = calRange();
    var key = state.mode + '.' + ymd(r.from);
    var token = ++state.loadToken;
    renderDateBar();
    if (cache[key]) state.bookings = cache[key];
    else {
      var saved = store.get('cal.' + key);
      try { state.bookings = saved ? JSON.parse(saved) : []; } catch (e) { state.bookings = []; }
    }
    renderCal(opts && opts.scroll);
    $('loading').hidden = false;
    return api.list(r.from, r.to).then(function (list) {
      cache[key] = list;
      store.set('cal.' + key, JSON.stringify(list));
      if (token !== state.loadToken) return;
      state.bookings = list;
      renderCal(false);
    }).catch(function (err) {
      if (token === state.loadToken) toast(errorText(err));
    }).then(function () {
      if (token === state.loadToken) $('loading').hidden = true;
    });
  }

  function renderDateBar() {
    var r = calRange();
    var now = Date.now();
    var text;
    if (state.mode === 'week') text = 'KW ' + isoWeek(r.from) + ' · ' + dm(r.from) + '–' + dm(addDays(r.from, 6));
    else if (state.mode === 'month') text = MONTHS[new Date(state.day).getMonth()] + ' ' + new Date(state.day).getFullYear();
    else text = dayName(state.day);
    $('date-text').textContent = text;
    $('date-input').value = ymd(state.day);
    var showsToday = state.mode === 'month'
      ? monthStart(state.day) === monthStart(now)
      : now >= r.from && now < r.to;
    $('today-btn').hidden = showsToday;
    document.querySelectorAll('#modes button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
  }

  function renderCal(scroll) {
    var month = state.mode === 'month';
    $('grid-head').hidden = month;
    $('grid-scroll').hidden = month;
    $('month').hidden = !month;
    renderNowStrip(state.mode === 'day' && state.day === startOfDay(Date.now()));
    if (state.mode === 'week') renderWeek(scroll);
    else if (month) renderMonth();
    else renderDay(scroll);
  }

  function setCols(n, week) {
    $('grid-head').style.setProperty('--cols', n);
    $('grid').style.setProperty('--cols', n);
    $('grid').classList.toggle('week', !!week);
  }

  function hoursColumn() {
    var hours = el('div', 'hours');
    for (var h = 1; h < 24; h++) {
      var s = el('span', null, pad(h) + ':00');
      s.style.top = h * HOUR_PX + 'px';
      hours.appendChild(s);
    }
    return hours;
  }

  function nowLine() {
    var line = el('div', 'now-line');
    line.style.top = minutesInDay(Date.now(), startOfDay(Date.now())) / 60 * HOUR_PX + 'px';
    return line;
  }

  function scrollGrid(containsToday) {
    var target = containsToday ? minutesInDay(Date.now(), startOfDay(Date.now())) / 60 - 1.5 : 7;
    $('grid-scroll').scrollTop = Math.max(0, target) * HOUR_PX;
  }

  function renderDay(scroll) {
    var head = $('grid-head'), grid = $('grid');
    var dayStart = state.day;
    setCols(COLUMNS.length, false);
    head.innerHTML = '';
    head.appendChild(el('div'));
    COLUMNS.forEach(function (c) {
      var d = el('div', 'c-' + c.id);
      d.appendChild(el('span', 'emoji', c.emoji));
      d.appendChild(document.createTextNode(c.short));
      head.appendChild(d);
    });

    grid.innerHTML = '';
    grid.appendChild(hoursColumn());
    COLUMNS.forEach(function (car) {
      var col = el('div', 'col c-' + car.id);
      col.dataset.car = car.id;
      col.dataset.day = dayStart;
      var items = state.bookings.filter(function (b) { return b.car === car.id; })
        .sort(function (a, b) { return a.start - b.start; });
      layoutLanes(items).forEach(function (item) {
        col.appendChild(bookingBlock(item.b, dayStart, item.lane, item.lanes, false));
      });
      grid.appendChild(col);
    });

    var isToday = dayStart === startOfDay(Date.now());
    if (isToday) grid.appendChild(nowLine());
    if (scroll) scrollGrid(isToday);
  }

  function renderWeek(scroll) {
    var head = $('grid-head'), grid = $('grid');
    var ws = calRange().from;
    var today = startOfDay(Date.now());
    setCols(7, true);
    head.innerHTML = '';
    head.appendChild(el('div'));
    grid.innerHTML = '';
    grid.appendChild(hoursColumn());

    for (var i = 0; i < 7; i++) {
      var day = addDays(ws, i);
      var btn = el('button', 'dayhead' + (day === today ? ' today' : ''));
      btn.type = 'button';
      btn.appendChild(document.createTextNode(WEEKDAYS[new Date(day).getDay()]));
      btn.appendChild(el('b', null, String(new Date(day).getDate())));
      btn.setAttribute('aria-label', 'Tagesansicht ' + wdm(day));
      btn.addEventListener('click', setMode.bind(null, 'day', day));
      head.appendChild(btn);

      var col = el('div', 'col' + (day === today ? ' today' : ''));
      col.dataset.day = day;
      layoutLanes(overlapping(state.bookings, day, addDays(day, 1))).forEach(function (item) {
        col.appendChild(bookingBlock(item.b, this, item.lane, item.lanes, true));
      }, day);
      if (day === today) col.appendChild(nowLine());
      grid.appendChild(col);
    }
    if (scroll) scrollGrid(today >= ws && today < addDays(ws, 7));
  }

  function renderMonth() {
    var box = $('month');
    var gs = calRange().from;
    var month = new Date(state.day).getMonth();
    var today = startOfDay(Date.now());
    box.innerHTML = '';
    ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].forEach(function (w) { box.appendChild(el('div', 'wd', w)); });
    for (var i = 0; i < 42; i++) {
      var day = addDays(gs, i);
      var cell = el('button', 'mcell' + (new Date(day).getMonth() !== month ? ' other' : '') + (day === today ? ' today' : ''));
      cell.type = 'button';
      var num = el('div', 'num');
      num.appendChild(el('span', null, String(new Date(day).getDate())));
      cell.appendChild(num);
      var items = overlapping(state.bookings, day, addDays(day, 1));
      var shown = items.length > 3 ? 2 : 3;
      items.slice(0, shown).forEach(function (b) {
        cell.appendChild(el('span', 'mpill c-' + b.car, b.person));
      });
      if (items.length > shown) cell.appendChild(el('span', 'mmore', '+' + (items.length - shown) + ' weitere'));
      cell.setAttribute('aria-label', wdm(day) + ', ' + (items.length ? items.length + ' Buchungen' : 'frei'));
      cell.addEventListener('click', setMode.bind(null, 'day', day));
      box.appendChild(cell);
    }
  }

  /** Überlappende Buchungen in einer Spalte nebeneinander legen. */
  function layoutLanes(items) {
    var out = [], cluster = [], laneEnds = [], clusterEnd = -Infinity;
    function flush() {
      cluster.forEach(function (it) { it.lanes = laneEnds.length; });
      cluster = []; laneEnds = [];
    }
    items.forEach(function (b) {
      if (b.start >= clusterEnd) { flush(); clusterEnd = -Infinity; }
      var lane = laneEnds.findIndex(function (end) { return end <= b.start; });
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(b.end); } else laneEnds[lane] = b.end;
      var it = { b: b, lane: lane };
      cluster.push(it);
      out.push(it);
      clusterEnd = Math.max(clusterEnd, b.end);
    });
    flush();
    return out;
  }

  function bookingBlock(b, dayStart, lane, lanes, compact) {
    var top = minutesInDay(b.start, dayStart) / 60 * HOUR_PX;
    var bottom = minutesInDay(b.end, dayStart) / 60 * HOUR_PX;
    var height = Math.max(20, bottom - top - 2);
    var btn = el('button', 'booking c-' + b.car + (isMine(b) ? ' mine' : ''));
    btn.type = 'button';
    btn.style.top = top + 'px';
    btn.style.height = height + 'px';
    if (lanes > 1) {
      btn.style.left = 'calc(' + (lane / lanes * 100) + '% + 1px)';
      btn.style.right = 'auto';
      btn.style.width = 'calc(' + (100 / lanes) + '% - 2px)';
    }
    var time = hm(Math.max(b.start, dayStart)) + (b.end > addDays(dayStart, 1) ? ' →' : '–' + hm(b.end));
    if (compact) {
      btn.appendChild(el('b', null, b.person)); // Farbe zeigt das Auto
      if (lanes < 2 && height > 34) btn.appendChild(el('small', null, time));
    } else {
      btn.appendChild(el('b', null, (b.series ? '🔁 ' : '') + b.person));
      btn.appendChild(el('small', null, time));
      if (b.note && height > 50) btn.appendChild(el('small', null, b.note));
    }
    btn.setAttribute('aria-label', b.person + ', ' + carById(b.car).name + ', ' + rangeText(b));
    btn.addEventListener('click', function (e) { e.stopPropagation(); openDetail(b); });
    return btn;
  }

  function renderNowStrip(show) {
    var strip = $('now-strip');
    strip.innerHTML = '';
    if (!show) return;
    var now = Date.now();
    var active = state.bookings.filter(function (b) { return b.start <= now && b.end > now; });
    var busy = 0;
    CARS.forEach(function (car) {
      var card = el('div', 'now-card c-' + car.id);
      card.appendChild(el('b', null, car.emoji + ' ' + car.short));
      var cur = active.filter(function (b) { return b.car === car.id; })[0];
      if (cur) {
        busy++;
        card.appendChild(el('span', null, cur.person + ' bis ' + (ymd(cur.end) === ymd(now) ? hm(cur.end) : wdm(cur.end))));
      } else {
        var next = state.bookings.filter(function (b) { return b.car === car.id && b.start > now; })
          .sort(function (a, b) { return a.start - b.start; })[0];
        card.appendChild(el('span', 'free', next ? 'frei bis ' + hm(next.start) : 'frei'));
      }
      strip.appendChild(card);
    });
    var anyNow = active.filter(function (b) { return b.car === ANY_CAR.id; }).length;
    if (anyNow) {
      var left = Math.max(0, CARS.length - busy - anyNow);
      strip.appendChild(el('div', 'now-note',
        '🚗 ' + anyNow + '× „egal welches“ gebucht – ' +
        (left === 0 ? 'gerade kein Auto mehr frei' : 'noch ' + left + ' Auto' + (left > 1 ? 's' : '') + ' frei')));
    }
  }

  function setMode(mode, day) {
    state.mode = mode;
    store.set('mode', mode);
    if (day != null) state.day = startOfDay(day);
    loadCal({ scroll: true });
  }

  /** Zu einem Zeitpunkt springen (Ansicht bleibt), optional dorthin scrollen. */
  function goTo(ms, scrollTo) {
    state.day = startOfDay(ms);
    loadCal({ scroll: true });
    if (scrollTo && state.mode !== 'month') {
      $('grid-scroll').scrollTop = Math.max(0, minutesInDay(scrollTo, startOfDay(scrollTo)) / 60 - 1) * HOUR_PX;
    }
  }

  function step(dir) {
    if (state.mode === 'month') {
      var target = addMonths(state.day, dir);
      goTo(monthStart(target) === monthStart(Date.now()) ? Date.now() : target);
    } else {
      goTo(addDays(state.day, dir * (state.mode === 'week' ? 7 : 1)));
    }
  }

  /* ---------- Liste ---------- */
  function loadList() {
    var from = startOfDay(Date.now());
    var list = $('list');
    if (!list.children.length) list.appendChild(el('div', 'empty', 'Lade Buchungen …'));
    return api.list(from, addDays(from, 90)).then(function (all) {
      renderList(all);
    }).catch(function (err) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty', errorText(err)));
    });
  }

  function renderList(all) {
    var list = $('list');
    var now = Date.now();
    var items = all.filter(function (b) { return b.end > now && (state.listFilter === 'all' || isMine(b)); })
      .sort(function (a, b) { return a.start - b.start; });
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('div', 'empty', state.listFilter === 'mine'
        ? 'Du hast gerade keine Buchungen.\nTipp auf „Auto buchen“, um eins zu reservieren.'
        : 'In den nächsten 90 Tagen ist nichts gebucht.'));
      return;
    }
    var lastDay = '';
    items.forEach(function (b) {
      var day = ymd(Math.max(b.start, startOfDay(now)));
      if (day !== lastDay) {
        lastDay = day;
        list.appendChild(el('h3', null, dayName(startOfDay(Math.max(b.start, now)))));
      }
      var car = carById(b.car);
      var item = el('button', 'list-item c-' + b.car);
      item.type = 'button';
      item.appendChild(el('span', 'emoji', car.emoji));
      var text = el('div');
      text.appendChild(el('b', null, car.name + (state.listFilter === 'all' ? ' · ' + b.person : '') + (b.series ? ' 🔁' : '')));
      text.appendChild(el('span', null, rangeText(b, Math.max(b.start, now)) + (b.note ? ' · ' + b.note : '')));
      item.appendChild(text);
      item.addEventListener('click', function () { openDetail(b); });
      list.appendChild(item);
    });
  }

  /* ---------- Details ---------- */
  function openDetail(b) {
    state.detail = b;
    var car = carById(b.car);
    $('d-title').textContent = car.emoji + ' ' + car.name;
    var dl = $('d-body');
    dl.innerHTML = '';
    [['Wer', b.person], ['Wann', rangeText(b)], ['Notiz', b.note], ['Serie', b.series ? '🔁 Wiederholt sich' : '']].forEach(function (row) {
      if (!row[1]) return;
      dl.appendChild(el('dt', null, row[0]));
      dl.appendChild(el('dd', null, row[1]));
    });
    $('d-actions').hidden = false;
    $('d-series-delete').hidden = true;
    openSheet('sheet-detail');
  }

  function deleteDetail() {
    var b = state.detail;
    if (b.series) {
      $('d-actions').hidden = true;
      $('d-series-delete').hidden = false;
      return;
    }
    var question = isMine(b) ? 'Buchung wirklich löschen?' : 'Das ist die Buchung von ' + b.person + '. Trotzdem löschen?';
    if (window.confirm(question)) removeBooking(false);
  }

  function removeBooking(wholeSeries) {
    var b = state.detail;
    var buttons = document.querySelectorAll('#sheet-detail button');
    buttons.forEach(function (x) { x.disabled = true; });
    api.remove(b, wholeSeries).then(function () {
      closeSheet('sheet-detail');
      toast(wholeSeries ? 'Serie ab ' + dm(b.start) + ' gelöscht' : 'Buchung gelöscht');
      refresh();
    }).catch(function (err) { toast(errorText(err)); })
      .then(function () { buttons.forEach(function (x) { x.disabled = false; }); });
  }

  /* ---------- Buchen / Ändern ---------- */
  function defaultStart() {
    var now = Date.now();
    if (state.view === 'day' && state.day > now) return state.day + 8 * HOUR;
    var d = new Date(now + 15 * MIN);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return d.getTime();
  }

  function openForm(opts) {
    opts = opts || {};
    var b = opts.booking;
    var start = b ? b.start : opts.start || defaultStart();
    var end = b ? b.end : start + 2 * HOUR;
    state.form = { id: b ? b.id : null, person: b ? b.person : state.me, car: b ? b.car : opts.car || null, existing: null, token: 0 };
    lastStart = start;
    $('form-title').textContent = b ? (b.series ? 'Diesen Termin ändern' : 'Buchung ändern') : 'Auto buchen';
    $('form-submit').textContent = b ? 'Speichern' : 'Buchen';
    $('f-start').value = toInput(start);
    $('f-end').value = toInput(end);
    $('f-note').value = b ? b.note : '';
    $('repeat-field').hidden = !!b;
    $('f-repeat').value = '';
    $('f-until').value = '';
    $('f-until-wrap').hidden = true;
    hideFormError();
    closeSheet('sheet-detail');
    openSheet('sheet-form');
    updateRepeatInfo();
    loadAvailability();
  }

  function formBooking() {
    return {
      id: state.form.id,
      car: state.form.car,
      person: state.form.person || state.me,
      note: $('f-note').value.trim(),
      start: fromInput($('f-start').value),
      end: fromInput($('f-end').value)
    };
  }

  /** Termine der Wiederholung oder null, wenn sich nichts wiederholt. */
  function formOccurrences() {
    var rule = $('f-repeat').value;
    if (!rule || state.form.id) return null;
    var b = formBooking();
    var until = fromDateInput($('f-until').value);
    if (!(b.end > b.start) || !isFinite(until)) return [];
    return expandRepeat(b.start, b.end, rule, until);
  }

  var REPEAT_DEFAULT_DAYS = { daily: 13, weekdays: 13, weekly: 49, biweekly: 77, monthly: 150 };
  function onRepeatChange() {
    var rule = $('f-repeat').value;
    $('f-until-wrap').hidden = !rule;
    if (rule) {
      var start = fromInput($('f-start').value);
      var until = fromDateInput($('f-until').value);
      if (isFinite(start) && (!isFinite(until) || until < startOfDay(start))) {
        $('f-until').value = ymd(addDays(start, REPEAT_DEFAULT_DAYS[rule]));
      }
    }
    updateRepeatInfo();
    loadAvailability();
  }

  function updateRepeatInfo() {
    var info = $('f-repeat-info');
    var occ = formOccurrences();
    if (!occ) { info.textContent = ''; return; }
    var problem = validateSeries(occ);
    info.textContent = problem || occ.length + ' Termin' + (occ.length > 1 ? 'e' : '') + ', der letzte am ' + wdm(occ[occ.length - 1].start);
  }

  var availTimer;
  function loadAvailability() {
    var f = state.form;
    f.existing = null;
    renderTiles();
    clearTimeout(availTimer);
    availTimer = setTimeout(function () {
      var b = formBooking();
      if (!(b.end > b.start)) return;
      var occ = formOccurrences();
      if (occ && validateSeries(occ)) return;
      var from = occ ? occ[0].start : b.start;
      var to = occ ? occ[occ.length - 1].end : b.end;
      var token = ++f.token;
      api.list(from - DAY, to + DAY).then(function (list) {
        if (state.form !== f || token !== f.token) return;
        f.existing = list;
        renderTiles();
      }).catch(function () { /* Vorschau ist nur eine Hilfe */ });
    }, 300);
  }

  function renderTiles() {
    var wrap = $('car-tiles');
    var f = state.form;
    var b = formBooking();
    var occ = formOccurrences();
    wrap.innerHTML = '';
    COLUMNS.forEach(function (car) {
      var tile = el('button', 'car-tile c-' + car.id + (f.car === car.id ? ' selected' : ''));
      tile.type = 'button';
      tile.appendChild(el('span', 'emoji', car.emoji));
      var text = el('div');
      text.appendChild(el('b', null, car.id === ANY_CAR.id ? 'Egal welches' : car.name));
      var status;
      if (!(b.end > b.start) || (occ && validateSeries(occ))) status = el('span', null, ' ');
      else if (!f.existing) status = el('span', null, 'prüfe …');
      else if (occ) {
        var plan = planSeries({ car: car.id, person: b.person, note: b.note }, occ, f.existing, FMT);
        var bad = plan.conflicts.length;
        if (!bad) status = el('span', 'ok', 'immer frei');
        else if (bad === occ.length) { status = el('span', 'bad', 'nie frei'); tile.disabled = true; }
        else status = el('span', 'bad', 'an ' + bad + ' Termin' + (bad > 1 ? 'en' : '') + ' belegt');
      } else {
        var conflict = checkBooking({ id: f.id, car: car.id, person: b.person, start: b.start, end: b.end }, f.existing, FMT);
        if (!conflict) status = el('span', 'ok', 'frei');
        else {
          status = el('span', 'bad', conflict.code === 'car' ? 'belegt · ' + conflict.other.person : conflict.code === 'full' ? 'alle Autos verplant' : 'nicht durchgehend frei');
          if (conflict.code !== 'nofit') tile.disabled = true;
        }
      }
      if (f.car === car.id && tile.disabled) { f.car = null; tile.classList.remove('selected'); }
      text.appendChild(status);
      tile.appendChild(text);
      tile.addEventListener('click', function () {
        f.car = car.id;
        hideFormError();
        renderTiles();
      });
      wrap.appendChild(tile);
    });
  }

  function setDuration(dur) {
    var start = fromInput($('f-start').value);
    if (!isFinite(start)) start = defaultStart();
    if (dur === 'day') {
      start = startOfDay(start);
      $('f-start').value = toInput(start);
      $('f-end').value = toInput(addDays(start, 1));
    } else {
      $('f-end').value = toInput(start + Number(dur) * MIN);
    }
    updateRepeatInfo();
    loadAvailability();
  }

  var lastStart = null;
  function onStartChange() {
    var start = fromInput($('f-start').value);
    var end = fromInput($('f-end').value);
    if (isFinite(start) && isFinite(lastStart) && isFinite(end)) {
      $('f-end').value = toInput(start + Math.max(15 * MIN, end - lastStart));
    }
    lastStart = start;
    if ($('f-repeat').value) onRepeatChange(); else loadAvailability();
  }

  function hideFormError() {
    $('form-error').hidden = true;
    $('form-skip').hidden = true;
  }
  function showFormError(message, conflicts, total) {
    var box = $('form-error');
    box.innerHTML = '';
    box.appendChild(document.createTextNode(message));
    if (conflicts && conflicts.length) {
      var ul = el('ul');
      conflicts.slice(0, 5).forEach(function (c) { ul.appendChild(el('li', null, wdm(c.start) + ': ' + c.message)); });
      if (conflicts.length > 5) ul.appendChild(el('li', null, '… und ' + (conflicts.length - 5) + ' weitere'));
      box.appendChild(ul);
    }
    box.hidden = false;
    $('form-skip').hidden = !(conflicts && conflicts.length && conflicts.length < total);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function submitForm(e, skipConflicts) {
    if (e) e.preventDefault();
    var b = formBooking();
    var occ = formOccurrences();
    var problem = !b.car ? 'Bitte wähle ein Auto.' : validateBooking(b) || (occ && validateSeries(occ));
    if (problem) { showFormError(problem); return; }
    var btn = $('form-submit');
    var label = btn.textContent;
    btn.disabled = true;
    $('form-skip').disabled = true;
    btn.textContent = occ ? 'Speichere ' + occ.length + ' Termine …' : 'Speichere …';
    hideFormError();
    var request = occ
      ? api.saveSeries(b, occ, skipConflicts).then(function (res) {
          toast(res.bookings.length + ' Termine gebucht ✓' + (res.skipped ? ' (' + res.skipped + ' übersprungen)' : ''));
          return res.bookings[0];
        })
      : api.save(b).then(function (saved) {
          toast(b.id ? 'Gespeichert ✓' : 'Gebucht ✓ ' + carById(saved.car).name);
          return saved;
        });
    request.then(function (first) {
      closeSheet('sheet-form');
      cache = {};
      if (state.view === 'day') goTo(first.start, first.start); else refresh();
    }).catch(function (err) {
      showFormError(errorText(err), err.conflicts, occ ? occ.length : 1);
    }).then(function () {
      btn.disabled = false;
      $('form-skip').disabled = false;
      btn.textContent = label;
    });
  }

  /* ---------- Name ---------- */
  function renderWho() { $('who').textContent = '👤 ' + (state.me || 'Name?'); }
  function askName() {
    $('name-input').value = state.me;
    openSheet('sheet-name');
    setTimeout(function () { $('name-input').focus(); }, 50);
  }
  function saveName(e) {
    e.preventDefault();
    var name = $('name-input').value.trim();
    if (!name) { $('name-input').focus(); return; }
    state.me = name;
    store.set('name', name);
    renderWho();
    closeSheet('sheet-name');
    refresh();
  }

  /* ---------- Navigation ---------- */
  function showView(view) {
    state.view = view;
    $('view-day').hidden = view !== 'day';
    $('view-list').hidden = view !== 'list';
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    refresh();
  }
  function refresh() {
    cache = {};
    if (state.view === 'day') loadCal(); else loadList();
  }

  function bindSwipe(target) {
    var touch = null;
    target.addEventListener('touchstart', function (e) {
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    target.addEventListener('touchend', function (e) {
      if (!touch) return;
      var dx = e.changedTouches[0].clientX - touch.x;
      var dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 40) step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function bind() {
    $('prev-day').addEventListener('click', function () { step(-1); });
    $('next-day').addEventListener('click', function () { step(1); });
    $('today-btn').addEventListener('click', function () { goTo(Date.now()); });
    $('date-input').addEventListener('change', function (e) {
      var d = fromDateInput(e.target.value);
      if (isFinite(d)) goTo(d);
    });
    document.querySelectorAll('#modes button').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    $('grid').addEventListener('click', function (e) {
      var col = e.target.closest('.col');
      if (!col || e.target !== col) return;
      var rect = col.getBoundingClientRect();
      var minutes = Math.floor((e.clientY - rect.top) / HOUR_PX * 2) * 30;
      var day = Number(col.dataset.day);
      var start = new Date(day);
      start.setMinutes(minutes);
      openForm({ car: col.dataset.car, start: start.getTime() });
    });

    bindSwipe($('grid-scroll'));
    bindSwipe($('month'));

    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.dataset.view); });
    });
    document.querySelectorAll('#list-filter button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.listFilter = b.dataset.filter;
        document.querySelectorAll('#list-filter button').forEach(function (x) { x.classList.toggle('active', x === b); });
        loadList();
      });
    });

    $('fab').addEventListener('click', function () { openForm(); });
    $('form').addEventListener('submit', submitForm);
    $('form-skip').addEventListener('click', function () { submitForm(null, true); });
    $('f-start').addEventListener('focus', function () { lastStart = fromInput($('f-start').value); });
    $('f-start').addEventListener('change', onStartChange);
    $('f-end').addEventListener('change', function () { updateRepeatInfo(); loadAvailability(); });
    $('f-repeat').addEventListener('change', onRepeatChange);
    $('f-until').addEventListener('change', function () { updateRepeatInfo(); loadAvailability(); });
    document.querySelectorAll('.quick button').forEach(function (b) {
      b.addEventListener('click', function () { setDuration(b.dataset.dur); });
    });

    $('d-edit').addEventListener('click', function () { openForm({ booking: state.detail }); });
    $('d-delete').addEventListener('click', deleteDetail);
    $('d-del-one').addEventListener('click', function () { removeBooking(false); });
    $('d-del-all').addEventListener('click', function () { removeBooking(true); });
    $('d-del-cancel').addEventListener('click', function () {
      $('d-actions').hidden = false;
      $('d-series-delete').hidden = true;
    });

    $('who').addEventListener('click', askName);
    $('name-form').addEventListener('submit', saveName);

    document.querySelectorAll('.sheet-backdrop').forEach(function (bd) {
      bd.addEventListener('click', function (e) {
        if (e.target === bd || e.target.closest('[data-close]')) bd.hidden = true;
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.querySelectorAll('.sheet-backdrop').forEach(function (bd) { bd.hidden = true; });
    });

    // Beim Zurückkehren in die App neu laden, jede Minute die Jetzt-Linie bewegen
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    setInterval(function () { if (!document.hidden && state.view === 'day' && state.mode !== 'month') renderCal(false); }, 60000);
  }

  /* ---------- Start ---------- */
  $('mock-banner').hidden = !MOCK;
  renderWho();
  bind();
  loadCal({ scroll: true });
  if (!state.me) askName();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* läuft auch ohne */ });
  }
})();

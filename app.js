/* Autoplaner – App-Oberfläche. Logik zur Konfliktprüfung steht in logic.js. */
(function () {
  'use strict';

  var API_URL = String(window.AUTOPLANER_API || '').trim();
  var MOCK = !API_URL;
  var HOUR_PX = 52;
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var COLUMNS = CARS.concat([ANY_CAR]);
  var WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

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
  var FMT = { day: ymd, time: hm, date: dm };

  /* ---------- Verbindung zum Google-Script ---------- */
  function userError(message) { var e = new Error(message); e.user = true; return e; }

  var api = MOCK ? mockApi() : {
    list: function (from, to) {
      return call(fetch(API_URL + '?action=list&from=' + from + '&to=' + to)).then(function (d) { return d.bookings; });
    },
    save: function (b) { return post({ action: 'save', booking: b }).then(function (d) { return d.booking; }); },
    remove: function (id) { return post({ action: 'delete', id: id }); }
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
      if (!data.ok) throw userError(data.error || 'Unbekannter Fehler.');
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
    return {
      list: function (from, to) {
        return later(function () {
          return load().filter(function (b) { return b.start < to && b.end > from; });
        });
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
            all = all.map(function (o) { return o.id === b.id ? b : o; });
          } else {
            b.id = 'm' + Date.now();
            all.push(b);
          }
          save(all);
          return b;
        });
      },
      remove: function (id) {
        return later(function () { save(load().filter(function (o) { return o.id !== id; })); return {}; });
      }
    };
  }

  /* ---------- Zustand ---------- */
  var state = {
    me: store.get('name') || '',
    day: startOfDay(Date.now()),
    bookings: [],
    view: 'day',
    listFilter: 'mine',
    detail: null,
    form: null,
    loadToken: 0
  };
  var dayCache = {};

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
    toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }
  function errorText(err) {
    return err && err.user ? err.message : 'Keine Verbindung. Bitte prüfe dein Internet und versuch es nochmal.';
  }
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }

  /* ---------- Tagesansicht ---------- */
  function renderHead() {
    var head = $('grid-head');
    head.innerHTML = '';
    head.appendChild(el('div'));
    COLUMNS.forEach(function (c) {
      var d = el('div', 'c-' + c.id);
      d.appendChild(el('span', 'emoji', c.emoji));
      d.appendChild(document.createTextNode(c.short));
      head.appendChild(d);
    });
  }

  function loadDay(opts) {
    var day = state.day;
    var key = ymd(day);
    var token = ++state.loadToken;
    renderDateBar();
    if (dayCache[key]) {
      state.bookings = dayCache[key];
      renderDay(opts && opts.scroll);
    } else {
      var saved = store.get('day.' + key);
      state.bookings = saved ? JSON.parse(saved) : [];
      renderDay(opts && opts.scroll);
    }
    $('loading').hidden = false;
    return api.list(day, addDays(day, 1)).then(function (list) {
      dayCache[key] = list;
      store.set('day.' + key, JSON.stringify(list));
      if (token !== state.loadToken) return;
      state.bookings = list;
      renderDay(false);
    }).catch(function (err) {
      if (token === state.loadToken) toast(errorText(err));
    }).then(function () {
      if (token === state.loadToken) $('loading').hidden = true;
    });
  }

  function renderDateBar() {
    $('date-text').textContent = dayName(state.day);
    $('date-input').value = ymd(state.day);
    $('today-btn').hidden = state.day === startOfDay(Date.now());
  }

  function renderDay(scroll) {
    var grid = $('grid');
    var dayStart = state.day;
    grid.innerHTML = '';

    var hours = el('div', 'hours');
    for (var h = 1; h < 24; h++) {
      var s = el('span', null, pad(h) + ':00');
      s.style.top = h * HOUR_PX + 'px';
      hours.appendChild(s);
    }
    grid.appendChild(hours);

    COLUMNS.forEach(function (car) {
      var col = el('div', 'col c-' + car.id);
      col.dataset.car = car.id;
      var items = state.bookings.filter(function (b) { return b.car === car.id; })
        .sort(function (a, b) { return a.start - b.start; });
      layoutLanes(items).forEach(function (item) {
        col.appendChild(bookingBlock(item.b, dayStart, item.lane, item.lanes));
      });
      grid.appendChild(col);
    });

    var isToday = dayStart === startOfDay(Date.now());
    if (isToday) {
      var line = el('div', 'now-line');
      line.style.top = minutesInDay(Date.now(), dayStart) / 60 * HOUR_PX + 'px';
      grid.appendChild(line);
    }
    renderNowStrip(isToday);

    if (scroll) {
      var target = isToday ? minutesInDay(Date.now(), dayStart) / 60 - 1.5 : 7;
      $('grid-scroll').scrollTop = Math.max(0, target) * HOUR_PX;
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

  function bookingBlock(b, dayStart, lane, lanes) {
    var top = minutesInDay(b.start, dayStart) / 60 * HOUR_PX;
    var bottom = minutesInDay(b.end, dayStart) / 60 * HOUR_PX;
    var btn = el('button', 'booking c-' + b.car + (isMine(b) ? ' mine' : ''));
    btn.type = 'button';
    btn.style.top = top + 'px';
    btn.style.height = Math.max(20, bottom - top - 2) + 'px';
    if (lanes > 1) {
      btn.style.left = 'calc(' + (lane / lanes * 100) + '% + 1px)';
      btn.style.right = 'auto';
      btn.style.width = 'calc(' + (100 / lanes) + '% - 2px)';
    }
    btn.appendChild(el('b', null, b.person));
    btn.appendChild(el('small', null, hm(Math.max(b.start, dayStart)) + (b.end > addDays(dayStart, 1) ? ' →' : '–' + hm(b.end))));
    if (b.note && bottom - top > 50) btn.appendChild(el('small', null, b.note));
    btn.setAttribute('aria-label', b.person + ', ' + carById(b.car).name + ', ' + rangeText(b));
    btn.addEventListener('click', function (e) { e.stopPropagation(); openDetail(b); });
    return btn;
  }

  function renderNowStrip(isToday) {
    var strip = $('now-strip');
    strip.innerHTML = '';
    if (!isToday) return;
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
        var s = el('span', 'free', next ? 'frei bis ' + hm(next.start) : 'frei');
        card.appendChild(s);
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

  function changeDay(ms, scrollTo) {
    state.day = startOfDay(ms);
    loadDay({ scroll: true });
    if (scrollTo) $('grid-scroll').scrollTop = Math.max(0, minutesInDay(scrollTo, state.day) / 60 - 1) * HOUR_PX;
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
      text.appendChild(el('b', null, car.name + (state.listFilter === 'all' ? ' · ' + b.person : '')));
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
    [['Wer', b.person], ['Wann', rangeText(b)], ['Notiz', b.note]].forEach(function (row) {
      if (!row[1]) return;
      dl.appendChild(el('dt', null, row[0]));
      dl.appendChild(el('dd', null, row[1]));
    });
    openSheet('sheet-detail');
  }

  function deleteDetail() {
    var b = state.detail;
    var question = isMine(b) ? 'Buchung wirklich löschen?' : 'Das ist die Buchung von ' + b.person + '. Trotzdem löschen?';
    if (!window.confirm(question)) return;
    var btn = $('d-delete');
    btn.disabled = true;
    api.remove(b.id).then(function () {
      closeSheet('sheet-detail');
      toast('Buchung gelöscht');
      refresh();
    }).catch(function (err) { toast(errorText(err)); })
      .then(function () { btn.disabled = false; });
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
    $('form-title').textContent = b ? 'Buchung ändern' : 'Auto buchen';
    $('form-submit').textContent = b ? 'Speichern' : 'Buchen';
    $('f-start').value = toInput(start);
    $('f-end').value = toInput(end);
    $('f-note').value = b ? b.note : '';
    $('form-error').hidden = true;
    closeSheet('sheet-detail');
    openSheet('sheet-form');
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

  var availTimer;
  function loadAvailability() {
    var f = state.form;
    f.existing = null;
    renderTiles();
    clearTimeout(availTimer);
    availTimer = setTimeout(function () {
      var b = formBooking();
      if (!(b.end > b.start)) return;
      var token = ++f.token;
      api.list(b.start - DAY, b.end + DAY).then(function (list) {
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
    wrap.innerHTML = '';
    COLUMNS.forEach(function (car) {
      var tile = el('button', 'car-tile c-' + car.id + (f.car === car.id ? ' selected' : ''));
      tile.type = 'button';
      tile.appendChild(el('span', 'emoji', car.emoji));
      var text = el('div');
      text.appendChild(el('b', null, car.id === ANY_CAR.id ? 'Egal welches' : car.name));
      var status;
      if (!(b.end > b.start)) status = el('span', null, ' ');
      else if (!f.existing) status = el('span', null, 'prüfe …');
      else {
        var conflict = checkBooking({ id: f.id, car: car.id, person: b.person, start: b.start, end: b.end }, f.existing, FMT);
        if (!conflict) status = el('span', 'ok', 'frei');
        else {
          status = el('span', 'bad', conflict.code === 'car' ? 'belegt · ' + conflict.other.person : conflict.code === 'full' ? 'alle Autos verplant' : 'nicht durchgehend frei');
          if (conflict.code !== 'nofit') tile.disabled = true;
          if (f.car === car.id && tile.disabled) { f.car = null; tile.classList.remove('selected'); }
        }
      }
      text.appendChild(status);
      tile.appendChild(text);
      tile.addEventListener('click', function () {
        f.car = car.id;
        $('form-error').hidden = true;
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
    loadAvailability();
  }

  function submitForm(e) {
    e.preventDefault();
    var b = formBooking();
    var errBox = $('form-error');
    var problem = !b.car ? 'Bitte wähle ein Auto.' : validateBooking(b);
    if (problem) { errBox.textContent = problem; errBox.hidden = false; return; }
    var btn = $('form-submit');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Speichere …';
    errBox.hidden = true;
    api.save(b).then(function (saved) {
      closeSheet('sheet-form');
      toast(b.id ? 'Gespeichert ✓' : 'Gebucht ✓ ' + carById(saved.car).name);
      dayCache = {};
      if (state.view === 'day') changeDay(saved.start, saved.start); else refresh();
    }).catch(function (err) {
      errBox.textContent = errorText(err);
      errBox.hidden = false;
    }).then(function () {
      btn.disabled = false;
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
    dayCache = {};
    if (state.view === 'day') loadDay(); else loadList();
  }

  function bind() {
    $('prev-day').addEventListener('click', function () { changeDay(addDays(state.day, -1)); });
    $('next-day').addEventListener('click', function () { changeDay(addDays(state.day, 1)); });
    $('today-btn').addEventListener('click', function () { changeDay(Date.now()); });
    $('date-input').addEventListener('change', function (e) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
      if (m) changeDay(new Date(+m[1], m[2] - 1, +m[3]).getTime());
    });

    $('grid').addEventListener('click', function (e) {
      var col = e.target.closest('.col');
      if (!col || e.target !== col) return;
      var rect = col.getBoundingClientRect();
      var minutes = Math.floor((e.clientY - rect.top) / HOUR_PX * 2) * 30;
      openForm({ car: col.dataset.car, start: state.day + minutes * MIN });
    });

    // Wischen für den nächsten/vorherigen Tag
    var touch = null;
    $('grid-scroll').addEventListener('touchstart', function (e) {
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    $('grid-scroll').addEventListener('touchend', function (e) {
      if (!touch) return;
      var dx = e.changedTouches[0].clientX - touch.x;
      var dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 40) changeDay(addDays(state.day, dx < 0 ? 1 : -1));
    }, { passive: true });

    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.dataset.view); });
    });
    document.querySelectorAll('.segmented button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.listFilter = b.dataset.filter;
        document.querySelectorAll('.segmented button').forEach(function (x) { x.classList.toggle('active', x === b); });
        loadList();
      });
    });

    $('fab').addEventListener('click', function () { openForm(); });
    $('form').addEventListener('submit', submitForm);
    $('f-start').addEventListener('focus', function () { lastStart = fromInput($('f-start').value); });
    $('f-start').addEventListener('change', onStartChange);
    $('f-end').addEventListener('change', loadAvailability);
    document.querySelectorAll('.quick button').forEach(function (b) {
      b.addEventListener('click', function () { setDuration(b.dataset.dur); });
    });

    $('d-edit').addEventListener('click', function () { openForm({ booking: state.detail }); });
    $('d-delete').addEventListener('click', deleteDetail);

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
    setInterval(function () { if (!document.hidden && state.view === 'day') renderDay(false); }, 60000);
  }

  /* ---------- Start ---------- */
  $('mock-banner').hidden = !MOCK;
  renderHead();
  renderWho();
  bind();
  loadDay({ scroll: true });
  if (!state.me) askName();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* läuft auch ohne */ });
  }
})();

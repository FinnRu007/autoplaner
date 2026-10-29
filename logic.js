/* ===== AUTOPLANER-LOGIK START =====
 * Dieser Block steht identisch in app/logic.js und google-script/Code.gs.
 * Die App nutzt ihn für die Vorschau, das Google-Script für die verbindliche Prüfung.
 */

var CARS = [
  { id: 'schwarz', name: 'Schwarzes Auto', short: 'Schwarz', emoji: '⚫' },
  { id: 'blau', name: 'Blaues Auto', short: 'Blau', emoji: '🔵' },
  { id: 'elektro', name: 'Elektro Auto', short: 'Elektro', emoji: '⚡' }
];
var ANY_CAR = { id: 'any', name: 'Beliebiges Auto', short: 'Egal', emoji: '🚗' };
var MAX_BOOKING_DAYS = 31;

function carById(id) {
  for (var i = 0; i < CARS.length; i++) if (CARS[i].id === id) return CARS[i];
  return id === ANY_CAR.id ? ANY_CAR : null;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Gibt einen Fehlertext zurück oder null, wenn die Eingaben in Ordnung sind. */
function validateBooking(b) {
  if (!b.person) return 'Bitte gib deinen Namen an.';
  if (b.person.length > 40) return 'Der Name ist zu lang.';
  if (!carById(b.car)) return 'Bitte wähle ein Auto.';
  if (!isFinite(b.start) || !isFinite(b.end)) return 'Bitte gib Start und Ende an.';
  if (b.end <= b.start) return 'Das Ende muss nach dem Start liegen.';
  if (b.end - b.start > MAX_BOOKING_DAYS * 864e5) return 'Eine Buchung darf höchstens ' + MAX_BOOKING_DAYS + ' Tage lang sein.';
  if (b.note && b.note.length > 200) return 'Die Notiz ist zu lang.';
  return null;
}

/**
 * Prüft, ob Buchung b zu den bestehenden Buchungen passt.
 * fmt = { day(ms) -> 'yyyy-MM-dd', time(ms) -> 'HH:mm', date(ms) -> 'dd.MM.' }
 * Gibt null zurück, wenn alles passt, sonst { code, message }.
 */
function checkBooking(b, existing, fmt) {
  var others = existing.filter(function (o) { return o.id !== b.id; });
  var over = others.filter(function (o) { return overlaps(o, b); });

  function at(ms) {
    return fmt.day(ms) === fmt.day(b.start) ? fmt.time(ms) : fmt.date(ms) + ' ' + fmt.time(ms);
  }

  // 1. Ein bestimmtes Auto darf nicht doppelt gebucht sein.
  if (b.car !== ANY_CAR.id) {
    for (var i = 0; i < over.length; i++) {
      if (over[i].car === b.car) {
        return {
          code: 'car',
          other: over[i],
          message: carById(b.car).name + ' ist von ' + at(over[i].start) + ' bis ' + at(over[i].end) +
            ' schon von ' + over[i].person + ' gebucht.'
        };
      }
    }
  }

  // 2. Zu keinem Zeitpunkt mehr Buchungen als Autos.
  var points = [b.start];
  over.forEach(function (o) { if (o.start > b.start) points.push(o.start); });
  for (var p = 0; p < points.length; p++) {
    var t = points[p];
    var active = over.filter(function (o) { return o.start <= t && o.end > t; });
    if (active.length >= CARS.length) {
      return {
        code: 'full',
        at: t,
        message: 'Um ' + at(t) + ' sind schon alle ' + CARS.length + ' Autos verplant.'
      };
    }
  }

  // 3. Jede „beliebig“-Buchung braucht ein Auto, das die ganze Zeit frei ist.
  if (!assignable(blockAround(others.concat([b]), b))) {
    return {
      code: 'nofit',
      message: 'So wäre nicht für jede Buchung durchgehend ein Auto frei. Probier eine andere Zeit oder ein anderes Auto.'
    };
  }
  return null;
}

/** Alle Buchungen, die über Überschneidungen mit b zusammenhängen. */
function blockAround(all, b) {
  var sorted = all.slice().sort(function (x, y) { return x.start - y.start; });
  var block = [], blockEnd = -Infinity, found = false;
  for (var i = 0; i < sorted.length; i++) {
    var o = sorted[i];
    if (o.start >= blockEnd) {
      if (found) break;
      block = [];
    }
    block.push(o);
    blockEnd = Math.max(blockEnd, o.end);
    if (o === b) found = true;
  }
  return block;
}

/** Versucht, jeder „beliebig“-Buchung ein durchgehend freies Auto zuzuordnen. */
function assignable(block) {
  var used = {};
  CARS.forEach(function (c) { used[c.id] = []; });
  var flex = [];
  block.forEach(function (o) {
    if (o.car === ANY_CAR.id) flex.push(o);
    else if (used[o.car]) used[o.car].push(o);
  });
  flex.sort(function (x, y) { return x.start - y.start; });

  var budget = 50000;
  function place(i) {
    if (i === flex.length) return true;
    if (--budget < 0) return true; // Notbremse bei absurden Datenmengen
    for (var c = 0; c < CARS.length; c++) {
      var list = used[CARS[c].id];
      var free = list.every(function (o) { return !overlaps(o, flex[i]); });
      if (free) {
        list.push(flex[i]);
        if (place(i + 1)) return true;
        list.pop();
      }
    }
    return false;
  }
  return place(0);
}

/* ===== AUTOPLANER-LOGIK ENDE ===== */

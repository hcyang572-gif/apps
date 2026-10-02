/*!
 * haptics.js — 랜딩 공용 햅틱 (정본). 의존성 없음. 각 빌드가 인라인해서 쓴다.
 * 햅틱 v2 «애플워치 용두처럼 섬세하게» — BRIEF.md 참조.
 *
 *  - Android(Chrome·삼성 인터넷): navigator.vibrate 마이크로 펄스.
 *      detent 3ms · tap 4ms · settle [3,40,5] · success [4,70,6]
 *  - 직전 펄스가 «끝난» 뒤 최소 40ms 간격. detent 는 간격 안이면 버리고,
 *    tap·settle·success 는 버리지 않고 간격이 열리는 순간으로 미룬다.
 *  - 첫 사용자 터치(pointerdown pointerType==='touch' / touchstart) 전에는 시도조차 안 한다.
 *  - prefers-reduced-motion: reduce 이거나 탭이 숨겨져 있으면 꺼진다.
 *  - iOS(vibrate 없음): iOS 18+ <input type=checkbox switch> 기법으로 tap 류만 «틱» 1회.
 *    연속 detent 는 iOS 에서 하지 않는다.
 *  - 데스크톱·미지원: 아무것도 안 한다(에러 0).
 *
 * API
 *   Haptics.detent() / tap() / settle() / success()   → true(발생·예약) | false(건너뜀)
 *   Haptics.pulse(ms|pattern)                          → 비교용 원시 펄스(같은 규칙 적용)
 *   Haptics.stepper({step, rate})                      → feed(value): step 넘을 때마다 detent(초당 ≤ rate)
 *   Haptics.dial(el, {stepPct:8, boundaries:[0,100], progress?}) → {destroy()}
 *        손가락 터치 스크롤 중 el 진행률이 stepPct 마다 detent, 경계에서 tap.
 *   Haptics.decelTimes(n, durationMs, power=3)         → 감속(ease-out) 자리 넘김 시각 배열
 *   Haptics.rollDigits(times, onStep(i), onDone)       → 각 시각에 onStep+detent, 끝에 settle. cancel() 반환
 *   Haptics.config({detent:ms, ...}) / Haptics.status() / Haptics.log
 */
(function (w, d) {
  'use strict';
  if (!w || !d) return;
  if (w.Haptics && w.Haptics.__v === 2) return;

  var MIN_GAP = 40;          // 직전 펄스 «끝»에서 다음 펄스 «시작»까지
  var MAX_RATE = 18;         // 다이얼 detent 초당 상한
  var INERTIA_MS = 1200;     // 손가락을 뗀 뒤 관성 스크롤로 보는 시간
  var P = { detent: 3, tap: 4, settle: [3, 40, 5], success: [4, 70, 6] };
  var PRIORITY = { tap: 1, settle: 1, success: 1, pulse: 1 };

  var now = function () { return (w.performance && w.performance.now) ? w.performance.now() : Date.now(); };
  var nav = w.navigator || {};
  var ua = nav.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  var canVibrate = function () { return typeof nav.vibrate === 'function'; };

  var armed = false;         // 첫 사용자 터치 이후 true
  var touching = false;
  var touchEndAt = -1e9;
  var lastEnd = -1e9;        // 마지막 펄스가 끝나는 시각
  var pending = null;        // 미뤄 둔 우선 펄스 타이머
  var log = [];
  var rmq = null;
  try { rmq = w.matchMedia ? w.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch (e) { rmq = null; }

  function reduced() { try { return !!(rmq && rmq.matches); } catch (e) { return false; } }
  function hidden() { return d.visibilityState === 'hidden' || d.hidden === true; }
  function enabled() { return armed && !reduced() && !hidden(); }
  function dur(p) {
    if (typeof p === 'number') return p;
    var s = 0; for (var i = 0; i < p.length; i++) s += p[i]; return s;
  }

  // ── 첫 터치 감지(터치만 — 마우스 클릭은 무장하지 않는다) ─────────────
  function onDown(e) {
    if (e.type === 'pointerdown' && e.pointerType !== 'touch') return;
    armed = true; touching = true;
  }
  function onUp(e) {
    if (e.type.indexOf('pointer') === 0 && e.pointerType !== 'touch') return;
    touching = false; touchEndAt = now();
  }
  var opt = { capture: true, passive: true };
  try {
    d.addEventListener('pointerdown', onDown, opt);
    d.addEventListener('touchstart', onDown, opt);
    d.addEventListener('touchend', onUp, opt);
    d.addEventListener('touchcancel', onUp, opt);
    d.addEventListener('pointerup', onUp, opt);
    d.addEventListener('pointercancel', onUp, opt);
    d.addEventListener('visibilitychange', function () {
      if (hidden() && pending) { clearTimeout(pending); pending = null; }
    });
  } catch (e) { /* 아주 오래된 환경 */ }

  // ── iOS 18+ switch 체크박스 기법 ──────────────────────────────────
  var iosLabel = null;
  function iosTick() {
    try {
      if (!iosLabel) {
        iosLabel = d.createElement('label');
        iosLabel.setAttribute('aria-hidden', 'true');
        iosLabel.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
        var cb = d.createElement('input');
        cb.type = 'checkbox'; cb.setAttribute('switch', ''); cb.tabIndex = -1;
        iosLabel.appendChild(cb);
        (d.body || d.documentElement).appendChild(iosLabel);
      }
      iosLabel.click();
      return true;
    } catch (e) { return false; }
  }

  // ── 실제 발생 ────────────────────────────────────────────────────
  function fire(kind, pattern) {
    var t = now();
    var ok = false;
    try { ok = nav.vibrate(pattern) !== false; } catch (e) { ok = false; }
    lastEnd = t + dur(pattern);
    log.push({ t: Math.round(t), kind: kind, pattern: pattern, ok: ok });
    if (log.length > 200) log.shift();
    return ok;
  }

  function emit(kind, pattern) {
    if (!enabled()) return false;
    if (!canVibrate()) {
      // iOS: tap 류(경계·버튼)만 1회. 연속 detent·settle 은 하지 않는다.
      if (isIOS && kind === 'tap') {
        var t0 = now();
        if (t0 - lastEnd < MIN_GAP) return false;
        lastEnd = t0;
        log.push({ t: Math.round(t0), kind: 'ios-tap', pattern: 0, ok: true });
        return iosTick();
      }
      return false;
    }
    var wait = lastEnd + MIN_GAP - now();
    if (wait <= 0) return fire(kind, pattern);
    if (!PRIORITY[kind]) return false;          // detent 는 간격 안이면 버린다
    if (pending) clearTimeout(pending);         // 우선 펄스는 최신 것 하나만 미뤄 낸다
    pending = setTimeout(function () {
      pending = null;
      if (enabled() && now() - lastEnd >= MIN_GAP - 1) fire(kind, pattern);
    }, Math.ceil(wait) + 1);
    return true;
  }

  // ── 스테퍼: 값이 step 을 넘을 때마다 detent (한 번에 여러 칸 넘어도 1회) ─
  function stepper(o) {
    o = o || {};
    var step = o.step || 1;
    var minIv = 1000 / (o.rate || MAX_RATE);
    var lastIdx = null, lastAt = -1e9;
    // silent=true: 칸 위치만 맞추고 울리지 않는다(손가락 없는 스크롤·경계에서 tap 을 낸 순간)
    return function feed(v, silent) {
      var idx = Math.floor(v / step + 1e-9);
      if (lastIdx === null) { lastIdx = idx; return false; }
      if (idx === lastIdx) return false;
      lastIdx = idx;
      if (silent) return false;
      var t = now();
      if (t - lastAt < minIv) return false;             // 속도 과다 → 건너뜀
      if (Haptics.detent()) { lastAt = t; return true; }
      return false;
    };
  }

  // ── 다이얼: 터치 스크롤 중 요소 진행률 → detent / 경계 → tap ─────────
  function defaultProgress(el) {
    var r = el.getBoundingClientRect();
    var vh = w.innerHeight || d.documentElement.clientHeight;
    var p = r.height - vh > 1
      ? -r.top / (r.height - vh)                        // 스티키 장면: 위 끝이 화면 위에 닿을 때 0, 아래 끝이 닿을 때 100
      : (vh - r.top) / (r.height + vh);                 // 화면보다 낮은 일반 요소: 들어올 때 0, 나갈 때 100
    return Math.max(0, Math.min(1, p)) * 100;
  }
  function dial(el, o) {
    o = o || {};
    if (!el) return { destroy: function () {} };
    var stepPct = o.stepPct || 8;
    var bounds = (o.boundaries || [0, 100]).slice().sort(function (a, b) { return a - b; });
    var getP = o.progress || defaultProgress;
    var feed = stepper({ step: stepPct, rate: o.rate || MAX_RATE });
    var prevP = null, raf = 0, visible = true, io = null;

    function fingerScroll() { return touching || (now() - touchEndAt < INERTIA_MS); }
    function tick() {
      raf = 0;
      if (!visible) return;
      var p = getP(el);
      if (prevP === null) { prevP = p; feed(p, true); return; }
      if (p === prevP) return;
      var finger = fingerScroll();
      var crossed = false;
      for (var i = 0; i < bounds.length; i++) {
        var b = bounds[i];
        if ((prevP < b && p >= b) || (prevP > b && p <= b)) { crossed = true; break; }
      }
      prevP = p;
      if (!finger) { feed(p, true); return; }      // 휠·키보드 스크롤: 위치만 따라가고 울리지 않는다
      if (crossed) { feed(p, true); Haptics.tap(); return; } // 경계는 tap 하나(같은 순간 detent 중복 금지)
      feed(p, false);
    }

    function onScroll() { if (!raf) raf = w.requestAnimationFrame(tick); }
    w.addEventListener('scroll', onScroll, { passive: true });
    try {
      io = new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) onScroll(); });
      io.observe(el);
    } catch (e) { io = null; }
    onScroll();
    return {
      destroy: function () {
        w.removeEventListener('scroll', onScroll);
        if (io) io.disconnect();
        if (raf) w.cancelAnimationFrame(raf);
      }
    };
  }

  // ── 롤링 숫자: 감속 곡선 자리 넘김 시각 ────────────────────────────
  function decelTimes(n, duration, power) {
    power = power || 3;
    var out = [];
    for (var i = 1; i <= n; i++) out.push(duration * (1 - Math.pow(1 - i / n, 1 / power)));
    return out;
  }
  function rollDigits(times, onStep, onDone) {
    times = (times || []).slice().sort(function (a, b) { return a - b; });
    var start = now(), i = 0, raf = 0, dead = false;
    function frame() {
      if (dead) return;
      var t = now() - start;
      var fired = false;
      while (i < times.length && times[i] <= t) {
        if (onStep) { try { onStep(i); } catch (e) {} }
        fired = true; i++;
      }
      if (fired && i < times.length) Haptics.detent();
      if (i >= times.length) {
        Haptics.settle();
        if (onDone) { try { onDone(); } catch (e) {} }
        return;
      }
      raf = w.requestAnimationFrame(frame);
    }
    raf = w.requestAnimationFrame(frame);
    return function cancel() { dead = true; if (raf) w.cancelAnimationFrame(raf); };
  }

  var Haptics = {
    __v: 2,
    detent: function () { return emit('detent', P.detent); },
    tap: function () { return emit('tap', P.tap); },
    settle: function () { return emit('settle', P.settle.slice()); },
    success: function () { return emit('success', P.success.slice()); },
    pulse: function (p) { return emit('pulse', p); },
    stepper: stepper,
    dial: dial,
    decelTimes: decelTimes,
    rollDigits: rollDigits,
    config: function (o) { for (var k in o) if (P.hasOwnProperty(k)) P[k] = o[k]; return P; },
    status: function () {
      return {
        vibrate: canVibrate(), ios: isIOS, armed: armed, touching: touching,
        reducedMotion: reduced(), hidden: hidden(), enabled: enabled(),
        pulses: { detent: P.detent, tap: P.tap, settle: P.settle, success: P.success }
      };
    },
    log: log,
    MIN_GAP: MIN_GAP,
    MAX_RATE: MAX_RATE
  };
  w.Haptics = Haptics;
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);

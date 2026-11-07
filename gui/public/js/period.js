/* Taxio Pilot - pemilih periode bersama: chip bulan (SPT Masa, e-Bupot, dst), chip tahun (SPT
   tahunan), dan satu bulan (Billing, masa pengkreditan). Menghasilkan kode yang sama dengan yang
   dulu diketik ("0126-0526;0826", "2024-2025"); kode itu tetap bisa diketik langsung. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    let seq = 0;

    /** mode: 'masa' (banyak bulan) | 'masa1' (satu bulan) | 'tahun' (banyak tahun). */
    function create(opts) {
        const mode = opts.mode || 'masa';
        const now = P.today();
        const thisYear = now.getFullYear();
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const self = {
            id: 'pp-' + (++seq), mode, sel: new Set(), year: prevMonth.getFullYear(), textOpen: false, text: '', error: '',
            onChange: opts.onChange || function () {}
        };
        // Bawaan: bulan lalu / tahun lalu, karena itulah yang paling sering dikerjakan.
        if (mode === 'tahun') self.sel.add(thisYear - 1);
        else self.sel.add(L.mmYY(prevMonth.getMonth() + 1, prevMonth.getFullYear()));

        const tahunWindow = () => { const a = []; for (let y = thisYear - 5; y <= thisYear; y++) a.push(y); return a; };

        self.code = () => (mode === 'tahun' ? L.yearsToCode(Array.from(self.sel)) : L.masaToCode(Array.from(self.sel)));
        self.count = () => self.sel.size;
        self.values = () => Array.from(self.sel);
        self.single = () => (self.sel.size ? Array.from(self.sel)[0] : '');
        self.unit = () => (mode === 'tahun' ? 'year(s)' : 'period(s)');

        function head() {
            if (mode === 'tahun') {
                return '<div class="pills">' + [['last', 'Last year'], ['last2', 'Last 2 years'], ['clear', 'Clear']].map(([v, t]) => '<button type="button" class="pill" data-pp="quick" data-val="' + v + '">' + t + '</button>').join('') + '</div>';
            }
            const quick = mode === 'masa'
                ? '<div class="pills">' + [['year', 'Full year'], ['q1', 'Q1'], ['s1', 'H1'], ['clear', 'Clear']].map(([v, t]) => '<button type="button" class="pill" data-pp="quick" data-val="' + v + '">' + t + '</button>').join('') + '</div>'
                : '<span></span>';
            return '<div class="row" style="justify-content:space-between">' + quick
                + '<div class="stepper-year"><button type="button" aria-label="Previous year" data-pp="yprev">' + P.icon('left', 16) + '</button><span>' + self.year + '</span><button type="button" aria-label="Next year" data-pp="ynext">' + P.icon('right', 16) + '</button></div></div>';
        }
        function grid() {
            if (mode === 'tahun') {
                return '<div class="chips c6 tall">' + tahunWindow().map((y) => '<button type="button" class="chip" data-pp="chip" data-val="' + y + '" aria-pressed="' + self.sel.has(y) + '">' + y + '</button>').join('') + '</div>';
            }
            return '<div class="chips c6">' + L.MONTHS.map((m, i) => {
                const code = L.mmYY(i + 1, self.year);
                return '<button type="button" class="chip" data-pp="chip" data-val="' + code + '" aria-pressed="' + self.sel.has(code) + '">' + m + '</button>';
            }).join('') + '</div>';
        }
        function sum() {
            const n = self.count();
            const what = mode === 'tahun' ? (n === 1 ? 'year' : 'years') : (n === 1 ? 'period' : 'periods');
            return '<div class="summary-line"><span class="grow">Selected: <b>' + n + ' ' + what + '</b></span><span class="code-chip">' + P.esc(self.code() || '—') + '</span>'
                + '<button type="button" class="link link-quiet" style="font-size:12.5px" data-pp="text">' + (self.textOpen ? 'Close' : 'Type code') + '</button></div>';
        }
        function text() {
            if (!self.textOpen) return '';
            const ph = mode === 'tahun' ? 'e.g. 2025 or 2024-2025' : 'e.g. 0126;0226 or 0125-1225';
            return '<div class="stack" style="gap:6px"><input type="text" class="input sm mono" data-pp-input placeholder="' + ph + '" value="' + P.esc(self.text) + '" aria-label="Period code">'
                + '<div class="field-error" data-pp-error>' + P.esc(self.error) + '</div></div>';
        }
        const part = (name, fn) => '<div class="pp-' + name + '">' + fn() + '</div>';

        self.html = () => '<div class="pp stack-lg" id="' + self.id + '">' + part('head', head) + part('grid', grid) + part('sum', sum) + '<div class="pp-text">' + text() + '</div></div>';
        const wrap = () => document.getElementById(self.id);
        function paint(names) {
            const w = wrap();
            if (!w) return;
            const fns = { head, grid, sum, text };
            names.forEach((n) => { const el = w.querySelector('.pp-' + n); if (el) el.innerHTML = fns[n](); });
        }
        function changed() { paint(['head', 'grid', 'sum']); self.onChange(self); }

        function applyQuick(v) {
            if (mode === 'tahun') {
                if (v === 'last') self.sel = new Set([thisYear - 1]);
                else if (v === 'last2') self.sel = new Set([thisYear - 2, thisYear - 1]);
                else self.sel = new Set();
                return;
            }
            if (v === 'clear') { self.sel = new Set(); return; }
            const months = v === 'q1' ? 3 : v === 's1' ? 6 : 12;
            self.sel = new Set(Array.from({ length: months }, (_, i) => L.mmYY(i + 1, self.year)));
        }

        self.bind = function () {
            const w = wrap();
            if (!w) return;
            w.addEventListener('click', (e) => {
                const t = e.target.closest('[data-pp]');
                if (!t || !w.contains(t)) return;
                const act = t.dataset.pp; const val = t.dataset.val;
                if (act === 'chip') {
                    if (mode === 'masa1') self.sel = new Set([val]);
                    else {
                        const key = mode === 'tahun' ? Number(val) : val;
                        if (self.sel.has(key)) self.sel.delete(key); else self.sel.add(key);
                    }
                    self.text = self.code(); self.error = '';
                } else if (act === 'quick') { applyQuick(val); self.text = self.code(); self.error = ''; }
                else if (act === 'yprev') self.year -= 1;
                else if (act === 'ynext') self.year += 1;
                else if (act === 'text') {
                    self.textOpen = !self.textOpen; self.text = self.code();
                    paint(['sum', 'text']);
                    const input = w.querySelector('[data-pp-input]'); if (input) input.focus();
                    return;
                }
                paint(['head', 'grid', 'sum']);
                if (self.textOpen) paint(['text']);
                if (act !== 'yprev' && act !== 'ynext') self.onChange(self);
            });
            w.addEventListener('input', (e) => {
                if (!e.target.matches('[data-pp-input]')) return;
                self.text = e.target.value;
                const r = mode === 'tahun' ? L.parseYears(self.text) : L.parseMasa(self.text);
                let error = r.error;
                if (!error && mode === 'masa1' && r.set.size > 1) error = 'Select one period only.';
                self.error = error || '';
                const errEl = w.querySelector('[data-pp-error]'); if (errEl) errEl.textContent = self.error;
                if (error) return;
                self.sel = new Set(r.set);
                if (mode !== 'tahun' && r.set.size) self.year = parseInt('20' + Array.from(r.set)[0].slice(2), 10);
                paint(['head', 'grid', 'sum']);
                self.onChange(self);
            });
        };
        return self;
    }
    P.period = { create };
})();

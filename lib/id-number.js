/* Indonesian number text ("2.646.648", "1,75") without Intl: the packaged exe's Node has no Indonesian
 * locale data, so toLocaleString('id-ID') silently comes out as "2,646,648" / "1.75" there (caught by
 * the exe self-test 2026-10-19) while plain node formats it correctly. */
const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Whole rupiah, halves away from zero (as Angular's number pipe on Coretax's screens). */
function money(v) {
    const n = Number(v);
    const whole = Math.round(Math.abs(n));
    return (n < 0 && whole ? '-' : '') + group(String(whole));
}

/** Fixed decimals with a decimal comma: fixed(1.5, 2) = "1,50". Rounds the DECIMAL value half away
 *  from zero (1.755 -> "1,76", as Angular does), not the binary double (toFixed gives "1.75"). */
function fixed(v, decimals) {
    const n = Number(v);
    const rounded = Number(Math.round(Number(Math.abs(n) + 'e' + decimals)) + 'e-' + decimals);
    const [int, frac] = rounded.toFixed(decimals).split('.');
    return (n < 0 && rounded ? '-' : '') + group(int) + (frac ? ',' + frac : '');
}

module.exports = { money, fixed };

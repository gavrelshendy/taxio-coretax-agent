/* Puts Coretax's data into a compiled PER-11 sheet (see scripts/build-per11-layout.js), producing
 * a new sheet the renderer draws exactly like the blank one - same cells, same styles - with:
 *   - the kop's NPWP and TAHUN PAJAK digit boxes filled;
 *   - every list table's blank data rows replaced by one copy of the template's own data row per
 *     record (a record may be several Excel rows tall), and its JUMLAH row filled;
 *   - reconciliation tables (L1, OP L3A) filled in place, account code by account code;
 *   - calculation forms (L6, L8, L11-B I, ...) filled into each numbered line's value box;
 *   - Ya/Tidak answers and tick boxes marked.
 * Anything that could not be placed is returned in `unplaced`, so nothing is dropped silently.
 */
// The code lives in lib/lampiran-per11-*.js, split by step (see each file's header); this file
// stays the public entry point with the same exports.
const { similarity } = require('./lampiran-per11-sheet');
const { findTables } = require('./lampiran-per11-tables');
const { sheetRegions } = require('./lampiran-per11-tidy');
const { fillSheet } = require('./lampiran-per11-entry');

module.exports = { fillSheet, findTables, similarity, sheetRegions };

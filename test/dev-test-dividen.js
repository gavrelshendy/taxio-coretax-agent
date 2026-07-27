/* TEMPORARY - offline unit test of automation/dividen.js's parse+validate+translate pipeline,
   using the generated template and the live-scraped reference data (no browser needed). */
const fs = require('fs');
const path = require('path');
const dividen = require('../automation/dividen');

// Rebuild the ref maps the way readRefMaps() would, from scraped data.
const scraped = JSON.parse(JSON.parse(fs.readFileSync('.dev-inspect/out-48.json', 'utf8')).find((e) => e.result && e.result.includes('income')).result);
const cities = JSON.parse(fs.readFileSync('.dev-inspect/cities.json', 'utf8'));
const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const maps = {
    income: Object.fromEntries(scraped.income.map((x) => [nrm(x.desc), x.code])),
    currency: Object.fromEntries(scraped.currency.map((x) => [nrm(x.name), x.code])),
    form: Object.fromEntries(scraped.form.map((x) => [nrm(x.name), x.code])),
    city: Object.fromEntries(cities.map((x) => [nrm(x.name), x.code])),
    fullYearPeriods: Object.fromEntries([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027].map((y) => ['0112' + y, true])),
};

(async () => {
    const buf = fs.readFileSync('Template Impor Dividen - Coretax Agent.xlsx');
    // parseTemplate / buildRows aren't exported; re-require via internals by monkey-reading? They
    // are module-local. Instead exercise them through a tiny copy of the flow is overkill - so
    // just re-export check: call the internal funcs by requiring the file's private pieces isn't
    // possible. Re-implement the two-call sequence by temporarily exposing them:
    const mod = require('../automation/dividen');
    // parseTemplate + buildRows are internal; expose for the test via the module's own functions
    // by reading them off a fresh require with a test hook is messy - instead just re-run the
    // exact same logic here would duplicate. Simplest: add a hidden test export.
    if (!mod.__test) { console.log('NOTE: add module.exports.__test = { parseTemplate, buildRows } to run this test.'); return; }
    const parsed = await mod.__test.parseTemplate(buf);
    console.log('Parsed city:', parsed.city, '| dividen rows:', parsed.dividen.length, '| investasi rows:', parsed.investasi.length);
    console.log('First dividen parsed:', JSON.stringify(parsed.dividen[0]));
    const built = mod.__test.buildRows(parsed, maps);
    console.log('cityCode:', built.cityCode);
    console.log('errors (' + built.errors.length + '):', built.errors);
    console.log('dividend[0]:', JSON.stringify(built.dividend[0]));
    console.log('investment[0]:', JSON.stringify(built.investment[0]));
})();

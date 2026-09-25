/* Runs only in the isolated print document, never in the live Coretax form. */
module.exports = ({ mode, taxTypeCode, references }) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const format = cents => { const neg=cents<0n;const v=neg?-cents:cents;return(neg?'-':'')+(v/100n).toLocaleString('id-ID')+(v%100n?','+String(v%100n).padStart(2,'0'):''); };
    const amount = text => {
        let s=clean(text).replace(/^Rp\.?\s*/i,'').replace(/\s/g,'');
        if (!s || s==='-' || s==='–') return null;
        const negative=/^\(.*\)$/.test(s);if(negative)s=s.slice(1,-1);
        if(!/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(s))return null;
        s=s.replace(/\./g,'');const sign=s.startsWith('-')||negative?-1n:1n;const [a,b='']=s.replace(/^-/,'').split(',');return sign*(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));
    };
    const headerGrid = table => {
        const grid=[];
        [...table.tHead?.rows||[]].forEach((row,y)=>{grid[y] ||= [];let x=0;[...row.cells].forEach(cell=>{while(grid[y][x]!==undefined)x++;for(let dy=0;dy<cell.rowSpan;dy++){grid[y+dy] ||= [];for(let dx=0;dx<cell.colSpan;dx++)grid[y+dy][x+dx]=clean(cell.textContent);}x+=cell.colSpan;});});
        const width=Math.max(0,...grid.map(r=>r.length));return Array.from({length:width},(_,x)=>[...new Set(grid.map(r=>r[x]).filter(v=>v&&!/^\(?\d+\)?$/.test(v)))].join(' / '));
    };
    const style=document.createElement('style');style.textContent='tfoot{display:table-row-group!important}tfoot td{font-size:inherit!important;padding:1.1mm .7mm!important}tfoot tr{break-inside:avoid!important}.omitted td{background:#fff7d6!important;font-weight:400!important;text-align:left!important}.control-difference td{background:#fff0e9!important}.p-panel-header{margin-bottom:0!important}.keep{break-inside:auto!important}p-table:last-child,.p-panel:last-child{margin-bottom:0!important}.col-12:last-child{padding-bottom:0!important}';document.head.append(style);
    const models=[],boxes=[];
    for(const table of document.querySelectorAll('table')){
        const headers=headerGrid(table);if(!headers.length)continue;
        const n=headers.length;
        // A Coretax "table" whose every header row is one full-width label beside a single value
        // cell, with no body rows at all, is a label/value box on the form, not a grid - Badan L3
        // lays out "PENGEMBALIAN/PENGURANGAN PAJAK PENGHASILAN LUAR NEGERI (PASAL 24)..." that way.
        // Read as a grid, that one label repeats across all eleven columns and the value is
        // discarded (headerGrid drops bare numbers); read as a field, it says what it means.
        const headRows=[...(table.tHead?.rows||[])];
        if(n>2&&headRows.length&&![...table.tBodies].flatMap(b=>[...b.rows]).length&&headRows.every(r=>[...r.cells].some(c=>c.colSpan>=n-1))){
            for(const row of headRows){
                const cells=[...row.cells];
                const label=cells.filter(c=>c.colSpan>=n-1).map(c=>clean(c.textContent)).join(' ').trim();
                const value=cells.filter(c=>c.colSpan<n-1).map(c=>clean(c.textContent)).filter(Boolean).join(' ');
                if(label)boxes.push([label,value]);
            }
            continue;
        }
        const numbered=/^NO\.?$/i.test(headers[0]);
        const records=numbered||/^(KODE HARTA|TANGGAL|NPWP|NIK|NOMOR (?:BUKTI|IDENTITAS))/i.test(headers[0]);
        // Non-"records" tables (e.g. a neraca's "KODE AKUN/NAMA AKUN/NILAI" rows) have their grand
        // total styled by Coretax as a native <tfoot> row rather than a <tbody> row - unlike
        // "records" tables, nothing below re-adds totals from tFoot, so it must join allRows here
        // or the total silently vanishes from `rows` (still fine for the screenshot-style PDF path,
        // which never reads `rows` and prints the untouched DOM, but not for anything that does).
        const allRows=[...table.tBodies].flatMap(b=>[...b.rows]).concat(records?[]:[...(table.tFoot?.rows||[])]);
        const data=allRows.filter(r=>!/^Tidak ada data|No records|No data found/i.test(clean(r.textContent)) && (!records || (r.cells.length===n&&r.cells[0].colSpan===1&&(!numbered||/^\d[\d.]*$/.test(clean(r.cells[0].textContent))))));
        const moneyCols=headers.map((h,i)=>({h,i})).filter(({h})=>!(/TARIF|PERSEN|TINGKAT|KODE|NOMOR|NPWP|NIK|TANGGAL|METODE|MATA UANG ASING/i.test(h))&&(/\bRp\b|Rupiah|PENGHASILAN BRUTO|PAJAK PENGHASILAN|DASAR PENGENAAN|\bDPP\b|^PPN$|^PPnBM$|JUMLAH BRUTO|NILAI|SALDO|HARGA|PLAFON|PIUTANG|PPh (?:TERUTANG|YANG|DIPOTONG)|PENGHASILAN NETO|KREDIT PAJAK/i.test(h))).map(x=>x.i);
        const codeAt=headers.findIndex(h=>/^KODE OBJEK PAJAK$/i.test(h)), objectAt=headers.findIndex(h=>/^OBJEK PAJAK$/i.test(h)), taxAt=headers.findIndex(h=>/^JENIS PAJAK$/i.test(h));
        data.forEach((r,i)=>{
            if(numbered)r.cells[0].textContent=(i+1).toLocaleString('id-ID');
            if(taxTypeCode==='ICT_WT'&&codeAt>=0&&objectAt>=0&&taxAt>=0&&/^(?:PPh\s*)?(?:Pasal\s*)?23$/i.test(clean(r.cells[taxAt].textContent))){const translated=references[clean(r.cells[codeAt].textContent)];if(translated)r.cells[objectAt].textContent=translated;}
        });
        const rowValues=data.map(r=>{const values=[];for(const c of r.cells){values.push(clean(c.textContent));for(let j=1;j<c.colSpan;j++)values.push('');}return values;});
        const added=table.nextElementSibling?.classList.contains('added-note');
        // Each foot cell is kept with the column it actually sits on (colSpan-aware), so a total
        // row that the money-column regex cannot account for can still be placed by position.
        const sourceFoot=[...(added?[]:table.tFoot?.rows||[])].map(r=>{let col=0;const cells=[...r.cells].map(c=>{const at=col;col+=c.colSpan;return {col:at,text:clean(c.textContent)};});return {cells,texts:cells.map(c=>c.text).filter(Boolean)};}).filter(r=>r.texts.length);
        const controls={};
        if(records)for(const col of moneyCols){let total=0n;for(const r of rowValues){const value=amount(r[col]);if(value===null&&clean(r[col])&&!/^[-–]$/.test(clean(r[col])))throw Error('Angka kontrol tidak dapat dibaca: '+headers[col]);total+=value??0n;}controls[col]=format(total);}
        const model={headers,rows:rowValues,records,moneyCols,totals:controls,sourceTotals:[],title:clean(table.closest('.p-panel,.p-accordion-tab')?.querySelector('.p-panel-header,.p-accordion-header-link')?.textContent)||'Tabel '+(models.length+1)};
        if(records){
            table.tFoot?.remove();const foot=table.createTFoot();
            const addRow=(label,values,cls='')=>{const tr=foot.insertRow();tr.className=cls;const indices=Object.keys(values).map(Number).sort((a,b)=>a-b);const first=indices.length?indices[0]:n;let col=0;if(first>0){const td=tr.insertCell();td.colSpan=first;td.textContent=label;col=first;}for(;col<n;col++){const td=tr.insertCell();td.textContent=values[col]??'';if(col===0)td.textContent=label;td.className='num';}return tr;};
            // Coretax's own total line ("JUMLAH TABEL 1") and the app's computed control line
            // ("Total seluruh 7 baris") are two ways of saying the same thing. Printing both, with
            // identical figures, reads as a mistake - so the computed one is only shown when it
            // adds something: when no source line agrees with it, or when they differ.
            const mapped=sourceFoot.map(source=>{
                const numbers=source.texts.filter(v=>amount(v)!==null);
                const cols=moneyCols.slice(-numbers.length);
                const vals={};
                if(numbers.length>cols.length){for(const cell of source.cells)if(amount(cell.text)!==null)vals[cell.col]=cell.text;}
                else numbers.forEach((v,i)=>vals[cols[i]]=v);
                return vals;
            });
            const matchesControl=vals=>{
                const keys=Object.keys(controls);
                if(!keys.length||keys.length!==Object.keys(vals).length)return false;
                return keys.every(col=>vals[col]!==undefined&&amount(vals[col])===amount(controls[col]));
            };
            if(Object.keys(controls).length&&!mapped.some(matchesControl)){
                addRow('Total seluruh '+data.length.toLocaleString('id-ID')+' baris',controls);
            }
            for(const source of sourceFoot){
                const label=source.texts.filter(v=>amount(v)===null).join(' / ')||'Total Coretax';const numbers=source.texts.filter(v=>amount(v)!==null);
                const cols=moneyCols.slice(-numbers.length);
                const vals={};
                // Coretax's own total row can cover more numeric columns than the money-column
                // regex recognises - the Unifikasi Induk table carries five where the regex sees
                // two. Rather than widening that regex for every such header, place those numbers
                // on the columns their cells actually occupy.
                if(numbers.length>cols.length){
                    for(const cell of source.cells)if(amount(cell.text)!==null)vals[cell.col]=cell.text;
                    if(Object.keys(vals).length!==numbers.length)throw Error('Kolom total Coretax tidak dapat dipetakan: '+JSON.stringify({headers,source:source.texts,moneyCols}));
                }else numbers.forEach((v,i)=>vals[cols[i]]=v);
                model.sourceTotals.push({label,values:vals});
                const simple=/^(JUMLAH|TOTAL)(\s*\([^)]*\))?$/i.test(label);
                // The difference line is a completeness check: it says the rows on the page do not
                // add up to the total Coretax states. In the compact PDF that gap is created on
                // purpose - only the first 50 rows are fetched - so reporting it there reads as an
                // error when it is just the cap doing its job. The "showing 50 of N" note covers it.
                const diffs={};if(simple&&data.length&&mode!=='print')for(const col of Object.keys(vals).map(Number))if(controls[col]!==undefined){const diff=amount(controls[col])-amount(vals[col]);if(diff!==0n)diffs[col]=format(diff);}
                if(!simple||Object.keys(diffs).length){addRow(label,vals);if(Object.keys(diffs).length){addRow('Selisih total hitung terhadap Coretax',diffs,'control-difference');model.differences=diffs;}}
            }
            if(mode==='print'&&data.length>50){data.slice(50).forEach(r=>r.remove());const tr=foot.insertRow(0);tr.className='omitted';const td=tr.insertCell();td.colSpan=n;td.textContent='Ditampilkan 50 dari '+data.length.toLocaleString('id-ID')+' baris. '+(data.length-50).toLocaleString('id-ID')+' baris lainnya tidak ditampilkan dalam PDF ringkas. Rincian lengkap tersedia melalui unduhan Excel atau PDF lengkap.';}
        }
        // Added control totals can be wider than any individual source amount.
        const cols=[...table.querySelectorAll(':scope>colgroup>col')];
        if(cols.length===n){
            const canvas=document.createElement('canvas').getContext('2d');
            const minimum=Array(n).fill(0),base=cols.map(c=>c.getBoundingClientRect().width);
            for(const row of [...allRows,...table.tFoot?.rows||[]]){if(!row.isConnected)continue;let index=0;for(const cell of row.cells){
                const text=clean(cell.textContent),css=getComputedStyle(cell);
                if(cell.colSpan===1&&/^(?:Rp\.?\s*)?-?[\d.,]+$/.test(text)){
                    canvas.font=css.fontWeight+' '+css.fontSize+' '+css.fontFamily;
                    minimum[index]=Math.max(minimum[index],canvas.measureText(text).width+parseFloat(css.paddingLeft)+parseFloat(css.paddingRight)+3);
                }index+=cell.colSpan;
            }}
            const total=table.getBoundingClientRect().width;
            const widths=base.map((w,i)=>Math.max(w,minimum[i]));
            const excess=widths.reduce((a,b)=>a+b,0)-total;
            if(excess>0){const room=widths.map((w,i)=>Math.max(0,w-Math.max(40,minimum[i]))),available=room.reduce((a,b)=>a+b,0);if(available>=excess)widths.forEach((w,i)=>widths[i]=w-excess*room[i]/available);}
            widths.forEach((w,i)=>cols[i].style.width=(w/total*100)+'%');
        }
        models.push(model);
    }
    const fields=[...document.querySelectorAll('.financial-row,.choice-row')].filter(r=>!r.closest('table')).map(r=>[...r.children].map(c=>clean(c.textContent)));
    const other=document.body.cloneNode(true);other.querySelectorAll('table,style,.p-panel-header,.p-accordion-header-link,.financial-row,.choice-row').forEach(n=>n.remove());
    return {tables:models,fields:[...fields,...boxes],otherText:clean(other.textContent)};
};

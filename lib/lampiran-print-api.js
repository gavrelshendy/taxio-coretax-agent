/* Lampiran printing: rows from Coretax's grid API written into the print snapshot (annual, PPh
 * 21/26, Unifikasi, PPN) and printed chunk by chunk; the PPh 21 confidential overview page.
 * Split out of automation/lampiran.js (still the public entry point). */
const { PDFDocument } = require('pdf-lib');
const { log } = require('./log');
const returnsheetGridApi = require('./returnsheet-grid-api');
const { PPH21_API_GRIDS, UNIFIKASI_API_GRIDS, PPN_API_GRIDS, ANNUAL_API_GRIDS } = require('./lampiran-config');
const { printPdf, stampHeaderOnPdf } = require('./lampiran-print-pdf');
const { setActivePaginatorOwner, clearPaginatorOwners } = require('./lampiran-print-paginator');

async function replaceAnnualSnapshotRows(page, rootSelector, items) {
    const payload = { rootSelector, items };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=value=>String(value??'').replace(/\\s+/g,' ').trim(),upper=value=>clean(value).toUpperCase();
      const visible=node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
      const source=document.querySelector(p.rootSelector);if(!source)return{ok:false,reason:'root-not-found'};
      source.querySelectorAll('[data-ca-annual-table-index]').forEach(node=>node.removeAttribute('data-ca-annual-table-index'));
      const sourceOwners=Array.from(source.querySelectorAll('p-table')).filter(visible);sourceOwners.forEach((owner,index)=>owner.dataset.caAnnualTableIndex=String(index));
      source.querySelectorAll('[data-ca-annual-active-panel]').forEach(node=>node.removeAttribute('data-ca-annual-active-panel'));const activePanel=Array.from(source.querySelectorAll('.p-tabview-panel')).find(visible);if(activePanel)activePanel.dataset.caAnnualActivePanel='1';
      const sync=(a,b)=>{const left=a.querySelectorAll('input,textarea,select'),right=b.querySelectorAll('input,textarea,select');left.forEach((control,index)=>{const target=right[index];if(!target)return;target.value=control.value||'';target.setAttribute('value',control.value||'');if('checked'in control){target.checked=control.checked;target.toggleAttribute('checked',!!control.checked)}if(control.tagName==='SELECT')Array.from(target.options).forEach((option,i)=>option.selected=!!control.options[i]?.selected)})};
      document.getElementById('__ca_annual_snapshot')?.remove();const snapshot=document.createElement('div');snapshot.id='__ca_annual_snapshot';const root=source.cloneNode(true);sync(source,root);const header=document.getElementById('__ca_print_header');let headerCopy=null;if(header){headerCopy=header.cloneNode(true);headerCopy.removeAttribute('id');headerCopy.classList.add('__ca_print_header_clone')}source.querySelectorAll('[data-ca-annual-active-panel]').forEach(node=>node.removeAttribute('data-ca-annual-active-panel'));snapshot.appendChild(root);if(headerCopy)snapshot.prepend(headerCopy);document.body.appendChild(snapshot);document.body.classList.add('__ca_annual_snapshot_active');
      const date=value=>{const match=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return match?match[3]+'-'+match[2]+'-'+match[1]:clean(value)};
      const monthYear=value=>{const match=clean(value).match(/^(\\d{4})-(\\d{2})/);return match?match[2]+'-'+match[1]:clean(value)};
      const number=value=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:0,maximumFractionDigits:2});
      const mapped=(heading,row,index,endpoint)=>{const h=upper(heading),ep=String(endpoint||'').toLowerCase();
        if(/^TINDAKAN$|^ACTION$/.test(h))return['',true];if(/^NO\\.?$/.test(h))return[index+1,true];if(/^KODE$/.test(h))return[row.Code,true];if(/^DESKRIPSI$/.test(h))return[row.Description,true];if(/^KETERANGAN$/.test(h))return[row.Remark??row.Notes,true];
        if(ep.includes('l3-table-b-grid')){if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/NPWP.*PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/JENIS PAJAK/.test(h))return[row.TaxType,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/PPH YANG DIPOTONG\\/DIPUNGUT/.test(h))return[row.IncomeTax,true];if(/BUKTI POTONG.*NOMOR/.test(h))return[row.WithholdingSlipsNumber,true];if(/BUKTI POTONG.*TANGGAL/.test(h))return[row.WithholdingSlipsDate,true]}
        if(ep.includes('l4-table-a-grid')){if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];if(/^OBJEK PAJAK$/.test(h))return[row.TaxObject,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/TINGKAT/.test(h))return[row.TaxRate,true];if(/PPH FINAL TERUTANG/.test(h))return[row.IncomeTax,true]}
        if(/l9-table-[123]-grid/.test(ep)){if(/KODE HARTA/.test(h))return[clean(row.CodeOfAsset)?row.CodeOfAsset:row.GroupAssetType,true];if(/KELOMPOK\\/JENIS HARTA/.test(h))return[row.GroupAssetType,true];if(/BULAN\\/TAHUN PEROLEHAN/.test(h))return[monthYear(row.MonthYearAcquisition),true];if(/BIAYA PEROLEHAN/.test(h))return[row.AcquisitionPrice,true];if(/NILAI SISA BUKU/.test(h))return[row.RemainingBeginningValue,true];if(/(?:METODE|PILIH).*KOMERSIAL|^KOMERSIAL$/.test(h))return[row.MethodCommercial,true];if(/(?:METODE|PILIH).*FISKAL|^FISKAL$/.test(h))return[row.MethodFiscal,true];if(/PENYUSUTAN\\/AMORTISASI FISKAL TAHUN INI/.test(h))return[row.FiscalYearValue,true]}
        if(ep.includes('l1-table-a1-grid')){if(/NOMOR AKUN/.test(h))return[row.AccountNumber,true];if(/ATAS NAMA/.test(h))return[row.OnBehalfOf,true];if(/NAMA BANK\\/INSTITUSI/.test(h))return[row.BankInstitutionName,true];if(/LOKASI HARTA/.test(h))return[row.CountryLocated,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/^SALDO$/.test(h))return[row.Balance,true]}
        if(ep.includes('l1-table-a2-grid')){if(/LOKASI PENERIMA PINJAMAN/.test(h))return[row.CountryRecipient,true];if(/NIK\\/NPWP PENERIMA PINJAMAN/.test(h))return[row.TinOfRecipient,true];if(/NAMA PENERIMA PINJAMAN/.test(h))return[row.NameOfRecipient,true];if(/TAHUN DIMULAI/.test(h))return[row.YearOfReceivable,true];if(/NILAI PIUTANG/.test(h))return[row.ReceivableValue,true];if(/SALDO PIUTANG/.test(h))return[row.CurrentBalance,true]}
        if(ep.includes('l1-table-a3-grid')){if(/LOKASI HARTA/.test(h))return[row.CountryLocated,true];if(/NPWP BANK\\/INSTITUSI\\/PENERIMA INVESTASI/.test(h))return[row.TinOfRecipient,true];if(/NAMA BANK\\/INSTITUSI\\/PENERIMA INVESTASI/.test(h))return[row.NameOfRecipient,true];if(/NOMOR AKUN/.test(h))return[row.AccountNumber,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance,true]}
        if(ep.includes('l1-table-a4-grid')){if(/^TIPE$/.test(h))return[row.Type??row.Description,true];if(/MERK\\/MODEL/.test(h))return[row.BrandModel,true];if(/NOMOR POLISI\\/REGISTRASI/.test(h))return[row.RegistrationNumber,true];if(/^KEPEMILIKAN$/.test(h))return[row.Ownership,true];if(/NIK\\/NPWP PEMILIK/.test(h))return[row.OwnerTIN,true];if(/NAMA PEMILIK/.test(h))return[row.OwnerName,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance??row.FairMarketValue,true]}
        if(ep.includes('l1-table-a5-grid')){if(/LOKASI HARTA/.test(h))return[row.LocationOfAsset,true];if(/UKURAN PROPERTI - TANAH/.test(h))return[row.PropertyTypeLand,true];if(/UKURAN PROPERTI - BANGUNAN/.test(h))return[row.PropertyTypeBuilding,true];if(/SUMBER KEPEMILIKAN/.test(h))return[row.SourceOfOwnership,true];if(/NOMOR SERTIFIKAT/.test(h))return[row.CertificateNumber,true];if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.FairMarketValue,true]}
        if(ep.includes('l1-table-a6-grid')){if(/TAHUN PEROLEHAN/.test(h))return[row.YearOfAcquisition,true];if(/BUKTI KEPEMILIKAN|NOMOR AKUN/.test(h))return[row.OwnershipEvidence??row.AccountNumber,true];if(/INFORMASI TAMBAHAN/.test(h))return[row.AdditionalInformation,true];if(/HARGA PEROLEHAN/.test(h))return[row.CostOfAcquisition,true];if(/NILAI SAAT INI/.test(h))return[row.CurrentBalance??row.FairMarketValue,true]}
        if(ep.includes('l1-table-d-grid')){if(/NAMA PEMBERI KERJA/.test(h))return[row.NameOfEmployer,true];if(/NOMOR IDENTITAS PEMBERI KERJA/.test(h))return[row.TinOfEmployer,true];if(/^PENGHASILAN BRUTO$/.test(h))return[row.GrossIncome,true];if(/PENGURANG PENGHASILAN BRUTO/.test(h))return[row.DeductionOfGrossIncome,true];if(/PENGHASILAN NETO/.test(h))return[row.NetIncome,true]}
        if(ep.includes('l1-table-e-grid')){if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.TaxpayerName,true];if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NOMOR BUKTI/.test(h))return[row.WithholdingSlipNumber,true];if(/TANGGAL BUKTI/.test(h))return[row.WithholdingSlipsDate,true];if(/JENIS PAJAK/.test(h))return[row.TaxType,true];if(/PENGHASILAN BRUTO/.test(h))return[row.TaxBase,true];if(/PPh YANG DIPOTONG\\/DIPUNGUT/i.test(h))return[row.IncomeTax,true]}
        if(ep.includes('l2-table-a-grid')){if(/NPWP PEMOTONG\\/PEMUNGUT/.test(h))return[row.TIN,true];if(/NAMA PEMOTONG\\/PEMUNGUT/.test(h))return[row.Name,true];if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];if(/JENIS PENGHASILAN/.test(h))return[row.TaxObject,true];if(/DASAR PENGENAAN PAJAK/.test(h))return[row.TaxBase,true];if(/PPh TERUTANG/i.test(h))return[row.WithholdingTax,true]}
        return['',false]};
      const cellText=cell=>{const clone=cell.cloneNode(true);clone.querySelectorAll('.p-column-title,[class*="column-title" i]').forEach(node=>node.remove());return clean(clone.textContent)};
      const put=(cell,value)=>{let text=clean(value);if(typeof value==='number')text=number(value);else if(/^\\d{4}-\\d{2}-\\d{2}/.test(text))text=date(text);else if(text==='IDN')text='Indonesia';else if(text==='ARTICLE21')text='Pasal 21';
        // Clone kontrol Angular tidak lagi memiliki change detection. Nilai properti value dapat
        // terlihat di DOM tetapi kosong saat dicetak, jadi isi baris tambahan dibuat statis.
        const mobile=Array.from(cell.querySelectorAll('.p-column-title,[class*="column-title" i]')).map(node=>node.cloneNode(true));cell.replaceChildren(...mobile,document.createTextNode(text));return text};
      const results=[],usedOwners=new Set();
      for(const item of p.items){const regex=new RegExp(item.signature,'i'),owners=Array.from(root.querySelectorAll('p-table[data-ca-annual-table-index]'));let selected=null;
        for(const owner of owners){if(usedOwners.has(owner))continue;if(Number.isInteger(item.tableIndex)&&Number(owner.dataset.caAnnualTableIndex)!==item.tableIndex)continue;const table=owner.querySelector('table');if(!table?.tHead)continue;const rows=Array.from(table.tHead.rows),head=rows.sort((a,b)=>b.cells.length-a.cells.length)[0],signature=clean(table.tHead.textContent);if(regex.test(signature)){selected={owner,table,head};usedOwners.add(owner);break}}
        if(!selected){if(item.total>0)return{ok:false,reason:'table-not-found',endpoint:item.endpoint,signature:item.signature};results.push({endpoint:item.endpoint,total:item.total,visible:0,appended:0});continue}
        const headerRow=Array.from(selected.head.cells).map(cell=>clean(cell.textContent)),body=selected.table.tBodies[0],existing=Array.from(body?.rows||[]).filter(row=>!/TIDAK ADA DATA|NO RECORDS?/i.test(clean(row.textContent)));
        // Tabel L9 memakai header bertingkat dan satu baris filter dengan sembilan sel.
        // Baris filter itulah yang memiliki jumlah sel terbanyak, tetapi sebagian besar
        // judulnya kosong. PrimeNG menaruh judul daun yang benar di .p-column-title pada
        // setiap sel data; gunakan itu sebagai sumber utama agar tanggal, angka, kode,
        // serta keterangan tidak dipetakan sebagai kolom tanpa nama lalu dikosongkan.
        const headers=existing[0]&&existing[0].cells.length===headerRow.length
          ? Array.from(existing[0].cells).map((cell,index)=>clean(cell.querySelector('.p-column-title,[class*="column-title" i]')?.textContent)||headerRow[index]||'')
          : headerRow;
        const unmapped=headers.filter(header=>header&&!mapped(header,item.rows[0]||{},0,item.endpoint)[1]);if(unmapped.length&&item.total>existing.length)return{ok:false,reason:'unmapped-headers',endpoint:item.endpoint,unmapped};
        const lookups=headers.map(()=>new Map());for(let index=0;index<Math.min(existing.length,item.rows.length);index++){headers.forEach((header,column)=>{const raw=mapped(header,item.rows[index],index,item.endpoint)[0],shown=cellText(existing[index].cells[column]);if(clean(raw)&&shown)lookups[column].set(clean(raw),shown)})}
        const fallbackTemplate=existing[existing.length-1]||body?.rows?.[0];if(item.rows.length&&!fallbackTemplate)return{ok:false,reason:'row-template-not-found',endpoint:item.endpoint};
        const replacement=body.cloneNode(false),isNumeric=header=>/DASAR PENGENAAN|PENGHASILAN BRUTO|(?:^| )PPH(?: |$)|NILAI|BIAYA|JUMLAH|TINGKAT|PENYUSUTAN|HARGA|SALDO/i.test(header),isCentered=header=>/^(?:NO[.]?|KODE|KOMERSIAL|FISKAL)$|NPWP|NIK|JENIS PAJAK|KODE (?:OBJEK|HARTA)|BUKTI POTONG.*(?:NOMOR|TANGGAL)|BULAN[^A-Z0-9]TAHUN|METODE|PILIH (?:KOMERSIAL|FISKAL)/i.test(header);
        for(let index=0;index<item.rows.length;index++){const template=existing[Math.min(index,Math.max(0,existing.length-1))]||fallbackTemplate,row=template.cloneNode(true);if(row.cells.length!==headers.length)return{ok:false,reason:'column-count-mismatch',endpoint:item.endpoint,row:index,expected:headers.length,actual:row.cells.length};let expectedValues=0,printedValues=0;headers.forEach((header,column)=>{const result=mapped(header,item.rows[index],index,item.endpoint);let value=result[0],known=lookups[column].get(clean(value));if(known)value=known;if(result[1]&&clean(value)!=='')expectedValues++;const cell=row.cells[column],printed=put(cell,value);cell.classList.toggle('__ca_numeric',isNumeric(header));cell.classList.toggle('__ca_center',!isNumeric(header)&&isCentered(header));if(result[1]&&clean(printed)!=='')printedValues++});if(printedValues!==expectedValues)return{ok:false,reason:'static-value-mismatch',endpoint:item.endpoint,row:index,expectedValues,printedValues};replacement.appendChild(row)}
        body.replaceWith(replacement);const finalRows=Array.from(replacement.rows||[]).filter(row=>!/TIDAK ADA DATA|NO RECORDS?/i.test(clean(row.textContent))).length;if(finalRows!==item.total)return{ok:false,reason:'row-count-mismatch',endpoint:item.endpoint,expected:item.total,actual:finalRows};
        results.push({endpoint:item.endpoint,total:item.total,visible:existing.length,appended:Math.max(0,item.total-existing.length),staticRows:finalRows,headers})}
      return{ok:true,tables:results};
    })()`).catch(error=>({ ok: false, reason: error.message }));
}

async function printAnnualApiPages(page, session, taxTypeCode, tabLabel, rootSelector, printScale) {
    const mappings = ANNUAL_API_GRIDS[taxTypeCode] && ANNUAL_API_GRIDS[taxTypeCode][tabLabel];
    if (!mappings) return null;
    const variants = returnsheetGridApi.dataRequestVariants(page.context());
    const available = new Set(variants.map((request) => request.pathname));
    const active = mappings.filter((mapping) => Array.from(available).some((pathname) => pathname.endsWith(mapping.suffix)));
    if (!active.length) return null;
    const items = [];
    for (const mapping of active) {
        if (mapping.allVariants) {
            const matched = variants.filter((request) => request.pathname.endsWith(mapping.suffix));
            for (let index = 0; index < matched.length; index++) {
                const grid = await returnsheetGridApi.fetchAllRowsFromRequest(page, matched[index]);
                if (grid.total > 0) items.push({ ...mapping, tableIndex: mapping.tableIndexOffset + index,
                    endpoint: grid.endpoint, total: grid.total, rows: grid.rows });
            }
        } else {
            const grid = await returnsheetGridApi.fetchAllRows(page, mapping.suffix);
            items.push({ ...mapping, endpoint: grid.endpoint, total: grid.total, rows: grid.rows });
        }
    }
    if (!items.length) return null;
    const rendered = await replaceAnnualSnapshotRows(page, rootSelector, items);
    if (!rendered || !rendered.ok) throw new Error('Renderer API tahunan ' + tabLabel + ' gagal: ' + JSON.stringify(rendered));
    for (const table of rendered.tables) log('[Lampiran API tahunan] ' + tabLabel + ': ' + table.total + '/' + table.total + ' baris dari ' + table.endpoint + ' (tambahan ' + table.appended + ').');
    await page.evaluate(`(()=>{document.getElementById('__ca_annual_page_style')?.remove();const style=document.createElement('style');style.id='__ca_annual_page_style';style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 0!important}body.__ca_annual_header_only #__ca_annual_snapshot>*:not(.__ca_print_header_clone){display:none!important}body.__ca_annual_header_only #__ca_annual_snapshot .__ca_print_header_clone{display:grid!important;position:static!important;margin:0!important;padding:3px 5px 6px!important;background:#fff!important}}';document.head.appendChild(style);document.body.classList.add('__ca_annual_header_only')})()`);
    try {
        const headerBuffer = await printPdf(session, 1);
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_header_only');const style=document.getElementById('__ca_annual_page_style');if(style)style.textContent='@media print{@page{size:A3 landscape!important;margin:7mm 8mm 8mm!important}body.__ca_annual_snapshot_active #__ca_annual_snapshot .__ca_print_header_clone{display:none!important}body.__ca_annual_snapshot_active #__ca_annual_snapshot table tfoot{display:table-row-group!important}}'})()`);
        const contentBuffer = await printPdf(session, printScale);
        return [await stampHeaderOnPdf(contentBuffer, headerBuffer)];
    }
    finally {
        await page.evaluate(`(()=>{document.body.classList.remove('__ca_annual_header_only');document.getElementById('__ca_annual_page_style')?.remove();document.getElementById('__ca_annual_snapshot')?.remove();document.body.classList.remove('__ca_annual_snapshot_active');document.querySelectorAll('[data-ca-annual-table-index]').forEach(node=>node.removeAttribute('data-ca-annual-table-index'))})()`).catch(() => {});
    }
}

async function replacePph21SnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tHead.rows[0]?.cells.length||0)-(a.tHead.rows[0]?.cells.length||0))[0];if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0],headers=Array.from(headerRow.cells).map(cell=>clean(cell.textContent));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const date=value=>{const m=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:clean(value)};
      const number=(value,digits=0)=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:digits,maximumFractionDigits:digits});
      const title=value=>clean(value).toLowerCase().replace(/(^|\\s)\\S/g,char=>char.toUpperCase());
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true];
        if(/NIK\\/NPWP|NOMOR IDENTITAS/.test(h))return[row.TIN??row.Tin,true];
        if(/^NAMA$|NAMA PEMOTONG|NAMA PENERIMA/.test(h))return[row.Name,true];
        if(/JENIS PAJAK/.test(h))return[row.TaxArticle,true];
        if(/NOMOR BUKTI POTONG/.test(h))return[row.WithholdingSlipsNumber??row.WithholdingNumber,true];
        if(/TANGGAL BUKTI PEMOTONGAN/.test(h))return[date(row.WithholdingSlipsDate??row.WithholdingDate),true];
        if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];
        if(/OBJEK PAJAK/.test(h))return[row.TaxObject,true];
        if(/PENGHASILAN BRUTO/.test(h))return[number(row.GrossIncome),true];
        if(/TARIF PAJAK/.test(h))return[number(row.TaxRate,2),true];
        if(/PAJAK PENGHASILAN/.test(h))return[number(row.IncomeTax),true];
        if(/FASILITAS PERPAJAKAN/.test(h)){const value=clean(row.TaxCertificate);return[value==='9'?'Tanpa Fasilitas':value,true]}
        if(/^NEGARA$/.test(h)){const value=clean(row.CountryCode);return[value==='IDN'?'Indonesia':value,true]}
        if(/MASA PE+ROLEHAN PENGHASILAN/.test(h))return[row.IncomePeriod??[row.IncomePeriodStart,row.IncomePeriodEnd].filter(Boolean).join(' - '),true];
        if(/ID TEMPAT KEGIATAN USAHA|NITKU/.test(h))return[row.PlaceOfBusinessID,true];
        if(/KAP-KJS/.test(h))return[row.RevenueCode,true];
        if(/^STATUS$/.test(h))return[title(row.Status),true];
        return['',false]};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';headers.forEach((header,column)=>{const td=document.createElement('td');td.className=classes[column]||'';td.textContent=clean(mapped(header,row,index)[0]);tr.appendChild(td)});body.appendChild(tr)});
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printAdaptiveApiGrid(page, session, printScale, options) {
    const allRows = options.rows || [];
    const maxRows = Math.max(1, Number(options.maxRows) || 25);
    let preferredRows = maxRows;
    const buffers = [];
    for (let offset = 0; offset < allRows.length;) {
        let count = Math.min(preferredRows, allRows.length - offset);
        let accepted = null;
        while (count >= 1) {
            await page.evaluate(`window.__ca_rebuildRepeatSnapshot&&window.__ca_rebuildRepeatSnapshot()`).catch(() => {});
            const chunk = allRows.slice(offset, offset + count);
            const finalChunk = !!options.isLastGrid && offset + count >= allRows.length;
            const rendered = await options.render(chunk, offset, finalChunk);
            if (!rendered || !rendered.ok) throw new Error(options.errorLabel + ' gagal: ' + JSON.stringify(rendered));
            const buffer = await printPdf(session, printScale);
            const physicalPages = (await PDFDocument.load(buffer)).getPageCount();
            if (physicalPages === 1) {
                accepted = buffer;
                preferredRows = Math.min(preferredRows, count);
                break;
            }
            if (count === 1) {
                throw new Error(options.errorLabel + ' masih menghasilkan ' + physicalPages + ' halaman fisik untuk satu baris.');
            }
            count--;
        }
        buffers.push(accepted);
        offset += count;
    }
    return buffers;
}

async function printPph21ApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = PPH21_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API ' + tabLabel,
            render: (rows, offset, finalChunk) => replacePph21SnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk)
        }));
        log('[Lampiran API] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

async function replaceUnifikasiSnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk, totals) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk, totals: totals || null };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      snapshot.querySelectorAll('table.__ca_sibling_empty_table').forEach(table=>{const section=table.closest('p-accordiontab,.p-accordion-tab,p-fieldset,.p-fieldset,p-panel,.p-panel')||table.parentElement;if(section&&!section.contains(owner))section.style.setProperty('display','none','important')});
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tHead.rows[0]?.cells.length||0)-(a.tHead.rows[0]?.cells.length||0))[0];if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0],headers=Array.from(headerRow.cells).map(cell=>clean(cell.textContent));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const date=value=>{const m=clean(value).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:clean(value)};
      const number=(value,digits=0)=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{minimumFractionDigits:digits,maximumFractionDigits:digits});
      const title=value=>clean(value).toLowerCase().replace(/(^|\\s)\\S/g,char=>char.toUpperCase());
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true];
        if(/NIK\\/NPWP PENERIMA/.test(h))return[row.RecipientIdentificationNumber??row.TaxIdentificationNumber,true];
        if(/NAMA PENERIMA/.test(h))return[row.RecipientName??row.TaxpayerName,true];
        if(/IDENTITAS AKUN PENERIMA/.test(h))return[row.RecipientAccountId??row.RecipientAccountIdentifier??row.RecipientAccountID,true];
        if(/NIK\\/NPWP PEMBERI/.test(h))return[row.GiverIdentificationNumber??row.PayerIdentificationNumber,true];
        if(/NAMA PEMBERI/.test(h))return[row.GiverName??row.PayerName,true];
        if(/IDENTITAS AKUN PEMBERI/.test(h))return[row.GiverAccountId??row.PayerAccountIdentifier??row.PayerAccountID,true];
        if(/^NIK\\/NPWP$/.test(h))return[row.TaxIdentificationNumber,true];
        if(/^NAMA$/.test(h))return[row.TaxpayerName,true];
        if(/NOMOR BUKTI POTONG/.test(h))return[row.WithholdingSlipsNumber,true];
        if(/TANGGAL BUKTI POTONG/.test(h))return[date(row.WithholdingSlipsDate),true];
        if(/NOMOR DOKUMEN/.test(h))return[row.BillingDocumentNumber??row.DocumentNumber,true];
        if(/TANGGAL DOKUMEN/.test(h))return[date(row.BillingDocumentDate??row.DocumentDate),true];
        if(/JENIS PAJAK/.test(h))return[row.TaxArticle,true];
        if(/KODE OBJEK PAJAK/.test(h))return[row.TaxObjectCode,true];
        if(/^OBJEK PAJAK$/.test(h))return[row.TaxObject,true];
        if(/DASAR PENGENAAN PAJAK/.test(h))return[number(row.TaxBase),true];
        if(/TINGKAT/.test(h))return[number(row.TaxRate,2),true];
        if(/PAJAK PENGHASILAN/.test(h))return[number(row.IncomeTax),true];
        if(/FASILITAS PERPAJAKAN/.test(h)){const value=clean(row.TaxCertificate);return[value==='9'?'Tanpa Fasilitas':value,true]}
        if(/UANG PERSEDIAAN \\/ PEMBAYARAN LANGSUNG/.test(h))return[row.PaymentMethod,true];
        if(/NITKU|IDENTITAS SUBUNIT ORGANISASI/.test(h))return[row.BranchId,true];
        if(/^STATUS$/.test(h))return[title(row.Status),true];
        if(/KAP-KJS/.test(h))return[row.RevenueCode,true];
        return['',false]};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';headers.forEach((header,column)=>{const td=document.createElement('td');td.className=classes[column]||'';td.textContent=clean(mapped(header,row,index)[0]);tr.appendChild(td)});body.appendChild(tr)});
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else{snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});if(!table.tFoot&&p.totals){const dpp=headers.findIndex(header=>/DASAR PENGENAAN PAJAK/i.test(header)),pph=headers.findIndex(header=>/PAJAK PENGHASILAN/i.test(header));const foot=document.createElement('tfoot'),tr=document.createElement('tr'),cells=headers.map((header,index)=>{const td=document.createElement('td');td.className=classes[index]||'';tr.appendChild(td);return td});const labelAt=Math.max(0,(dpp>=0?dpp:pph)-1);cells[labelAt].textContent='JUMLAH';cells[labelAt].classList.add('__ca_total_label');if(dpp>=0){cells[dpp].textContent=number(p.totals.taxBase);cells[dpp].classList.add('__ca_numeric')}if(pph>=0){cells[pph].textContent=number(p.totals.incomeTax);cells[pph].classList.add('__ca_numeric')}foot.appendChild(tr);table.appendChild(foot)}}
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printUnifikasiApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = UNIFIKASI_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        const totals = grid.rows.reduce((sum, row) => {
            const taxBase = Number(row && row.TaxBase), incomeTax = Number(row && row.IncomeTax);
            if (Number.isFinite(taxBase)) sum.taxBase += taxBase;
            if (Number.isFinite(incomeTax)) sum.incomeTax += incomeTax;
            return sum;
        }, { taxBase: 0, incomeTax: 0 });
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API ' + tabLabel,
            render: (rows, offset, finalChunk) => replaceUnifikasiSnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk, totals)
        }));
        log('[Lampiran API] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

async function replacePpnSnapshotRows(page, rootSelector, ownerId, rows, rowOffset, finalChunk) {
    const payload = { rootSelector, ownerId: String(ownerId), rows, rowOffset, finalChunk: !!finalChunk };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},clean=v=>String(v??'').replace(/\\s+/g,' ').trim(),upper=v=>clean(v).toUpperCase();
      const scalar=value=>value&&typeof value==='object'?(value.Name??value.Description??value.Label??value.Code??value.Value??''):value;
      const pick=(row,...keys)=>{for(const key of keys){const value=row&&row[key];if(value!==undefined&&value!==null&&value!=='')return scalar(value)}return''};
      const snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const owner=snapshot.querySelector('[data-ca-paginator-owner-id="'+CSS.escape(p.ownerId)+'"]');if(!owner)return{ok:false,reason:'owner-not-found'};
      const candidates=Array.from(owner.querySelectorAll('table.__ca_layout')).filter(table=>table.tHead&&table.tHead.rows.length);
      const table=candidates.sort((a,b)=>(b.tBodies[0]?.rows[0]?.cells.length||b.tHead.rows[0]?.cells.length||0)-(a.tBodies[0]?.rows[0]?.cells.length||a.tHead.rows[0]?.cells.length||0))[0];
      if(!table)return{ok:false,reason:'table-not-found'};
      const headerRow=Array.from(table.tHead.rows).sort((a,b)=>b.cells.length-a.cells.length)[0];
      const leafHeaders=Array.from(headerRow.cells).map(cell=>clean(cell.textContent).replace(/^Pilih\\s+/i,''));
      const oldBody=table.tBodies[0],template=oldBody?.rows[0],classes=Array.from(template?.cells||[]).map(cell=>cell.className);
      const headers=template&&template.cells.length?Array.from(template.cells).map((cell,index)=>clean(cell.querySelector('.p-column-title,[class*="column-title" i]')?.textContent).replace(/^Pilih\\s+/i,'')||leafHeaders[index]||''):leafHeaders;
      if(!headers.length)return{ok:false,reason:'headers-not-found'};
      const date=value=>{const text=clean(scalar(value)),m=text.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);return m?m[3]+'-'+m[2]+'-'+m[1]:text};
      const number=value=>value===null||value===undefined||value===''?'':Number(value).toLocaleString('id-ID',{maximumFractionDigits:0});
      const mapped=(heading,row,index)=>{const h=upper(heading);
        if(!h||/^(PILIH|AKSI|ACTION)$/.test(h))return['',true,''];
        if(/^NO\\.?$/.test(h))return[p.rowOffset+index+1,true,p.rowOffset+index+1];
        if(/NPWP.*PENJUAL|NOMOR IDENTITAS WP.*PENJUAL/.test(h))return[pick(row,'SellerTin'),true,pick(row,'SellerTin')];
        if(/NAMA.*PENJUAL/.test(h)){const raw=pick(row,'SellerName','Name');return[raw,true,raw]}
        if(/NPWP.*PEMBELI|NOMOR IDENTITAS(?: WP)?.*PEMBELI/.test(h))return[pick(row,'BuyerTin'),true,pick(row,'BuyerTin')];
        if(/NAMA.*PEMBELI/.test(h)){const raw=pick(row,'BuyerName','Name');return[raw,true,raw]}
        if(/^NAMA |NAMA PENJUAL BARANG/.test(h))return[pick(row,'Name'),true,pick(row,'Name')];
        if(/NPWP\\/NIK\\/NOMOR PASPOR|NOMOR IDENTITAS WP/.test(h)){const tin=pick(row,'TIN');const fallback=clean(tin)==='0000000000000000'?pick(row,'DocumentNumberByBuyerInfor'):'';return[fallback||tin,true,fallback||tin]}
        if(/^NOMOR FAKTUR PAJAK\\/DOKUMEN TERTENTU|NOMOR BILLING/.test(h))return[pick(row,'BillingNumber'),true,pick(row,'BillingNumber')];
        if(/^TANGGAL FAKTUR PAJAK\\/DOKUMEN TERTENTU|TANGGAL BILLING/.test(h)){const raw=pick(row,'BillingDate');return[date(raw),true,raw]}
        if(/DOKUMEN TERTENTU.*NOMOR|FAKTUR PAJAK.*NOMOR/.test(h))return[pick(row,'DocumentNumber'),true,pick(row,'DocumentNumber')];
        if(/DOKUMEN TERTENTU.*TANGGAL|FAKTUR PAJAK.*TANGGAL/.test(h)){const raw=pick(row,'DocumentDate');return[date(raw),true,raw]}
        if(/JENIS PPN|JENIS PAJAK PERTAMBAHAN NILAI|TIPE TRANSAKSI PPN/.test(h))return[pick(row,'TypeOfVatName','TypeOfVatDescription','TypeOfVatLabel','TypeOfVat'),true,pick(row,'TypeOfVatName','TypeOfVatDescription','TypeOfVatLabel','TypeOfVat')];
        if(/KODE DAN NOMOR SERI/.test(h))return[pick(row,'CodeAndSerialNumber','TaxInvoiceCode'),true,pick(row,'CodeAndSerialNumber','TaxInvoiceCode')];
        if(/DPP NILAI LAIN/.test(h)){const raw=pick(row,'OtherTaxBase');return[number(raw),true,raw]}
        if(/HARGA JUAL|NILAI IMPOR|^DPP(?: \\(RUPIAH\\))?$/.test(h)){const raw=pick(row,'TaxBase');return[number(raw),true,raw]}
        if(/^PPNBM/.test(h)){const raw=pick(row,'STLG');return[number(raw),true,raw]}
        if(/^PPN(?: |\\()/.test(h)){const raw=pick(row,'VAT');return[number(raw),true,raw]}
        if(/^(KETERANGAN|INFORMASI)$/.test(h))return[pick(row,'Information'),true,pick(row,'Information')];
        return['',false,'']};
      const unmapped=[];headers.forEach(header=>{if(header&&!mapped(header,p.rows[0]||{},0)[1])unmapped.push(header)});if(unmapped.length)return{ok:false,reason:'unmapped-headers',unmapped,headers};
      const body=document.createElement('tbody');body.className=oldBody?.className||'';const expected=[];const emptyMapped=[];
      p.rows.forEach((row,index)=>{const tr=document.createElement('tr');tr.className=template?.className||'';const expectedRow=[];headers.forEach((header,column)=>{const result=mapped(header,row,index),value=clean(result[0]),raw=scalar(result[2]);const td=document.createElement('td');td.className=classes[column]||'';const h=upper(header);if(/^NO\\.?$|NPWP|NIK|NOMOR PASPOR|NOMOR IDENTITAS|TANGGAL|NOMOR BILLING|^NOMOR FAKTUR|DOKUMEN TERTENTU.*NOMOR|FAKTUR PAJAK.*NOMOR|KODE DAN NOMOR SERI|JENIS PPN|TIPE TRANSAKSI PPN/.test(h))td.classList.add('__ca_center');if(/DPP|HARGA JUAL|NILAI IMPOR|^PPN(?: |\\()|^PPNBM/.test(h))td.classList.add('__ca_numeric');td.textContent=value;tr.appendChild(td);expectedRow.push(value);if(clean(raw)&&!value)emptyMapped.push({row:p.rowOffset+index+1,header})});body.appendChild(tr);expected.push(expectedRow)});
      if(emptyMapped.length)return{ok:false,reason:'mapped-value-empty',emptyMapped};
      Array.from(table.tBodies).forEach(node=>node.remove());table.insertBefore(body,table.tFoot||null);
      const actual=Array.from(body.rows).map(tr=>Array.from(tr.cells).map(td=>clean(td.textContent)));const mismatches=[];expected.forEach((row,r)=>row.forEach((value,c)=>{if(actual[r]?.[c]!==value)mismatches.push({row:r,column:c,expected:value,actual:actual[r]?.[c]})}));if(mismatches.length)return{ok:false,reason:'render-mismatch',mismatches:mismatches.slice(0,10)};
      if(!p.finalChunk)snapshot.querySelectorAll('tfoot').forEach(node=>node.remove());
      else snapshot.querySelectorAll('[data-ca-paginator-owner-id]').forEach(node=>{const active=node.dataset.caPaginatorOwnerId===p.ownerId;node.classList.toggle('__ca_paginator_owner_hidden',!active);if(!active){node.querySelectorAll('thead,tbody,tfoot').forEach(part=>part.style.setProperty('display','none','important'));const section=node.closest('p-panel,.p-panel,p-fieldset,.p-fieldset,p-accordiontab,.p-accordion-tab');if(section&&!section.contains(owner))section.style.setProperty('display','none','important')}});
      return{ok:true,rows:p.rows.length,columns:headers.length,headers};
    })()`).catch(error => ({ ok: false, reason: error.message }));
}

async function printPpnApiPages(page, session, tabLabel, ids, rootSelector, printScale) {
    const suffixes = PPN_API_GRIDS[tabLabel];
    if (!suffixes) return null;
    const grids = [];
    for (const suffix of suffixes) grids.push(await returnsheetGridApi.fetchAllRows(page, suffix));
    const nonEmpty = grids.filter((grid) => grid.total > 0);
    if (!nonEmpty.length) return [await printPdf(session, printScale)];
    if (nonEmpty.length !== ids.length) {
        throw new Error('Validasi grid PPN ' + tabLabel + ' gagal: backend ' + nonEmpty.length + ' tabel berisi, DOM ' + ids.length + ' paginator.');
    }
    const buffers = [];
    for (let gridIndex = 0; gridIndex < nonEmpty.length; gridIndex++) {
        const grid = nonEmpty[gridIndex], state = ids[gridIndex];
        if (grid.total !== state.total) throw new Error('Jumlah data PPN ' + tabLabel + ' berbeda: backend ' + grid.total + ', DOM ' + state.total + '.');
        const owner = await setActivePaginatorOwner(page, rootSelector, state.id);
        if (!owner || !owner.ok) throw new Error('Owner tabel PPN ' + tabLabel + ' tidak ditemukan: ' + JSON.stringify(owner));
        buffers.push(...await printAdaptiveApiGrid(page, session, printScale, {
            rows: grid.rows,
            isLastGrid: gridIndex === nonEmpty.length - 1,
            errorLabel: 'Renderer API PPN ' + tabLabel,
            render: (rows, offset, finalChunk) => replacePpnSnapshotRows(page, rootSelector, state.id, rows, offset, finalChunk)
        }));
        log('[Lampiran API PPN] ' + tabLabel + ' lengkap: ' + grid.rows.length + '/' + grid.total + ' baris dari ' + grid.endpoint + '.');
    }
    await clearPaginatorOwners(page, rootSelector);
    return buffers;
}

async function replacePph21SnapshotWithOverview(page, rootSelector, summaries) {
    const payload = { rootSelector, summaries };
    return page.evaluate(`(()=>{
      const p=${JSON.stringify(payload)},snapshot=document.getElementById('__ca_repeat_snapshot');if(!snapshot)return{ok:false,reason:'snapshot-not-found'};
      const root=snapshot.querySelector(p.rootSelector);if(!root)return{ok:false,reason:'root-not-found'};
      snapshot.querySelectorAll('.__ca_repeat_page_header').forEach(node=>node.remove());
      const sub=snapshot.querySelector('.__ca_print_header_clone .ca-ph-sub');if(sub)sub.textContent='LAMPIRAN L1-L3';
      const format=value=>Number(value||0).toLocaleString('id-ID',{minimumFractionDigits:0,maximumFractionDigits:2});
      const section=document.createElement('section');section.className='__ca_confidential_summary';
      section.style.cssText='margin:7mm 8mm 0;border:1px solid #d6dee6;border-radius:3px;overflow:hidden;background:#fff;color:#334155;font-family:inherit';
      const heading=document.createElement('div');heading.textContent='RINGKASAN LAMPIRAN PPh PASAL 21 DAN/ATAU PASAL 26';heading.style.cssText='padding:8px 10px;background:#f8fafc;border-bottom:1px solid #d6dee6;color:#172554;font-size:11pt;font-weight:700';section.appendChild(heading);
      const table=document.createElement('table');table.style.cssText='width:100%;table-layout:fixed;border-collapse:collapse;font-size:9.2pt';
      const colgroup=document.createElement('colgroup');['8%','52%','10%','15%','15%'].forEach(width=>{const col=document.createElement('col');col.style.width=width;colgroup.appendChild(col)});table.appendChild(colgroup);
      const thead=document.createElement('thead'),headRow=document.createElement('tr');
      ['KODE','JUDUL LAMPIRAN','JUMLAH DATA','TOTAL PENGHASILAN BRUTO (Rp)','TOTAL PPh (Rp)'].forEach(label=>{const th=document.createElement('th');th.textContent=label;th.style.cssText='padding:7px 8px;background:#eaf0f4;color:#172554;border-right:1px solid #d6dee6;text-align:center;font-weight:700;line-height:1.15';headRow.appendChild(th)});thead.appendChild(headRow);table.appendChild(thead);
      const tbody=document.createElement('tbody');
      p.summaries.forEach(summary=>{const row=document.createElement('tr'),values=[summary.code,summary.title,Number(summary.count||0).toLocaleString('id-ID'),format(summary.grossIncome),format(summary.incomeTax)];values.forEach((value,index)=>{const td=document.createElement('td');td.textContent=value;td.style.cssText='padding:8px;border-top:1px solid #d6dee6;border-right:1px solid #d6dee6;line-height:1.22;vertical-align:middle;font-variant-numeric:tabular-nums;text-align:'+(index===1?'left':index>=3?'right':'center')+(index===0?';font-weight:700':'');row.appendChild(td)});tbody.appendChild(row)});table.appendChild(tbody);section.appendChild(table);
      root.replaceChildren(section);return{ok:true,rows:p.summaries.length};
    })()`).catch(error=>({ok:false,reason:error.message}));
}

async function printPph21ConfidentialOverview(page, session, summaries, rootSelector, printScale) {
    const rendered = await replacePph21SnapshotWithOverview(page, rootSelector, summaries);
    if (!rendered || !rendered.ok) throw new Error('Pembuatan PDF rahasia L1-L3 gagal: ' + JSON.stringify(rendered));
    log('[Lampiran Rahasia] L1-L3 diringkas dalam satu halaman: ' + summaries.map(item => item.code + '=' + item.count).join(', ') + '.');
    return [await printPdf(session, printScale)];
}

module.exports = { replaceAnnualSnapshotRows, printAnnualApiPages, replaceUnifikasiSnapshotRows, printUnifikasiApiPages, replacePpnSnapshotRows, printPpnApiPages, replacePph21SnapshotWithOverview, printPph21ConfidentialOverview };

// PDF-only projection. The Excel model has already captured all source columns.
module.exports = () => {
    for (const table of document.querySelectorAll('table')) {
        const head = table.tHead?.rows[0];
        if (!head) continue;
        let column = 0, target = -1;
        for (const cell of head.cells) {
            if (cell.textContent.replace(/\s+/g, ' ').trim().toUpperCase() === 'OBJEK PAJAK' && cell.colSpan === 1) target = column;
            column += cell.colSpan;
        }
        if (target < 0) continue;
        for (const row of table.rows) {
            let offset = 0;
            for (const cell of [...row.cells]) {
                const span = cell.colSpan;
                if (target >= offset && target < offset + span) {
                    if (span === 1) cell.remove();
                    else cell.colSpan = span - 1;
                    break;
                }
                offset += span;
            }
        }
        const cols = [...table.querySelectorAll('colgroup col')];
        const freed = parseFloat(cols[target]?.style.width) || 0;
        cols[target]?.remove();
        const remaining = cols.filter((_, i) => i !== target);
        // The dropped column's width goes to the two free-text columns (NAMA, FASILITAS) whose long
        // values otherwise wrap to five or more lines, rather than being spread over every column.
        const labels = [...head.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim().toUpperCase());
        const takers = remaining.filter((_, i) => /^NAMA$|^FASILITAS/.test(labels[i] || ''));
        if (freed && takers.length) takers.forEach(col => col.style.width = ((parseFloat(col.style.width) || 0) + freed / takers.length) + '%');
        const sum = remaining.reduce((n, col) => n + (parseFloat(col.style.width) || 0), 0);
        if (sum) remaining.forEach(col => col.style.width = (parseFloat(col.style.width) / sum * 100) + '%');
    }
};

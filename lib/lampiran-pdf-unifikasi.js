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
        cols[target]?.remove();
        const remaining = cols.filter((_, i) => i !== target);
        const sum = remaining.reduce((n, col) => n + (parseFloat(col.style.width) || 0), 0);
        if (sum) remaining.forEach(col => col.style.width = (parseFloat(col.style.width) / sum * 100) + '%');
    }
};

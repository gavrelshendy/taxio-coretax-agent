/* Runs inside a captured Coretax tab, BEFORE lampiran-snapshot-layout rewrites it, and returns
 * the form's answers: every Ya/Tidak radio group with the statement it answers, and every tick
 * box with its label. The later pipeline flattens these controls into plain text ("TidakYa"),
 * which loses which option was chosen - that is why the printed L10-B never showed its answers.
 */
module.exports = function per11Answers() {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isChecked = (el) => !!el.querySelector('input[aria-checked="true"],input[checked],.p-radiobutton-checked,.p-checkbox-checked');
    // The statement a control answers is the form label of the row it sits in.
    const questionOf = (el) => {
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            const label = [...node.querySelectorAll('label')].find((l) => !l.classList.contains('p-radiobutton-label') && !l.classList.contains('p-checkbox-label') && clean(l.textContent).length > 1);
            if (label) return clean(label.textContent);
        }
        return '';
    };
    const groups = new Map();
    for (const radio of document.querySelectorAll('p-radiobutton')) {
        const name = radio.getAttribute('name') || radio.getAttribute('formcontrolname') || '';
        if (!groups.has(name)) groups.set(name, { name, question: questionOf(radio), options: [], chosen: '' });
        const label = clean(radio.getAttribute('label') || radio.textContent);
        const g = groups.get(name);
        g.options.push(label);
        if (isChecked(radio)) g.chosen = label;
    }
    const checks = [...document.querySelectorAll('p-checkbox')].map((box) => {
        const field = box.closest('.p-field-checkbox') || box.parentElement;
        return { label: clean((field.querySelector('label:not(.p-checkbox-label)') || field).textContent) || clean(box.getAttribute('label')), checked: isChecked(box) };
    });
    return { radios: [...groups.values()], checks };
};

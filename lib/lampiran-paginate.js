module.exports=()=>{
    // Chromium drops repeated headers when a tall thead consumes its repeat budget.
    for(const table of [...document.querySelectorAll('table')]){
        const head=table.tHead;if(!head)continue;
        const hh=head.getBoundingClientRect().height;
        if(hh<140)continue;
        const rows=[...table.tBodies].flatMap(b=>[...b.rows]);if(rows.length<2)continue;
        const foot=table.tFoot,fh=foot?.getBoundingClientRect().height||0;
        const parts=[];let used=0;
        let limit=Math.max(150,630-(table.getBoundingClientRect().top%650)-hh);
        const create=()=>{const chunk=table.cloneNode(false);const cols=table.querySelector('colgroup');if(cols)chunk.append(cols.cloneNode(true));chunk.append(head.cloneNode(true));if(parts.length)chunk.style.breakBefore='page';parts.push(chunk);return chunk.createTBody();};
        let body=create();
        rows.forEach((row,index)=>{const height=row.getBoundingClientRect().height;const reserve=index===rows.length-1?fh:0;if(used&&used+height+reserve>limit){body=create();used=0;limit=630-hh;}body.append(row.cloneNode(true));used+=height;});
        if(foot)parts.at(-1).append(foot.cloneNode(true));
        table.replaceWith(...parts);
    }
    const style=document.createElement('style');style.textContent='.control-end{break-inside:avoid!important}.control-total td{background:#eef2f5!important;font-weight:600!important}.control-end .omitted td{background:#fff7d6!important;font-weight:400!important}.control-end .control-difference td{background:#fff0e9!important}';document.head.append(style);
    for(const table of document.querySelectorAll('table')){
        const foot=table.tFoot;if(!foot)continue;
        const rows=[...table.tBodies].flatMap(b=>[...b.rows]);const last=rows.at(-1);if(!last)continue;
        const end=document.createElement('tbody');end.className='control-end';end.append(last);
        for(const row of [...foot.rows]){row.classList.add('control-total');end.append(row);}
        foot.remove();table.append(end);
    }
};

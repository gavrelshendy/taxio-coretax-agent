import os
import re
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(os.environ['TEMP']) / 'coretax-agent-live-layout-qa'
OUT = Path(os.environ['TEMP']) / 'coretax-agent-contact-sheets'
POPPLER = Path(r'C:\Users\shend\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe')
OUT.mkdir(parents=True, exist_ok=True)

def clean_label(path: Path):
    name = path.stem
    name = re.sub(r'^.*? - 17(?:70|71) LAMPIRAN ', '', name)
    return name

def render_entity(entity_dir: Path):
    rendered = []
    pdfs = sorted((entity_dir / 'SPT' / '2025').glob('*.pdf'))
    pdfs = [p for p in pdfs if 'GABUNGAN' not in p.name]
    page_dir = OUT / re.sub(r'[^A-Za-z0-9_-]+', '_', entity_dir.name)
    page_dir.mkdir(exist_ok=True)
    for pdf in pdfs:
        prefix = page_dir / re.sub(r'[^A-Za-z0-9_-]+', '_', clean_label(pdf))
        # pdftoppm tidak menghapus hasil render lama. Bersihkan dahulu agar halaman yang
        # sudah hilang pada PDF terbaru tidak ikut terbaca sebagai halaman "hantu".
        for old_image in page_dir.glob(prefix.name + '-*.png'):
            old_image.unlink()
        subprocess.run([str(POPPLER), '-png', '-r', '55', str(pdf), str(prefix)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for image_path in sorted(page_dir.glob(prefix.name + '-*.png')):
            rendered.append((clean_label(pdf), image_path))

    font = ImageFont.load_default(size=18)
    columns, rows_per_sheet = 4, 3
    tile_w, tile_h, label_h = 910, 665, 34
    chunk_size = columns * rows_per_sheet
    outputs = []
    for chunk_index in range(0, len(rendered), chunk_size):
        chunk = rendered[chunk_index:chunk_index + chunk_size]
        sheet = Image.new('RGB', (columns * tile_w, rows_per_sheet * tile_h), 'white')
        draw = ImageDraw.Draw(sheet)
        for index, (label, image_path) in enumerate(chunk):
            row, col = divmod(index, columns)
            image = Image.open(image_path).convert('RGB')
            image.thumbnail((tile_w - 12, tile_h - label_h - 12), Image.Resampling.LANCZOS)
            x = col * tile_w + (tile_w - image.width) // 2
            y = row * tile_h + label_h
            sheet.paste(image, (x, y))
            draw.rectangle((col * tile_w, row * tile_h, (col + 1) * tile_w - 1,
                            (row + 1) * tile_h - 1), outline='#64748b', width=1)
            draw.text((col * tile_w + 8, row * tile_h + 6),
                      f'{label} — page {chunk_index + index + 1}', fill='#0f172a', font=font)
        out = OUT / f'{page_dir.name}-sheet-{chunk_index // chunk_size + 1}.png'
        sheet.save(out, optimize=True)
        outputs.append(out)
    return outputs

for entity in [ROOT / 'SOHENDRA, SO', ROOT / 'DION FARMA ABADI']:
    for output in render_entity(entity):
        print(output)

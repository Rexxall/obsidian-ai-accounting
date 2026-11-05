"""Frame one 2x screenshot like the demo GIF: rounded window on the README card.

    python3 frame_shot.py <shot.png> <light|dark> <out.png> [x0 y0 x1 y1 in CSS px]
"""
import os
import sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, os.environ.get('README_KIT', str(Path(__file__).parent)))  # folder with the shared make_demo.py
from make_demo import Film, CROP_LEFT, W, PAD
src, mode, out = sys.argv[1:4]
shot = Image.open(src).convert('RGB')
box = [int(v) * 2 for v in sys.argv[4:8]] if len(sys.argv) >= 8 else [CROP_LEFT, 0, shot.width, shot.height]
crop = shot.crop(box)
film = Film(mode, shot.size)
inner = W - 2 * PAD
crop = crop.resize((inner, round(inner * crop.height / crop.width)), Image.LANCZOS)
film.inner = inner
film.frame(crop).save(out, optimize=True)
print(out, Image.open(out).size)

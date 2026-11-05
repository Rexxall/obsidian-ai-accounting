"""AI Accounting README demo: read a note with a receipt photo, review the two drafted lines, enter them.

    python3 demo_aa.py <frames dir> <light|dark> <out.gif>
"""
import os
import json, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, os.environ.get('README_KIT', str(Path(__file__).parent)))  # folder with the shared make_demo.py
from make_demo import Film, smooth, ACCENT, SCALE

def load(d):
    d = Path(d)
    boxes = {k: [v * SCALE for v in b] for k, b in json.loads((d / 'boxes.json').read_text()).items() if b}
    shots = {}
    for f in sorted(d.glob('*.png')):
        shots.setdefault(f.stem.split('-', 1)[1], []).append(Image.open(f).convert('RGB'))
    return boxes, shots

def centre(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

def main(frames, mode, out):
    boxes, shots = load(frames)
    start, palette, types, progress, review, result = (shots[k] for k in ('start', 'palette', 'type', 'progress', 'review', 'result'))
    start, palette, progress, review, result = start[0], palette[0], progress[0], review[0], result[0]
    film = Film(mode, start.size)
    note = film.around(boxes['receipt'], 1500)
    cmd = film.around([560, 140, 1980, 660], 1600)
    dialog = film.around([860, 440, 2080, 1220], 1560)
    side = film.cam(1248, 60, start.width - 1248)
    item, enter = centre(boxes['item']), centre(boxes['enter'])

    film.add(start, film.full, 1400)
    for k in range(1, 9):  # in to the receipt
        film.add(start, film.mix(film.full, note, smooth(k / 8)), 45)
    film.add(start, note, 1100, ring=boxes['receipt'], ring_color=ACCENT[mode])
    for k in range(1, 9):
        film.add(palette, film.mix(note, cmd, smooth(k / 8)), 45)
    for img in types:
        film.add(img, cmd, 140)
    film.add(types[-1], cmd, 500, ring=boxes['item'], ring_color=ACCENT[mode])
    for k in range(3):
        film.add(types[-1], cmd, 50, ripple=(*item, k / 2))
    for k in range(1, 9):
        film.add(progress, film.mix(cmd, film.full, smooth(k / 8)), 45)
    film.add(progress, film.full, 1300, ring=boxes['notice'], ring_color=ACCENT[mode])
    for k in range(1, 11):
        film.add(review, film.mix(film.full, dialog, smooth(k / 10)), 45)
    film.add(review, dialog, 900)
    film.add(review, dialog, 1600, ring=boxes['list'], ring_color=ACCENT[mode])
    origin = (boxes['list'][0] + 200, boxes['list'][3])
    for k in range(1, 9):
        film.add(review, dialog, 35, cursor=film.mix(origin, enter, smooth(k / 8)))
    for k in range(4):
        film.add(review, dialog, 45, cursor=enter, ripple=(*enter, k / 3))
    for k in range(1, 11):
        film.add(result, film.mix(dialog, side, smooth(k / 10)), 45)
    film.add(result, side, 2200)
    for k in range(1, 9):
        film.add(result, film.mix(side, film.full, smooth(k / 8)), 55)
    film.add(result, film.full, 2200)
    film.save(out)

if __name__ == '__main__':
    main(*sys.argv[1:4])

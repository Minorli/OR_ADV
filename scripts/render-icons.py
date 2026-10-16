#!/usr/bin/env python3
"""Render the project's own outline icons. Optional tool: Pillow 12.3.0."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / 'app/miniprogram/assets'
SCALE = 16


def icon(name, color, size, target):
    image = Image.new('RGBA', (24 * SCALE, 24 * SCALE))
    draw = ImageDraw.Draw(image)
    stroke = round(1.8 * SCALE)

    def line(points):
        coordinates = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        draw.line(coordinates, fill=color, width=stroke, joint='curve')
        radius = stroke / 2
        for x, y in coordinates:
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)

    def ellipse(bounds):
        draw.ellipse(tuple(round(v * SCALE) for v in bounds), outline=color, width=stroke)

    if name == 'home':
        line([(3, 10), (12, 3), (21, 10)])
        line([(5, 9), (5, 21), (10, 21), (10, 15), (14, 15), (14, 21), (19, 21), (19, 9)])
    elif name in ('rank', 'points'):
        line([(4, 21), (4, 13), (8, 13), (8, 21)])
        line([(10, 21), (10, 4), (14, 4), (14, 21)])
        line([(16, 21), (16, 9), (20, 9), (20, 21)])
    elif name == 'history':
        ellipse((3, 3, 21, 21))
        ellipse((8, 3, 16, 21))
        line([(3, 12), (21, 12)])
    elif name == 'profile':
        ellipse((8, 3, 16, 11))
        draw.arc((4*SCALE, 14*SCALE, 20*SCALE, 30*SCALE), 180, 360, fill=color, width=stroke)
    elif name == 'trips':
        line([(5, 21), (5, 3), (20, 3), (16, 8), (20, 13), (5, 13)])
    elif name == 'shield':
        line([(12, 2), (20, 6), (20, 12), (18, 17), (12, 22), (6, 17), (4, 12), (4, 6), (12, 2)])
        line([(8, 12), (11, 15), (16, 9)])
    elif name == 'members':
        ellipse((4, 4, 11, 11))
        ellipse((14, 5, 20, 11))
        draw.arc((1*SCALE, 14*SCALE, 14*SCALE, 27*SCALE), 180, 360, fill=color, width=stroke)
        draw.arc((12*SCALE, 14*SCALE, 23*SCALE, 25*SCALE), 180, 360, fill=color, width=stroke)
    elif name == 'calendar':
        line([(4, 5), (20, 5), (20, 21), (4, 21), (4, 5)])
        line([(8, 2), (8, 8)])
        line([(16, 2), (16, 8)])
        line([(4, 10), (20, 10)])
        line([(8, 14), (11, 14)])
        line([(14, 17), (17, 17)])
    elif name == 'contact':
        line([(4, 4), (20, 4), (20, 17), (10, 17), (4, 22), (4, 4)])
        line([(8, 9), (16, 9)])
        line([(8, 13), (13, 13)])
    target.parent.mkdir(parents=True, exist_ok=True)
    image.resize((size, size), Image.Resampling.LANCZOS).save(target)


for name in ('home', 'rank', 'history', 'profile'):
    for suffix, color in (('', '#929292'), ('-active', '#FF6B00')):
        icon(name, color, 81, ROOT / 'tabs' / f'{name}{suffix}.png')
for name in ('trips', 'points', 'shield', 'members', 'calendar', 'contact'):
    icon(name, '#FF6B00', 64, ROOT / 'icons' / f'{name}.png')
print('Rendered 14 local outline icons; no network or product data used.')

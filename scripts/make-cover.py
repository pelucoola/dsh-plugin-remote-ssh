#!/usr/bin/env python3
"""Generate the WeChat cover image for dsh-plugin-remote-ssh.

Output (docs/assets/):
  promo-cover.png         1080x460  (2.35:1, WeChat article cover / 首图)
  promo-cover-square.png  1080x1080 (1:1, 分享小图)

The design is drawn with Pillow at 2x and downscaled with LANCZOS so edges and
type stay crisp. Run with the bundled runtime Python:

  /Users/yangyang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 \
      scripts/make-cover.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "assets"
S = 2  # supersample factor

FONT_BOLD = ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2)   # W6
FONT_REG = ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0)    # W3
FONT_MONO = ("/System/Library/Fonts/Menlo.ttc", 0)

C = {
    "bg_top": (5, 13, 26),
    "bg_bottom": (8, 24, 44),
    "text": (234, 243, 255),
    "muted": (139, 165, 201),
    "faint": (96, 125, 163),
    "cyan": (56, 189, 248),
    "cyan_soft": (125, 211, 252),
    "green": (52, 211, 153),
    "amber": (251, 191, 36),
    "red": (248, 113, 113),
    "border": (27, 53, 82),
    "card": (9, 20, 36),
    "card_hi": (12, 28, 49),
}


def font(spec, size):
    path, index = spec
    return ImageFont.truetype(path, int(size * S), index=index)


def px(value):
    return int(round(value * S))


def gradient_background(w, h):
    top = np.array(C["bg_top"], dtype=np.float64)
    bottom = np.array(C["bg_bottom"], dtype=np.float64)
    t = np.linspace(0.0, 1.0, h)[:, None, None]
    row = top[None, None, :] * (1 - t) + bottom[None, None, :] * t
    img = np.broadcast_to(row, (h, w, 3)).astype(np.float64).copy()

    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)

    def glow(cx, cy, radius, color, strength):
        d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
        falloff = np.clip(1 - d / radius, 0, 1) ** 2.2 * strength
        return np.array(color, dtype=np.float64)[None, None, :] * falloff[..., None]

    img += glow(w * 0.82, h * 0.16, w * 0.62, (30, 120, 220), 0.55)
    img += glow(w * 0.12, h * 0.95, w * 0.5, (20, 90, 160), 0.22)
    img += glow(w * 0.62, h * 1.05, w * 0.55, (10, 60, 120), 0.18)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return Image.fromarray(img, "RGB").convert("RGBA")


def draw_grid(img):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    step = px(54)
    for x in range(0, img.width, step):
        d.line([(x, 0), (x, img.height)], fill=(120, 170, 220, 12), width=max(1, px(0.7)))
    for y in range(0, img.height, step):
        d.line([(0, y), (img.width, y)], fill=(120, 170, 220, 12), width=max(1, px(0.7)))
    # accent dots
    for (x, y, r, a) in [(px(915), px(88), 2.0, 90), (px(60), px(352), 1.6, 70), (px(1042), px(300), 1.4, 60)]:
        d.ellipse([x - r * S, y - r * S, x + r * S, y + r * S], fill=(125, 211, 252, a))
    img.alpha_composite(layer)


def rounded_card(img, box, radius, fill, outline, shadow=True):
    if shadow:
        shadow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow_layer)
        sx0, sy0, sx1, sy1 = box
        sd.rounded_rectangle(
            [sx0 + px(6), sy0 + px(14), sx1 + px(6), sy1 + px(18)],
            radius=radius,
            fill=(0, 0, 0, 150),
        )
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(px(16)))
        img.alpha_composite(shadow_layer)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=max(1, px(1)))
    img.alpha_composite(layer)


def chip(draw, x, y, text, text_font, pad_x=px(12), height=px(30), fg=None, border=None, bg=None):
    fg = fg or C["cyan_soft"]
    border = border or (46, 88, 126, 220)
    bg = bg or (12, 32, 54, 210)
    w = draw.textlength(text, font=text_font)
    box = [x, y, x + w + pad_x * 2, y + height]
    draw.rounded_rectangle(box, radius=height // 2, fill=bg, outline=border, width=max(1, px(0.8)))
    draw.text((x + pad_x, y + height / 2), text, font=text_font, fill=fg, anchor="lm")
    return box[2]


def draw_cover():
    W, H = px(1080), px(460)
    img = gradient_background(W, H)
    draw_grid(img)
    d = ImageDraw.Draw(img)

    f_pill = font(FONT_MONO, 12.5)
    f_title = font(FONT_BOLD, 62)
    f_sub = font(FONT_REG, 19)
    f_mono_small = font(FONT_MONO, 12.5)
    f_chip = font(FONT_REG, 12)
    f_url = font(FONT_MONO, 10.5)

    left = px(72)

    # eyebrow pill
    pill_text = "DSH PLUGIN"
    pill_w = d.textlength(pill_text, font=f_pill)
    pill_box = [left, px(48), left + pill_w + px(44), px(48) + px(28)]
    d.rounded_rectangle(pill_box, radius=px(14), fill=(14, 44, 72, 220), outline=(52, 130, 170, 200), width=px(1))
    dot_cx = pill_box[0] + px(13)
    dot_cy = (pill_box[1] + pill_box[3]) / 2
    d.ellipse([dot_cx - px(2.4), dot_cy - px(2.4), dot_cx + px(2.4), dot_cy + px(2.4)], fill=C["green"])
    d.text((pill_box[0] + px(24), dot_cy), pill_text, font=f_pill, fill=C["cyan"], anchor="lm")

    # headline
    y1 = px(104)
    x = left
    d.text((x, y1), "让 ", font=f_title, fill=C["text"], anchor="la")
    x += d.textlength("让 ", font=f_title)
    d.text((x, y1), "AI", font=f_title, fill=C["cyan"], anchor="la")
    x += d.textlength("AI", font=f_title)
    d.text((x, y1), " 接管", font=f_title, fill=C["text"], anchor="la")
    d.text((left, y1 + px(70)), "你的服务器", font=f_title, fill=C["text"], anchor="la")

    # accent bar under headline
    d.rounded_rectangle(
        [left, y1 + px(150), left + px(56), y1 + px(155)],
        radius=px(3), fill=C["cyan"],
    )

    # subtitle
    sub_y = y1 + px(176)
    d.text((left, sub_y), "DSH SSH 远程主机插件", font=f_sub, fill=(203, 219, 240), anchor="la")
    d.text((left, sub_y + px(32)), "dsh-plugin-remote-ssh", font=f_mono_small, fill=C["cyan_soft"], anchor="la")

    # chips
    chips_y = px(370)
    cx = left
    for text in ["设置页管理主机", "连接复用 871→29ms", "动态超时", "凭据不落地"]:
        cx = chip(d, cx, chips_y, text, f_chip) + px(9)

    # footer url
    d.text((left, px(420)), "github.com/pelucoola/dsh-plugin-remote-ssh", font=f_url, fill=C["faint"], anchor="la")

    # ---------------------------------------------------------------- card ---
    card = [px(724), px(46), px(1014), px(414)]
    rounded_card(img, card, radius=px(18), fill=(8, 19, 34, 244), outline=(31, 61, 94, 255))
    d = ImageDraw.Draw(img)

    # window header
    dot_y = card[1] + px(21)
    for i, color in enumerate([C["red"], C["amber"], C["green"]]):
        cxd = card[0] + px(18) + i * px(13)
        d.ellipse([cxd, dot_y - px(4.2), cxd + px(8.4), dot_y + px(4.2)], fill=color)
    d.text((card[0] + px(64), dot_y), "ssh prod-web", font=font(FONT_MONO, 11), fill=C["muted"], anchor="lm")
    d.line([(card[0], card[1] + px(40)), (card[2], card[1] + px(40))], fill=(27, 53, 82, 255), width=px(1))

    f_term = font(FONT_MONO, 11.2)
    f_term_small = font(FONT_MONO, 10.2)
    tx = card[0] + px(18)
    ty = card[1] + px(58)
    lh = px(21)

    def term_line(prompt, text, color=C["text"]):
        nonlocal ty
        if prompt:
            d.text((tx, ty), "$", font=f_term, fill=C["green"], anchor="la")
            d.text((tx + px(12), ty), text, font=f_term, fill=color, anchor="la")
        else:
            d.text((tx, ty), text, font=f_term, fill=color, anchor="la")
        ty += lh

    term_line(True, "df -h /var")
    term_line(False, "/dev/vda2  50G  35G  75%", C["muted"])
    term_line(True, "du -sh /var")
    term_line(False, "26G  /var", C["amber"])
    term_line(True, "docker system df")
    term_line(False, "17.2G reclaimable", C["muted"])

    # result panel
    panel = [card[0] + px(14), card[1] + px(196), card[2] - px(14), card[1] + px(352)]
    d.rounded_rectangle(panel, radius=px(12), fill=(10, 34, 40, 235), outline=(45, 120, 98, 220), width=px(1))
    d.text((panel[0] + px(14), panel[1] + px(14)), "清理后", font=font(FONT_REG, 11.5), fill=(148, 233, 198), anchor="la")
    d.text((panel[0] + px(14), panel[1] + px(38)), "26G", font=font(FONT_MONO, 17), fill=C["muted"], anchor="la")
    arrow_x = panel[0] + px(66)
    d.text((arrow_x, panel[1] + px(38)), "→", font=font(FONT_MONO, 17), fill=C["faint"], anchor="la")
    d.text((panel[0] + px(100), panel[1] + px(34)), "5.1G", font=font(FONT_BOLD, 24), fill=C["green"], anchor="la")
    # reclaimed-space bar
    bar_x0 = panel[0] + px(14)
    bar_x1 = panel[2] - px(14)
    bar_y = panel[1] + px(112)
    bar_h = px(9)
    d.rounded_rectangle([bar_x0, bar_y, bar_x1, bar_y + bar_h], radius=bar_h // 2, fill=(96, 62, 20, 200))
    freed = 1 - 5.1 / 26.0
    d.rounded_rectangle(
        [bar_x0, bar_y, bar_x0 + (bar_x1 - bar_x0) * freed, bar_y + bar_h],
        radius=bar_h // 2,
        fill=C["green"],
    )
    d.text((bar_x0, bar_y + px(16)), "释放约 20G（-80%）· 服务零中断", font=font(FONT_REG, 11), fill=(160, 200, 185), anchor="la")

    # reuse badge
    badge_text = "复用连接 29ms"
    tw = d.textlength(badge_text, font=f_term_small)
    bw = tw + px(46)
    bx0 = card[2] - bw - px(10)
    by0 = card[1] + px(8)
    d.rounded_rectangle([bx0, by0, card[2] - px(10), by0 + px(22)], radius=px(11), fill=(14, 40, 66, 235), outline=(52, 120, 170, 220), width=px(1))
    d.polygon([
        (bx0 + px(11), by0 + px(6)), (bx0 + px(18), by0 + px(6)), (bx0 + px(14.5), by0 + px(11)),
        (bx0 + px(19), by0 + px(11)), (bx0 + px(11), by0 + px(18)), (bx0 + px(13.5), by0 + px(12.5)), (bx0 + px(9), by0 + px(12.5)),
    ], fill=C["cyan"])
    d.text((bx0 + px(32), by0 + px(11)), badge_text, font=f_term_small, fill=C["cyan_soft"], anchor="lm")

    out = img.resize((1080, 460), Image.LANCZOS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "promo-cover.png"
    out.convert("RGB").save(path, optimize=True)
    return path


def draw_square():
    W = H = px(1080)
    img = gradient_background(W, H)
    draw_grid(img)
    d = ImageDraw.Draw(img)

    f_title = font(FONT_BOLD, 74)
    f_sub = font(FONT_REG, 25)
    f_mono = font(FONT_MONO, 15)
    f_chip = font(FONT_REG, 15)
    f_big = font(FONT_BOLD, 46)

    # centered icon block
    icon_box = [px(424), px(96), px(656), px(328)]
    rounded_card(img, icon_box, radius=px(26), fill=(11, 34, 62, 250), outline=(50, 110, 160, 255))
    d = ImageDraw.Draw(img)
    # terminal glyph
    d.rounded_rectangle([icon_box[0] + px(44), icon_box[1] + px(74), icon_box[2] - px(44), icon_box[3] - px(74)], radius=px(10), fill=(6, 22, 40, 255), outline=(44, 120, 160, 255), width=px(2))
    d.line([(icon_box[0] + px(70), icon_box[1] + px(120)), (icon_box[0] + px(92), icon_box[1] + px(142))], fill=C["green"], width=px(5))
    d.line([(icon_box[0] + px(92), icon_box[1] + px(142)), (icon_box[0] + px(70), icon_box[1] + px(164))], fill=C["green"], width=px(5))
    d.line([(icon_box[0] + px(104), icon_box[1] + px(164)), (icon_box[0] + px(136), icon_box[1] + px(164))], fill=C["green"], width=px(5))

    d.text((W / 2, px(382)), "让 AI 接管你的服务器", font=f_title, fill=C["text"], anchor="ma")
    d.text((W / 2, px(474)), "DSH SSH 远程主机插件", font=f_sub, fill=(203, 219, 240), anchor="ma")
    d.text((W / 2, px(512)), "dsh-plugin-remote-ssh", font=f_mono, fill=C["cyan_soft"], anchor="ma")

    # chips row
    labels = ["设置页管理主机", "连接复用 871→29ms", "动态超时", "凭据不落地"]
    widths = [d.textlength(t, font=f_chip) + px(28) for t in labels]
    gap = px(12)
    total = sum(widths) + gap * (len(labels) - 1)
    x = (W - total) / 2
    for text, w in zip(labels, widths):
        d.rounded_rectangle([x, px(560), x + w, px(560) + px(40)], radius=px(20), fill=(12, 32, 54, 230), outline=(46, 88, 126, 220), width=px(1))
        d.text((x + w / 2, px(580)), text, font=f_chip, fill=C["cyan_soft"], anchor="mm")
        x += w + gap

    # stats panel
    panel = [px(120), px(662), px(960), px(842)]
    rounded_card(img, panel, radius=px(18), fill=(8, 19, 34, 244), outline=(31, 61, 94, 255), shadow=True)
    d = ImageDraw.Draw(img)
    f_stat = font(FONT_MONO, 26)
    f_stat_label = font(FONT_REG, 16)
    rows = [
        ("26G → 5.1G", "释放约 20G", C["green"]),
        ("871ms → 29ms", "连接复用", C["cyan"]),
        ("1h", "单次硬超时上限", C["text"]),
    ]
    for i, (value, label, color) in enumerate(rows):
        ry = panel[1] + px(26) + i * px(52)
        d.text((panel[0] + px(26), ry), value, font=f_stat, fill=color, anchor="la")
        d.text((panel[2] - px(26), ry + px(4)), label, font=f_stat_label, fill=C["muted"], anchor="ra")

    d.text((W / 2, px(888)), "github.com/pelucoola/dsh-plugin-remote-ssh", font=f_mono, fill=C["faint"], anchor="ma")
    d.rounded_rectangle([px(430), px(924), px(650), px(928)], radius=px(2), fill=C["cyan"])

    out = img.resize((1080, 1080), Image.LANCZOS)
    path = OUT_DIR / "promo-cover-square.png"
    out.convert("RGB").save(path, optimize=True)
    return path


if __name__ == "__main__":
    cover = draw_cover()
    square = draw_square()
    print(cover)
    print(square)

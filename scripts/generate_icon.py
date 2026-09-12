"""Generate Camlib app icon — simple cartoon camera, light palette."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BG_TOP = (232, 244, 255)
BG_BOTTOM = (255, 249, 242)
BODY = (122, 192, 230)
BODY_TOP = (96, 168, 212)
WHITE = (255, 255, 255)
GOLD = (255, 210, 110)
PUPIL = (78, 104, 140)
FLASH = (255, 190, 100)
CARD = (255, 255, 255, 130)
CARD_EDGE = (170, 205, 235, 140)

SS = 4
SIZE = 1024
OUT = SIZE * SS


def squircle_mask(size: int, radius_ratio: float = 0.2237) -> Image.Image:
    r = int(size * radius_ratio)
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return m


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        t = t * t * (3 - 2 * t)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        row = (r, g, b)
        for x in range(size):
            px[x, y] = row
    return img


def build_master() -> Image.Image:
    size = OUT
    cx = cy = size / 2

    # Background
    bg = vertical_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")
    sheen = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        (-size * 0.15, -size * 0.3, size * 0.75, size * 0.4),
        fill=(255, 255, 255, 100),
    )
    sheen = sheen.filter(ImageFilter.GaussianBlur(radius=size * 0.1))
    bg = Image.alpha_composite(bg, sheen)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # --- Photo cards behind (library hint) ---
    cards = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cards)
    card_w, card_h = size * 0.30, size * 0.36
    for dx, dy, rot_hint in ((-0.10, 0.12, 0), (0.10, -0.12, 0)):
        sx = cx + dx * size
        sy = cy + dy * size
        cd.rounded_rectangle(
            (sx - card_w / 2, sy - card_h / 2, sx + card_w / 2, sy + card_h / 2),
            radius=size * 0.04,
            fill=CARD,
            outline=CARD_EDGE,
            width=int(size * 0.007),
        )
    # Soft blur so they read as depth, not competition
    cards = cards.filter(ImageFilter.GaussianBlur(radius=size * 0.006))
    bg = Image.alpha_composite(bg, cards)

    d = ImageDraw.Draw(layer)

    # --- Camera geometry (centered slightly lower for viewfinder) ---
    body_w, body_h = size * 0.54, size * 0.40
    body_r = size * 0.08
    body_cx = cx
    body_cy = cy + size * 0.02
    bx0 = body_cx - body_w / 2
    by0 = body_cy - body_h / 2
    bx1 = body_cx + body_w / 2
    by1 = body_cy + body_h / 2

    # Soft shadow
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (bx0, by0 + size * 0.03, bx1, by1 + size * 0.03),
        radius=body_r,
        fill=(80, 120, 160, 50),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.04))
    layer = Image.alpha_composite(layer, shadow)
    d = ImageDraw.Draw(layer)

    # Viewfinder bump (behind body top edge)
    vf_w, vf_h = size * 0.15, size * 0.11
    vf_cx = body_cx - body_w * 0.16
    vf_cy = by0 - vf_h * 0.35
    d.rounded_rectangle(
        (vf_cx - vf_w / 2, vf_cy - vf_h / 2, vf_cx + vf_w / 2, by0 + size * 0.03),
        radius=vf_h * 0.45,
        fill=(*BODY_TOP, 255),
    )

    # Body
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=body_r, fill=(*BODY, 255))

    # Top color band clipped to body (flat cartoon depth)
    band_h = size * 0.055
    band = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle((bx0, by0, bx1, by0 + band_h), fill=(*BODY_TOP, 255))
    body_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(body_mask).rounded_rectangle((bx0, by0, bx1, by1), radius=body_r, fill=255)
    band.putalpha(Image.composite(band.split()[3], Image.new("L", (size, size), 0), body_mask))
    layer = Image.alpha_composite(layer, band)
    d = ImageDraw.Draw(layer)

    # Soft highlight on body top-left
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse(
        (bx0 + body_w * 0.06, by0 + body_h * 0.08, bx0 + body_w * 0.48, by0 + body_h * 0.42),
        fill=(255, 255, 255, 60),
    )
    hl = hl.filter(ImageFilter.GaussianBlur(radius=size * 0.035))
    hl.putalpha(Image.composite(hl.split()[3], Image.new("L", (size, size), 0), body_mask))
    layer = Image.alpha_composite(layer, hl)
    d = ImageDraw.Draw(layer)

    # Shutter button (top-right of body top edge)
    btn_r = size * 0.040
    btn_cx = body_cx + body_w * 0.30
    btn_cy = by0 - size * 0.008
    d.ellipse((btn_cx - btn_r, btn_cy - btn_r, btn_cx + btn_r, btn_cy + btn_r), fill=(*FLASH, 255))
    d.ellipse(
        (btn_cx - btn_r * 0.5, btn_cy - btn_r * 0.65, btn_cx + btn_r * 0.15, btn_cy + btn_r * 0.05),
        fill=(255, 255, 255, 130),
    )

    # Viewfinder glass
    d.rounded_rectangle(
        (vf_cx - vf_w * 0.20, vf_cy - vf_h * 0.15, vf_cx + vf_w * 0.20, vf_cy + vf_h * 0.20),
        radius=size * 0.014,
        fill=(235, 247, 255, 220),
    )

    # --- Lens ---
    lens_cx = body_cx
    lens_cy = body_cy + size * 0.005
    outer_r = size * 0.160

    d.ellipse(
        (lens_cx - outer_r, lens_cy - outer_r, lens_cx + outer_r, lens_cy + outer_r),
        fill=(*WHITE, 255),
    )
    mid_r = outer_r * 0.76
    d.ellipse(
        (lens_cx - mid_r, lens_cy - mid_r, lens_cx + mid_r, lens_cy + mid_r),
        fill=(*GOLD, 255),
    )
    inner_r = mid_r * 0.60
    d.ellipse(
        (lens_cx - inner_r, lens_cy - inner_r, lens_cx + inner_r, lens_cy + inner_r),
        fill=(*WHITE, 255),
    )
    pupil_r = inner_r * 0.58
    d.ellipse(
        (lens_cx - pupil_r, lens_cy - pupil_r, lens_cx + pupil_r, lens_cy + pupil_r),
        fill=(*PUPIL, 255),
    )
    # glint
    gr = pupil_r * 0.36
    d.ellipse(
        (lens_cx - pupil_r * 0.5, lens_cy - pupil_r * 0.6, lens_cx - pupil_r * 0.5 + gr * 1.3, lens_cy - pupil_r * 0.6 + gr),
        fill=(255, 255, 255, 220),
    )
    # thin outer edge
    d.ellipse(
        (lens_cx - outer_r, lens_cy - outer_r, lens_cx + outer_r, lens_cy + outer_r),
        outline=(210, 230, 248, 180),
        width=int(size * 0.007),
    )

    composed = Image.alpha_composite(bg, layer)
    mask = squircle_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(composed, (0, 0), mask)
    return out.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out_path = root / "src-tauri" / "icons" / "icon-1024.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    build_master().save(out_path, "PNG", optimize=True)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()

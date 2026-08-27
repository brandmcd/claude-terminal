# Terminal-prompt PWA icon set (">_" in terminal green on the app's dark background).
#
# Replaces the upstream sunburst-with-an-emoji mark. Kept as a script so the whole set
# regenerates consistently: a hand-edited PNG here and a stale one there is what put a
# transparent-cornered apple-touch-icon and a hairline push badge into the tree.
#
# Why Python/PIL rather than Bun like genicon.ts: this box has no SVG rasteriser
# (no rsvg-convert, no imagemagick, no cairosvg), and PIL is already installed. The
# glyph is drawn directly at 4x and downsampled, so there is no SVG step to rasterise.
#
#   python3 pwa/genicon-terminal.py
#
# Three rules this file exists to enforce, all of which the previous set broke:
#  - apple-touch-icon must be FULL-BLEED and fully OPAQUE. iOS composites transparent
#    pixels against black and then applies its own squircle, so a pre-rounded icon with
#    transparent corners renders as black wedges around a smaller rounded square.
#  - maskable icons must keep the glyph inside the central 80% safe circle, because
#    Android crops to a platform-chosen shape.
#  - the push badge is a monochrome white-on-transparent glyph; Android renders it at
#    ~24dp in the status bar, so it needs a much heavier stroke than the app icon.

from PIL import Image, ImageDraw

BG = (13, 17, 23, 255)       # #0D1117 - matches html,body background in overlay.js
FG = (74, 222, 128, 255)     # #4ADE80 - terminal green
SS = 4                       # supersample factor; drawn at N*SS then LANCZOS down


def draw_glyph(size, stroke_ratio, colour):
    """Draw '>_' on a transparent square of `size` px, returned with its own alpha bbox
    trimmed. Caller positions it; trimming here is what makes the centring optical
    rather than nominal (the previous set sat ~19px right of centre at 512)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = int(S * stroke_ratio)

    # Chevron: apex on the right, drawn as two round-capped strokes so the joint is a
    # clean miter-free point at any size.
    cx0, cy0 = int(S * 0.30), int(S * 0.30)   # top-left arm start
    cx1, cym = int(S * 0.47), int(S * 0.47)   # apex
    cy1 = int(S * 0.64)                        # bottom-left arm end
    d.line([(cx0, cy0), (cx1, cym)], fill=colour, width=w, joint="curve")
    d.line([(cx1, cym), (cx0, cy1)], fill=colour, width=w, joint="curve")
    for pt in ((cx0, cy0), (cx1, cym), (cx0, cy1)):
        d.ellipse([pt[0] - w // 2, pt[1] - w // 2, pt[0] + w // 2, pt[1] + w // 2], fill=colour)

    # Underscore: sits on the chevron's lower arm baseline, to its right.
    ux0, ux1 = int(S * 0.545), int(S * 0.73)
    uy = cy1
    d.line([(ux0, uy), (ux1, uy)], fill=colour, width=w)
    for pt in ((ux0, uy), (ux1, uy)):
        d.ellipse([pt[0] - w // 2, pt[1] - w // 2, pt[0] + w // 2, pt[1] + w // 2], fill=colour)

    return img.crop(img.getbbox())


def compose(size, coverage, stroke_ratio=0.085, bg=BG, fg=FG):
    """Square icon of `size` px: glyph scaled so its longest side is `coverage` of the
    canvas, centred, over `bg`. coverage is the knob that keeps maskable inside the
    safe circle while letting the plain icon breathe wider."""
    glyph = draw_glyph(size, stroke_ratio, fg)
    target = int(size * SS * coverage)
    scale = target / max(glyph.size)
    g = glyph.resize((max(1, int(glyph.width * scale)), max(1, int(glyph.height * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (size * SS, size * SS), bg)
    canvas.alpha_composite(g, ((size * SS - g.width) // 2, (size * SS - g.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def svg(coverage, stroke_ratio=0.085, bg=None, fg="#4ADE80"):
    """Same glyph as compose(), emitted as SVG. Kept in step with the PNGs by deriving
    from the identical normalised coordinates, so the two can never drift apart."""
    x0, y0 = 0.30, 0.30      # top-left arm start
    x1, ym = 0.47, 0.47      # apex
    y1 = 0.64                # bottom arm end / underscore baseline
    ux0, ux1 = 0.545, 0.73
    half = stroke_ratio / 2

    # bbox of the stroked glyph, caps included
    bx0, bx1 = x0 - half, ux1 + half
    by0, by1 = y0 - half, y1 + half
    k = coverage / max(bx1 - bx0, by1 - by0)          # scale so longest side == coverage
    tx = 0.5 - k * (bx0 + bx1) / 2                    # centre the bbox
    ty = 0.5 - k * (by0 + by1) / 2

    S = 512
    p = lambda v: round(v * S, 2)
    plate = f'<rect width="{S}" height="{S}" fill="{bg}"/>' if bg else ""
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">\n'
        f'  {plate}\n'
        f'  <g transform="translate({p(tx)} {p(ty)}) scale({k})" fill="none" stroke="{fg}"\n'
        f'     stroke-width="{p(stroke_ratio)}" stroke-linecap="round" stroke-linejoin="round">\n'
        f'    <polyline points="{p(x0)},{p(y0)} {p(x1)},{p(ym)} {p(x0)},{p(y1)}"/>\n'
        f'    <line x1="{p(ux0)}" y1="{p(y1)}" x2="{p(ux1)}" y2="{p(y1)}"/>\n'
        f'  </g>\n'
        f'</svg>\n'
    )


def main():
    out = []

    # purpose:"any". Full-bleed rather than a pre-rounded square: Chrome on Android
    # paints a white plate behind a non-full-bleed icon, which framed the old one.
    for n in (192, 512):
        compose(n, 0.56).save(f"icon-{n}.png"); out.append(f"icon-{n}.png")

    # purpose:"maskable". 0.50 keeps the glyph well inside the 80% safe circle even
    # after Android crops to a circle on the most aggressive launchers.
    for n in (192, 512):
        compose(n, 0.50).save(f"icon-maskable-{n}.png"); out.append(f"icon-maskable-{n}.png")

    # iOS home screen. Opaque, square, unrounded - iOS masks it itself.
    compose(180, 0.56).convert("RGB").convert("RGBA").save("apple-touch-icon.png")
    out.append("apple-touch-icon.png")

    # Browser tab. Heavier stroke because 32px eats thin strokes to grey mush.
    compose(32, 0.68, stroke_ratio=0.115).save("favicon-32.png"); out.append("favicon-32.png")

    # Android push badge: monochrome white on transparent, heavy, drawn large in frame
    # because the status bar shrinks it to roughly 24dp.
    badge = compose(96, 0.74, stroke_ratio=0.125, bg=(0, 0, 0, 0), fg=(255, 255, 255, 255))
    badge.save("badge-96.png"); out.append("badge-96.png")

    # Vector source of truth, at the same two coverages as the PNGs above. Nothing in
    # the app loads these (the manifest and <link> tags all point at PNGs) - they exist
    # so the mark can be re-rendered at any size later.
    hexbg = "#%02X%02X%02X" % BG[:3]
    open("icon.svg", "w").write(svg(0.56, bg=hexbg)); out.append("icon.svg")
    open("icon-maskable.svg", "w").write(svg(0.50, bg=hexbg)); out.append("icon-maskable.svg")
    open("badge.svg", "w").write(svg(0.74, stroke_ratio=0.125, fg="#FFFFFF")); out.append("badge.svg")

    for f in out:
        print("wrote", f)


if __name__ == "__main__":
    main()

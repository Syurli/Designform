"""生成“策”字品牌的矢量源。仅制作资产时使用，不属于软件运行时。"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
import argparse

parser = argparse.ArgumentParser(description="导出策问品牌 SVG，字体文件不随应用分发。")
parser.add_argument("--font", default="C:/Windows/Fonts/msyhbd.ttc", help="本机可用于图形制作的中文粗体")
args = parser.parse_args()
font = TTFont(args.font, fontNumber=0)
glyphs = font.getGlyphSet()
glyph = glyphs[font.getBestCmap()[ord("策")]]
bounds = BoundsPen(glyphs)
glyph.draw(bounds)
x0, y0, x1, y1 = bounds.bounds

def outline(size, center=256):
    """把字形轮廓归一到画布中央，避免依赖用户机器上的字体排版。"""
    scale = min(size / (x1 - x0), size / (y1 - y0))
    pen = SVGPathPen(glyphs)
    glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, center - (x0 + x1) * scale / 2, center + (y0 + y1) * scale / 2)))
    return pen.getCommands()

root = Path(__file__).resolve().parent.parent / "public" / "icons"
root.mkdir(parents=True, exist_ok=True)
for theme, top, bottom, ink, line in [
    ("dark", "#293b59", "#101b2e", "#f2e4c8", "#8cb7d2"),
    ("light", "#faf7ef", "#e7edf5", "#2a4365", "#5c7b9e"),
]:
    # 印章形轮廓承载策字，右上星点和左下短连线呼应知识关系。
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="策问">
<defs><linearGradient id="base" x2=".8" y2="1"><stop stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient></defs>
<rect x="14" y="14" width="484" height="484" rx="116" fill="url(#base)"/>
<rect x="27" y="27" width="458" height="458" rx="105" fill="none" stroke="{line}" stroke-opacity=".28" stroke-width="2"/>
<path d="{outline(307)}" fill="{ink}"/>
<path d="M415 57 421 78 442 84 421 90 415 111 409 90 388 84 409 78Z" fill="{line}"/>
<path d="M64 398V432H97" fill="none" stroke="{line}" stroke-opacity=".5" stroke-width="4" stroke-linecap="round"/>
<circle cx="64" cy="393" r="5" fill="{line}"/><circle cx="103" cy="432" r="5" fill="{line}"/>
</svg>'''
    (root / f"cewen-{theme}.svg").write_text(svg, encoding="utf-8")
    # 小托盘单独使用更大的策字，省去细小装饰，确保 16/20 像素仍可识别。
    tray = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="8" y="8" width="496" height="496" rx="100" fill="{bottom}"/><path d="{outline(405)}" fill="{ink}"/></svg>'
    (root / f"tray-{theme}.svg").write_text(tray, encoding="utf-8")
print("策字矢量源已生成；资产不包含字体文件。")

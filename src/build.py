import math, os
OUT = "/workspace/xraysavvy/diagrams"
def f(v): 
    s = f"{v:.1f}"; return s[:-2] if s.endswith(".0") else s

HEAD = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300" font-family="system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<title>{title}</title>
<style>.t{{fill:#e7e9ea;font-size:16px;font-weight:700}}.c{{fill:#8b98a5;font-size:13px}}.m{{fill:#8b98a5;font-size:13px}}.g{{fill:#ffd700;font-size:13px;font-weight:700}}.r{{fill:#f4212e;font-size:13px;font-weight:700}}.b{{fill:#1d9bf0;font-size:13px;font-weight:700}}.an{{fill:#2a3341;stroke:#e7e9ea;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}}.bn{{fill:none;stroke:#8b98a5;stroke-width:1.2;opacity:.6;stroke-linecap:round}}.ir{{fill:rgba(139,152,165,.1);stroke:#8b98a5;stroke-width:1.5}}.bx{{fill:none;stroke:#8b98a5;stroke-width:1;stroke-dasharray:4 3}}.cr{{stroke:#f4212e;stroke-width:4;fill:none;stroke-linecap:round}}</style>
<defs><marker id="ar" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0 0L10 5L0 10z" fill="#f4212e"/></marker><marker id="ab" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" fill="#1d9bf0"/></marker><marker id="ag" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" fill="#00ba7c"/></marker></defs>
<rect width="400" height="300" rx="12" fill="#1a2332"/>
<text class="t" x="200" y="25" text-anchor="middle">{title}</text>
'''
def foot(cap): return f'<text class="c" x="200" y="289" text-anchor="middle">{cap}</text>\n</svg>\n'

def target(x, y):  # CR entering perpendicular (into page) + gold centering dot
    return (f'<g stroke="#f4212e" stroke-width="2" fill="none"><circle cx="{x}" cy="{y}" r="9"/>'
            f'<path d="M{x-15} {y}h8M{x+7} {y}h8M{x} {y-15}v8M{x} {y+7}v8"/></g>'
            f'<circle cx="{x}" cy="{y}" r="3.5" fill="#ffd700"/>\n')

def tube(cx, y):
    return f'<rect x="{cx-24}" y="{y}" width="48" height="20" rx="4" fill="#0f1419" stroke="#8b98a5" stroke-width="1.5"/><text class="m" x="{cx}" y="{y+15}" text-anchor="middle">Tube</text>\n'

def legend(x, y):  # small "target = CR into IR" key
    return (f'<g stroke="#f4212e" stroke-width="1.5" fill="none"><circle cx="{x}" cy="{y}" r="5"/><path d="M{x-8} {y}h16M{x} {y-8}v16"/></g>'
            f'<text class="r" x="{x+12}" y="{y+4.5}">CR ⊥ IR</text>\n')

# ---------------- HAND PA ----------------
def finger(bl, br, ang, L, w):
    a = math.radians(ang); d = (math.sin(a), -math.cos(a)); p = (math.cos(a), math.sin(a))
    bc = ((bl[0]+br[0])/2, (bl[1]+br[1])/2); hw = w*0.42
    T = (bc[0]+d[0]*(L-hw), bc[1]+d[1]*(L-hw))
    l = (T[0]-p[0]*hw, T[1]-p[1]*hw); r = (T[0]+p[0]*hw, T[1]+p[1]*hw)
    return f"L{f(l[0])} {f(l[1])}A{f(hw)} {f(hw)} 0 0 1 {f(r[0])} {f(r[1])}L{f(br[0])} {f(br[1])}", bc, T

def web(a, b):
    mx, my = (a[0]+b[0])/2, max(a[1], b[1])+5
    return f"Q{f(mx)} {f(my)} {f(b[0])} {f(b[1])}"

def hand():
    fingers = [((97,153),(114,151),-9,68,18),((116,149),(134,149),-1,78,18),
               ((136,150),(153,152),7,71,17),((155,156),(170,160),16,55,15)]
    d = "M100 266C96 250 92 236 90 222"
    s, tb, tt = finger((90,222),(104,180),-48,60,23); d += s
    prev = (104,180); bases = []; mcp_tops = []
    for bl, br, ang, L, w in fingers:
        d += web(prev, bl) if prev != (104,180) else f"Q106 164 {bl[0]} {bl[1]}"
        s, bc, T = finger(bl, br, ang, L, w); d += s; prev = br; bases.append((bc, T))
    d += "C178 178 182 205 176 232C172 246 168 256 166 266"
    out = f'<rect class="ir" x="22" y="38" width="222" height="230" rx="3"/><text class="m" x="30" y="56">IR</text>\n'
    out += f'<path class="an" d="{d}"/>\n'
    bn = ""   # faint metacarpals + phalanges
    wr = [(112,236),(124,236),(136,236),(150,238)]
    for (bc, T), w0 in zip(bases, wr):
        bn += f"M{w0[0]} {w0[1]}L{f(bc[0])} {f(bc[1]+8)}M{f(bc[0])} {f(bc[1]+2)}L{f(bc[0]+(T[0]-bc[0])*.8)} {f(bc[1]+(T[1]-bc[1])*.8)}"
    bn += f"M106 232L{f(tb[0])} {f(tb[1])}"
    out += f'<path class="bn" d="{bn}"/>\n'
    mx, my = 125, 159
    out += target(mx, my)
    out += '<text class="g" x="140" y="197" text-anchor="middle">3rd MCP</text>\n'
    out += legend(176, 54)
    # side-view inset
    out += '<rect class="bx" x="254" y="38" width="136" height="230" rx="8"/><text class="m" x="322" y="56" text-anchor="middle">Side view</text>\n'
    out += tube(322, 64)
    out += '<line x1="264" y1="232" x2="380" y2="232" stroke="#8b98a5" stroke-width="1.5"/>'
    out += '<rect class="ir" x="268" y="218" width="108" height="10" rx="2"/>\n'
    out += '<path class="an" d="M268 217V199C284 196 298 198 312 204L362 209Q373 210 373 214V217"/>\n'
    out += '<line class="cr" x1="322" y1="88" x2="322" y2="198" marker-end="url(#ar)"/>'
    out += '<circle cx="322" cy="205" r="3.5" fill="#ffd700"/>'
    out += '<text class="r" x="330" y="146">0°</text>\n'
    out += '<text class="m" x="270" y="252">IR</text><text class="m" x="378" y="252" text-anchor="end">Table</text>\n'
    return out

# ---------------- ANKLE MORTISE ----------------
def ankle():
    out = '<rect class="ir" x="22" y="38" width="222" height="230" rx="3"/><text class="m" x="30" y="56">IR</text>\n'
    out += '<g transform="translate(14 0)">'
    leg = ("M86 40C84 82 92 124 102 160C105 172 100 182 98 194C96 204 102 210 106 213"
           "C100 226 98 242 104 254Q105 261 114 257Q120 265 130 259Q137 267 146 260Q154 269 165 261Q178 270 181 252"
           "C183 234 174 218 164 210C170 204 168 196 162 186C160 176 162 168 164 160C172 122 176 80 172 40")
    out += f'<path class="an" d="{leg}"/>\n'
    out += '<path class="bn" d="M106 44C104 100 106 150 102 196M122 44C120 100 124 150 116 184M156 44C158 100 152 150 160 184M116 184Q138 178 160 184"/>\n'
    out += '<line x1="101" y1="198" x2="161" y2="188" stroke="#8b98a5" stroke-width="1.2" stroke-dasharray="3 3"/>'
    out += '<circle cx="101" cy="198" r="2.5" fill="#8b98a5"/><circle cx="161" cy="188" r="2.5" fill="#8b98a5"/>'
    out += '<text class="m" x="88" y="194" text-anchor="end">L</text><text class="m" x="174" y="186">M</text>\n'
    out += '<path d="M84 98Q130 132 176 98" fill="none" stroke="#1d9bf0" stroke-width="2.5" marker-end="url(#ab)"/>\n'
    out += target(131, 193) + '</g>'
    out += '<text class="b" x="194" y="112">15–20°</text><text class="b" x="194" y="128">medial</text>\n'
    out += '<path d="M78 232L130 200" stroke="#ffd700" stroke-width="1.2"/>'
    out += '<text class="g" x="28" y="248">Midway</text><text class="g" x="28" y="263">between mall.</text>\n'
    out += legend(176, 54)
    # axial inset: view from feet
    out += '<rect class="bx" x="254" y="38" width="136" height="230" rx="8"/><text class="m" x="322" y="56" text-anchor="middle">View from feet</text>\n'
    out += tube(322, 64)
    out += '<line x1="264" y1="256" x2="380" y2="256" stroke="#8b98a5" stroke-width="1.5"/><rect class="ir" x="286" y="242" width="90" height="10" rx="2"/><text class="m" x="262" y="252">IR</text>\n'
    out += '<rect class="an" x="309" y="124" width="26" height="72" rx="13" transform="rotate(18 322 196)"/>'
    out += '<circle class="an" cx="322" cy="196" r="22"/>\n'
    out += '<line x1="300" y1="196" x2="344" y2="196" stroke="#e7e9ea" stroke-width="1.5"/>'
    out += '<circle cx="300" cy="196" r="3" fill="#8b98a5"/><circle cx="344" cy="196" r="3" fill="#8b98a5"/>'
    out += '<text class="m" x="290" y="200" text-anchor="end">L</text><text class="m" x="354" y="200">M</text>\n'
    a = math.radians(18); r = 46
    out += f'<path d="M322 {196-r}A{r} {r} 0 0 1 {f(322+r*math.sin(a))} {f(196-r*math.cos(a))}" fill="none" stroke="#1d9bf0" stroke-width="2"/>'
    out += f'<line x1="322" y1="196" x2="{f(322+82*math.sin(a))}" y2="{f(196-82*math.cos(a))}" stroke="#1d9bf0" stroke-width="1.5" stroke-dasharray="4 3"/>'
    out += '<text class="b" x="316" y="140" text-anchor="end">15–20°</text>\n'
    out += '<line class="cr" x1="322" y1="88" x2="322" y2="186" marker-end="url(#ar)"/><circle cx="322" cy="196" r="3.5" fill="#ffd700"/>'
    out += '<text class="r" x="300" y="106" text-anchor="end">0°</text>\n'
    out += '<text class="m" x="322" y="234" text-anchor="middle">IM line ∥ IR</text>\n'
    return out

# ---------------- C-SPINE LATERAL ----------------
def cspine():
    out = '<rect class="ir" x="22" y="38" width="222" height="230" rx="3"/><text class="m" x="30" y="56">IR</text>\n'
    head = ("M176 268C176 250 180 232 172 214C166 196 166 172 170 154C188 138 194 102 178 76"
            "C162 50 116 46 96 66C84 78 82 92 86 102L76 122L86 127Q83 134 88 138Q84 143 88 148"
            "C90 160 104 164 118 160C124 162 126 172 126 184C126 196 120 206 108 214C88 226 72 244 66 268")
    out += f'<path class="an" d="{head}"/>\n'
    out += '<path class="an" d="M92 268C96 236 128 218 150 218C170 218 186 236 190 268" fill="none"/>\n'
    out += '<ellipse class="an" cx="146" cy="108" rx="8" ry="13" stroke-width="1.5"/>\n'
    vb = ""
    for i, y in enumerate(range(134, 214, 12)):
        vb += f'<rect x="141" y="{y}" width="18" height="9" rx="2" {"fill=\"rgba(255,215,0,.25)\" stroke=\"#ffd700\"" if i==3 else "fill=\"none\" stroke=\"#8b98a5\""} stroke-width="1" opacity="{1 if i==3 else .6}"/>'
    out += vb + "\n"
    out += '<line x1="150" y1="116" x2="150" y2="214" stroke="#8b98a5" stroke-width="1.2" stroke-dasharray="3 3"/>'
    out += '<circle cx="150" cy="124" r="3" fill="#e7e9ea"/>'
    out += '<path d="M153 124L196 118" stroke="#8b98a5" stroke-width="1"/><text class="m" x="198" y="116">Mastoid</text><text class="m" x="198" y="130">tip</text>\n'
    out += target(150, 172)
    out += '<path d="M166 172L196 176" stroke="#ffd700" stroke-width="1.2"/><text class="g" x="199" y="181">C4</text>\n'
    out += '<path d="M34 218v28" stroke="#00ba7c" stroke-width="2.5" marker-end="url(#ag)"/>'
    out += '<text fill="#00ba7c" font-size="13" font-weight="700" x="44" y="232">Shoulders</text><text fill="#00ba7c" font-size="13" font-weight="700" x="44" y="247">depressed</text>\n'
    out += legend(176, 54).replace('x="188"', 'x="188"')
    # front-view inset
    out += '<rect class="bx" x="254" y="38" width="136" height="230" rx="8"/><text class="m" x="322" y="56" text-anchor="middle">Front view</text>\n'
    out += '<rect class="ir" x="264" y="80" width="10" height="160" rx="2"/><text class="m" x="269" y="74" text-anchor="middle">IR</text>\n'
    out += '<path class="an" d="M300 130V150Q286 156 280 172Q276 178 276 186V234H338V186Q338 178 334 172Q328 156 314 150V130Z"/><ellipse class="an" cx="307" cy="110" rx="17" ry="22"/>\n'
    out += '<path d="M284 148v11" stroke="#00ba7c" stroke-width="2.5" marker-end="url(#ag)"/><path d="M330 148v11" stroke="#00ba7c" stroke-width="2.5" marker-end="url(#ag)"/>'
    out += '<line class="cr" x1="370" y1="141" x2="284" y2="141" marker-end="url(#ar)"/><circle cx="307" cy="141" r="3.5" fill="#ffd700"/>'
    out += '<rect x="374" y="129" width="12" height="24" rx="3" fill="#0f1419" stroke="#8b98a5" stroke-width="1.5"/><text class="m" x="380" y="122" text-anchor="middle">Tube</text>\n'
    out += '<path d="M274 133h8v8" fill="none" stroke="#8b98a5" stroke-width="1.2"/><text class="r" x="356" y="166" text-anchor="middle">0°</text>\n'
    out += '<path d="M274 248H380M274 242v12M380 242v12" stroke="#8b98a5" stroke-width="1.2" fill="none"/>'
    out += '<text class="m" x="327" y="264" text-anchor="middle">SID 72 in</text>\n'
    return out

specs = [
 ("hand-pa", "Hand — PA", hand, "CR ⊥ (0°) to 3rd MCP joint · palm flat · no rotation"),
 ("ankle-mortise", "Ankle — AP Oblique (Mortise)", ankle, "Leg 15–20° medial · CR ⊥ (0°) midway between malleoli"),
 ("cspine-lateral", "C-Spine — Lateral (Grandy)", cspine, "CR horizontal ⊥ (0°) to C4 · 72 in SID · no rotation"),
]
for name, title, fn, cap in specs:
    svg = HEAD.format(title=title) + fn() + foot(cap)
    open(f"{OUT}/{name}.svg", "w").write(svg)
    print(name, len(svg.encode()))

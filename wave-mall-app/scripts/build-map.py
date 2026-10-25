"""Draw the area map from OpenStreetMap data.

Input  assets-src/osm/{roads,buildings}.json  (Overpass `out geom` exports, © OpenStreetMap contributors)
Output public/img/area-map.svg                 the base: ground, parks, buildings, roads, monorail
       src/map-data.json                       street labels and places, in the same coordinates

Units are metres in a local equirectangular projection, north up.
"""
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OSM = ROOT / 'assets-src' / 'osm'

# frame: the First Sector between Cairo Festival City and the Dusit Thani
W, E, S, N = 31.403, 31.4565, 30.006, 30.033
LAT0 = (S + N) / 2
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574
WIDTH = round((E - W) * KX)
HEIGHT = round((N - S) * KY)
WAVE = (30.0194714, 31.4319505)


def xy(lat, lon):
    return ((lon - W) * KX, (N - lat) * KY)


def path(points, closed=False):
    pts = [xy(p['lat'], p['lon']) for p in points]
    d = 'M' + ' L'.join(f'{x:.0f} {y:.0f}' for x, y in pts)
    return d + ('Z' if closed else '')


def inside(points, pad=0.004):
    return any(W - pad <= p['lon'] <= E + pad and S - pad <= p['lat'] <= N + pad for p in points)


roads = json.load(open(OSM / 'roads.json'))['elements']
blds = json.load(open(OSM / 'buildings.json'))['elements']

# road classes: stroke width in metres
CLASS = {
    'motorway': 30, 'trunk': 24, 'primary': 22, 'secondary': 14, 'tertiary': 10,
    'motorway_link': 9, 'trunk_link': 9, 'primary_link': 8, 'secondary_link': 7, 'tertiary_link': 6,
    'unclassified': 6, 'residential': 6, 'service': 3.5,
}
layers = {w: [] for w in sorted(set(CLASS.values()))}
for e in roads:
    hw = e['tags'].get('highway')
    if hw in CLASS and inside(e['geometry']):
        layers[CLASS[hw]].append(path(e['geometry']))

green, built, rail = [], [], []
for e in blds:
    t = e.get('tags', {})
    g = e.get('geometry') or []
    if len(g) < 2 or not inside(g):
        continue
    if 'railway' in t:
        if t['railway'] in ('monorail', 'rail', 'light_rail', 'construction'):
            rail.append(path(g))
    elif 'building' in t:
        built.append(path(g, True))
    elif len(g) > 2:
        green.append(path(g, True))

svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" preserveAspectRatio="xMidYMid slice">',
    f'<rect width="{WIDTH}" height="{HEIGHT}" fill="#ece8de"/>',
    f'<path fill="#dfe3d6" d="{" ".join(green)}"/>',
    f'<path fill="#dcd6c8" d="{" ".join(built)}"/>',
]
for w in sorted(layers):
    if layers[w]:
        svg.append(f'<path fill="none" stroke="#fbfaf6" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" d="{" ".join(layers[w])}"/>')
if rail:
    svg.append(f'<path fill="none" stroke="#283833" stroke-opacity=".55" stroke-width="5" stroke-dasharray="26 14" d="{" ".join(rail)}"/>')
svg.append('</svg>')
(ROOT / 'public' / 'img' / 'area-map.svg').write_text('\n'.join(svg))

# ---------- street labels: a straight run of each road, fitted through its points ----------
STREETS = [
    # OSM name:en, English label, Arabic label, where along the road (0..1), weight
    ('Al Tesein Northern Street', 'North 90 Street', 'شارع التسعين الشمالي', 0.1, 'major'),
    ('Al Tesein Northern Street', 'North 90 Street', 'شارع التسعين الشمالي', 0.80, 'major'),
    ('Al Tesein Southern Street', 'South 90 Street', 'شارع التسعين الجنوبي', 0.30, 'major'),
    ('Al Tesein Southern Street', 'South 90 Street', 'شارع التسعين الجنوبي', 0.78, 'major'),
    ('El Benouk Road', 'Banks Road', 'طريق البنوك', 0.45, 'minor'),
    ('El Orouba Axis', 'El Orouba Axis', 'محور العروبة', 0.72, 'minor'),
    ('Talaat Harb Axis', 'Talaat Harb Axis', 'محور طلعت حرب', 0.45, 'minor'),
    ('Moustafa Kamel Axis', 'Mostafa Kamel Axis', 'محور مصطفى كامل', 0.5, 'minor'),
    ('Omar Ibn Abd Al Aziz Street', 'Omar Ibn Abdel Aziz St.', 'شارع عمر بن عبد العزيز', 0.4, 'minor'),
    ('Khaled Ibn Al Walid Street', 'Khaled Ibn El Walid St.', 'شارع خالد بن الوليد', 0.5, 'minor'),
    ('Al Choueifat Street', 'Choueifat St.', 'شارع الشويفات', 0.45, 'minor'),
]
RUN = {'major': 900, 'minor': 520}


def fit(name, at, run):
    pts = [xy(p['lat'], p['lon']) for e in roads if e['tags'].get('name:en') == name for p in e['geometry']]
    pts = [(x, y) for x, y in pts if 60 < x < WIDTH - 60 and 60 < y < HEIGHT - 60]
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ux, uy = math.cos(ang), math.sin(ang)
    proj = sorted(((p[0] - mx) * ux + (p[1] - my) * uy, p) for p in pts)
    lo, hi = proj[0][0], proj[-1][0]
    c = lo + (hi - lo) * at
    win = [p for s, p in proj if abs(s - c) <= run / 2] or [proj[len(proj) // 2][1]]
    cx = sum(p[0] for p in win) / len(win)
    cy = sum(p[1] for p in win) / len(win)
    # the angle of the road where the label sits
    if len(win) > 2:
        wxx = sum((p[0] - cx) ** 2 for p in win)
        wyy = sum((p[1] - cy) ** 2 for p in win)
        wxy = sum((p[0] - cx) * (p[1] - cy) for p in win)
        ang = 0.5 * math.atan2(2 * wxy, wxx - wyy)
        ux, uy = math.cos(ang), math.sin(ang)
    if ux < 0 or (abs(ux) < 1e-6 and uy < 0):
        ux, uy = -ux, -uy
    deg = math.degrees(math.atan2(uy, ux))
    # vertical streets all read bottom to top
    if deg > 80:
        deg -= 180
    if deg < -100:
        deg += 180
    return round(cx), round(cy), round(deg, 1)


streets = []
for osm, en, ar, at, weight in STREETS:
    x, y, deg = fit(osm, at, RUN[weight])
    streets.append({'en': en, 'ar': ar, 'x': x, 'y': y, 'rot': deg, 'weight': weight})

# ---------- places: names and positions as mapped in OpenStreetMap ----------
PLACES = [
    ('mall', 'Downtown Katameya Mall', 'داون تاون مول القطامية', 30.01753, 31.41247),
    ('mall', 'Monaliza Mall', 'موناليزا مول', 30.01879, 31.41983),
    ('mall', 'Silver Star Mall', 'سيلفر ستار مول', 30.01934, 31.42060),
    ('mall', 'Town Center Mall', 'تاون سنتر مول', 30.01926, 31.42138),
    ('mall', 'Katameya Plaza', 'قطامية بلازا', 30.01862, 31.42209),
    ('mall', 'Hanimex Mall', 'هانيميكس مول', 30.01941, 31.42375),
    ('mall', 'Cairo Festival City Mall', 'كايرو فستيفال سيتي مول', 30.02813, 31.40812),
    ('mall', 'IKEA', 'ايكيا', 30.03018, 31.40761),
    ('landmark', 'Air Force Specialised Hospital', 'المستشفى الجوي التخصصي', 30.01762, 31.43457),
    ('landmark', 'As-Salam International Hospital', 'مستشفى السلام الدولي', 30.00759, 31.42816),
    ('landmark', 'Katameya Petrosport Club', 'نادي القطامية بتروسبورت', 30.02605, 31.44648),
    ('landmark', 'Dusit Thani LakeView', 'فندق دوسيت ثاني', 30.02611, 31.45444),
    ('transit', 'Monorail · Air Force Hospital station', 'المونوريل · محطة المستشفى الجوي', 30.01627, 31.43389),
]


def km(lat, lon):
    dx = (lon - WAVE[1]) * KX
    dy = (lat - WAVE[0]) * KY
    return round(math.hypot(dx, dy) / 1000, 1)


places = []
for kind, en, ar, lat, lon in PLACES:
    x, y = xy(lat, lon)
    places.append({'kind': kind, 'en': en, 'ar': ar, 'x': round(x), 'y': round(y), 'km': km(lat, lon)})

wx, wy = xy(*WAVE)
data = {'w': WIDTH, 'h': HEIGHT, 'wave': {'x': round(wx), 'y': round(wy)}, 'streets': streets, 'places': places}
(ROOT / 'src' / 'map-data.json').write_text(json.dumps(data, ensure_ascii=False, indent=1))
print(WIDTH, HEIGHT, len(built), 'buildings', sum(len(v) for v in layers.values()), 'roads', len(rail), 'rail')

#!/usr/bin/env python3
"""Draws the hand-designed fictional maps from shapes.

For each map this writes map-generator/assets/maps/<folder>/image.png (terrain),
features.png (forests, rivers, fords) and info.json (nations and spawns).
Coastlines and elevation use seeded noise, so every run gives the same files;
change a shape or a seed here and rerun to tweak a map.

    python map-generator/scripts/design_maps.py                  # all maps
    python map-generator/scripts/design_maps.py --maps caldera   # just one
    python map-generator/scripts/design_maps.py --preview DIR    # also write previews

Then build the game files for them (from map-generator/):

    go run -tags nodynamic . --maps=hourglass,sevenpasses,caldera,drowningdelta,shatteredcrown

Needs numpy and Pillow. The pixel encoding is the generator's (see
map-generator/README.md): water is blue 106, impassable is pure black, land
elevation is blue 140 + 2 * magnitude (plains 0-9, highland 10-19, mountain
20-30), and features.png uses the fixed feature colours.
"""

import argparse
import json
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "maps"

# Terrain kinds.
WATER, LAND, IMPASSABLE = 0, 1, 2
# Terrain features (TerrainFeature in packages/engine-api).
NONE, FOREST, RIVER, FORD = 0, 1, 2, 3

WATER_RGB = (36, 72, 106)  # only blue 106 matters
FEATURE_RGBA = {
    FOREST: (0, 128, 0, 255),
    RIVER: (0, 0, 255, 255),
    FORD: (255, 255, 0, 255),
}

# Magnitude bands.
PLAINS_MAX = 9
HIGHLAND = 10
MOUNTAIN = 20

TAU = 2 * math.pi


# ---------------------------------------------------------------------------
# Noise
# ---------------------------------------------------------------------------


class Noise:
    """Seeded value noise on periodic lattices, evaluated anywhere."""

    def __init__(self, seed):
        rng = np.random.default_rng(seed)
        self.lattices = [
            rng.uniform(-1, 1, (256, 256)).astype(np.float32) for _ in range(16)
        ]

    def value(self, x, y, lattice):
        g = self.lattices[lattice % len(self.lattices)]
        x0 = np.floor(x)
        y0 = np.floor(y)
        fx = (x - x0).astype(np.float32)
        fy = (y - y0).astype(np.float32)
        xi = x0.astype(np.int64) & 255
        yi = y0.astype(np.int64) & 255
        xj = (xi + 1) & 255
        yj = (yi + 1) & 255
        sx = fx * fx * (3 - 2 * fx)
        sy = fy * fy * (3 - 2 * fy)
        top = g[yi, xi] + (g[yi, xj] - g[yi, xi]) * sx
        bottom = g[yj, xi] + (g[yj, xj] - g[yj, xi]) * sx
        return top + (bottom - top) * sy

    def fbm(self, x, y, scale, octaves=4, seed=0, gain=0.5):
        """Fractal noise in about [-1, 1] with features `scale` pixels wide."""
        total = np.zeros(np.shape(x), np.float32)
        amp, norm, freq = 1.0, 0.0, 1.0 / scale
        for o in range(octaves):
            lattice = seed * 4 + o
            total += amp * self.value(
                x * freq + 37.1 * o + 101.3 * seed,
                y * freq + 71.9 * o + 53.7 * seed,
                lattice,
            )
            norm += amp
            amp *= gain
            freq *= 2
        return total / norm


# ---------------------------------------------------------------------------
# Shapes (signed distances, negative inside)
# ---------------------------------------------------------------------------


def seg_dist(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = np.clip(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1)
    return np.hypot(x - ax - t * dx, y - ay - t * dy)


def polyline_dist(x, y, pts):
    d = np.full(np.shape(x), np.inf, np.float32)
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        d = np.minimum(d, seg_dist(x, y, ax, ay, bx, by))
    return d


def polygon_sd(x, y, pts):
    d = np.full(np.shape(x), np.inf, np.float32)
    inside = np.zeros(np.shape(x), bool)
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        d = np.minimum(d, seg_dist(x, y, ax, ay, bx, by))
        if ay != by:
            crosses = ((ay > y) != (by > y)) & (
                x < (bx - ax) * (y - ay) / (by - ay) + ax
            )
            inside ^= crosses
    return np.where(inside, -d, d)


def point_on_polyline(pts, t):
    """The point a fraction t of the way along a polyline."""
    lengths = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
    target = t * sum(lengths)
    for (a, b), length in zip(zip(pts, pts[1:]), lengths):
        if target <= length:
            f = target / length
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        target -= length
    return pts[-1]


def dilate(mask, steps):
    m = mask.copy()
    for _ in range(steps):
        n = m.copy()
        n[1:] |= m[:-1]
        n[:-1] |= m[1:]
        n[:, 1:] |= m[:, :-1]
        n[:, :-1] |= m[:, 1:]
        m = n
    return m


def fold_x(x, cx):
    """Mirror about x = cx: the west half is canonical."""
    return cx - np.abs(x - cx)


def polar_fold(x, y, cx, cy, n, offset_deg):
    """
    Dihedral fold with n mirror sectors. Returns (r, a, xc, yc): radius, the
    folded angle in [0, pi/n] (0 on the sector's axis, measured clockwise
    from straight up plus offset_deg), and canonical cartesian coordinates
    for sampling noise symmetrically.
    """
    dx = x - cx
    dy = y - cy
    r = np.hypot(dx, dy)
    theta = np.arctan2(dx, -dy) - math.radians(offset_deg)
    period = TAU / n
    phi = np.mod(theta, period)
    a = np.minimum(phi, period - phi)
    return r, a, r * np.cos(a), r * np.sin(a)


def at_angle(cx, cy, r, deg):
    """The point r from (cx, cy), deg clockwise from straight up."""
    t = math.radians(deg)
    return (cx + r * math.sin(t), cy - r * math.cos(t))


# ---------------------------------------------------------------------------
# Canvas
# ---------------------------------------------------------------------------


class Canvas:
    def __init__(self, width, height, seed):
        assert width % 4 == 0 and height % 4 == 0
        self.w, self.h = width, height
        y, x = np.mgrid[0:height, 0:width].astype(np.float32)
        self.x, self.y = x, y
        self.noise = Noise(seed)
        self.kind = np.full((height, width), WATER, np.uint8)
        self.mag = np.zeros((height, width), np.float32)
        self.feat = np.zeros((height, width), np.uint8)

    def land(self, mask, mag=None):
        self.kind[mask] = LAND
        if mag is not None:
            self.mag[mask] = (mag[mask] if isinstance(mag, np.ndarray) else mag)

    def water(self, mask):
        self.kind[mask] = WATER
        self.feat[mask] = NONE

    def wall(self, mask):
        self.kind[mask] = IMPASSABLE
        self.feat[mask] = NONE

    def set_mag(self, mask, mag):
        self.mag[mask] = mag[mask] if isinstance(mag, np.ndarray) else mag

    def forest(self, mask):
        m = mask & (self.kind == LAND) & (self.feat == NONE)
        self.feat[m] = FOREST

    def river(self, mask):
        m = mask & (self.kind == LAND)
        self.feat[m] = RIVER

    def ford(self, mask):
        m = mask & (self.feat == RIVER)
        self.feat[m] = FORD

    def draw_river(self, xs, ys, pts, width, fords, ford_len=7):
        """A river along pts in (possibly warped) coordinates xs, ys."""
        d = polyline_dist(xs, ys, pts)
        bed = d < width / 2
        self.river(bed)
        for t in fords:
            fx, fy = point_on_polyline(pts, t)
            self.ford(bed & (np.hypot(xs - fx, ys - fy) < ford_len))
        return bed

    def spawn(self, x, y, search=45, clearance=4):
        """The closest good spawn tile to (x, y): dry, open land."""
        x, y = int(round(x)), int(round(y))
        ok = (self.kind == LAND) & ((self.feat == NONE) | (self.feat == FOREST))
        best = None
        for dy in range(-search, search + 1):
            for dx in range(-search, search + 1):
                d2 = dx * dx + dy * dy
                if best is not None and d2 >= best[0]:
                    continue
                px, py = x + dx, y + dy
                if not (
                    clearance <= px < self.w - clearance
                    and clearance <= py < self.h - clearance
                ):
                    continue
                box = ok[
                    py - clearance : py + clearance + 1,
                    px - clearance : px + clearance + 1,
                ]
                if box.all():
                    best = (d2, px, py)
        if best is None:
            raise ValueError(f"no spawn tile near ({x}, {y})")
        return best[1], best[2]

    # -- output ------------------------------------------------------------

    def finish(self):
        self.mag = np.clip(np.rint(self.mag), 0, 30)
        self.feat[self.kind != LAND] = NONE

    def save(self, folder):
        out = ASSETS / folder
        out.mkdir(parents=True, exist_ok=True)
        rgb = np.zeros((self.h, self.w, 3), np.uint8)
        land = self.kind == LAND
        blue = (140 + 2 * self.mag).astype(np.uint8)
        for ch in range(3):
            rgb[..., ch][land] = blue[land]
        rgb[self.kind == WATER] = WATER_RGB
        rgb[self.kind == IMPASSABLE] = (0, 0, 0)
        Image.fromarray(rgb, "RGB").save(out / "image.png", optimize=True)

        rgba = np.zeros((self.h, self.w, 4), np.uint8)
        for f, color in FEATURE_RGBA.items():
            rgba[self.feat == f] = color
        Image.fromarray(rgba, "RGBA").save(out / "features.png", optimize=True)

    def preview(self, path, spawns, center, scale=2):
        rgb = np.zeros((self.h, self.w, 3), np.uint8)
        m = self.mag
        land = self.kind == LAND
        plains = land & (m < HIGHLAND)
        high = land & (m >= HIGHLAND) & (m < MOUNTAIN)
        mount = land & (m >= MOUNTAIN)
        rgb[self.kind == WATER] = (70, 132, 180)
        rgb[plains] = (190, 220, 138)
        rgb[high] = (220, 203, 158)
        rgb[mount] = (238, 238, 238)
        rgb[self.kind == IMPASSABLE] = (40, 40, 40)
        rgb[self.feat == FOREST] = (95, 150, 80)
        rgb[self.feat == RIVER] = (40, 90, 220)
        rgb[self.feat == FORD] = (250, 230, 60)
        for sx, sy in spawns:
            rgb[max(0, sy - 6) : sy + 7, max(0, sx - 6) : sx + 7] = (220, 30, 30)
        cx, cy = center
        rgb[cy - 3 : cy + 4, cx - 12 : cx + 13] = (255, 0, 255)
        rgb[cy - 12 : cy + 13, cx - 3 : cx + 4] = (255, 0, 255)
        img = Image.fromarray(rgb, "RGB")
        img = img.resize((self.w // scale, self.h // scale), Image.BOX)
        img.save(path)

    def stats(self):
        land = self.kind == LAND
        counts = {
            "land": int(land.sum()),
            "plains": int((land & (self.mag < HIGHLAND)).sum()),
            "highland": int(
                (land & (self.mag >= HIGHLAND) & (self.mag < MOUNTAIN)).sum()
            ),
            "mountain": int((land & (self.mag >= MOUNTAIN)).sum()),
            "impassable": int((self.kind == IMPASSABLE).sum()),
            "forest": int((self.feat == FOREST).sum()),
            "river": int((self.feat == RIVER).sum()),
            "ford": int((self.feat == FORD).sum()),
        }
        return counts


# ---------------------------------------------------------------------------
# Maps
# ---------------------------------------------------------------------------


def hourglass():
    """
    Two mirrored continents joined by a 40-tile isthmus, with a cliff-walled
    keep at its middle and sea lanes on both sides. Cliffs line the coasts
    near the waist, so the waist falls to a siege or to a landing further
    out on the enemy coast.
    """
    W, H, cx, cy = 2200, 1300, 1100, 650
    c = Canvas(W, H, seed=1101)
    n = c.noise
    X, Y = c.x, c.y
    xf = fold_x(X, cx)  # mirror-symmetric: both teams get the same land
    wx = n.fbm(xf, Y, 260, 3, seed=1) * 45 + n.fbm(xf, Y, 45, 2, seed=2) * 9
    wy = n.fbm(xf, Y, 260, 3, seed=3) * 45 + n.fbm(xf, Y, 45, 2, seed=4) * 9
    xw, yw = xf + wx, Y + wy

    continent = [
        (90, 150), (480, 70), (640, 110), (845, 590), (880, 622),
        (880, 678), (845, 710), (640, 1190), (480, 1230), (90, 1150),
        (50, 650),
    ]  # fmt: skip
    neck = [(690, 500), (880, 622), (880, 678), (690, 800)]
    land = (polygon_sd(xw, yw, continent) < 0) | (polygon_sd(xf, Y, neck) < 0)

    base = 3 + 3 * n.fbm(xf, Y, 180, 4, seed=5)
    hills = np.clip((n.fbm(xf, Y, 140, 4, seed=6) - 0.22) * 42, 0, 13)
    ridge = polyline_dist(xw, yw, [(160, 300), (250, 540), (240, 780), (170, 1020)])
    ridge = np.maximum(ridge + 22 * n.fbm(xf, Y, 60, 3, seed=16), 0)
    crest = 25 + 5 * n.fbm(xf, Y, 50, 3, seed=17)
    mag = np.maximum(base + hills, np.clip(crest - ridge * 0.3, 0, 30))
    c.land(land, mag)

    # The waist: 40 tiles of isthmus (rows 630-669) behind cliffs, and a
    # cliff-ringed keep in the middle.
    waist = (X >= 880) & (X <= W - 880)
    c.water(waist & (np.abs(Y - cy + 0.5) <= 140))
    isthmus = waist & (Y >= cy - 20) & (Y < cy + 20)
    c.land(isthmus, 4 + 2 * n.fbm(xf, Y, 60, 2, seed=9))
    kr = np.hypot(X - cx + 0.5, Y - cy + 0.5)
    keep = kr < 92
    c.land(keep, 12 + 6 * (1 - kr / 92) + 1.5 * n.fbm(xf, Y, 30, 2, seed=10))
    arm_cliff = waist & (np.abs(Y - cy + 0.5) >= 20) & (np.abs(Y - cy + 0.5) < 28)
    keep_cliff = (kr >= 92) & (kr < 100) & (np.abs(Y - cy + 0.5) >= 20)
    c.wall((arm_cliff & (kr >= 92)) | keep_cliff)

    # Coastal cliffs near the waist: no landing right behind the siege.
    coast = (c.kind == LAND) & dilate(c.kind == WATER, 6)
    near = (np.hypot(X - 880, Y - cy) < 290) | (np.hypot(X - (W - 880), Y - cy) < 290)
    c.wall(coast & near & ~waist)

    # Rivers from the western hills to both coasts, two fords each.
    rx = xf + n.fbm(xf, Y, 110, 3, seed=11) * 22
    ry = Y + n.fbm(xf, Y, 110, 3, seed=12) * 22
    north = [(300, 590), (360, 470), (450, 330), (530, 210), (600, 40)]
    south = [(x, 2 * cy - y) for x, y in north]
    for pts in (north, south):
        c.draw_river(rx, ry, pts, 8, [0.36, 0.74])

    # Woods: patches across both continents, the keep, and the isthmus mouths.
    woods = n.fbm(xf, Y, 90, 4, seed=13)
    c.forest((woods > 0.24) & (c.mag < MOUNTAIN))
    c.forest(keep & (kr > 36) & (n.fbm(xf, Y, 25, 2, seed=14) > -0.25))
    mouth = np.hypot(xf - 800, Y - cy) < 110
    c.forest(mouth & (n.fbm(xf, Y, 30, 2, seed=15) > -0.1))
    c.finish()

    names_w = ["Varnholt", "Ashgrove", "Kestrel Reach", "Duskmoor",
               "Ironvale", "Saltmere", "Brindle", "Harrowgate"]  # fmt: skip
    names_e = ["Solvane", "Ombria", "Quarry Hollow", "Tidecrest",
               "Emberfall", "Lowmarsh", "Ravenspire", "Glimmerdeep"]  # fmt: skip
    # Eight spawns per side on an arc 620 tiles from the keep.
    nations = []
    for side, names in ((-1, names_w), (1, names_e)):
        for name, deg in zip(names, [5, -5, 15, -15, 26, -26, 37, -37]):
            t = math.radians(deg)
            spawn = c.spawn(cx + side * 620 * math.cos(t), cy - 620 * math.sin(t))
            nations.append((name, spawn))
    info = {
        "id": "Hourglass",
        "name": "Hourglass",
        "special_team_count": 2,
        "teamGameSpawnAreas": {
            "2": [
                {"x": 0, "y": 0, "width": 880, "height": H},
                {"x": W - 880, "y": 0, "width": 880, "height": H},
            ]
        },
    }
    return c, nations, (cx, cy), info


def seven_passes():
    """
    A mountain spine with an impassable core runs north to south. Seven
    passes cross it, 60 tiles wide at the central basin down to 8, each with
    its own ground. Open plains cut by rivers lie west, wooded highlands
    east, and the sea goes around both ends of the spine.
    """
    W, H, cx, cy = 2200, 1400, 1100, 700
    c = Canvas(W, H, seed=2207)
    n = c.noise
    X, Y = c.x, c.y
    wx = n.fbm(X, Y, 240, 3, seed=1) * 40 + n.fbm(X, Y, 45, 2, seed=2) * 9
    wy = n.fbm(X, Y, 240, 3, seed=3) * 40 + n.fbm(X, Y, 45, 2, seed=4) * 9
    xw, yw = X + wx, Y + wy
    landmass = [
        (200, 170), (700, 150), (1100, 165), (1500, 150), (2000, 170),
        (2020, 700), (2000, 1230), (1500, 1250), (1100, 1235), (700, 1250),
        (200, 1230), (180, 700),
    ]  # fmt: skip
    land = polygon_sd(xw, yw, landmass) < 0
    for bx, by, br in ((200, 430, 120), (200, 970, 120), (2000, 520, 110),
                       (2000, 880, 110), (1450, 150, 90), (1450, 1250, 90),
                       (750, 150, 80), (750, 1250, 80)):  # fmt: skip
        wobble = 1 + 0.3 * n.fbm(X, Y, 55, 3, seed=15 + bx // 100)
        land &= np.hypot(xw - bx, yw - by) > br * wobble

    # Spine centre line and horizontal distance to it.
    spine_x = cx + 45 * np.sin((Y - 100) / 210) + 14 * n.fbm(X * 0, Y, 120, 3, seed=5)
    ds = np.abs(X - spine_x)
    west = X < spine_x
    flank = np.clip(30 - (ds - 20) * 0.2, 0, 30)
    west_mag = 2 + 3 * n.fbm(X, Y, 200, 4, seed=6) + np.clip(
        (n.fbm(X, Y, 150, 3, seed=7) - 0.4) * 40, 0, 11
    )
    east_mag = 14 + 4 * n.fbm(X, Y, 160, 4, seed=8)
    mag = np.where(west, np.maximum(west_mag, flank), np.maximum(east_mag, flank))
    c.land(land, mag)
    # The core runs out into the sea, so the only way around it is a ship.
    core = (ds < 20) & (Y > 110) & (Y < H - 110)
    c.wall(core)

    # Central basin: the prize, ringed by the core except at the 60 pass.
    br = np.hypot((X - cx) / 120, (Y - cy) / 130)
    basin = br < 1
    rim = (br >= 1) & (br < 1.13)
    c.wall(rim & (ds < 150))
    c.land(basin, 11 + 3 * n.fbm(X, Y, 40, 3, seed=9) + 4 * (1 - br))
    c.forest(basin & (n.fbm(X, Y, 35, 3, seed=10) > 0.05))

    # The passes: (y, width, ground).
    passes = [
        (235, 12, "mountain"),
        (375, 36, "forest"),
        (510, 18, "river"),
        (cy, 60, "basin"),
        (890, 26, "mountain"),
        (1030, 48, "plains"),
        (1165, 8, "plains"),
    ]
    for py, width, ground in passes:
        centre = py + 12 * np.sin(X / 85)
        if ground == "basin":
            centre = np.full_like(X, cy - 0.5)
        dy = np.abs(Y - centre)
        # The basin's entrances also cut its rim, out to ~140 tiles.
        reach = (ds < (170 if ground == "basin" else 125)) & land
        gap = reach & (dy < width / 2)
        valley = reach & (dy < width / 2 + np.clip(ds - 20, 0, None) * 0.3)
        c.land(gap)
        if ground == "mountain":
            c.set_mag(valley, np.full_like(X, 24.0))
        elif ground == "forest":
            c.set_mag(valley, np.full_like(X, 14.0))
            c.forest(valley)
        elif ground in ("plains", "river"):
            c.set_mag(valley, np.full_like(X, 5.0))
        elif ground == "basin":
            c.set_mag(valley & ~basin, np.full_like(X, 12.0))
        if ground == "river":
            # A stream runs down the gap; one ford crosses it.
            stream = (np.abs(X - spine_x) < 5) & (dy < width / 2 + 40)
            c.river(stream & (c.kind == LAND))
            c.ford(stream & (dy < 4))

    # West: two rivers from the spine to the coast, between spawn groups.
    rx = X + n.fbm(X, Y, 120, 3, seed=11) * 26
    ry = Y + n.fbm(X, Y, 120, 3, seed=12) * 26
    for sign in (-1, 1):
        a = math.radians(26)
        pts = [
            (cx - r * math.cos(a), cy + sign * r * math.sin(a))
            for r in (190, 380, 600, 820, 1050, 1250)
        ]
        c.draw_river(rx, ry, pts, 10, [0.18, 0.47, 0.76])
    # East: woods on the highlands; a few copses out west.
    c.forest(~west & (n.fbm(X, Y, 80, 4, seed=13) > 0.05) & (c.mag < MOUNTAIN))
    c.forest(west & (n.fbm(X, Y, 45, 3, seed=14) > 0.5) & (c.mag < HIGHLAND))
    c.finish()

    names_w = ["Amberfield", "Larkspur", "Meadowmere", "Goldenreach",
               "Windmoor", "Sorrel Downs", "Hayden Vale", "Brightwater"]  # fmt: skip
    names_e = ["Highcrag", "Stonehelm", "Cairnwold", "Fellshire",
               "Granite Keep", "Thornridge", "Aeriemount", "Shalehold"]  # fmt: skip
    # Eight spawns per side, 620 tiles from the basin.
    nations = []
    for side, names in ((-1, names_w), (1, names_e)):
        for name, deg in zip(names, [6, -6, 19, -19, 32, -32, 45, -45]):
            t = math.radians(deg)
            spawn = c.spawn(cx + side * 620 * math.cos(t), cy - 620 * math.sin(t))
            nations.append((name, spawn))
    info = {
        "id": "SevenPasses",
        "name": "Seven Passes",
        "special_team_count": 2,
        "teamGameSpawnAreas": {
            "2": [
                {"x": 0, "y": 0, "width": 960, "height": H},
                {"x": W - 960, "y": 0, "width": 960, "height": H},
            ]
        },
    }
    return c, nations, (cx, cy), info


def caldera():
    """
    A ring of land around an inland sea, inside an impassable crater wall,
    with a volcanic island in the middle. Six identical sectors: walls split
    neighbours, each wall with a coastal gap and a high mountain gap, and two
    rivers flank every spawn.
    """
    W, H, cx, cy = 1800, 1800, 900, 900
    c = Canvas(W, H, seed=3301)
    n = c.noise
    r, a, xc, yc = polar_fold(c.x + 0.5, c.y + 0.5, cx, cy, 6, 0)
    xs, ys = xc + 4000, yc + 4000
    r_in = 500 + 34 * n.fbm(xs, ys, 180, 3, seed=1) + 8 * n.fbm(xs, ys, 40, 2, seed=2)
    r_out = 850 + 22 * n.fbm(xs, ys, 160, 3, seed=3) + 6 * n.fbm(xs, ys, 35, 2, seed=4)
    r_isle = 155 + 18 * n.fbm(xs, ys, 70, 3, seed=5) + 5 * n.fbm(xs, ys, 20, 2, seed=6)

    ring = (r >= r_in) & (r < r_out)
    jitter = 2.5 * n.fbm(xs, ys, 60, 3, seed=7)
    rb = r + 32 * n.fbm(xs, ys, 110, 3, seed=13) + 8 * n.fbm(xs, ys, 30, 2, seed=14)
    ring_mag = np.select(
        [rb < 620, rb < 725],
        [3 + jitter, 14 + jitter],
        np.minimum(24 + (rb - 725) / 30, 30) + jitter,
    )
    c.land(ring, ring_mag)
    c.wall(r >= r_out)

    isle = r < r_isle
    ri = r + 12 * n.fbm(xs, ys, 40, 3, seed=15)
    isle_mag = np.select(
        [ri < 70, ri < 118], [30 - ri / 14 + jitter, 15 + jitter], 4 + jitter
    )
    c.land(isle, isle_mag)
    c.wall(r < 22)  # the crater
    c.forest(isle & (ri >= 70) & (ri < 118) & (n.fbm(xs, ys, 25, 2, seed=8) > -0.3))

    # Walls between sectors (folded angle pi/6), with a coastal gap
    # (r_in to r_in + 75) and a mountain gap (745 to 815).
    to_wall = r * np.sin(math.pi / 6 - a) + 3 * n.fbm(xs, ys, 50, 2, seed=9)
    wall = (to_wall < 10) & (
        ((r >= r_in + 75) & (r < 745)) | ((r >= 815) & (r < r_out + 10))
    )
    c.wall(wall)

    # Two rivers per spawn, 19 degrees either side, from the rim to the sea.
    meander = 22 * n.fbm(r, r * 0, 110, 3, seed=10)
    to_river = np.abs(r * np.sin(a - math.radians(19)) - meander)
    bed = (to_river < 5) & (r < 840) & (r > r_in - 15) & (a > math.radians(8))
    c.river(bed)
    for fr in (560, 680):
        c.ford(bed & (np.abs(r - fr) < 7))
    c.forest(
        (rb >= 620) & (rb < 725) & (n.fbm(xs, ys, 70, 4, seed=11) > -0.05)
    )
    c.forest((r >= r_in) & (rb < 620) & (n.fbm(xs, ys, 60, 4, seed=12) > 0.45))
    c.finish()

    names = ["Pyreholm", "Ashfall", "Cinderwick", "Basalt Gate",
             "Obsidian Reach", "Embermoor"]  # fmt: skip
    nations = [
        (names[i], c.spawn(*at_angle(cx, cy, 600, i * 60))) for i in range(6)
    ]
    info = {"id": "Caldera", "name": "Caldera", "special_team_count": 3}
    return c, nations, (cx, cy), info


def drowning_delta():
    """
    A wide, low delta. The mother river enters from the north and splits
    into two navigable arms around a cliff-walled central plateau. River
    channels radiate from it to the sea between the spawns, two rings of
    channel cross them, and fords mark the cheap crossings.
    """
    W, H, cx, cy = 2000, 1400, 1000, 650
    c = Canvas(W, H, seed=4409)
    n = c.noise
    X, Y = c.x, c.y
    xf = fold_x(X, cx)  # mirror-symmetric about the mother river
    wx = n.fbm(xf, Y, 230, 3, seed=1) * 40 + n.fbm(xf, Y, 40, 2, seed=2) * 9
    wy = n.fbm(xf, Y, 230, 3, seed=3) * 40 + n.fbm(xf, Y, 40, 2, seed=4) * 9
    xw, yw = xf + wx, Y + wy
    delta = [
        (1200, -80), (-80, -80), (70, 150), (110, 520), (210, 850),
        (400, 1080), (700, 1215), (1000, 1250), (1200, 1250),
    ]  # fmt: skip
    land = polygon_sd(xw, yw, delta) < 0
    low = 1.5 + 1.5 * n.fbm(xf, Y, 150, 4, seed=5)
    low += np.clip((n.fbm(xf, Y, 120, 3, seed=6) - 0.45) * 25, 0, 5)
    c.land(land, low)
    pr = np.hypot(X - cx + 0.5, Y - cy + 0.5)

    # Drowned ground: lagoons, kept clear of the plateau.
    lagoon = (n.fbm(xf, Y, 90, 4, seed=13) > 0.42) & (pr > 260)
    c.water(lagoon & land)

    rx = xf + n.fbm(xf, Y, 100, 3, seed=7) * 18
    ry = Y + n.fbm(xf, Y, 100, 3, seed=8) * 18

    def ray(alpha, r):  # alpha degrees from north, towards the west
        t = math.radians(alpha)
        return (cx - r * math.sin(t), cy - r * math.cos(t))

    # The mother river and its two navigable arms (water).
    arm = [(cx, -30), (cx, 400), (900, 430), (800, 520), (765, 650),
           (790, 790), (720, 960), (610, 1130), (520, 1320)]  # fmt: skip
    c.water(polyline_dist(rx, ry, arm) < 13)

    # Channels between the spawns (which sit at 15 + 30k degrees, r 500).
    for alpha in (30, 60, 90, 120):
        pts = [ray(alpha, r) for r in (260, 450, 700, 950, 1200)]
        bed = c.draw_river(rx, ry, pts, 9, [])
        for fr in (420, 640, 880):
            fx, fy = ray(alpha, fr)
            c.ford(bed & (np.hypot(rx - fx, ry - fy) < 8))
    # Two rings of channel: inside the spawns and outside them.
    for ring_r, fords in ((330, (45, 105, 135)), (720, (15, 45, 75, 105, 135, 165))):
        pts = [ray(alpha, ring_r) for alpha in range(18, 166, 4)]
        bed = c.draw_river(rx, ry, pts, 7, [])
        for alpha in fords:
            fx, fy = ray(alpha, ring_r)
            c.ford(bed & (np.hypot(rx - fx, ry - fy) < 8))

    # The plateau: cliff ring with four ramps on the diagonals.
    pr = pr + 6 * n.fbm(xf, Y, 50, 2, seed=9)
    ang = np.degrees(np.arctan2(np.abs(X - cx + 0.5), -(Y - cy + 0.5)))
    ramp = (np.abs(ang - 45) < 7) | (np.abs(ang - 135) < 7)
    plateau = pr < 150
    c.feat[plateau] = NONE
    c.land(plateau, 15 + 4 * (1 - pr / 150) + 1.5 * n.fbm(xf, Y, 30, 2, seed=10))
    c.land(pr < 40, 23 - pr / 10)
    c.wall((pr >= 150) & (pr < 160) & ~ramp)
    c.land((pr >= 150) & (pr < 172) & ramp, np.full_like(X, 9.0))
    c.forest(plateau & (pr > 45) & (n.fbm(xf, Y, 30, 3, seed=11) > 0.0))

    # Old dikes: impassable walls out on the wetland, between channels.
    for a0, a1, wr in ((64, 86, 870), (35, 53, 930)):
        pts = [ray(alpha, wr) for alpha in range(a0, a1 + 1, 2)]
        c.wall(polyline_dist(rx, ry, pts) < 6)
    # Reed woods across the wetland.
    c.forest((n.fbm(xf, Y, 70, 4, seed=12) > 0.3) & (pr > 175))
    c.finish()

    names = ["Reedmarsh", "Silt Haven", "Mudwater", "Heronfield",
             "Eelwick", "Lotusreach", "Tidewall", "Brackenmouth",
             "Willowisle", "Floodgate", "Cattail Moor", "Deltagard"]  # fmt: skip
    nations = [
        (names[i], c.spawn(*at_angle(cx, cy, 500, 15 + 30 * i))) for i in range(12)
    ]
    info = {"id": "DrowningDelta", "name": "Drowning Delta"}
    return c, nations, (cx, cy), info


def shattered_crown():
    """
    25 islands around a central crown island: 10 spawn islands, 5 inner
    stepping stones and 10 rocky outer islands, with a broken reef between
    the inner waters and the spawn ring. Impassable crags crown the centre.
    """
    W, H, cx, cy = 1800, 1800, 900, 900
    c = Canvas(W, H, seed=5521)
    n = c.noise
    # D5 fold: angle 0 = an inner island (and outer island A), 18 degrees =
    # a spawn island, 36 degrees = outer island B.
    r, a, xc, yc = polar_fold(c.x + 0.5, c.y + 0.5, cx, cy, 5, 18)
    xs, ys = xc + 4000, yc + 4000
    jitter = 2 * n.fbm(xs, ys, 40, 3, seed=1)

    def blob(r0, deg, radial, tangential, seed):
        """Normalised distance (1 at the coast) of an island centred r0 out
        at folded angle deg, stretched along the ring."""
        t = math.radians(deg)
        dx, dy = xc - r0 * math.cos(t), yc - r0 * math.sin(t)
        u = dx * math.cos(t) + dy * math.sin(t)
        v = -dx * math.sin(t) + dy * math.cos(t)
        q = np.hypot(u / radial, v / tangential)
        edge = (
            1
            + 0.28 * n.fbm(xs, ys, radial * 0.9, 3, seed=seed)
            + 0.08 * n.fbm(xs, ys, radial * 0.25, 2, seed=seed + 40)
        )
        return q / edge

    def bands(seed, scale):
        """A wobble for the elevation bands inside an island."""
        return 1 + 0.35 * n.fbm(xs, ys, scale, 3, seed=seed)

    # The crown island.
    edge = 230 + 30 * n.fbm(xs, ys, 90, 3, seed=2) + 8 * n.fbm(xs, ys, 30, 2, seed=20)
    crown = r < edge
    rb = r / bands(21, 60)
    crown_mag = np.select(
        [rb < 115, rb < 172], [14 + jitter, 24 + jitter], 4 + jitter
    )
    c.land(crown, crown_mag)
    c.forest(crown & (rb < 110) & (n.fbm(xs, ys, 25, 2, seed=3) > -0.2))
    # Crags on the crown ring, on the fold lines: gaps face the spawn islands.
    for deg in (0, 36):
        off = r * np.abs(np.sin(a - math.radians(deg)))
        crag = (r >= 118) & (r < 180) & (off < (180 - r) * 0.42 + 4)
        c.wall(crag)

    spawn_q = blob(600, 18, 78, 108, seed=4)
    spawn = spawn_q < 1
    spawn_hi = spawn_q < 0.5 * bands(22, 35)
    c.land(spawn, np.where(spawn_hi, 13 + jitter, 4 + jitter))
    c.forest(spawn_hi & (n.fbm(xs, ys, 22, 2, seed=5) > -0.25))
    c.forest(spawn & ~spawn_hi & (n.fbm(xs, ys, 30, 2, seed=23) > 0.45))
    inner_q = blob(360, 0, 52, 72, seed=6)
    inner = inner_q < 1
    c.land(inner, 5 + jitter)
    c.forest(inner & (n.fbm(xs, ys, 20, 2, seed=7) > 0.1))
    for deg, seed in ((0, 8), (36, 9)):
        outer_q = blob(790, deg, 50, 64, seed=seed)
        peak = outer_q < 0.6 * bands(seed + 30, 25)
        c.land(outer_q < 1, np.where(peak, 25 + jitter, 15 + jitter))

    # The reef: an impassable arc between the inner waters and the spawn
    # ring, open towards the inner islands, the spawns and outer island B.
    reef_r = 470 + 6 * n.fbm(xs, ys, 80, 2, seed=10)
    deg = np.degrees(a)
    reef = (np.abs(r - reef_r) < 4) & (
        ((deg > 3.5) & (deg < 12)) | ((deg > 24) & (deg < 32.5))
    )
    c.wall(reef & (c.kind == WATER))
    c.finish()

    names = ["Crownfall", "Shardholm", "Gemhaven", "Saltspire",
             "Coral Throne", "Driftmark", "Pearlgate", "Wavecrest",
             "Splinter Isle", "Reefward"]  # fmt: skip
    nations = [
        (names[i], c.spawn(*at_angle(cx, cy, 600, 36 * i))) for i in range(10)
    ]
    info = {"id": "ShatteredCrown", "name": "Shattered Crown"}
    return c, nations, (cx, cy), info


MAPS = {
    "hourglass": hourglass,
    "sevenpasses": seven_passes,
    "caldera": caldera,
    "drowningdelta": drowning_delta,
    "shatteredcrown": shattered_crown,
}


def write_info(folder, info, nations):
    doc = {
        "$schema": "../../../info.schema.json",
        "id": info["id"],
        "name": info["name"],
        "translation_key": f"map.{folder}",
        "categories": ["fictional", "new"],
    }
    if "special_team_count" in info:
        doc["special_team_count"] = info["special_team_count"]
    doc["nations"] = [
        {"coordinates": [x, y], "flag": "", "name": name}
        for name, (x, y) in nations
    ]
    if "teamGameSpawnAreas" in info:
        doc["teamGameSpawnAreas"] = info["teamGameSpawnAreas"]
    # Short arrays on one line, the way Oxfmt writes them.
    text = re.sub(
        r"\[\s+([^\[\]{}]*?)\s+\]",
        lambda m: "[" + ", ".join(v.strip() for v in m.group(1).split(",")) + "]",
        json.dumps(doc, indent=2),
    )
    (ASSETS / folder / "info.json").write_text(
        text + "\n", encoding="utf8", newline="\n"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--maps", default=",".join(MAPS))
    parser.add_argument("--preview", help="directory for preview PNGs")
    args = parser.parse_args()
    for folder in args.maps.split(","):
        c, nations, center, info = MAPS[folder]()
        c.save(folder)
        write_info(folder, info, nations)
        dists = [math.dist(xy, center) for _, xy in nations]
        print(
            f"{folder}: {c.w}x{c.h}, {len(nations)} nations, spawn distance "
            f"{min(dists):.0f}-{max(dists):.0f}, {c.stats()}"
        )
        if args.preview:
            Path(args.preview).mkdir(parents=True, exist_ok=True)
            c.preview(
                Path(args.preview) / f"{folder}.png",
                [xy for _, xy in nations],
                center,
            )


if __name__ == "__main__":
    main()

# Colormap registry — names that anyplotlib accepts directly.
# anyplotlib uses colorcet internally; these names are passed verbatim to
# Plot2D.set_colormap() / the Electron colormap selector.
#
# Only visually DISTINCT maps belong here. anyplotlib's _CMAP_ALIASES maps
# "plasma" and "hot" onto colorcet's "fire", and colorcet's own CET_L3 is a
# synonym for "fire" while CET_L1 is its grey ramp — so fire/hot/CET_L3 render
# byte-identical to plasma, and CET_L1 to gray. Verified by diffing the full
# 256-entry LUTs from anyplotlib._utils._build_colormap_lut; re-check
# distinctness the same way before adding a name.
#
# Names use colorcet's underscore spelling (CET_R1, not CET-R1) — the dashed
# spelling silently resolves to a flat grey ramp via anyplotlib's fallback
# chain (colorcet miss -> matplotlib miss -> grey ramp).

COLORMAPS: dict[str, str] = {
    "gray": "gray",
    "viridis": "viridis",
    "plasma": "plasma",
    "inferno": "inferno",
    "magma": "magma",
    "cividis": "cividis",
    "turbo": "turbo",
    "CET_R1": "CET_R1",   # a rainbow, not a diverging map: its middle is yellow
    "CET_D1": "CET_D1",   # diverging blue-white-red, matplotlib's coolwarm
}

DEFAULT_COLORMAP = "gray"
#: For a signed map (a strain, a field component): white at the middle, so a
#: range centered on zero shows zero as white.
DIVERGING_COLORMAP = "CET_D1"

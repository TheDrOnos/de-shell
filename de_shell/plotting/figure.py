"""
figure.py — a single image pane, created once and repainted in place.

The smallest correct anyplotlib figure a shell app can own. Creating one emits
its HTML to the renderer, which mounts it in an iframe keyed by ``fig_id``;
every later frame is a ``set_data`` push down the same channel, so the iframe is
never rebuilt and the user's zoom survives the next frame.

**This is deliberately the small shape, not SpyDE's.** SpyDE's ``Plot`` carries
the array cache, the tiered navigator read, overlay layers and tile mode — all
of which exist because it displays multi-gigabyte lazy datasets on disk. A live
camera hands over a frame that is already in RAM, so none of it applies. The
shared wrapper is the in-memory core; an app that needs the out-of-core
machinery layers it on top rather than the shell carrying it for everyone.

It satisfies the WindowController protocol (a ``window_id`` and a ``close()``),
so a session's window registry can own its lifetime.

Two things here are easy to get wrong and cost a debugging session each; both
are enforced rather than documented-and-hoped:

* **Registration mints the fig_id.** ``_electron.register(fig)`` attaches the
  trait observers that turn a later ``set_data`` into a push, and returns the id
  the renderer routes those pushes by. Inventing an id instead leaves the figure
  unregistered: it mounts, sizes and titles correctly, and then never updates,
  with no error anywhere.
* **Levels are robust by default.** One hot pixel — which every real detector
  has — sets the ceiling under a plain min/max and renders the whole image
  black.
"""
from __future__ import annotations

import logging
import warnings
from collections.abc import Sequence

import numpy as np

import anyplotlib as apl
import anyplotlib._electron as _electron
from anyplotlib.embed import build_standalone_html

from de_shell.ipc import emit
from de_shell.plotting.colormaps import DEFAULT_COLORMAP

log = logging.getLogger(__name__)


#: Subsample any axis longer than this before measuring levels. Percentiles over
#: 16 M pixels cost tens of ms and land on the paint path; a ≤512² sample gives
#: the same answer to well within a display level.
LEVEL_SAMPLE = 512


def robust_levels(frame: np.ndarray, *,
                  low: float | None = 2.0, high: float = 98.0,
                  sample: int = LEVEL_SAMPLE) -> tuple[float, float]:
    """A display range for *frame* that a hot pixel cannot wreck.

    Percentiles rather than min/max: one saturated pixel — which every real
    detector has — otherwise sets the ceiling and renders everything else black.

    ``low=None`` uses the true minimum instead of a low percentile. That is the
    right choice for an image with no saturating spike (a navigator, a virtual
    image), where clipping the floor throws away real dynamic range; an image
    that DOES have one (a diffraction pattern, whose central beam is orders of
    magnitude brighter than the spots) wants both ends clipped.

    Lifted from SpyDE's ``Plot._robust_levels``, which had already paid for the
    subsampling and the non-finite handling.
    """
    arr = np.asarray(frame)
    try:
        sy = max(1, arr.shape[0] // sample)
        sx = max(1, arr.shape[1] // sample) if arr.ndim > 1 else 1
        data = np.asarray(arr[::sy, ::sx] if arr.ndim > 1 else arr[::sy],
                          dtype=np.float64)
        data = data[np.isfinite(data)]
        if data.size == 0:
            # Nothing measurable — an all-NaN frame, or an empty one.
            return 0.0, 1.0
        # No warnings.catch_warnings() here, deliberately. `data` is already
        # finite-filtered above, so numpy's all-NaN RuntimeWarning cannot fire —
        # and this runs on the PAINT path, where entering a context manager that
        # saves and restores global warning state on every frame is pure cost.
        lo = float(np.percentile(data, low)) if low is not None else float(data.min())
        hi = float(np.percentile(data, high))
        # Collapsed percentiles mean the BULK of the frame is one value. Fall
        # back to the true maximum — load-bearing for a SPARSE image, e.g. a
        # count map that is >99.5% zeros with a few bright spots: the percentile
        # is zero there, and without this the spots all saturate against a
        # 1-wide window instead of scaling properly.
        #
        # The cost is that a perfectly FLAT frame carrying one hot pixel scales
        # to that pixel and renders dark. That is the right trade: a sparse real
        # image is common and a flat synthetic one is not, and any frame with
        # genuine variation never reaches this branch.
        if hi <= lo:
            hi = float(data.max())
        # Still collapsed: genuinely uniform. Widen by a hair rather than return
        # a zero-width window, which renders as a solid block and is
        # indistinguishable from a broken decode.
        if hi <= lo:
            hi = lo + 1.0
        return lo, hi
    except Exception:
        return 0.0, 1.0


#: Figure chrome background. The apps are dark; anyplotlib's template is not.
FIGURE_BACKGROUND = "#1e1e2e"

#: Injected into every figure frame: the figure document must never SCROLL.
#:
#: anyplotlib lays its panel out at the size the app reports and then wraps it
#: in ~16 px of its own chrome, so the figure document is always a little taller
#: than the frame it lives in. Nothing shows that — the overflow is clipped —
#: until something inside gets FOCUS: the first pointer entry focuses the plot
#: canvas, the browser scrolls that focused element into view, and the whole
#: picture jumps up by half the overflow. Once. On the first hover of a fresh
#: pane, which is exactly what an operator reads as "the FFT moved".
#:
#: CSS cannot stop it. `overflow: hidden` still leaves a programmatically
#: scrollable box, and `overflow: clip` on the root propagates to the viewport,
#: which Chromium scrolls anyway (measured, both).
#:
#: So the scroll is UNDONE, on the capture phase, the moment it happens. The
#: figure's own pan and zoom never touch document scroll — they are canvas
#: transforms — so a scrolled figure document is always this artefact and never
#: something a user asked for. Assigning 0 to an already-0 offset does not
#: re-fire, so this settles rather than loops.
#: BOTH boxes, deliberately: which one actually scrolls depends on the overflow
#: cascade — with `html` hidden the viewport cannot scroll and `body` keeps a
#: scroll box of its own, and the focus scroll lands on whichever it is
#: (measured: `body` under the style above, `html` when the root is `clip`).
PIN_SCROLL = (
    "<script>addEventListener('scroll',function(){"
    "var d=document,b=[d.documentElement,d.body,d.scrollingElement];"
    "for(var i=0;i<b.length;i++){var e=b[i];if(!e)continue;"
    "if(e.scrollTop)e.scrollTop=0;if(e.scrollLeft)e.scrollLeft=0}"
    "},{capture:true,passive:true})</script>"
)

#: Relays anyplotlib's hover readout (`apl:readout`, which fires whether or not
#: the pill is shown) to the host page, for `FigureFrame`'s `onReadout`.
#: `info` is null when the cursor leaves the image.
RELAY_READOUT = (
    "<script>document.addEventListener('apl:readout',function(e){"
    "if(parent!==window)parent.postMessage({type:'apl_readout',info:e.detail},'*')"
    "})</script>"
)


def fill_iframe_html(html: str, *, background: str = FIGURE_BACKGROUND,
                     extra_head: str = "") -> str:
    """Make a standalone figure FILL its iframe, and match the app's theme.

    Load-bearing for any app that drives figure size with
    ``_electron.resize_figure``. anyplotlib's standalone template pins
    ``html``/``body`` to the figure's INITIAL pixel size with
    ``overflow:hidden`` — correct for a fixed docs or notebook embed. A shell app
    resizes the figure live, so once the pane is larger than that initial size
    the grown figure is CLIPPED to the old body box: the image spills past the
    panel and the bottom is cut off, while everything around it looks fine.

    ``extra_head`` is injected alongside, for an app that needs its own script in
    the frame (SpyDE relays a pointerdown to bring its subwindow to the front).
    """
    style = (f"<style>html,body{{background:{background} !important;color-scheme:dark;"
             "width:100% !important;height:100% !important;overflow:hidden}"
             f"#widget-root{{background:{background} !important;"
             "width:100% !important;height:100% !important;display:block !important}"
             "</style>")
    return html.replace("<body>",
                        style + PIN_SCROLL + RELAY_READOUT + extra_head + "<body>", 1)


class FigureView:
    """One always-on image pane.

    Parameters
    ----------
    window_id
        The window this figure belongs to, as minted by the session.
    title
        Shown above the image and used as the window title.
    colormap
        Initial colormap name.
    gpu
        Passed through to ``imshow``. ``"auto"`` renders large scalar images on
        the GPU and falls back to Canvas2D for small ones, RGB, and machines
        without it; ``"off"`` forces Canvas2D (what a CPU-reference screenshot
        test wants).
    """

    def __init__(self, window_id: int, title: str = "", *,
                 colormap: str = DEFAULT_COLORMAP, gpu: str = "auto") -> None:
        self.window_id = window_id
        self.title = title
        #: Assigned by `open()` from `_electron.register` — see the module note.
        self.fig_id: str | None = None
        self._fig = None
        self._axes = None
        self._plot2d = None
        self._colormap = colormap
        self._gpu = gpu
        self._closed = False
        self._tiled = False
        #: The last frame `show` painted, for `auto_clim`. One reference, not a
        #: copy; None while tiled, since `show` is not on that path.
        self._last_frame = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    @property
    def is_open(self) -> bool:
        return self._plot2d is not None and not self._closed

    def open(self, shape: tuple[int, int], *, is_navigator: bool = False) -> str | None:
        """Create the figure and send it to the renderer. Idempotent.

        *shape* is the frame size to lay out for. Passing the REAL size (rather
        than a small stand-in) matters: a placeholder of a different shape makes
        the pane resize the moment the first frame lands, which reads as the
        window jumping.

        Returns the fig_id.
        """
        if self._fig is not None:
            return self.fig_id
        h, w = int(shape[0]), int(shape[1])
        self._fig, axes_obj = apl.subplots(1, 1)
        self._axes = axes_obj[0][0] if isinstance(axes_obj, list) else axes_obj
        self._plot2d = self._axes.imshow(
            np.zeros((h, w), dtype=np.float32), cmap=self._colormap, gpu=self._gpu)
        if self.title:
            self._plot2d.set_title(self.title)

        # Register BEFORE building the HTML: registration attaches the trait
        # observers AND mints the id, so the HTML must be built with that id.
        self.fig_id = _electron.register(self._fig)
        html = fill_iframe_html(
            build_standalone_html(self._fig, fig_id=self.fig_id, resizable=False))

        emit({
            "type": "figure",
            "fig_id": self.fig_id,
            "window_id": self.window_id,
            "html": html,
            "title": self.title,
            "is_navigator": is_navigator,
            "aspect": (w / h) if h else None,
        })
        return self.fig_id

    def close(self) -> None:
        """WindowController.close — idempotent, and never raises during teardown."""
        if self._closed:
            return
        self._closed = True
        self._tiled = False
        self._plot2d = None
        self._axes = None
        self._fig = None
        self._last_frame = None      # a closed figure must not pin a 4096² frame

    # ── Painting ──────────────────────────────────────────────────────────────

    def show(self, frame: np.ndarray, *,
             clim: tuple[float, float] | None = None) -> bool:
        """Paint one frame. **Main thread only** — see the threading contract in
        ``de_shell.actions.lifecycle``.

        ``clim=None`` re-derives a robust range per frame, which is what a live
        scene wants; pass an explicit range to hold contrast steady across
        frames. Returns whether the paint landed, so a caller that must know
        (a live preview, a test) is not left inferring it from a counter that
        increments either way.
        """
        if not self.is_open:
            return False
        try:
            # Pin BEFORE set_data when the plot is already tiled (a figure
            # opened at a large shape tiles on its zeros placeholder), so the
            # frame is encoded over a valid band in the same push. The
            # after-call catches the other route: this set_data being the one
            # that swaps the plot into tile mode.
            pinned = self._pin_tile_band(frame)
            self._plot2d.set_data(
                frame, clim=clim if clim is not None else robust_levels(frame))
            if not pinned and self._pin_tile_band(frame):
                # Swapped mid-call: the push above quantised over the encoder's
                # display-window fallback; re-encode once over the real band.
                self._plot2d.update_tile_source()
            # Kept so Auto can re-derive a range later. A live scene re-derives
            # per frame and never needs it, but a STILL figure — a calibration
            # image, a motion average — has no next frame to hand the job to,
            # so without this its Auto button has nothing to compute from.
            self._last_frame = frame
            return True
        except Exception as e:
            log.debug("painting figure %s failed: %s", self.fig_id, e)
            return False

    def _pin_tile_band(self, frame: np.ndarray) -> bool:
        """Give a tiled plot a valid quantisation band, from *frame* itself.

        anyplotlib auto-tiles any frame over its size threshold and derives the
        raw_min/raw_max band ONCE — from whatever the tile source holds at
        enable time. A figure opened at a large shape tiles on its ZEROS
        placeholder, so the band comes out (0, 0), and `_set_data_tiled` never
        re-derives it. The two ends of the protocol then disagree about that
        degenerate band: the Python encoder falls back to the display window,
        but the frontend LUT honours (0, 0) — every byte maps below the display
        floor and the pane renders black however good the data. (`set_tile_band`
        documents the same failure for the explicit-tile live path, which is
        why the camera view survived while every large STILL — Calibrate, the
        FFT panels, Motion sums — went black.)

        Returns whether the band was already valid or has been pinned; False
        means the plot is not in tile mode (nothing to do). Upstream fix worth
        proposing (CSSFrancis/anyplotlib): derive the band in `_set_data_tiled`,
        and treat raw_max <= raw_min as unset in the frontend LUT.
        """
        st = getattr(self._plot2d, "_state", None)
        if not isinstance(st, dict) or not st.get("tile_enabled"):
            return False
        lo, hi = st.get("raw_min"), st.get("raw_max")
        if lo is not None and hi is not None and hi > lo:
            return True
        arr = np.asarray(frame)
        if arr.size == 0:
            return False
        if arr.dtype.kind == "f":
            # nanmin/nanmax rather than a finite mask: the mask materialises a
            # copy of the frame (~½ GB transient on an 8k float), this doesn't.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN frame
                lo, hi = float(np.nanmin(arr)), float(np.nanmax(arr))
            if not (np.isfinite(lo) and np.isfinite(hi)):
                finite = arr[np.isfinite(arr)]      # rare: ±inf in the frame
                if finite.size == 0:
                    return False
                lo, hi = float(finite.min()), float(finite.max())
        else:
            lo, hi = float(arr.min()), float(arr.max())
        if not hi > lo:
            hi = lo + 1.0
        st["raw_min"], st["raw_max"] = lo, hi
        return True

    @property
    def last_frame(self):
        """The last frame painted by :meth:`show`, or None.

        For a caller that needs to recompute something ABOUT the displayed
        pixels — a histogram to re-send after the range changed, say — rather
        than re-deriving it from wherever the frame originally came from.
        """
        return self._last_frame

    def auto_clim(self) -> tuple[float, float] | None:
        """Re-derive the robust display range from the last painted frame.

        Returns the range applied, or None when there is nothing to derive it
        from — a figure that has only ever been tiled (``show`` is never called
        in tile mode) or one that has not painted yet.
        """
        frame = self._last_frame
        if frame is None:
            return None
        lo, hi = robust_levels(frame)
        return (float(lo), float(hi)) if self.set_clim(lo, hi) else None

    # ── Tiled display ─────────────────────────────────────────────────────────

    def enable_tile(self, backend, *, integration_method: str = "mean") -> bool:
        """Render through a :class:`TileBackend` instead of pushed frames.

        anyplotlib then owns the loop: it shows a downsampled overview as the
        base and, on its own debounced ``view_changed``, asks the backend for a
        hi-res tile of just the visible region at panel resolution. So the
        source can be larger than anything worth sending whole — an 8192²
        detector, or a camera that is only ever asked for the crop on screen.

        Backends are duck-typed (``full_shape``, ``dtype``, ``origin``,
        ``extent()``, ``sample()``); the shell requires no particular class.

        Returns whether tiling was enabled — an anyplotlib without the tile API
        is a soft failure, and the caller can fall back to :meth:`show`.
        """
        if not self.is_open or not hasattr(self._plot2d, "enable_tile"):
            return False
        try:
            self._plot2d.enable_tile(backend, integration_method=integration_method)
            self._tiled = True
            return True
        except Exception as e:
            log.warning("enable_tile failed, falling back to pushed frames: %s", e)
            return False

    @property
    def is_tiled(self) -> bool:
        return self._tiled

    def refresh_tile(self) -> bool:
        """Re-read the CURRENT view from the backend — the live-data path.

        The zoom and pan persist across the refresh, which is the contract that
        matters for a live camera: new pixels arrive without the user's
        viewport being reset out from under them.
        """
        if not self.is_open or not self._tiled:
            return False
        try:
            self._plot2d.update_tile_source()
            return True
        except Exception as e:
            log.debug("refresh_tile failed: %s", e)
            return False

    def set_tile_band(self, lo: float, hi: float) -> bool:
        """Fix the tile QUANTISATION band (raw_min/raw_max) and re-encode.

        anyplotlib derives this band once, at `enable_tile`, by sampling the
        backend — which cannot work for a source that has no data yet (a real
        DE Server serves no frame before an acquisition, and the tile source
        deliberately answers zeros until then). With the band unset, tile
        bytes are quantised over fallback guesses and the display window then
        re-windows THOSE — on real hardware that rendered a healthy frame as
        a black pane. The caller knows the true whole-frame range (the
        server's histogram rides along with every read) and pins the band
        here the moment data exists, or when the range outgrows it.

        Reaches into `_plot2d._state` because anyplotlib has no public
        band-setter yet — worth an upstream API (CSSFrancis/anyplotlib);
        until then this is the one sanctioned touch point.
        """
        if not self.is_open or not self._tiled:
            return False
        try:
            st = self._plot2d._state
            st["raw_min"], st["raw_max"] = float(lo), float(hi)
            self._plot2d.update_tile_source()   # re-encode over the new band
            return True
        except Exception as e:
            log.debug("set_tile_band(%s, %s) failed: %s", lo, hi, e)
            return False

    def set_clim(self, vmin: float, vmax: float) -> bool:
        """Set the display range without touching the pixels.

        The separate call matters in tile mode: :meth:`show` is never called
        there, so there is no ``clim=`` argument to ride along with. Left
        unset, a tiled plot keeps whatever range the placeholder passed to
        ``imshow`` established — which renders real data as a uniform white or
        black panel.
        """
        if not self.is_open:
            return False
        try:
            self._plot2d.set_clim(float(vmin), float(vmax))
            return True
        except Exception as e:
            log.debug("set_clim(%s, %s) failed: %s", vmin, vmax, e)
            return False

    def set_readout_visible(self, visible: bool) -> bool:
        """Show or hide the on-image hover pill. Hidden, the readout still reaches
        the host through `FigureFrame`'s `onReadout`, so an app can print it in
        its own units."""
        if not self.is_open:
            return False
        try:
            self._plot2d.set_readout_visible(bool(visible))
            return True
        except Exception as e:
            log.debug("set_readout_visible(%s) failed: %s", visible, e)
            return False

    def on_event(self, *event_types: str):
        """Register a handler for anyplotlib pointer/key events on this figure.

        A decorator, matching anyplotlib's own API::

            @view.on_event("pointer_down")
            def clicked(event): ...

        The handler receives an `Event` whose ``xdata``/``ydata`` are in DATA
        space — image pixels for an ``imshow`` — which is what a caller
        measuring in the image wants, not canvas pixels.

        Handlers fire on the asyncio main thread (the stdin reader dispatches
        them), so a slow one blocks every other message: hand real work to a
        worker rather than doing it inline.

        Returns a no-op decorator when the figure is not open, so registration
        at construction time is safe.
        """
        def _register(fn):
            if self.is_open:
                try:
                    self._plot2d.add_event_handler(fn, *event_types)
                except Exception as e:
                    log.warning("could not register %s handler: %s", event_types, e)
            return fn
        return _register

    def add_circle_widget(self, *, cx: float, cy: float, r: float,
                          color: str = "#00e5ff", on_change=None,
                          lock_center: bool = False,
                          linewidth: float = 2, show_handles: bool = True):
        """A draggable circle overlay. Returns the widget, or None.

        WIDGETS are the way to get DRAGGED geometry out of an anyplotlib
        figure: the plot owns the hit-testing and pushes the new state back.
        A plain click does arrive as `pointer_down` (anyplotlib >= 0.7.3
        separates a click from a pan), so use `on_event` for click-to-mark.

        `on_change(cx, cy, r)` fires on ``pointer_up`` — when the drag settles —
        not on every frame, so a callback that recomputes something expensive
        does not run sixty times a second.

        `lock_center` pins the centre and lets only the radius change. On a
        power spectrum the centre IS the DC term, so a draggable one is a
        control that can only ever be wrong — and a ring nudged off-centre
        silently corrupts every radius measured from it. anyplotlib enforces it
        in the HIT-TEST: a grab on the ring body is refused outright, so the
        centre never moves at all.

        `linewidth` and `show_handles` are anyplotlib's own, passed through at
        its own defaults. They matter for a circle used as an ANNOTATION rather
        than a control: a set of them drawn at the default 2 px with grab
        handles reads as a cluster of filled discs and a row of dots, which
        obscures the very image it is marking up. A caller drawing many should
        thin them and drop the handles — a handle on something nothing reads
        back is an affordance that promises an effect it does not have.
        """
        if not self.is_open:
            return None
        try:
            w = self._plot2d.add_circle_widget(
                cx=float(cx), cy=float(cy), r=float(r), color=color,
                lock_center=bool(lock_center), linewidth=float(linewidth),
                show_handles=bool(show_handles))
        except Exception as e:
            log.warning("could not add circle widget: %s", e)
            return None

        def _settled(_event, _w=w):
            try:
                if on_change is not None:
                    on_change(float(_w.cx), float(_w.cy), float(_w.r))
            except Exception as e:
                log.debug("circle widget callback failed: %s", e)

        if on_change is not None:
            try:
                w.add_event_handler(_settled, "pointer_up")
            except Exception as e:
                log.warning("could not observe circle widget: %s", e)
        return w

    def add_line_widget(self, *, x1: float, y1: float, x2: float, y2: float,
                        color: str = "#00e5ff", on_change=None):
        """A draggable two-endpoint line overlay. Returns the widget, or None.

        The measuring counterpart to the circle: drag either end onto a feature
        and the length between them is the measurement. A LINE widget rather
        than two clicks because the plot owns the hit-testing of a drag and
        pushes the geometry back; clicks themselves do arrive as
        `pointer_down` on anyplotlib >= 0.7.3.

        `on_change(x1, y1, x2, y2)` fires when a drag settles.
        """
        if not self.is_open:
            return None
        try:
            w = self._plot2d.add_line_widget(
                x1=float(x1), y1=float(y1), x2=float(x2), y2=float(y2),
                color=color)
        except Exception as e:
            log.warning("could not add line widget: %s", e)
            return None

        def _settled(_event, _w=w):
            try:
                if on_change is not None:
                    on_change(float(_w.x1), float(_w.y1),
                              float(_w.x2), float(_w.y2))
            except Exception as e:
                log.debug("line widget callback failed: %s", e)

        if on_change is not None:
            try:
                w.add_event_handler(_settled, "pointer_up")
            except Exception as e:
                log.warning("could not observe line widget: %s", e)
        return w

    def add_rectangle_widget(self, *, x: float, y: float, w: float, h: float,
                             color: str = "#00e5ff", on_change=None,
                             max_extent=None, show_handles: bool = True,
                             linewidth: float = 2):
        """A draggable rectangle overlay. Returns the widget, or None.

        `x, y` is the top-left corner. `max_extent` (a scalar, or
        `(max_w, max_h)`) stops growth at the cap while a corner is dragged.
        `on_change(x, y, w, h)` fires when a drag settles.
        """
        if not self.is_open:
            return None
        try:
            rect = self._plot2d.add_rectangle_widget(
                x=float(x), y=float(y), w=float(w), h=float(h), color=color,
                linewidth=float(linewidth), show_handles=bool(show_handles),
                max_extent=max_extent)
        except Exception as e:
            log.warning("could not add rectangle widget: %s", e)
            return None

        def _settled(_event, _w=rect):
            try:
                if on_change is not None:
                    on_change(float(_w.x), float(_w.y),
                              float(_w.w), float(_w.h))
            except Exception as e:
                log.debug("rectangle widget callback failed: %s", e)

        if on_change is not None:
            try:
                rect.add_event_handler(_settled, "pointer_up")
            except Exception as e:
                log.warning("could not observe rectangle widget: %s", e)
        return rect

    def add_texts(self, offsets, texts, *, name: str | None = None,
                  color: str | Sequence[str] = "#ffffff", fontsize: int = 12,
                  fontweight: str = "normal", outline_color: str | None = None):
        """Text labels at image-pixel positions (top-left anchors). Returns the
        group, or None. The same `name` again replaces it in place;
        `remove_widget` drops it. `color` is one colour or one per text.
        `outline_color` draws a legibility halo.
        """
        if not self.is_open:
            return None
        try:
            return self._plot2d.add_texts(
                offsets, [str(t) for t in texts], name=name, color=color,
                fontsize=fontsize, fontweight=fontweight,
                outline_color=outline_color)
        except Exception as e:
            log.warning("could not add texts: %s", e)
            return None

    @staticmethod
    def set_widget_geometry(widget, **geometry) -> bool:
        """Move an overlay from Python. Returns whether it landed.

        `_notify=False` is the whole point: a `set()` is otherwise
        indistinguishable from a user drag, so the widget's own `on_change`
        fires on it — and a handler that recomputes a measurement from the
        widget would then be recomputing from a value it was just given. The
        caller already knows what it set.
        """
        if widget is None:
            return False
        try:
            widget.set(_notify=False, **{k: float(v)
                                         for k, v in geometry.items()})
            return True
        except Exception as e:
            log.debug("set_widget_geometry(%s) failed: %s", geometry, e)
            return False

    def remove_widget(self, widget) -> None:
        """Drop ONE overlay. Tolerates None and an already-removed widget, so a
        caller swapping overlays does not have to track which it still holds."""
        if widget is None or not self.is_open:
            return
        try:
            widget.remove()
        except Exception as e:
            log.debug("remove_widget failed: %s", e)

    def clear_widgets(self) -> None:
        """Drop every overlay widget. Idempotent, never raises in teardown."""
        if not self.is_open:
            return
        try:
            self._plot2d.clear_widgets()
        except Exception as e:
            log.debug("clear_widgets failed: %s", e)

    def set_colormap(self, name: str) -> None:
        self._colormap = name
        if not self.is_open:
            return
        try:
            self._plot2d.set_colormap(name)
        except Exception as e:
            log.debug("set_colormap(%s) failed: %s", name, e)

    def set_title(self, title: str) -> None:
        self.title = title
        if not self.is_open:
            return
        try:
            self._plot2d.set_title(title)
        except Exception as e:
            log.debug("set_title(%s) failed: %s", title, e)
